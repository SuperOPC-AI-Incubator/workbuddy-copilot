BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions, pg_catalog;

SELECT plan(36);

CREATE TEMP TABLE cloud_test_results (
  label text PRIMARY KEY,
  result jsonb NOT NULL
) ON COMMIT DROP;

GRANT SELECT, INSERT, UPDATE ON TABLE cloud_test_results
TO service_role, authenticated;

-- A public signup may request a privileged role in user metadata, but the Auth
-- trigger must always provision only a student.
INSERT INTO auth.users (
  id,
  email,
  raw_user_meta_data,
  raw_app_meta_data
)
VALUES (
  '10000000-0000-0000-0000-000000000001'::uuid,
  'student-one@example.invalid',
  '{"display_name":"Student One","role":"team_admin"}'::jsonb,
  '{}'::jsonb
);

SELECT ok(
  (
    EXISTS (
      SELECT 1
      FROM public.user_roles
      WHERE user_id = '10000000-0000-0000-0000-000000000001'::uuid
        AND role = 'student'::public.app_role
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.user_roles
      WHERE user_id = '10000000-0000-0000-0000-000000000001'::uuid
        AND role IN (
          'mentor'::public.app_role,
          'team_admin'::public.app_role
        )
    )
    AND EXISTS (
      SELECT 1
      FROM public.students
      WHERE user_id = '10000000-0000-0000-0000-000000000001'::uuid
    )
  ),
  'public signup role metadata cannot self-promote'
);

-- Auth users created through the trusted staff path are intentionally left for
-- the service-only provision_staff_account RPC.
INSERT INTO auth.users (
  id,
  email,
  raw_user_meta_data,
  raw_app_meta_data
)
VALUES (
  '10000000-0000-0000-0000-000000000100'::uuid,
  'trusted-staff@example.invalid',
  '{"display_name":"Should Not Become Student","role":"student"}'::jsonb,
  '{"account_kind":"staff"}'::jsonb
);

SELECT ok(
  (
    NOT EXISTS (
      SELECT 1
      FROM public.user_roles
      WHERE user_id = '10000000-0000-0000-0000-000000000100'::uuid
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.students
      WHERE user_id = '10000000-0000-0000-0000-000000000100'::uuid
    )
  ),
  'trusted staff Auth creation skips student provisioning'
);

INSERT INTO auth.users (id, email, raw_app_meta_data)
VALUES
  (
    '10000000-0000-0000-0000-000000000101'::uuid,
    'active-mentor@example.invalid',
    '{"account_kind":"staff"}'::jsonb
  ),
  (
    '10000000-0000-0000-0000-000000000102'::uuid,
    'disabled-mentor@example.invalid',
    '{"account_kind":"staff"}'::jsonb
  ),
  (
    '10000000-0000-0000-0000-000000000103'::uuid,
    'must-change-mentor@example.invalid',
    '{"account_kind":"staff"}'::jsonb
  );

SET LOCAL ROLE service_role;

DO $setup$
BEGIN
  PERFORM public.provision_staff_account(
    _user_id => '10000000-0000-0000-0000-000000000101'::uuid,
    _username => 'Active.Mentor',
    _auth_identity_version => 1,
    _is_team_admin => true
  );
  PERFORM public.provision_staff_account(
    _user_id => '10000000-0000-0000-0000-000000000102'::uuid,
    _username => 'Disabled.Mentor',
    _auth_identity_version => 1
  );
  PERFORM public.provision_staff_account(
    _user_id => '10000000-0000-0000-0000-000000000103'::uuid,
    _username => 'Must.Change',
    _auth_identity_version => 1
  );
END;
$setup$;

UPDATE public.staff_accounts
SET must_change_password = false
WHERE user_id IN (
  '10000000-0000-0000-0000-000000000101'::uuid,
  '10000000-0000-0000-0000-000000000102'::uuid
);

UPDATE public.staff_accounts
SET
  is_active = false,
  disabled_at = pg_catalog.now()
WHERE user_id = '10000000-0000-0000-0000-000000000102'::uuid;

RESET ROLE;

