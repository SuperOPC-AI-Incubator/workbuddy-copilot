CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- Staff authentication metadata is kept separate from authorization roles.
CREATE TABLE public.staff_accounts (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username text NOT NULL,
  normalized_username text NOT NULL UNIQUE,
  auth_identity_version integer NOT NULL DEFAULT 1,
  is_active boolean NOT NULL DEFAULT true,
  must_change_password boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  disabled_at timestamptz,
  disabled_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT staff_accounts_username_check
    CHECK (
      username = normalized_username
      AND username = btrim(username)
      AND char_length(username) BETWEEN 2 AND 32
      AND username ~ '^[a-z0-9][a-z0-9._-]{1,31}$'
    ),
  CONSTRAINT staff_accounts_normalized_username_check
    CHECK (
      normalized_username = lower(btrim(normalized_username))
      AND char_length(normalized_username) BETWEEN 2 AND 32
      AND normalized_username ~ '^[a-z0-9][a-z0-9._-]{1,31}$'
    ),
  CONSTRAINT staff_accounts_auth_identity_version_check
    CHECK (auth_identity_version = 1),
  CONSTRAINT staff_accounts_disabled_state_check
    CHECK (
      (is_active AND disabled_at IS NULL AND disabled_by IS NULL)
      OR (NOT is_active AND disabled_at IS NOT NULL)
    )
);

CREATE INDEX staff_accounts_is_active_idx
  ON public.staff_accounts (is_active);
CREATE INDEX staff_accounts_created_by_idx
  ON public.staff_accounts (created_by)
  WHERE created_by IS NOT NULL;
CREATE INDEX staff_accounts_disabled_by_idx
  ON public.staff_accounts (disabled_by)
  WHERE disabled_by IS NOT NULL;

-- Existing privileged users are staged only from trusted Auth app metadata.
-- Email/local-part and user-editable metadata are deliberately never guessed.
INSERT INTO public.staff_accounts (
  user_id,
  username,
  normalized_username,
  auth_identity_version
)
SELECT DISTINCT
  auth_user.id,
  btrim(auth_user.raw_app_meta_data ->> 'staff_username'),
  btrim(auth_user.raw_app_meta_data ->> 'staff_username'),
  1
FROM public.user_roles AS staff_role
JOIN auth.users AS auth_user
  ON auth_user.id = staff_role.user_id
WHERE staff_role.role IN (
    'mentor'::public.app_role,
    'team_admin'::public.app_role
  )
  AND auth_user.raw_app_meta_data ->> 'account_kind' = 'staff'
  AND btrim(auth_user.raw_app_meta_data ->> 'staff_username')
    = lower(btrim(auth_user.raw_app_meta_data ->> 'staff_username'))
  AND char_length(
    btrim(auth_user.raw_app_meta_data ->> 'staff_username')
  ) BETWEEN 2 AND 32
  AND btrim(auth_user.raw_app_meta_data ->> 'staff_username')
    ~ '^[a-z0-9][a-z0-9._-]{1,31}$'
  AND (
    auth_user.raw_app_meta_data ->> 'auth_identity_version' IS NULL
    OR auth_user.raw_app_meta_data ->> 'auth_identity_version' = '1'
  )
ON CONFLICT DO NOTHING;

DO $existing_staff_guard$
DECLARE
  unresolved_user_ids text;
BEGIN
  SELECT pg_catalog.string_agg(
    unresolved.user_id::text,
    ',' ORDER BY unresolved.user_id::text
  )
  INTO unresolved_user_ids
  FROM (
    SELECT DISTINCT staff_role.user_id
    FROM public.user_roles AS staff_role
    LEFT JOIN public.staff_accounts AS staff
      ON staff.user_id = staff_role.user_id
    WHERE staff_role.role IN (
        'mentor'::public.app_role,
        'team_admin'::public.app_role
      )
      AND staff.user_id IS NULL
  ) AS unresolved;

  IF unresolved_user_ids IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'PST01',
      MESSAGE = 'unresolved_staff_accounts',
      DETAIL = unresolved_user_ids,
      HINT =
        'Set trusted raw_app_meta_data.account_kind=staff and staff_username, then rerun.';
  END IF;
END;
$existing_staff_guard$;

ALTER TABLE public.sessions
  ADD COLUMN source text NOT NULL DEFAULT 'web',
  ADD COLUMN source_session_key text,
  ADD CONSTRAINT sessions_id_student_unique
    UNIQUE (id, student_id),
  ADD CONSTRAINT sessions_source_check
    CHECK (source IN ('web', 'mcp', 'skill', 'connector')),
  ADD CONSTRAINT sessions_source_session_key_check
    CHECK (
      source_session_key IS NULL
      OR (
        source_session_key = btrim(source_session_key)
        AND char_length(source_session_key) BETWEEN 1 AND 255
      )
    );

CREATE UNIQUE INDEX sessions_student_source_key_unique
  ON public.sessions (student_id, source, source_session_key)
  WHERE source_session_key IS NOT NULL;

