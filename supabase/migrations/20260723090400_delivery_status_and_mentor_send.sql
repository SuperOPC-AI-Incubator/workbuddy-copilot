-- Task 9 strengthens mentor message creation: the trusted server supplies only
-- the verified bearer actor and session. The student target is derived here.
-- The existing AFTER INSERT trigger create_mentor_delivery runs in this same
-- transaction, so a delivery failure rolls the timeline insert back.
DROP FUNCTION IF EXISTS public.create_mentor_message(
  uuid,
  uuid,
  uuid,
  text,
  public.severity
);

CREATE OR REPLACE FUNCTION public.create_mentor_message(
  _author_user_id uuid,
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
  target_session public.sessions%ROWTYPE;
  trusted_author_username text;
  created_message_id uuid;
BEGIN
  SELECT staff.username
  INTO trusted_author_username
  FROM public.staff_accounts AS staff
  WHERE staff.user_id = _author_user_id
    AND staff.is_active = true
    AND staff.must_change_password = false
    AND EXISTS (
      SELECT 1
      FROM public.user_roles AS staff_role
      WHERE staff_role.user_id = staff.user_id
        AND staff_role.role IN (
          'mentor'::public.app_role,
          'team_admin'::public.app_role
        )
    )
  FOR SHARE OF staff;

  IF trusted_author_username IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'active_staff_account_required';
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

  SELECT session_row.*
  INTO target_session
  FROM public.sessions AS session_row
  WHERE session_row.id = _session_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'mentor_message_target_not_found';
  END IF;

  INSERT INTO public.timeline_items (
    session_id,
    kind,
    text,
    severity,
    author_id
  )
  VALUES (
    target_session.id,
    'mentor'::public.timeline_kind,
    _text,
    _severity,
    _author_user_id
  )
  RETURNING id INTO created_message_id;

  RETURN pg_catalog.jsonb_build_object(
    'message_id', created_message_id,
    'student_id', target_session.student_id,
    'session_id', target_session.id,
    'delivery_state', 'pending'
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.create_mentor_message(
  uuid,
  uuid,
  text,
  public.severity
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_mentor_message(
  uuid,
  uuid,
  text,
  public.severity
) TO service_role;

-- AI reply and optional diagnosis must appear together. The browser supplies
-- neither a student id nor a trusted author: the verified bearer actor is
-- checked against the session, then the service-only RPC performs both writes
-- in one transaction.
CREATE OR REPLACE FUNCTION public.create_ai_response(
  _actor_user_id uuid,
  _session_id uuid,
  _reply text,
  _diagnosis_text text,
  _diagnosis_severity public.severity,
  _tag text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  actor_student_id uuid;
  resolved_session_id uuid;
  reply_item_id uuid;
  diagnosis_item_id uuid;
  clean_tag text;
BEGIN
  SELECT student.id
  INTO actor_student_id
  FROM public.students AS student
  WHERE student.user_id = _actor_user_id;

  IF actor_student_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'student_actor_required';
  END IF;

  SELECT target_session.id
  INTO resolved_session_id
  FROM public.sessions AS target_session
  WHERE target_session.id = _session_id
    AND target_session.student_id = actor_student_id;

  IF resolved_session_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'student_session_required';
  END IF;

  IF _reply IS NULL
    OR pg_catalog.btrim(_reply) = ''
    OR pg_catalog.char_length(_reply) > 8000
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'ai_reply_invalid';
  END IF;

  IF (
    _diagnosis_text IS NULL
    AND _diagnosis_severity IS NOT NULL
  ) OR (
    _diagnosis_text IS NOT NULL
    AND (
      _diagnosis_severity IS NULL
      OR pg_catalog.btrim(_diagnosis_text) = ''
      OR pg_catalog.char_length(_diagnosis_text) > 8000
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'ai_diagnosis_invalid';
  END IF;

  clean_tag := NULLIF(pg_catalog.btrim(_tag), '');
  IF clean_tag IS NOT NULL AND pg_catalog.char_length(clean_tag) > 60 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'ai_tag_invalid';
  END IF;

  INSERT INTO public.timeline_items (
    session_id,
    kind,
    text,
    tag,
    author_id
  )
  VALUES (
    resolved_session_id,
    'reply'::public.timeline_kind,
    _reply,
    clean_tag,
    _actor_user_id
  )
  RETURNING id INTO reply_item_id;

  IF _diagnosis_text IS NOT NULL THEN
    INSERT INTO public.timeline_items (
      session_id,
      kind,
      text,
      severity,
      author_id
    )
    VALUES (
      resolved_session_id,
      'diagnosis'::public.timeline_kind,
      _diagnosis_text,
      _diagnosis_severity,
      _actor_user_id
    )
    RETURNING id INTO diagnosis_item_id;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'session_id', resolved_session_id,
    'reply_item_id', reply_item_id,
    'diagnosis_item_id', diagnosis_item_id
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.create_ai_response(
  uuid,
  uuid,
  text,
  text,
  public.severity,
  text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_ai_response(
  uuid,
  uuid,
  text,
  text,
  public.severity,
  text
) TO service_role;

-- One service-only call returns timeline rows and their optional delivery row
-- from one left-joined statement, avoiding mixed snapshots at the UI boundary.
CREATE OR REPLACE FUNCTION public.get_timeline_delivery_snapshot(
  _actor_user_id uuid,
  _session_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  actor_can_read boolean;
  snapshot jsonb;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM public.sessions AS target_session
    JOIN public.students AS target_student
      ON target_student.id = target_session.student_id
    WHERE target_session.id = _session_id
      AND (
        target_student.user_id = _actor_user_id
        OR EXISTS (
          SELECT 1
          FROM public.staff_accounts AS staff
          JOIN public.user_roles AS staff_role
            ON staff_role.user_id = staff.user_id
          WHERE staff.user_id = _actor_user_id
            AND staff.is_active = true
            AND staff.must_change_password = false
            AND staff_role.role IN (
              'mentor'::public.app_role,
              'team_admin'::public.app_role
            )
        )
      )
  )
  INTO actor_can_read;

  IF NOT actor_can_read THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'timeline_snapshot_forbidden';
  END IF;

  SELECT pg_catalog.jsonb_build_object(
    'session_id',
    _session_id,
    'items',
    COALESCE(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'timeline',
          pg_catalog.jsonb_build_object(
            'id', item.id,
            'session_id', item.session_id,
            'kind', item.kind,
            'text', item.text,
            'severity', item.severity,
            'tag', item.tag,
            'author_username', item.author_username,
            'created_at', item.created_at
          ),
          'delivery',
          CASE
            WHEN delivery.message_id IS NULL THEN NULL
            ELSE pg_catalog.jsonb_build_object(
              'message_id', delivery.message_id,
              'session_id', delivery.session_id,
              'first_fetched_at', delivery.first_fetched_at,
              'last_fetched_at', delivery.last_fetched_at,
              'fetch_count', delivery.fetch_count,
              'acknowledged_at', delivery.acknowledged_at,
              'web_seen_at', delivery.web_seen_at,
              'failure_count', delivery.failure_count,
              'last_error_code', delivery.last_error_code
            )
          END
        )
        ORDER BY item.created_at, item.id
      ),
      '[]'::jsonb
    )
  )
  INTO snapshot
  FROM public.timeline_items AS item
  LEFT JOIN public.mentor_message_deliveries AS delivery
    ON delivery.message_id = item.id
    AND delivery.session_id = item.session_id
  WHERE item.session_id = _session_id;

  RETURN snapshot;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_timeline_delivery_snapshot(
  uuid,
  uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_timeline_delivery_snapshot(
  uuid,
  uuid
) TO service_role;