SELECT ok(
  public.has_active_role(
    '10000000-0000-0000-0000-000000000001'::uuid,
    'student'::public.app_role
  ),
  'student role does not require a staff account'
);
SELECT ok(
  public.has_active_role(
    '10000000-0000-0000-0000-000000000101'::uuid,
    'mentor'::public.app_role
  )
  AND public.has_active_role(
    '10000000-0000-0000-0000-000000000101'::uuid,
    'team_admin'::public.app_role
  ),
  'active staff with completed password change has assigned roles'
);
SELECT ok(
  NOT public.has_active_role(
    '10000000-0000-0000-0000-000000000102'::uuid,
    'mentor'::public.app_role
  ),
  'disabled staff loses role access immediately'
);
SELECT ok(
  NOT public.has_active_role(
    '10000000-0000-0000-0000-000000000103'::uuid,
    'mentor'::public.app_role
  ),
  'staff awaiting password change has no active role'
);

SET LOCAL ROLE service_role;

INSERT INTO cloud_test_results (label, result)
SELECT
  'first_ingest',
  public.ingest_workbuddy_turn(
    _event_id => '20000000-0000-0000-0000-000000000001'::uuid,
    _student_id => (
      SELECT id
      FROM public.students
      WHERE user_id = '10000000-0000-0000-0000-000000000001'::uuid
    ),
    _source => 'mcp',
    _source_session_key => 'source-session-one',
    _session_title => 'Shared title',
    _payload_sha256 => repeat('a', 64),
    _prompt => 'Deterministic prompt one',
    _reply => 'Deterministic reply one'
  );

INSERT INTO cloud_test_results (label, result)
SELECT
  'duplicate_ingest',
  public.ingest_workbuddy_turn(
    _event_id => '20000000-0000-0000-0000-000000000001'::uuid,
    _student_id => (
      SELECT id
      FROM public.students
      WHERE user_id = '10000000-0000-0000-0000-000000000001'::uuid
    ),
    _source => 'mcp',
    _source_session_key => 'source-session-one',
    _session_title => 'Shared title',
    _payload_sha256 => repeat('a', 64),
    _prompt => 'Deterministic prompt one',
    _reply => 'Deterministic reply one'
  );

SELECT ok(
  (
    SELECT
      first_result.result - 'duplicate'
        = duplicate_result.result - 'duplicate'
      AND duplicate_result.result ->> 'duplicate' = 'true'
    FROM cloud_test_results AS first_result
    JOIN cloud_test_results AS duplicate_result
      ON duplicate_result.label = 'duplicate_ingest'
    WHERE first_result.label = 'first_ingest'
  ),
  'same event and hash returns the stable stored ids with duplicate=true'
);

SELECT is(
  (
    SELECT count(*)
    FROM public.timeline_items
    WHERE source_event_id = '20000000-0000-0000-0000-000000000001'::uuid
  ),
  2::bigint,
  'duplicate ingest does not create additional timeline rows'
);

SELECT throws_ok(
  $test$
    SELECT public.ingest_workbuddy_turn(
      _event_id => '20000000-0000-0000-0000-000000000001'::uuid,
      _student_id => (
        SELECT id
        FROM public.students
        WHERE user_id = '10000000-0000-0000-0000-000000000001'::uuid
      ),
      _source => 'mcp',
      _source_session_key => 'source-session-one',
      _session_title => 'Shared title',
      _payload_sha256 => repeat('b', 64),
      _prompt => 'Changed prompt',
      _reply => 'Changed reply'
    )
  $test$,
  'P4090',
  'workbuddy_event_conflict',
  'same event with a different hash raises the stable conflict'
);

INSERT INTO cloud_test_results (label, result)
SELECT
  'different_key',
  public.ingest_workbuddy_turn(
    _event_id => '20000000-0000-0000-0000-000000000002'::uuid,
    _student_id => (
      SELECT id
      FROM public.students
      WHERE user_id = '10000000-0000-0000-0000-000000000001'::uuid
    ),
    _source => 'mcp',
    _source_session_key => 'source-session-two',
    _session_title => 'Shared title',
    _payload_sha256 => repeat('c', 64),
    _prompt => 'Prompt for the second source key',
    _reply => 'Reply for the second source key'
  );

INSERT INTO cloud_test_results (label, result)
SELECT
  'same_key',
  public.ingest_workbuddy_turn(
    _event_id => '20000000-0000-0000-0000-000000000003'::uuid,
    _student_id => (
      SELECT id
      FROM public.students
      WHERE user_id = '10000000-0000-0000-0000-000000000001'::uuid
    ),
    _source => 'mcp',
    _source_session_key => 'source-session-one',
    _session_title => 'A changed title must not affect identity',
    _payload_sha256 => repeat('d', 64),
    _prompt => 'Prompt reusing the first source key',
    _reply => 'Reply reusing the first source key'
  );