-- The event row is the idempotency boundary for a single WorkBuddy upload.
CREATE TABLE public.workbuddy_ingest_events (
  event_id uuid PRIMARY KEY,
  student_id uuid NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  session_id uuid,
  source text NOT NULL,
  payload_sha256 text NOT NULL,
  client_created_at timestamptz NOT NULL,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workbuddy_ingest_events_event_session_unique
    UNIQUE (event_id, session_id),
  CONSTRAINT workbuddy_ingest_events_session_student_fkey
    FOREIGN KEY (session_id, student_id)
    REFERENCES public.sessions (id, student_id)
    ON DELETE CASCADE,
  CONSTRAINT workbuddy_ingest_events_source_check
    CHECK (source IN ('mcp', 'skill', 'connector')),
  CONSTRAINT workbuddy_ingest_events_payload_sha256_check
    CHECK (payload_sha256 ~ '^[0-9a-f]{64}$')
);

CREATE INDEX workbuddy_ingest_events_student_created_idx
  ON public.workbuddy_ingest_events (student_id, created_at DESC);
CREATE INDEX workbuddy_ingest_events_session_created_idx
  ON public.workbuddy_ingest_events (session_id, created_at DESC);

ALTER TABLE public.timeline_items
  ADD COLUMN source_event_id uuid,
  ADD COLUMN event_ordinal smallint,
  ADD COLUMN author_username text,
  ADD CONSTRAINT timeline_items_id_session_unique
    UNIQUE (id, session_id),
  ADD CONSTRAINT timeline_items_event_session_fkey
    FOREIGN KEY (source_event_id, session_id)
    REFERENCES public.workbuddy_ingest_events (event_id, session_id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT timeline_items_event_ordinal_range_check
    CHECK (event_ordinal BETWEEN 0 AND 2),
  ADD CONSTRAINT timeline_items_event_identity_check
    CHECK (
      (source_event_id IS NULL AND event_ordinal IS NULL)
      OR (source_event_id IS NOT NULL AND event_ordinal IS NOT NULL)
    ),
  ADD CONSTRAINT timeline_items_author_username_check
    CHECK (author_username IS NULL OR btrim(author_username) <> '');

CREATE UNIQUE INDEX timeline_items_source_event_ordinal_unique
  ON public.timeline_items (source_event_id, event_ordinal)
  WHERE source_event_id IS NOT NULL;

-- Only hashes and short display prefixes are persisted; plaintext tokens never enter this table.
-- students.workbuddy_token is a deprecated compatibility path and is removed only after callers migrate.
CREATE TABLE public.workbuddy_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id uuid NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  token_prefix text NOT NULL,
  source text NOT NULL DEFAULT 'issued',
  status text NOT NULL DEFAULT 'active',
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workbuddy_credentials_token_hash_check
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT workbuddy_credentials_token_prefix_check
    CHECK (
      token_prefix = btrim(token_prefix)
      AND char_length(token_prefix) BETWEEN 4 AND 24
    ),
  CONSTRAINT workbuddy_credentials_source_check
    CHECK (source IN ('issued', 'legacy_token_backfill')),
  CONSTRAINT workbuddy_credentials_status_check
    CHECK (status IN ('active', 'revoked')),
  CONSTRAINT workbuddy_credentials_revocation_check
    CHECK (
      (status = 'active' AND revoked_at IS NULL)
      OR (status = 'revoked' AND revoked_at IS NOT NULL)
    )
);

CREATE INDEX workbuddy_credentials_student_status_idx
  ON public.workbuddy_credentials (student_id, status);

-- Transitional backfill only: retain students.workbuddy_token until Task 6,
-- while making every existing token available through the hash-only store.
INSERT INTO public.workbuddy_credentials (
  student_id,
  token_hash,
  token_prefix,
  source
)
SELECT
  student.id,
  encode(
    extensions.digest(student.workbuddy_token, 'sha256'),
    'hex'
  ),
  left(
    encode(
      extensions.digest(student.workbuddy_token, 'sha256'),
      'hex'
    ),
    8
  ),
  'legacy_token_backfill'
FROM public.students AS student
WHERE student.workbuddy_token IS NOT NULL
ON CONFLICT (token_hash) DO NOTHING;

