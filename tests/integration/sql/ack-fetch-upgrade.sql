SET lock_timeout = '5s';
SET statement_timeout = '30s';

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET search_path = public, extensions, pg_catalog;

SELECT plan(7);

CREATE TEMP TABLE ack_fetch_upgrade_results (
  label text PRIMARY KEY,
  result jsonb NOT NULL
) ON COMMIT PRESERVE ROWS;

GRANT SELECT, INSERT ON TABLE ack_fetch_upgrade_results TO service_role;

DELETE FROM auth.users
WHERE id IN (
  '91000000-0000-0000-0000-000000000001'::uuid,
  '91000000-0000-0000-0000-000000000101'::uuid
);

DO $fixture$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
      'public.mentor_message_deliveries'::regclass
      AND constraint_row.conname =
        'mentor_message_deliveries_ack_requires_fetch_check'
  ) THEN
    UPDATE public.mentor_message_deliveries
    SET acknowledged_at = NULL
    WHERE acknowledged_at IS NOT NULL
      AND first_fetched_at IS NULL;

    ALTER TABLE public.mentor_message_deliveries
      ADD CONSTRAINT mentor_message_deliveries_ack_requires_fetch_check
      CHECK (
        acknowledged_at IS NULL
        OR first_fetched_at IS NOT NULL
      );
  END IF;
END;
$fixture$;

INSERT INTO auth.users (
  id,
  email,
  raw_user_meta_data,
  raw_app_meta_data
)
VALUES
  (
    '91000000-0000-0000-0000-000000000001'::uuid,
    'ack-upgrade-student@example.invalid',
    '{"display_name":"ACK Upgrade Student"}'::jsonb,
    '{}'::jsonb
  ),
  (
    '91000000-0000-0000-0000-000000000101'::uuid,
    'ack-upgrade-mentor@example.invalid',
    '{"username":"ack.upgrade.mentor"}'::jsonb,
    '{"account_kind":"staff"}'::jsonb
  );

SET ROLE service_role;

SELECT public.bootstrap_staff_account(
  _user_id => '91000000-0000-0000-0000-000000000101'::uuid,
  _username => 'ack.upgrade.mentor',
  _auth_identity_version => 1
);

SELECT public.complete_staff_password_change(
  '91000000-0000-0000-0000-000000000101'::uuid
);

INSERT INTO ack_fetch_upgrade_results (label, result)
VALUES (
  'ingest',
  public.ingest_workbuddy_turn(
    _event_id => '92000000-0000-0000-0000-000000000001'::uuid,
    _student_id => (
      SELECT id
      FROM public.students
      WHERE user_id = '91000000-0000-0000-0000-000000000001'::uuid
    ),
    _source => 'mcp',
    _source_session_key => 'ack-fetch-upgrade-session',
    _session_title => 'ACK fetch upgrade',
    _payload_sha256 => pg_catalog.repeat('9', 64),
    _prompt => 'Create an upgrade fixture',
    _reply => 'Upgrade fixture created'
  )
);

INSERT INTO ack_fetch_upgrade_results (label, result)
SELECT
  'message',
  public.create_mentor_message(
    _author_user_id => '91000000-0000-0000-0000-000000000101'::uuid,
    _session_id => (ingest.result ->> 'session_id')::uuid,
    _text => 'Legacy acknowledgement must be requeued'
  )
FROM ack_fetch_upgrade_results AS ingest
WHERE ingest.label = 'ingest';

RESET ROLE;

ALTER TABLE public.mentor_message_deliveries
  DROP CONSTRAINT mentor_message_deliveries_ack_requires_fetch_check;

UPDATE public.mentor_message_deliveries AS delivery
SET acknowledged_at = pg_catalog.now()
FROM ack_fetch_upgrade_results AS message_result
WHERE message_result.label = 'message'
  AND delivery.message_id = (message_result.result ->> 'message_id')::uuid;

SELECT ok(
  (
    SELECT
      delivery.acknowledged_at IS NOT NULL
      AND delivery.first_fetched_at IS NULL
      AND delivery.fetch_count = 0
    FROM public.mentor_message_deliveries AS delivery
    JOIN ack_fetch_upgrade_results AS message_result
      ON delivery.message_id = (message_result.result ->> 'message_id')::uuid
    WHERE message_result.label = 'message'
  ),
  'upgrade fixture reproduces the legacy acknowledged-before-fetch state'
);

-- __ACK_FETCH_GUARD_MIGRATION__

SELECT ok(
  (
    SELECT
      delivery.acknowledged_at IS NULL
      AND delivery.first_fetched_at IS NULL
      AND delivery.fetch_count = 0
    FROM public.mentor_message_deliveries AS delivery
    JOIN ack_fetch_upgrade_results AS message_result
      ON delivery.message_id = (message_result.result ->> 'message_id')::uuid
    WHERE message_result.label = 'message'
  ),
  'forward migration requeues a legacy unproven acknowledgement'
);

SELECT ok(
  (
    SELECT constraint_row.convalidated
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.mentor_message_deliveries'::regclass
      AND constraint_row.conname =
        'mentor_message_deliveries_ack_requires_fetch_check'
  ),
  'forward migration leaves the fetch-before-ack constraint validated'
);

SELECT throws_ok(
  $test$
    UPDATE public.mentor_message_deliveries AS delivery
    SET acknowledged_at = pg_catalog.now()
    FROM ack_fetch_upgrade_results AS message_result
    WHERE message_result.label = 'message'
      AND delivery.message_id = (message_result.result ->> 'message_id')::uuid
  $test$,
  '23514',
  NULL,
  'validated constraint rejects direct acknowledged-before-fetch writes'
);

SET ROLE service_role;

SELECT throws_ok(
  $test$
    SELECT public.ack_workbuddy_mentor_messages(
      (
        SELECT id
        FROM public.students
        WHERE user_id = '91000000-0000-0000-0000-000000000001'::uuid
      ),
      ARRAY[
        (
          SELECT (result ->> 'message_id')::uuid
          FROM ack_fetch_upgrade_results
          WHERE label = 'message'
        )
      ]
    )
  $test$,
  'P4040',
  'workbuddy_delivery_not_owned',
  'upgraded RPC rejects the requeued message before its first fetch'
);

INSERT INTO ack_fetch_upgrade_results (label, result)
SELECT
  'first_fetch',
  public.fetch_workbuddy_mentor_messages(
    (
      SELECT id
      FROM public.students
      WHERE user_id = '91000000-0000-0000-0000-000000000001'::uuid
    ),
    (ingest.result ->> 'session_id')::uuid,
    100,
    NULL,
    NULL
  )
FROM ack_fetch_upgrade_results AS ingest
WHERE ingest.label = 'ingest';

SELECT is(
  (
    SELECT pg_catalog.jsonb_array_length(result -> 'messages')
    FROM ack_fetch_upgrade_results
    WHERE label = 'first_fetch'
  ),
  1,
  'requeued legacy message remains deliverable after the upgrade'
);

SELECT lives_ok(
  $test$
    SELECT public.ack_workbuddy_mentor_messages(
      (
        SELECT id
        FROM public.students
        WHERE user_id = '91000000-0000-0000-0000-000000000001'::uuid
      ),
      ARRAY[
        (
          SELECT (result ->> 'message_id')::uuid
          FROM ack_fetch_upgrade_results
          WHERE label = 'message'
        )
      ]
    )
  $test$,
  'requeued legacy message can be acknowledged after a real fetch'
);

RESET ROLE;

SELECT * FROM finish();