SELECT isnt(
  (
    SELECT result ->> 'session_id'
    FROM cloud_test_results
    WHERE label = 'first_ingest'
  ),
  (
    SELECT result ->> 'session_id'
    FROM cloud_test_results
    WHERE label = 'different_key'
  ),
  'same title with different source keys creates different sessions'
);

SELECT is(
  (
    SELECT result ->> 'session_id'
    FROM cloud_test_results
    WHERE label = 'first_ingest'
  ),
  (
    SELECT result ->> 'session_id'
    FROM cloud_test_results
    WHERE label = 'same_key'
  ),
  'same student/source/key reuses the existing session regardless of title'
);

INSERT INTO cloud_test_results (label, result)
SELECT
  'student_one_message',
  public.create_mentor_message(
    _author_user_id => '10000000-0000-0000-0000-000000000101'::uuid,
    _student_id => (
      SELECT id
      FROM public.students
      WHERE user_id = '10000000-0000-0000-0000-000000000001'::uuid
    ),
    _session_id => (
      SELECT (result ->> 'session_id')::uuid
      FROM cloud_test_results
      WHERE label = 'first_ingest'
    ),
    _text => 'Deterministic mentor message',
    _severity => 'warn'::public.severity
  );

SELECT is(
  (
    SELECT item.author_username
    FROM public.timeline_items AS item
    JOIN cloud_test_results AS message_result
      ON item.id = (message_result.result ->> 'message_id')::uuid
    WHERE message_result.label = 'student_one_message'
  ),
  'Active.Mentor',
  'mentor message snapshots the current staff username'
);

SELECT ok(
  (
    SELECT
      delivery.first_fetched_at IS NULL
      AND delivery.last_fetched_at IS NULL
      AND delivery.fetch_count = 0
      AND delivery.acknowledged_at IS NULL
      AND delivery.web_seen_at IS NULL
      AND delivery.failure_count = 0
      AND message_result.result ->> 'delivery_state' = 'pending'
    FROM public.mentor_message_deliveries AS delivery
    JOIN cloud_test_results AS message_result
      ON delivery.message_id = (message_result.result ->> 'message_id')::uuid
    WHERE message_result.label = 'student_one_message'
  ),
  'mentor message atomically creates one pending delivery'
);

RESET ROLE;

INSERT INTO auth.users (
  id,
  email,
  raw_user_meta_data,
  raw_app_meta_data
)
VALUES (
  '10000000-0000-0000-0000-000000000002'::uuid,
  'student-two@example.invalid',
  '{"display_name":"Student Two"}'::jsonb,
  '{}'::jsonb
);

SET LOCAL ROLE service_role;

INSERT INTO cloud_test_results (label, result)
SELECT
  'student_two_ingest',
  public.ingest_workbuddy_turn(
    _event_id => '20000000-0000-0000-0000-000000000004'::uuid,
    _student_id => (
      SELECT id
      FROM public.students
      WHERE user_id = '10000000-0000-0000-0000-000000000002'::uuid
    ),
    _source => 'skill',
    _source_session_key => 'student-two-session',
    _session_title => 'Student two title',
    _payload_sha256 => repeat('e', 64),
    _prompt => 'Student two prompt',
    _reply => 'Student two reply'
  );

INSERT INTO cloud_test_results (label, result)
SELECT
  'student_two_message',
  public.create_mentor_message(
    _author_user_id => '10000000-0000-0000-0000-000000000101'::uuid,
    _student_id => (
      SELECT id
      FROM public.students
      WHERE user_id = '10000000-0000-0000-0000-000000000002'::uuid
    ),
    _session_id => (
      SELECT (result ->> 'session_id')::uuid
      FROM cloud_test_results
      WHERE label = 'student_two_ingest'
    ),
    _text => 'Student two mentor message'
  );

RESET ROLE;

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.workbuddy_credentials AS credential
    JOIN public.students AS student
      ON student.id = credential.student_id
    WHERE credential.token_hash = encode(
      extensions.digest(student.workbuddy_token, 'sha256'),
      'hex'
    )
      AND credential.source = 'legacy_token_backfill'
  ),
  'legacy plaintext tokens are idempotently backfilled as annotated hashes'
);

UPDATE public.students
SET workbuddy_token = ' x '
WHERE id = (
  SELECT id
  FROM public.students
  WHERE user_id IS NULL
  ORDER BY created_at
  LIMIT 1
);