CREATE TABLE public.mentor_message_deliveries (
  message_id uuid PRIMARY KEY,
  student_id uuid NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  session_id uuid NOT NULL,
  first_fetched_at timestamptz,
  last_fetched_at timestamptz,
  fetch_count integer NOT NULL DEFAULT 0,
  acknowledged_at timestamptz,
  web_seen_at timestamptz,
  failure_count integer NOT NULL DEFAULT 0,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mentor_message_deliveries_message_session_fkey
    FOREIGN KEY (message_id, session_id)
    REFERENCES public.timeline_items (id, session_id)
    ON DELETE CASCADE,
  CONSTRAINT mentor_message_deliveries_session_student_fkey
    FOREIGN KEY (session_id, student_id)
    REFERENCES public.sessions (id, student_id)
    ON DELETE CASCADE,
  CONSTRAINT mentor_message_deliveries_fetch_count_check
    CHECK (fetch_count >= 0),
  CONSTRAINT mentor_message_deliveries_failure_count_check
    CHECK (failure_count >= 0),
  CONSTRAINT mentor_message_deliveries_fetch_timestamp_presence_check
    CHECK (first_fetched_at IS NULL OR last_fetched_at IS NOT NULL),
  CONSTRAINT mentor_message_deliveries_fetch_state_check
    CHECK (
      (
        fetch_count = 0
        AND first_fetched_at IS NULL
        AND last_fetched_at IS NULL
      )
      OR (
        fetch_count > 0
        AND first_fetched_at IS NOT NULL
        AND last_fetched_at IS NOT NULL
      )
    ),
  CONSTRAINT mentor_message_deliveries_fetch_order_check
    CHECK (first_fetched_at IS NULL OR last_fetched_at >= first_fetched_at),
  CONSTRAINT mentor_message_deliveries_failure_state_check
    CHECK (
      (failure_count = 0 AND last_error_code IS NULL)
      OR (failure_count > 0 AND last_error_code IS NOT NULL)
    )
);

CREATE INDEX mentor_message_deliveries_student_fetch_idx
  ON public.mentor_message_deliveries (student_id, last_fetched_at);
CREATE INDEX mentor_message_deliveries_session_idx
  ON public.mentor_message_deliveries (session_id);

-- Reuse the existing hardened timestamp helper from the foundation migration.
DROP TRIGGER IF EXISTS set_staff_accounts_updated_at ON public.staff_accounts;
CREATE TRIGGER set_staff_accounts_updated_at
BEFORE UPDATE ON public.staff_accounts
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS set_mentor_message_deliveries_updated_at
  ON public.mentor_message_deliveries;
CREATE TRIGGER set_mentor_message_deliveries_updated_at
BEFORE UPDATE ON public.mentor_message_deliveries
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

-- The legacy AFTER INSERT trigger remains attached to this function. Harden
-- the function itself so authenticated inserts can still update aggregates
-- after table-wide authenticated UPDATE privileges are revoked below.
CREATE OR REPLACE FUNCTION public.on_timeline_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  UPDATE public.sessions
  SET
    updated_at = pg_catalog.now(),
    last_severity = COALESCE(NEW.severity, last_severity)
  WHERE id = NEW.session_id;

  UPDATE public.students
  SET
    last_active_at = pg_catalog.now(),
    last_severity = COALESCE(NEW.severity, last_severity)
  WHERE id = (
    SELECT target_session.student_id
    FROM public.sessions AS target_session
    WHERE target_session.id = NEW.session_id
  );

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.on_timeline_insert()
  FROM PUBLIC, anon, authenticated;

ALTER TABLE public.staff_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workbuddy_ingest_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workbuddy_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mentor_message_deliveries ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.staff_accounts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.workbuddy_ingest_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.workbuddy_credentials FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.mentor_message_deliveries FROM PUBLIC, anon, authenticated;

GRANT ALL ON TABLE public.staff_accounts TO service_role;
GRANT ALL ON TABLE public.workbuddy_ingest_events TO service_role;
GRANT ALL ON TABLE public.workbuddy_credentials TO service_role;
GRANT ALL ON TABLE public.mentor_message_deliveries TO service_role;

ALTER TABLE public.staff_accounts REPLICA IDENTITY FULL;
ALTER TABLE public.workbuddy_ingest_events REPLICA IDENTITY FULL;
ALTER TABLE public.mentor_message_deliveries REPLICA IDENTITY FULL;

-- A migration may be replayed against a linked project where these publication
-- memberships already exist, so guard each addition explicitly.
DO $publication$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_publication
    WHERE pubname = 'supabase_realtime'
  ) THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'staff_accounts'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.staff_accounts;
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'workbuddy_ingest_events'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.workbuddy_ingest_events;
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'mentor_message_deliveries'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.mentor_message_deliveries;
    END IF;
  END IF;
END
$publication$;

-- RLS policies call this definer helper instead of querying role tables
-- directly. That avoids policy recursion while immediately honoring staff
-- disablement and forced-password-change state.
CREATE OR REPLACE FUNCTION public.has_active_role(
  _user_id uuid,
  _role public.app_role
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles AS user_role
    LEFT JOIN public.staff_accounts AS staff
      ON staff.user_id = user_role.user_id
    WHERE user_role.user_id = _user_id
      AND user_role.role = _role
      AND (
        _role = 'student'::public.app_role
        OR (
          _role IN (
            'mentor'::public.app_role,
            'team_admin'::public.app_role
          )
          AND staff.is_active = true
          AND staff.must_change_password = false
        )
      )
  );
$function$;

