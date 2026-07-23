-- Task 6: persistent mentor delivery plus one-time, hash-only credentials.
-- There is no production learner data to preserve, so the temporary plaintext
-- compatibility surface is removed instead of carrying it into deployment.

DROP FUNCTION IF EXISTS public.get_my_legacy_workbuddy_setup();
REVOKE SELECT ON TABLE public.students FROM authenticated;
ALTER TABLE public.students
  DROP COLUMN IF EXISTS workbuddy_token;
-- The table is safe to expose through its existing RLS policies once the only
-- plaintext credential column is gone. Preserve the learner/mentor UI reads.
GRANT SELECT ON TABLE public.students TO authenticated;

DELETE FROM public.workbuddy_credentials
WHERE source = 'legacy_token_backfill';

ALTER TABLE public.workbuddy_credentials
  DROP CONSTRAINT IF EXISTS workbuddy_credentials_source_check,
  ADD CONSTRAINT workbuddy_credentials_source_check
    CHECK (source = 'issued');

CREATE UNIQUE INDEX workbuddy_credentials_one_active_per_student
  ON public.workbuddy_credentials (student_id)
  WHERE status = 'active';

-- PostgreSQL char_length counts Unicode characters rather than UTF-8 bytes.
-- Keep the 8000 boundary in sync with MENTOR_MESSAGE_MAX_CHARACTERS.
ALTER TABLE public.timeline_items
  DROP CONSTRAINT IF EXISTS timeline_items_mentor_text_length_check,
  ADD CONSTRAINT timeline_items_mentor_text_length_check
    CHECK (
      kind <> 'mentor'::public.timeline_kind
      OR pg_catalog.char_length(text) BETWEEN 1 AND 8000
    );

COMMENT ON CONSTRAINT timeline_items_mentor_text_length_check
  ON public.timeline_items
  IS 'Mentor timeline content is limited to 8000 Unicode characters.';

-- Every mentor_message_deliveries INSERT/UPDATE path takes this transaction
-- lock before any row lock or write. One namespace and one student UUID make
-- fetch, ack, web-seen, trigger inserts, and direct service-role writes agree.
CREATE OR REPLACE FUNCTION private.lock_workbuddy_delivery_student(
  _student_id uuid
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $function$
BEGIN
  IF _student_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22004',
      MESSAGE = 'workbuddy_delivery_student_required';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'workbuddy-delivery-student:' || _student_id::text,
      0
    )
  );
END;
$function$;