INSERT INTO public.workbuddy_credentials (
  student_id,
  token_hash,
  token_prefix,
  source
)
SELECT
  student.id,
  encode(extensions.digest(student.workbuddy_token, 'sha256'), 'hex'),
  left(
    encode(extensions.digest(student.workbuddy_token, 'sha256'), 'hex'),
    8
  ),
  'legacy_token_backfill'
FROM public.students AS student
WHERE student.workbuddy_token = ' x '
ON CONFLICT (token_hash) DO NOTHING;

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.workbuddy_credentials AS credential
    JOIN public.students AS student
      ON student.id = credential.student_id
    WHERE student.workbuddy_token = ' x '
      AND credential.token_hash = encode(
        extensions.digest(student.workbuddy_token, 'sha256'),
        'hex'
      )
      AND credential.token_prefix = left(credential.token_hash, 8)
      AND credential.source = 'legacy_token_backfill'
  ),
  'short or whitespace legacy tokens backfill through a hash prefix'
);

SET LOCAL ROLE service_role;

SELECT throws_ok(
  $test$
    INSERT INTO public.sessions (
      student_id,
      session_title,
      source,
      source_session_key
    )
    VALUES (
      (
        SELECT id
        FROM public.students
        WHERE user_id = '10000000-0000-0000-0000-000000000001'::uuid
      ),
      'Overlong source key',
      'mcp',
      repeat('x', 256)
    )
  $test$,
  '23514',
  NULL,
  'source session key rejects more than 255 characters'
);

SELECT throws_ok(
  $test$
    INSERT INTO public.workbuddy_ingest_events (
      event_id,
      student_id,
      session_id,
      source,
      payload_sha256,
      client_created_at
    )
    VALUES (
      '20000000-0000-0000-0000-000000000010'::uuid,
      (
        SELECT id
        FROM public.students
        WHERE user_id = '10000000-0000-0000-0000-000000000001'::uuid
      ),
      (
        SELECT (result ->> 'session_id')::uuid
        FROM cloud_test_results
        WHERE label = 'student_two_ingest'
      ),
      'mcp',
      repeat('f', 64),
      pg_catalog.now()
    )
  $test$,
  '23503',
  NULL,
  'event rejects a session owned by another student'
);

SELECT throws_ok(
  $test$
    INSERT INTO public.timeline_items (
      session_id,
      kind,
      text,
      source_event_id,
      event_ordinal
    )
    VALUES (
      (
        SELECT (result ->> 'session_id')::uuid
        FROM cloud_test_results
        WHERE label = 'student_two_ingest'
      ),
      'diagnosis',
      'Cross-event mismatch',
      '20000000-0000-0000-0000-000000000001'::uuid,
      2
    )
  $test$,
  '23503',
  NULL,
  'timeline rejects a session that differs from its event'
);

SELECT throws_ok(
  $test$
    INSERT INTO public.mentor_message_deliveries (
      message_id,
      student_id,
      session_id
    )
    VALUES (
      (
        SELECT (result ->> 'message_id')::uuid
        FROM cloud_test_results
        WHERE label = 'student_one_message'
      ),
      (
        SELECT id
        FROM public.students
        WHERE user_id = '10000000-0000-0000-0000-000000000002'::uuid
      ),
      (
        SELECT (result ->> 'session_id')::uuid
        FROM cloud_test_results
        WHERE label = 'student_two_ingest'
      )
    )
  $test$,
  '23503',
  NULL,
  'delivery rejects a mismatched session or student'
);

SELECT throws_ok(
  $test$
    INSERT INTO public.mentor_message_deliveries (
      message_id,
      student_id,
      session_id
    )
    SELECT
      item.id,
      ingest_event.student_id,
      item.session_id
    FROM public.timeline_items AS item
    JOIN public.workbuddy_ingest_events AS ingest_event
      ON ingest_event.event_id = item.source_event_id
    WHERE item.source_event_id =
      '20000000-0000-0000-0000-000000000001'::uuid
      AND item.event_ordinal = 0
  $test$,
  '23514',
  'mentor_delivery_message_kind_required',
  'mentor delivery rejects a non-mentor timeline item'
);

SELECT throws_ok(
  $test$
    UPDATE public.timeline_items
    SET kind = 'diagnosis'
    WHERE id = (
      SELECT (result ->> 'message_id')::uuid
      FROM cloud_test_results
      WHERE label = 'student_one_message'
    )
  $test$,
  '23514',
  'delivered_mentor_kind_immutable',
  'delivered mentor timeline kind is immutable'
);

RESET ROLE;

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub = '10000000-0000-0000-0000-000000000101';