REVOKE ALL ON FUNCTION public.has_active_role(uuid, public.app_role)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.has_active_role(uuid, public.app_role)
  TO authenticated, service_role;

-- Retire the legacy helper as an authorization surface. Keeping a gated
-- definition avoids silently reintroducing disabled staff access if an old
-- administrative query still invokes it during the transition.
CREATE SCHEMA IF NOT EXISTS private;
CREATE OR REPLACE FUNCTION private.has_role(
  _user_id uuid,
  _role public.app_role
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT public.has_active_role(_user_id, _role);
$function$;

REVOKE ALL ON FUNCTION private.has_role(uuid, public.app_role)
  FROM PUBLIC, anon, authenticated;
REVOKE USAGE ON SCHEMA private FROM authenticated;

-- Public signup metadata is display-only. Authorization metadata is accepted
-- only from raw_app_meta_data, which is controlled by trusted Auth admin APIs.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  provisioned_display_name text;
BEGIN
  IF NEW.raw_app_meta_data ->> 'account_kind' = 'staff' THEN
    RETURN NEW;
  END IF;

  provisioned_display_name := COALESCE(
    NULLIF(
      pg_catalog.btrim(NEW.raw_user_meta_data ->> 'display_name'),
      ''
    ),
    NULLIF(pg_catalog.split_part(NEW.email, '@', 1), ''),
    'Student'
  );

  INSERT INTO public.user_roles (user_id, role)
  VALUES (NEW.id, 'student'::public.app_role)
  ON CONFLICT (user_id, role) DO NOTHING;

  INSERT INTO public.students (user_id, display_name)
  VALUES (NEW.id, provisioned_display_name)
  ON CONFLICT (user_id) DO NOTHING;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.handle_new_user()
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.provision_staff_account(
  _user_id uuid,
  _username text,
  _auth_identity_version integer DEFAULT 1,
  _created_by uuid DEFAULT NULL,
  _is_team_admin boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
BEGIN
  IF _user_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22004',
      MESSAGE = 'staff_user_id_required';
  END IF;

  IF _username IS NULL
    OR _username IS DISTINCT FROM pg_catalog.lower(
      pg_catalog.btrim(_username)
    )
    OR pg_catalog.char_length(_username) NOT BETWEEN 2 AND 32
    OR _username !~ '^[a-z0-9][a-z0-9._-]{1,31}$'
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'invalid_staff_username';
  END IF;

  IF _auth_identity_version IS NULL OR _auth_identity_version <> 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'invalid_auth_identity_version';
  END IF;

  INSERT INTO public.staff_accounts (
    user_id,
    username,
    normalized_username,
    auth_identity_version,
    created_by
  )
  VALUES (
    _user_id,
    _username,
    _username,
    _auth_identity_version,
    _created_by
  );

  INSERT INTO public.user_roles (user_id, role)
  VALUES (_user_id, 'mentor'::public.app_role)
  ON CONFLICT (user_id, role) DO NOTHING;

  IF _is_team_admin THEN
    INSERT INTO public.user_roles (user_id, role)
    VALUES (_user_id, 'team_admin'::public.app_role)
    ON CONFLICT (user_id, role) DO NOTHING;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'user_id', _user_id,
    'username', _username,
    'normalized_username', _username,
    'auth_identity_version', _auth_identity_version,
    'is_team_admin', _is_team_admin,
    'must_change_password', true
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.provision_staff_account(
  uuid,
  text,
  integer,
  uuid,
  boolean
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.provision_staff_account(
  uuid,
  text,
  integer,
  uuid,
  boolean
) TO service_role;

CREATE OR REPLACE FUNCTION public.complete_staff_password_change(
  _user_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  updated_rows integer;
BEGIN
  IF _user_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22004',
      MESSAGE = 'staff_user_id_required';
  END IF;

  UPDATE public.staff_accounts
  SET must_change_password = false
  WHERE user_id = _user_id
    AND is_active = true
    AND must_change_password = true;

  GET DIAGNOSTICS updated_rows = ROW_COUNT;

  IF updated_rows = 1 THEN
    RETURN true;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.staff_accounts
    WHERE user_id = _user_id
      AND is_active = true
      AND must_change_password = false
  ) THEN
    RETURN true;
  END IF;

  RAISE EXCEPTION USING
    ERRCODE = '42501',
    MESSAGE = 'active_staff_account_required';
END;
$function$;

REVOKE ALL ON FUNCTION public.complete_staff_password_change(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_staff_password_change(uuid)
  TO service_role;

-- Both direct web/MCP inserts and the service RPC use this single author
-- snapshot path. Caller-supplied snapshots and connector provenance are
-- overwritten/rejected before the row reaches RLS.
CREATE OR REPLACE FUNCTION public.prepare_mentor_timeline_item()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  staff_account public.staff_accounts%ROWTYPE;
BEGIN
  IF NEW.kind <> 'mentor'::public.timeline_kind THEN
    RETURN NEW;
  END IF;

  IF NEW.source_event_id IS NOT NULL
    OR NEW.event_ordinal IS NOT NULL
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'mentor_timeline_provenance_forbidden';
  END IF;

  IF NEW.author_id IS NULL
    OR NOT (
      public.has_active_role(
        NEW.author_id,
        'mentor'::public.app_role
      )
      OR public.has_active_role(
        NEW.author_id,
        'team_admin'::public.app_role
      )
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'active_staff_role_required';
  END IF;

  SELECT staff.*
  INTO staff_account
  FROM public.staff_accounts AS staff
  WHERE staff.user_id = NEW.author_id
    AND staff.is_active = true
    AND staff.must_change_password = false;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'active_staff_account_required';
  END IF;

  NEW.author_username := staff_account.username;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.prepare_mentor_timeline_item()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS prepare_mentor_timeline_item_before_insert
  ON public.timeline_items;
CREATE TRIGGER prepare_mentor_timeline_item_before_insert
BEFORE INSERT ON public.timeline_items
FOR EACH ROW
EXECUTE FUNCTION public.prepare_mentor_timeline_item();

CREATE OR REPLACE FUNCTION public.prevent_delivered_mentor_kind_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(OLD.id::text, 0)
  );

  IF NEW.kind IS DISTINCT FROM OLD.kind
    AND EXISTS (
      SELECT 1
      FROM public.mentor_message_deliveries AS delivery
      WHERE delivery.message_id = OLD.id
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'delivered_mentor_kind_immutable';
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.prevent_delivered_mentor_kind_change()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS prevent_delivered_mentor_kind_change_before_update
  ON public.timeline_items;
CREATE TRIGGER prevent_delivered_mentor_kind_change_before_update
BEFORE UPDATE OF kind ON public.timeline_items
FOR EACH ROW
EXECUTE FUNCTION public.prevent_delivered_mentor_kind_change();

CREATE OR REPLACE FUNCTION public.validate_mentor_delivery()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  timeline_item public.timeline_items%ROWTYPE;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(NEW.message_id::text, 0)
  );

  SELECT item.*
  INTO timeline_item
  FROM public.timeline_items AS item
  WHERE item.id = NEW.message_id
  FOR UPDATE;

  IF FOUND
    AND timeline_item.kind <> 'mentor'::public.timeline_kind
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'mentor_delivery_message_kind_required';
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.validate_mentor_delivery()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS validate_mentor_delivery_before_write
  ON public.mentor_message_deliveries;
CREATE TRIGGER validate_mentor_delivery_before_write
BEFORE INSERT OR UPDATE ON public.mentor_message_deliveries
FOR EACH ROW
EXECUTE FUNCTION public.validate_mentor_delivery();

CREATE OR REPLACE FUNCTION public.create_mentor_delivery()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  target_session public.sessions%ROWTYPE;
BEGIN
  IF NEW.kind <> 'mentor'::public.timeline_kind THEN
    RETURN NEW;
  END IF;

  SELECT session_row.*
  INTO STRICT target_session
  FROM public.sessions AS session_row
  WHERE session_row.id = NEW.session_id;

  INSERT INTO public.mentor_message_deliveries (
    message_id,
    student_id,
    session_id
  )
  VALUES (
    NEW.id,
    target_session.student_id,
    NEW.session_id
  );

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.create_mentor_delivery()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS create_mentor_delivery_after_insert
  ON public.timeline_items;
CREATE TRIGGER create_mentor_delivery_after_insert
AFTER INSERT ON public.timeline_items
FOR EACH ROW
EXECUTE FUNCTION public.create_mentor_delivery();

CREATE OR REPLACE FUNCTION public.ingest_workbuddy_turn(
  _event_id uuid,
  _student_id uuid,
  _source text,
  _source_session_key text,
  _session_title text,
  _payload_sha256 text,
  _prompt text,
  _reply text,
  _diagnosis_text text DEFAULT NULL,
  _diagnosis_severity public.severity DEFAULT NULL,
  _client_created_at timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  event_inserted boolean := false;
  existing_student_id uuid;
  existing_source text;
  existing_payload_sha256 text;
  stable_result jsonb;
  resolved_session_id uuid;
  prompt_item_id uuid;
  reply_item_id uuid;
  diagnosis_item_id uuid;
BEGIN
  IF _event_id IS NULL OR _student_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22004',
      MESSAGE = 'event_and_student_ids_required';
  END IF;

  IF _source NOT IN ('mcp', 'skill', 'connector') THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'invalid_workbuddy_source';
  END IF;

  IF _source_session_key IS NULL
    OR pg_catalog.btrim(_source_session_key) = ''
    OR _source_session_key <> pg_catalog.btrim(_source_session_key)
    OR pg_catalog.char_length(_source_session_key) > 255
    OR _session_title IS NULL
    OR pg_catalog.btrim(_session_title) = ''
    OR _prompt IS NULL
    OR pg_catalog.btrim(_prompt) = ''
    OR _reply IS NULL
    OR pg_catalog.btrim(_reply) = ''
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'invalid_workbuddy_turn_text';
  END IF;

  IF _payload_sha256 IS NULL
    OR _payload_sha256 !~ '^[0-9a-f]{64}$'
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'invalid_payload_sha256';
  END IF;

  IF (
    _diagnosis_text IS NULL
    AND _diagnosis_severity IS NOT NULL
  ) OR (
    _diagnosis_text IS NOT NULL
    AND (
      _diagnosis_severity IS NULL
      OR pg_catalog.btrim(_diagnosis_text) = ''
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'invalid_diagnosis';
  END IF;

  -- Claim the idempotency key before resolving a session or writing timeline
  -- rows. A concurrent conflicting INSERT waits on the unique event key.
  INSERT INTO public.workbuddy_ingest_events (
    event_id,
    student_id,
    source,
    payload_sha256,
    client_created_at
  )
  VALUES (
    _event_id,
    _student_id,
    _source,
    _payload_sha256,
    COALESCE(_client_created_at, pg_catalog.now())
  )
  ON CONFLICT (event_id) DO NOTHING
  RETURNING true INTO event_inserted;

  IF NOT COALESCE(event_inserted, false) THEN
    SELECT
      ingest_event.student_id,
      ingest_event.source,
      ingest_event.payload_sha256,
      ingest_event.result
    INTO
      existing_student_id,
      existing_source,
      existing_payload_sha256,
      stable_result
    FROM public.workbuddy_ingest_events AS ingest_event
    WHERE ingest_event.event_id = _event_id
    FOR UPDATE;

    IF existing_payload_sha256 <> _payload_sha256
      OR existing_student_id <> _student_id
      OR existing_source <> _source
    THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P4090',
        MESSAGE = 'workbuddy_event_conflict';
    END IF;

    RETURN stable_result
      || pg_catalog.jsonb_build_object('duplicate', true);
  END IF;

  INSERT INTO public.sessions (
    student_id,
    session_title,
    source,
    source_session_key
  )
  VALUES (
    _student_id,
    pg_catalog.btrim(_session_title),
    _source,
    pg_catalog.btrim(_source_session_key)
  )
  ON CONFLICT (student_id, source, source_session_key)
    WHERE source_session_key IS NOT NULL
  DO UPDATE
    SET source_session_key = EXCLUDED.source_session_key
  RETURNING id INTO resolved_session_id;

  UPDATE public.workbuddy_ingest_events
  SET session_id = resolved_session_id
  WHERE event_id = _event_id;

  INSERT INTO public.timeline_items (
    session_id,
    kind,
    text,
    source_event_id,
    event_ordinal
  )
  VALUES (
    resolved_session_id,
    'prompt'::public.timeline_kind,
    _prompt,
    _event_id,
    0
  )
  RETURNING id INTO prompt_item_id;

  INSERT INTO public.timeline_items (
    session_id,
    kind,
    text,
    source_event_id,
    event_ordinal
  )
  VALUES (
    resolved_session_id,
    'reply'::public.timeline_kind,
    _reply,
    _event_id,
    1
  )
  RETURNING id INTO reply_item_id;

  IF _diagnosis_text IS NOT NULL THEN
    INSERT INTO public.timeline_items (
      session_id,
      kind,
      text,
      severity,
      source_event_id,
      event_ordinal
    )
    VALUES (
      resolved_session_id,
      'diagnosis'::public.timeline_kind,
      _diagnosis_text,
      _diagnosis_severity,
      _event_id,
      2
    )
    RETURNING id INTO diagnosis_item_id;
  END IF;

  stable_result := pg_catalog.jsonb_build_object(
    'event_id', _event_id,
    'student_id', _student_id,
    'session_id', resolved_session_id,
    'prompt_item_id', prompt_item_id,
    'reply_item_id', reply_item_id,
    'diagnosis_item_id', diagnosis_item_id,
    'duplicate', false
  );

  UPDATE public.workbuddy_ingest_events
  SET result = stable_result
  WHERE event_id = _event_id;

  RETURN stable_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.ingest_workbuddy_turn(
  uuid,
  uuid,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  public.severity,
  timestamptz
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ingest_workbuddy_turn(
  uuid,
  uuid,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  public.severity,
  timestamptz
) TO service_role;

CREATE OR REPLACE FUNCTION public.create_mentor_message(
  _author_user_id uuid,
  _student_id uuid,
  _session_id uuid,
  _text text,
  _severity public.severity DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  target_is_valid boolean;
  created_message_id uuid;
BEGIN
  IF NOT (
    public.has_active_role(
      _author_user_id,
      'mentor'::public.app_role
    )
    OR public.has_active_role(
      _author_user_id,
      'team_admin'::public.app_role
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'active_staff_role_required';
  END IF;

  IF _text IS NULL OR pg_catalog.btrim(_text) = '' THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'mentor_message_text_required';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.sessions AS target_session
    WHERE target_session.id = _session_id
      AND target_session.student_id = _student_id
  )
  INTO target_is_valid;

  IF NOT target_is_valid THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'mentor_message_target_mismatch';
  END IF;

  INSERT INTO public.timeline_items (
    session_id,
    kind,
    text,
    severity,
    author_id
  )
  VALUES (
    _session_id,
    'mentor'::public.timeline_kind,
    _text,
    _severity,
    _author_user_id
  )
  RETURNING id INTO created_message_id;

  RETURN pg_catalog.jsonb_build_object(
    'message_id', created_message_id,
    'student_id', _student_id,
    'session_id', _session_id,
    'delivery_state', 'pending'
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.create_mentor_message(
  uuid,
  uuid,
  uuid,
  text,
  public.severity
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_mentor_message(
  uuid,
  uuid,
  uuid,
  text,
  public.severity
) TO service_role;

-- This is the only authenticated write boundary for web visibility. Transport
-- fetch/ack/failure state remains service-controlled.
CREATE OR REPLACE FUNCTION public.mark_mentor_messages_web_seen(
  _message_ids uuid[]
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  updated_count integer;
BEGIN
  IF _message_ids IS NULL
    OR COALESCE(pg_catalog.array_length(_message_ids, 1), 0) = 0
  THEN
    RETURN 0;
  END IF;

  UPDATE public.mentor_message_deliveries AS delivery
  SET web_seen_at = COALESCE(
    delivery.web_seen_at,
    pg_catalog.now()
  )
  WHERE delivery.web_seen_at IS NULL
    AND delivery.message_id IN (
      SELECT candidate.message_id
      FROM public.mentor_message_deliveries AS candidate
      JOIN public.students AS student
        ON student.id = candidate.student_id
      WHERE student.user_id = auth.uid()
        AND candidate.message_id = ANY (_message_ids)
    );

  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$function$;

REVOKE ALL ON FUNCTION public.mark_mentor_messages_web_seen(uuid[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_mentor_messages_web_seen(uuid[])
  TO authenticated;

-- Transitional own-student read path for the existing setup screen. The
-- plaintext column is otherwise invisible to authenticated clients and this
-- function is removed together with students.workbuddy_token in Task 6.
CREATE OR REPLACE FUNCTION public.get_my_legacy_workbuddy_setup()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  setup_result jsonb;
BEGIN
  IF auth.uid() IS NULL
    OR EXISTS (
      SELECT 1
      FROM public.staff_accounts AS staff
      WHERE staff.user_id = auth.uid()
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'student_identity_required';
  END IF;

  SELECT pg_catalog.jsonb_build_object(
    'display_name',
    student.display_name,
    'workbuddy_token',
    student.workbuddy_token
  )
  INTO setup_result
  FROM public.students AS student
  WHERE student.user_id = auth.uid();

  IF setup_result IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'student_identity_required';
  END IF;

  RETURN setup_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_my_legacy_workbuddy_setup()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_legacy_workbuddy_setup()
  TO authenticated;

-- Replace every legacy staff-sensitive policy. The active-role helper is the
-- only path that confers mentor/team-admin access.
DROP POLICY IF EXISTS "students read own or mentor" ON public.students;
DROP POLICY IF EXISTS "students update self" ON public.students;
DROP POLICY IF EXISTS "students mentor manage" ON public.students;
DROP POLICY IF EXISTS "sessions read own or mentor" ON public.sessions;
DROP POLICY IF EXISTS "sessions owner insert" ON public.sessions;
DROP POLICY IF EXISTS "sessions owner update" ON public.sessions;
DROP POLICY IF EXISTS "sessions owner delete" ON public.sessions;
DROP POLICY IF EXISTS "timeline read own or mentor" ON public.timeline_items;
DROP POLICY IF EXISTS "timeline student insert own session"
  ON public.timeline_items;
DROP POLICY IF EXISTS "timeline mentor insert" ON public.timeline_items;
DROP POLICY IF EXISTS "timeline author delete" ON public.timeline_items;

REVOKE SELECT, INSERT, UPDATE, DELETE
ON TABLE public.students
FROM authenticated;
GRANT SELECT (
  id,
  user_id,
  display_name,
  last_severity,
  last_active_at,
  created_at,
  updated_at
)
ON public.students
TO authenticated;

REVOKE INSERT, UPDATE, DELETE
ON TABLE public.sessions
FROM authenticated;
GRANT INSERT (
  student_id,
  session_title,
  session_group,
  last_severity
)
ON public.sessions
TO authenticated;
GRANT UPDATE (
  session_title,
  session_group,
  last_severity
)
ON public.sessions
TO authenticated;

REVOKE INSERT, UPDATE, DELETE
ON TABLE public.timeline_items
FROM authenticated;
GRANT INSERT (
  session_id,
  kind,
  text,
  severity,
  tag,
  author_id
)
ON public.timeline_items
TO authenticated;

CREATE POLICY "students read own or active staff"
ON public.students
FOR SELECT
TO authenticated
USING (
  user_id = auth.uid()
  OR public.has_active_role(
    auth.uid(),
    'mentor'::public.app_role
  )
  OR public.has_active_role(
    auth.uid(),
    'team_admin'::public.app_role
  )
);

CREATE POLICY "sessions read own or active staff"
ON public.sessions
FOR SELECT
TO authenticated
USING (
  public.has_active_role(
    auth.uid(),
    'mentor'::public.app_role
  )
  OR public.has_active_role(
    auth.uid(),
    'team_admin'::public.app_role
  )
  OR EXISTS (
    SELECT 1
    FROM public.students AS student
    WHERE student.id = sessions.student_id
      AND student.user_id = auth.uid()
  )
);

CREATE POLICY "sessions owner insert web only"
ON public.sessions
FOR INSERT
TO authenticated
WITH CHECK (
  source = 'web'
  AND source_session_key IS NULL
  AND EXISTS (
    SELECT 1
    FROM public.students AS student
    WHERE student.id = sessions.student_id
      AND student.user_id = auth.uid()
  )
);

CREATE POLICY "sessions owner update web only"
ON public.sessions
FOR UPDATE
TO authenticated
USING (
  source = 'web'
  AND source_session_key IS NULL
  AND EXISTS (
    SELECT 1
    FROM public.students AS student
    WHERE student.id = sessions.student_id
      AND student.user_id = auth.uid()
  )
)
WITH CHECK (
  source = 'web'
  AND source_session_key IS NULL
  AND EXISTS (
    SELECT 1
    FROM public.students AS student
    WHERE student.id = sessions.student_id
      AND student.user_id = auth.uid()
  )
);

CREATE POLICY "timeline read own or active staff"
ON public.timeline_items
FOR SELECT
TO authenticated
USING (
  public.has_active_role(
    auth.uid(),
    'mentor'::public.app_role
  )
  OR public.has_active_role(
    auth.uid(),
    'team_admin'::public.app_role
  )
  OR EXISTS (
    SELECT 1
    FROM public.sessions AS target_session
    JOIN public.students AS student
      ON student.id = target_session.student_id
    WHERE target_session.id = timeline_items.session_id
      AND student.user_id = auth.uid()
  )
);

CREATE POLICY "timeline student insert without provenance"
ON public.timeline_items
FOR INSERT
TO authenticated
WITH CHECK (
  author_id = auth.uid()
  AND kind IN (
    'prompt'::public.timeline_kind,
    'reply'::public.timeline_kind,
    'diagnosis'::public.timeline_kind
  )
  AND source_event_id IS NULL
  AND event_ordinal IS NULL
  AND author_username IS NULL
  AND EXISTS (
    SELECT 1
    FROM public.sessions AS target_session
    JOIN public.students AS student
      ON student.id = target_session.student_id
    WHERE target_session.id = timeline_items.session_id
      AND student.user_id = auth.uid()
  )
);

CREATE POLICY "timeline active staff mentor insert"
ON public.timeline_items
FOR INSERT
TO authenticated
WITH CHECK (
  author_id = auth.uid()
  AND kind = 'mentor'::public.timeline_kind
  AND source_event_id IS NULL
  AND event_ordinal IS NULL
  AND (
    public.has_active_role(
      auth.uid(),
      'mentor'::public.app_role
    )
    OR public.has_active_role(
      auth.uid(),
      'team_admin'::public.app_role
    )
  )
);

CREATE POLICY "staff accounts read own or active team admin"
ON public.staff_accounts
FOR SELECT
TO authenticated
USING (
  user_id = auth.uid()
  OR public.has_active_role(
    auth.uid(),
    'team_admin'::public.app_role
  )
);

CREATE POLICY "ingest events read own or active staff"
ON public.workbuddy_ingest_events
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.students AS student
    WHERE student.id = workbuddy_ingest_events.student_id
      AND student.user_id = auth.uid()
  )
  OR public.has_active_role(
    auth.uid(),
    'mentor'::public.app_role
  )
  OR public.has_active_role(
    auth.uid(),
    'team_admin'::public.app_role
  )
);

CREATE POLICY "mentor deliveries read own or active staff"
ON public.mentor_message_deliveries
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.students AS student
    WHERE student.id = mentor_message_deliveries.student_id
      AND student.user_id = auth.uid()
  )
  OR public.has_active_role(
    auth.uid(),
    'mentor'::public.app_role
  )
  OR public.has_active_role(
    auth.uid(),
    'team_admin'::public.app_role
  )
);

GRANT SELECT ON TABLE public.staff_accounts TO authenticated;
GRANT SELECT ON TABLE public.workbuddy_ingest_events TO authenticated;
GRANT SELECT ON TABLE public.mentor_message_deliveries TO authenticated;