REVOKE ALL ON FUNCTION private.lock_workbuddy_delivery_student(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA private TO service_role;
GRANT EXECUTE ON FUNCTION private.lock_workbuddy_delivery_student(uuid)
  TO service_role;

-- Replaces the Task 5 trigger body. This is the shared authenticated web/MCP
-- write boundary for mentor timeline content and author snapshots.
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

  IF NEW.text IS NULL
    OR pg_catalog.char_length(NEW.text) NOT BETWEEN 1 AND 8000
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'mentor_message_text_length_invalid';
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

-- The existing BEFORE INSERT OR UPDATE trigger invokes this replacement for
-- every delivery write. UPDATE already owns the delivery row, so state-only
-- changes must not reach back to timeline rows and identity moves are denied.
CREATE OR REPLACE FUNCTION public.validate_mentor_delivery()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  timeline_item public.timeline_items%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.message_id IS DISTINCT FROM NEW.message_id
      OR OLD.student_id IS DISTINCT FROM NEW.student_id
      OR OLD.session_id IS DISTINCT FROM NEW.session_id
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'mentor_delivery_identity_immutable';
    END IF;

    RETURN NEW;
  END IF;

  PERFORM private.lock_workbuddy_delivery_student(NEW.student_id);

  SELECT item.*
  INTO timeline_item
  FROM public.timeline_items AS item
  WHERE item.id = NEW.message_id
  FOR UPDATE;

  IF FOUND
    AND (
      timeline_item.kind <> 'mentor'::public.timeline_kind
      OR pg_catalog.char_length(timeline_item.text) NOT BETWEEN 1 AND 8000
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'mentor_delivery_message_invalid';
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.validate_mentor_delivery()
  FROM PUBLIC, anon, authenticated;

-- The existing AFTER timeline trigger invokes this replacement. It acquires
-- the student lock before issuing the delivery INSERT statement.
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

  PERFORM private.lock_workbuddy_delivery_student(target_session.student_id);

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

  IF pg_catalog.char_length(_text) > 8000 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'mentor_message_text_length_invalid';
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

CREATE OR REPLACE FUNCTION public.mark_mentor_messages_web_seen(
  _message_ids uuid[]
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  resolved_student_id uuid;
  updated_count integer;
BEGIN
  IF _message_ids IS NULL
    OR COALESCE(pg_catalog.array_length(_message_ids, 1), 0) = 0
  THEN
    RETURN 0;
  END IF;

  SELECT student.id
  INTO resolved_student_id
  FROM public.students AS student
  WHERE student.user_id = auth.uid();

  IF resolved_student_id IS NULL THEN
    RETURN 0;
  END IF;

  PERFORM private.lock_workbuddy_delivery_student(resolved_student_id);

  UPDATE public.mentor_message_deliveries AS delivery
  SET web_seen_at = COALESCE(
    delivery.web_seen_at,
    pg_catalog.now()
  )
  WHERE delivery.student_id = resolved_student_id
    AND delivery.web_seen_at IS NULL
    AND delivery.message_id = ANY (_message_ids);

  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$function$;

REVOKE ALL ON FUNCTION public.mark_mentor_messages_web_seen(uuid[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_mentor_messages_web_seen(uuid[])
  TO authenticated;

CREATE OR REPLACE FUNCTION private.workbuddy_student_for_user(
  _user_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  resolved_student_id uuid;
BEGIN
  IF _user_id IS NULL
    OR EXISTS (
      SELECT 1
      FROM public.user_roles AS staff_role
      WHERE staff_role.user_id = _user_id
        AND staff_role.role IN (
          'mentor'::public.app_role,
          'team_admin'::public.app_role
        )
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'student_identity_required';
  END IF;

  SELECT student.id
  INTO resolved_student_id
  FROM public.students AS student
  JOIN public.user_roles AS student_role
    ON student_role.user_id = student.user_id
   AND student_role.role = 'student'::public.app_role
  WHERE student.user_id = _user_id;

  IF resolved_student_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'student_identity_required';
  END IF;

  RETURN resolved_student_id;
END;
$function$;

REVOKE ALL ON FUNCTION private.workbuddy_student_for_user(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA private TO service_role;
GRANT EXECUTE ON FUNCTION private.workbuddy_student_for_user(uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION public.get_workbuddy_credential_status(
  _user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  resolved_student_id uuid;
  credential public.workbuddy_credentials%ROWTYPE;
BEGIN
  resolved_student_id := private.workbuddy_student_for_user(_user_id);

  SELECT candidate.*
  INTO credential
  FROM public.workbuddy_credentials AS candidate
  WHERE candidate.student_id = resolved_student_id
  ORDER BY
    (candidate.status = 'active') DESC,
    candidate.created_at DESC,
    candidate.id DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'none',
      'credential', NULL
    );
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'status', credential.status,
    'credential', pg_catalog.jsonb_build_object(
      'prefix', credential.token_prefix,
      'status', credential.status,
      'created_at', credential.created_at,
      'last_used_at', credential.last_used_at,
      'revoked_at', credential.revoked_at
    )
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_workbuddy_credential_status(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_workbuddy_credential_status(uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION public.issue_workbuddy_credential(
  _user_id uuid,
  _token_hash text,
  _token_prefix text,
  _rotate boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  resolved_student_id uuid;
  issued_at timestamptz;
BEGIN
  IF _token_hash IS NULL
    OR _token_hash !~ '^[0-9a-f]{64}$'
    OR _token_prefix IS NULL
    OR _token_prefix IS DISTINCT FROM pg_catalog.btrim(_token_prefix)
    OR pg_catalog.char_length(_token_prefix) NOT BETWEEN 4 AND 24
    OR _token_prefix !~ '^wb_[A-Za-z0-9_-]+$'
    OR _rotate IS NULL
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'invalid_workbuddy_credential_material';
  END IF;

  resolved_student_id := private.workbuddy_student_for_user(_user_id);
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'workbuddy-credential:' || resolved_student_id::text,
      0
    )
  );

  IF _rotate THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public.workbuddy_credentials AS existing
      WHERE existing.student_id = resolved_student_id
        AND existing.status = 'active'
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P4091',
        MESSAGE = 'workbuddy_active_credential_required';
    END IF;

    UPDATE public.workbuddy_credentials
    SET
      status = 'revoked',
      revoked_at = COALESCE(revoked_at, pg_catalog.now())
    WHERE student_id = resolved_student_id
      AND status = 'active';
  ELSIF EXISTS (
    SELECT 1
    FROM public.workbuddy_credentials AS existing
    WHERE existing.student_id = resolved_student_id
      AND existing.status = 'active'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P4090',
      MESSAGE = 'workbuddy_active_credential_exists';
  END IF;

  INSERT INTO public.workbuddy_credentials (
    student_id,
    token_hash,
    token_prefix,
    source,
    status
  )
  VALUES (
    resolved_student_id,
    _token_hash,
    _token_prefix,
    'issued',
    'active'
  )
  RETURNING created_at INTO issued_at;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'active',
    'credential', pg_catalog.jsonb_build_object(
      'prefix', _token_prefix,
      'status', 'active',
      'created_at', issued_at,
      'last_used_at', NULL,
      'revoked_at', NULL
    )
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.issue_workbuddy_credential(
  uuid,
  text,
  text,
  boolean
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.issue_workbuddy_credential(
  uuid,
  text,
  text,
  boolean
) TO service_role;

CREATE OR REPLACE FUNCTION public.revoke_workbuddy_credential(
  _user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  resolved_student_id uuid;
  credential public.workbuddy_credentials%ROWTYPE;
BEGIN
  resolved_student_id := private.workbuddy_student_for_user(_user_id);
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'workbuddy-credential:' || resolved_student_id::text,
      0
    )
  );

  UPDATE public.workbuddy_credentials
  SET
    status = 'revoked',
    revoked_at = COALESCE(revoked_at, pg_catalog.now())
  WHERE student_id = resolved_student_id
    AND status = 'active';

  SELECT candidate.*
  INTO credential
  FROM public.workbuddy_credentials AS candidate
  WHERE candidate.student_id = resolved_student_id
  ORDER BY candidate.created_at DESC, candidate.id DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'none',
      'credential', NULL
    );
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'status', credential.status,
    'credential', pg_catalog.jsonb_build_object(
      'prefix', credential.token_prefix,
      'status', credential.status,
      'created_at', credential.created_at,
      'last_used_at', credential.last_used_at,
      'revoked_at', credential.revoked_at
    )
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.revoke_workbuddy_credential(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_workbuddy_credential(uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION public.fetch_workbuddy_mentor_messages(
  _student_id uuid,
  _session_id uuid DEFAULT NULL,
  _limit integer DEFAULT 50,
  _cursor_created_at timestamptz DEFAULT NULL,
  _cursor_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  result jsonb;
BEGIN
  IF _student_id IS NULL
    OR _limit IS NULL
    OR _limit NOT BETWEEN 1 AND 100
    OR ((_cursor_created_at IS NULL) <> (_cursor_id IS NULL))
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'invalid_workbuddy_delivery_query';
  END IF;

  PERFORM private.lock_workbuddy_delivery_student(_student_id);

  IF _session_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM public.sessions AS target_session
      WHERE target_session.id = _session_id
        AND target_session.student_id = _student_id
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P4041',
      MESSAGE = 'workbuddy_session_not_owned';
  END IF;

  -- The constraint prevents new invalid writes. This guard makes a manually
  -- corrupted/legacy row fail closed instead of leaking or being skipped.
  IF EXISTS (
    SELECT 1
    FROM public.mentor_message_deliveries AS delivery
    JOIN public.timeline_items AS item
      ON item.id = delivery.message_id
     AND item.session_id = delivery.session_id
    JOIN public.sessions AS target_session
      ON target_session.id = delivery.session_id
     AND target_session.student_id = delivery.student_id
    WHERE delivery.student_id = _student_id
      AND target_session.student_id = _student_id
      AND delivery.acknowledged_at IS NULL
      AND item.kind = 'mentor'::public.timeline_kind
      AND pg_catalog.char_length(item.text) NOT BETWEEN 1 AND 8000
      AND (_session_id IS NULL OR delivery.session_id = _session_id)
      AND (
        _cursor_created_at IS NULL
        OR (item.created_at, item.id) > (_cursor_created_at, _cursor_id)
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'mentor_message_text_length_invalid';
  END IF;

  WITH candidates AS MATERIALIZED (
    SELECT
      delivery.message_id,
      item.created_at
    FROM public.mentor_message_deliveries AS delivery
    JOIN public.timeline_items AS item
      ON item.id = delivery.message_id
     AND item.session_id = delivery.session_id
    JOIN public.sessions AS target_session
      ON target_session.id = delivery.session_id
     AND target_session.student_id = delivery.student_id
    WHERE delivery.student_id = _student_id
      AND target_session.student_id = _student_id
      AND delivery.acknowledged_at IS NULL
      AND item.kind = 'mentor'::public.timeline_kind
      AND (_session_id IS NULL OR delivery.session_id = _session_id)
      AND (
        _cursor_created_at IS NULL
        OR (item.created_at, item.id) > (_cursor_created_at, _cursor_id)
      )
    ORDER BY item.created_at, item.id
    LIMIT _limit
    -- Lock only delivery rows. Joined timeline/session rows remain MVCC reads,
    -- so a parent cascade can wait here without creating a reverse lock edge.
    FOR UPDATE OF delivery
  ),
  fetched AS (
    UPDATE public.mentor_message_deliveries AS delivery
    SET
      first_fetched_at = COALESCE(
        delivery.first_fetched_at,
        pg_catalog.now()
      ),
      last_fetched_at = pg_catalog.now(),
      fetch_count = delivery.fetch_count + 1
    FROM candidates
    WHERE delivery.message_id = candidates.message_id
    RETURNING
      delivery.message_id,
      delivery.student_id,
      delivery.session_id,
      delivery.first_fetched_at,
      delivery.last_fetched_at,
      delivery.fetch_count,
      delivery.acknowledged_at
  )
  SELECT pg_catalog.jsonb_build_object(
    'messages',
    COALESCE(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', item.id,
          'student_id', fetched.student_id,
          'session_id', item.session_id,
          'text', item.text,
          'author_username', item.author_username,
          'created_at', item.created_at,
          'first_fetched_at', fetched.first_fetched_at,
          'last_fetched_at', fetched.last_fetched_at,
          'fetch_count', fetched.fetch_count,
          'acknowledged_at', fetched.acknowledged_at
        )
        ORDER BY item.created_at, item.id
      ),
      '[]'::jsonb
    )
  )
  INTO result
  FROM fetched
  JOIN public.timeline_items AS item
    ON item.id = fetched.message_id
   AND item.session_id = fetched.session_id;

  RETURN result;
END;
$function$;

REVOKE ALL ON FUNCTION public.fetch_workbuddy_mentor_messages(
  uuid,
  uuid,
  integer,
  timestamptz,
  uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fetch_workbuddy_mentor_messages(
  uuid,
  uuid,
  integer,
  timestamptz,
  uuid
) TO service_role;

CREATE OR REPLACE FUNCTION public.ack_workbuddy_mentor_messages(
  _student_id uuid,
  _message_ids uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  owned_count integer;
  result jsonb;
BEGIN
  IF _student_id IS NULL
    OR _message_ids IS NULL
    OR pg_catalog.cardinality(_message_ids) NOT BETWEEN 1 AND 100
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.unnest(_message_ids) AS requested(message_id)
      WHERE requested.message_id IS NULL
    )
    OR pg_catalog.cardinality(_message_ids) <> (
      SELECT pg_catalog.count(DISTINCT requested.message_id)
      FROM pg_catalog.unnest(_message_ids) AS requested(message_id)
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P4040',
      MESSAGE = 'workbuddy_delivery_not_owned';
  END IF;

  PERFORM private.lock_workbuddy_delivery_student(_student_id);

  PERFORM 1
  FROM public.mentor_message_deliveries AS delivery
  WHERE delivery.message_id = ANY (_message_ids)
    AND delivery.student_id = _student_id
  ORDER BY delivery.message_id
  FOR UPDATE;

  SELECT pg_catalog.count(*)
  INTO owned_count
  FROM public.mentor_message_deliveries AS delivery
  WHERE delivery.message_id = ANY (_message_ids)
    AND delivery.student_id = _student_id;

  IF owned_count <> pg_catalog.cardinality(_message_ids) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P4040',
      MESSAGE = 'workbuddy_delivery_not_owned';
  END IF;

  WITH acknowledged AS (
    UPDATE public.mentor_message_deliveries AS delivery
    SET acknowledged_at = COALESCE(
      delivery.acknowledged_at,
      pg_catalog.now()
    )
    WHERE delivery.message_id = ANY (_message_ids)
      AND delivery.student_id = _student_id
    RETURNING delivery.message_id, delivery.acknowledged_at
  )
  SELECT pg_catalog.jsonb_build_object(
    'acknowledged',
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', acknowledged.message_id,
        'acknowledged_at', acknowledged.acknowledged_at
      )
      ORDER BY acknowledged.message_id
    )
  )
  INTO result
  FROM acknowledged;

  RETURN result;
END;
$function$;

REVOKE ALL ON FUNCTION public.ack_workbuddy_mentor_messages(uuid, uuid[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ack_workbuddy_mentor_messages(uuid, uuid[])
  TO service_role;

-- All production delivery writes now pass through the pre-locking trigger or
-- the service-role-only SECURITY DEFINER RPCs above. Closing direct DML avoids
-- a caller taking a row lock before it can take the student advisory lock.
REVOKE ALL ON TABLE public.mentor_message_deliveries FROM service_role;
GRANT SELECT ON TABLE public.mentor_message_deliveries TO service_role;