SELECT throws_ok(
  $test$
    SELECT workbuddy_token
    FROM public.students
    LIMIT 1
  $test$,
  '42501',
  NULL,
  'authenticated staff cannot select plaintext WorkBuddy tokens'
);

SELECT throws_ok(
  $test$
    SELECT public.get_my_legacy_workbuddy_setup()
  $test$,
  '42501',
  'student_identity_required',
  'authenticated staff cannot use the plaintext transition RPC'
);

WITH inserted_message AS (
  INSERT INTO public.timeline_items (
    session_id,
    kind,
    text,
    severity,
    author_id
  )
  VALUES (
    (
      SELECT (result ->> 'session_id')::uuid
      FROM cloud_test_results
      WHERE label = 'first_ingest'
    ),
    'mentor',
    'Direct mentor compatibility message',
    'warn',
    '10000000-0000-0000-0000-000000000101'::uuid
  )
  RETURNING id
)
INSERT INTO cloud_test_results (label, result)
SELECT
  'direct_mentor_message',
  pg_catalog.jsonb_build_object('message_id', id)
FROM inserted_message;

RESET ROLE;

SELECT ok(
  (
    SELECT
      item.author_username = 'Active.Mentor'
      AND delivery.message_id = item.id
      AND delivery.fetch_count = 0
      AND target_session.last_severity = 'warn'
      AND student.last_severity = 'warn'
      AND student.last_active_at >= item.created_at
    FROM public.timeline_items AS item
    JOIN public.mentor_message_deliveries AS delivery
      ON delivery.message_id = item.id
    JOIN public.sessions AS target_session
      ON target_session.id = item.session_id
    JOIN public.students AS student
      ON student.id = target_session.student_id
    JOIN cloud_test_results AS inserted
      ON item.id = (inserted.result ->> 'message_id')::uuid
    WHERE inserted.label = 'direct_mentor_message'
  ),
  'active staff direct insert derives username and delivery; active staff direct insert updates session and student aggregates'
);

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub = '10000000-0000-0000-0000-000000000102';

SELECT throws_ok(
  $test$
    INSERT INTO public.timeline_items (
      session_id,
      kind,
      text,
      author_id
    )
    VALUES (
      (
        SELECT (result ->> 'session_id')::uuid
        FROM cloud_test_results
        WHERE label = 'first_ingest'
      ),
      'mentor',
      'Disabled staff attempt',
      '10000000-0000-0000-0000-000000000102'::uuid
    )
  $test$,
  '42501',
  NULL,
  'disabled staff cannot insert a mentor message'
);

SET LOCAL request.jwt.claim.sub = '10000000-0000-0000-0000-000000000103';

SELECT throws_ok(
  $test$
    INSERT INTO public.timeline_items (
      session_id,
      kind,
      text,
      author_id
    )
    VALUES (
      (
        SELECT (result ->> 'session_id')::uuid
        FROM cloud_test_results
        WHERE label = 'first_ingest'
      ),
      'mentor',
      'Must-change staff attempt',
      '10000000-0000-0000-0000-000000000103'::uuid
    )
  $test$,
  '42501',
  NULL,
  'staff awaiting password change cannot insert a mentor message'
);

RESET ROLE;

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub = '10000000-0000-0000-0000-000000000001';

SELECT is(
  public.get_my_legacy_workbuddy_setup() ->> 'display_name',
  'Student One',
  'student plaintext transition RPC remains own-profile compatible'
);

SELECT throws_ok(
  $test$
    INSERT INTO public.sessions (
      student_id,
      session_title,
      source_session_key
    )
    VALUES (
      (
        SELECT id
        FROM public.students
        WHERE user_id = '10000000-0000-0000-0000-000000000001'::uuid
      ),
      'Forged connector session',
      'student-forged-key'
    )
  $test$,
  '42501',
  NULL,
  'student cannot supply a source session key'
);

WITH inserted_session AS (
  INSERT INTO public.sessions (
    student_id,
    session_title,
    session_group,
    last_severity
  )
  VALUES (
    (
      SELECT id
      FROM public.students
      WHERE user_id = '10000000-0000-0000-0000-000000000001'::uuid
    ),
    'Direct web session',
    'task',
    'ok'
  )
  RETURNING id
)
INSERT INTO cloud_test_results (label, result)
SELECT
  'direct_web_session',
  pg_catalog.jsonb_build_object('session_id', id)
FROM inserted_session;

SELECT ok(
  (
    SELECT
      target_session.source = 'web'
      AND target_session.source_session_key IS NULL
    FROM public.sessions AS target_session
    JOIN cloud_test_results AS inserted
      ON target_session.id = (inserted.result ->> 'session_id')::uuid
    WHERE inserted.label = 'direct_web_session'
  ),
  'student direct session insert remains web-only'
);

SELECT is(
  (
    WITH attempted_update AS (
      UPDATE public.sessions
      SET session_title = 'Student tried to change service data'
      WHERE id = (
        SELECT (result ->> 'session_id')::uuid
        FROM cloud_test_results
        WHERE label = 'first_ingest'
      )
      RETURNING id
    )
    SELECT count(*)
    FROM attempted_update
  ),
  0::bigint,
  'student cannot update a service-owned session'
);

SELECT throws_ok(
  $test$
    INSERT INTO public.timeline_items (
      session_id,
      kind,
      text,
      author_id,
      source_event_id,
      event_ordinal
    )
    VALUES (
      (
        SELECT (result ->> 'session_id')::uuid
        FROM cloud_test_results
        WHERE label = 'direct_web_session'
      ),
      'prompt',
      'Forged provenance',
      '10000000-0000-0000-0000-000000000001'::uuid,
      '20000000-0000-0000-0000-000000000001'::uuid,
      2
    )
  $test$,
  '42501',
  NULL,
  'student cannot forge timeline provenance'
);

WITH inserted_item AS (
  INSERT INTO public.timeline_items (
    session_id,
    kind,
    text,
    severity,
    author_id
  )
  VALUES (
    (
      SELECT (result ->> 'session_id')::uuid
      FROM cloud_test_results
      WHERE label = 'direct_web_session'
    ),
    'prompt',
    'Direct web prompt',
    'error',
    '10000000-0000-0000-0000-000000000001'::uuid
  )
  RETURNING
    id,
    session_id,
    created_at,
    source_event_id,
    event_ordinal,
    author_username
)
SELECT ok(
  inserted_item.source_event_id IS NULL
  AND inserted_item.event_ordinal IS NULL
  AND inserted_item.author_username IS NULL
  AND target_session.last_severity = 'error'
  AND student.last_severity = 'error'
  AND student.last_active_at >= inserted_item.created_at,
  'student direct timeline insert remains provenance-free; student direct timeline insert updates session and student aggregates'
)
FROM inserted_item
JOIN public.sessions AS target_session
  ON target_session.id = inserted_item.session_id
JOIN public.students AS student
  ON student.id = target_session.student_id;

SELECT results_eq(
  'SELECT count(*) FROM public.mentor_message_deliveries',
  ARRAY[1::bigint],
  'student RLS cannot see another student delivery'
);

SELECT is(
  public.mark_mentor_messages_web_seen(
    ARRAY[
      (
        SELECT (result ->> 'message_id')::uuid
        FROM cloud_test_results
        WHERE label = 'student_one_message'
      ),
      (
        SELECT (result ->> 'message_id')::uuid
        FROM cloud_test_results
        WHERE label = 'student_two_message'
      )
    ]
  ),
  1,
  'web-seen RPC updates only the authenticated student owned message'
);

RESET ROLE;

SELECT ok(
  (
    SELECT
      own_delivery.web_seen_at IS NOT NULL
      AND other_delivery.web_seen_at IS NULL
    FROM public.mentor_message_deliveries AS own_delivery
    JOIN cloud_test_results AS own_result
      ON own_delivery.message_id = (own_result.result ->> 'message_id')::uuid
    CROSS JOIN public.mentor_message_deliveries AS other_delivery
    JOIN cloud_test_results AS other_result
      ON other_delivery.message_id = (other_result.result ->> 'message_id')::uuid
    WHERE own_result.label = 'student_one_message'
      AND other_result.label = 'student_two_message'
  ),
  'web-seen ownership isolation is persisted'
);

SELECT ok(
  (
    SELECT bool_and(
      delivery.first_fetched_at IS NULL
      AND delivery.last_fetched_at IS NULL
      AND delivery.fetch_count = 0
      AND delivery.acknowledged_at IS NULL
      AND delivery.failure_count = 0
      AND delivery.last_error_code IS NULL
    )
    FROM public.mentor_message_deliveries AS delivery
    WHERE delivery.message_id IN (
      SELECT (result ->> 'message_id')::uuid
      FROM cloud_test_results
      WHERE label IN ('student_one_message', 'student_two_message')
    )
  ),
  'web-seen RPC never changes transport fetch ack or failure fields'
);

SELECT * FROM finish();
ROLLBACK;
