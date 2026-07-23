BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions, pg_catalog;

SELECT plan(125);

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
  ),
  (
    '10000000-0000-0000-0000-000000000104'::uuid,
    'other-must-change-mentor@example.invalid',
    '{"account_kind":"staff"}'::jsonb
  );

SET LOCAL ROLE service_role;

SELECT throws_ok(
  $test$
    SELECT public.bootstrap_staff_account(
      _user_id => '10000000-0000-0000-0000-000000000100'::uuid,
      _username => 'Uppercase.mentor'
    )
  $test$,
  '22023',
  'invalid_staff_username',
  'provisioning rejects uppercase staff usernames'
);

SELECT throws_ok(
  $test$
    SELECT public.bootstrap_staff_account(
      _user_id => '10000000-0000-0000-0000-000000000100'::uuid,
      _username => 'ｆｕｌｌｗｉｄｔｈ'
    )
  $test$,
  '22023',
  'invalid_staff_username',
  'provisioning rejects fullwidth staff usernames'
);

SELECT throws_ok(
  $test$
    SELECT public.bootstrap_staff_account(
      _user_id => '10000000-0000-0000-0000-000000000100'::uuid,
      _username => 'a'
    )
  $test$,
  '22023',
  'invalid_staff_username',
  'provisioning rejects out-of-range staff usernames'
);

SELECT throws_ok(
  $test$
    SELECT public.bootstrap_staff_account(
      _user_id => '10000000-0000-0000-0000-000000000100'::uuid,
      _username => 'version.two',
      _auth_identity_version => 2
    )
  $test$,
  '22023',
  'invalid_auth_identity_version',
  'provisioning rejects unsupported auth identity versions'
);

DO $setup$
BEGIN
  PERFORM public.bootstrap_staff_account(
    _user_id => '10000000-0000-0000-0000-000000000101'::uuid,
    _username => 'active.mentor',
    _auth_identity_version => 1,
    _is_team_admin => true
  );
  PERFORM public.bootstrap_staff_account(
    _user_id => '10000000-0000-0000-0000-000000000102'::uuid,
    _username => 'disabled.mentor',
    _auth_identity_version => 1
  );
  PERFORM public.bootstrap_staff_account(
    _user_id => '10000000-0000-0000-0000-000000000103'::uuid,
    _username => 'must.change',
    _auth_identity_version => 1
  );
  PERFORM public.bootstrap_staff_account(
    _user_id => '10000000-0000-0000-0000-000000000104'::uuid,
    _username => 'other.must.change',
    _auth_identity_version => 1
  );
END;
$setup$;

UPDATE public.staff_accounts
SET must_change_password = false
WHERE user_id = '10000000-0000-0000-0000-000000000101'::uuid;

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

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub = '10000000-0000-0000-0000-000000000103';

SELECT throws_ok(
  $test$
    SELECT public.complete_staff_password_change(
      '10000000-0000-0000-0000-000000000103'::uuid
    )
  $test$,
  '42501',
  'permission denied for function complete_staff_password_change',
  'authenticated browser cannot complete a staff password change'
);

SELECT throws_ok(
  $test$
    SELECT public.bootstrap_staff_account(
      _user_id => '10000000-0000-0000-0000-000000000100'::uuid,
      _username => 'browser.bootstrap'
    )
  $test$,
  '42501',
  'permission denied for function bootstrap_staff_account',
  'authenticated clients cannot use the trusted bootstrap provisioner'
);

RESET ROLE;
SET LOCAL ROLE service_role;

SELECT is(
  public.complete_staff_password_change(
    '10000000-0000-0000-0000-000000000103'::uuid
  ),
  true,
  'service role completes an explicit active staff password change'
);

SELECT is(
  public.complete_staff_password_change(
    '10000000-0000-0000-0000-000000000103'::uuid
  ),
  true,
  'password completion is idempotent for retry'
);

SELECT ok(
  (
    SELECT
      completed.must_change_password = false
      AND untouched.must_change_password = true
    FROM public.staff_accounts AS completed
    CROSS JOIN public.staff_accounts AS untouched
    WHERE completed.user_id = '10000000-0000-0000-0000-000000000103'::uuid
      AND untouched.user_id = '10000000-0000-0000-0000-000000000104'::uuid
  ),
  'password completion updates only the explicit active staff row'
);

SELECT throws_ok(
  $test$
    SELECT public.provision_staff_account(
      _user_id => '10000000-0000-0000-0000-000000000100'::uuid,
      _username => 'regular.provision',
      _created_by => '10000000-0000-0000-0000-000000000103'::uuid
    )
  $test$,
  '42501',
  'staff_admin_forbidden',
  'regular provision revalidates the creating team admin in its transaction'
);

SELECT is(
  public.provision_staff_account(
    _user_id => '10000000-0000-0000-0000-000000000100'::uuid,
    _username => 'regular.provision',
    _created_by => '10000000-0000-0000-0000-000000000101'::uuid
  ) ->> 'username',
  'regular.provision',
  'an active completed team admin can provision through the regular entry'
);

SELECT throws_ok(
  $test$
    SELECT public.complete_staff_password_change(
      '10000000-0000-0000-0000-000000000001'::uuid
    )
  $test$,
  '42501',
  'active_staff_account_required',
  'service role cannot complete a student password change'
);

SELECT throws_ok(
  $test$
    SELECT public.complete_staff_password_change(
      '10000000-0000-0000-0000-000000000102'::uuid
    )
  $test$,
  '42501',
  'active_staff_account_required',
  'service role cannot complete a disabled staff password change'
);

RESET ROLE;

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub = '10000000-0000-0000-0000-000000000101';

SELECT throws_ok(
  $test$
    SELECT public.admin_begin_staff_active_operation(
      '10000000-0000-0000-0000-000000000101'::uuid,
      '10000000-0000-0000-0000-000000000103'::uuid,
      false,
      '30000000-0000-4000-8000-000000000001'::uuid
    )
  $test$,
  '42501',
  'permission denied for function admin_begin_staff_active_operation',
  'authenticated clients cannot begin a staff active-state operation'
);

SELECT throws_ok(
  $test$
    SELECT public.admin_begin_staff_password_reset(
      '10000000-0000-0000-0000-000000000101'::uuid,
      '10000000-0000-0000-0000-000000000103'::uuid,
      '30000000-0000-4000-8000-000000000002'::uuid
    )
  $test$,
  '42501',
  'permission denied for function admin_begin_staff_password_reset',
  'authenticated clients cannot begin a staff password reset'
);

RESET ROLE;
SET LOCAL ROLE service_role;

SELECT throws_ok(
  $test$
    SELECT public.admin_begin_staff_active_operation(
      '10000000-0000-0000-0000-000000000101'::uuid,
      '10000000-0000-0000-0000-000000000101'::uuid,
      false,
      '30000000-0000-4000-8000-000000000003'::uuid
    )
  $test$,
  '42501',
  'staff_self_disable_forbidden',
  'a team admin cannot disable itself'
);

SELECT throws_ok(
  $test$
    SELECT public.admin_begin_staff_password_reset(
      '10000000-0000-0000-0000-000000000101'::uuid,
      '10000000-0000-0000-0000-000000000101'::uuid,
      '30000000-0000-4000-8000-000000000010'::uuid
    )
  $test$,
  '42501',
  'staff_self_password_reset_forbidden',
  'a team admin cannot reset its own temporary password'
);

SELECT throws_ok(
  $test$
    SELECT public.admin_begin_staff_active_operation(
      '10000000-0000-0000-0000-000000000103'::uuid,
      '10000000-0000-0000-0000-000000000101'::uuid,
      false,
      '30000000-0000-4000-8000-000000000004'::uuid
    )
  $test$,
  '42501',
  'last_active_team_admin_required',
  'a distinct actor cannot disable the sole usable team admin'
);

SELECT is(
  (
    public.admin_begin_staff_active_operation(
      '10000000-0000-0000-0000-000000000101'::uuid,
      '10000000-0000-0000-0000-000000000103'::uuid,
      false,
      '30000000-0000-4000-8000-000000000005'::uuid
    ) ->> 'desired_active'
  ),
  'false',
  'disable begin records the desired state while failing database access closed'
);

INSERT INTO cloud_test_results (label, result)
SELECT
  'admin_disable_state',
  public.admin_get_staff_active_sync_state(
    '10000000-0000-0000-0000-000000000101'::uuid,
    '10000000-0000-0000-0000-000000000103'::uuid
  );

SELECT ok(
  (
    SELECT
      result ->> 'operation_token'
        = '30000000-0000-4000-8000-000000000005'
      AND result ->> 'desired_active' = 'false'
    FROM cloud_test_results
    WHERE label = 'admin_disable_state'
  ),
  'active sync state exposes the exact pending operation and desired state'
);

SELECT is(
  (
    public.admin_begin_staff_active_operation(
      '10000000-0000-0000-0000-000000000101'::uuid,
      '10000000-0000-0000-0000-000000000103'::uuid,
      true,
      '30000000-0000-4000-8000-000000000006'::uuid
    ) ->> 'desired_active'
  ),
  'true',
  'a newer enable supersedes the pending disable operation'
);

SELECT is(
  (
    public.admin_confirm_staff_active_sync(
      '10000000-0000-0000-0000-000000000101'::uuid,
      '10000000-0000-0000-0000-000000000103'::uuid,
      (
        SELECT (result ->> 'version')::bigint
        FROM cloud_test_results
        WHERE label = 'admin_disable_state'
      ),
      '30000000-0000-4000-8000-000000000005'::uuid
    ) ->> 'confirmed'
  ),
  'false',
  'an older active-state confirmation cannot commit over a newer operation'
);

SELECT is(
  (
    public.admin_confirm_staff_active_sync(
      '10000000-0000-0000-0000-000000000101'::uuid,
      '10000000-0000-0000-0000-000000000103'::uuid,
      (
        public.admin_get_staff_active_sync_state(
          '10000000-0000-0000-0000-000000000101'::uuid,
          '10000000-0000-0000-0000-000000000103'::uuid
        ) ->> 'version'
      )::bigint,
      '30000000-0000-4000-8000-000000000006'::uuid
    ) ->> 'confirmed'
  ),
  'true',
  'the current active-state operation confirms after Auth reconciliation'
);

SELECT ok(
  (
    SELECT
      is_active = true
      AND disabled_at IS NULL
      AND disabled_by IS NULL
      AND active_operation_token IS NULL
      AND active_operation_desired IS NULL
    FROM public.staff_accounts
    WHERE user_id = '10000000-0000-0000-0000-000000000103'::uuid
  ),
  'confirmed activation clears operation and disable audit state'
);

SELECT is(
  (
    public.admin_begin_staff_password_reset(
      '10000000-0000-0000-0000-000000000101'::uuid,
      '10000000-0000-0000-0000-000000000103'::uuid,
      '30000000-0000-4000-8000-000000000007'::uuid
    ) ->> 'previous_value'
  )::boolean,
  false,
  'first password reset owns the previous false gate'
);

SELECT is(
  (
    public.admin_begin_staff_password_reset(
      '10000000-0000-0000-0000-000000000101'::uuid,
      '10000000-0000-0000-0000-000000000103'::uuid,
      '30000000-0000-4000-8000-000000000008'::uuid
    ) ->> 'previous_value'
  )::boolean,
  true,
  'newer password reset takes ownership without weakening the gate'
);

SELECT is(
  (
    public.admin_finish_staff_password_reset(
      '10000000-0000-0000-0000-000000000101'::uuid,
      '10000000-0000-0000-0000-000000000103'::uuid,
      '30000000-0000-4000-8000-000000000008'::uuid,
      true
    ) ->> 'applied'
  )::boolean,
  true,
  'current successful reset clears only its operation ownership'
);

SELECT is(
  (
    public.admin_finish_staff_password_reset(
      '10000000-0000-0000-0000-000000000101'::uuid,
      '10000000-0000-0000-0000-000000000103'::uuid,
      '30000000-0000-4000-8000-000000000007'::uuid,
      false
    ) ->> 'applied'
  )::boolean,
  false,
  'older failed reset cannot compensate after newer success'
);

SELECT ok(
  (
    SELECT
      must_change_password = true
      AND password_reset_operation_token IS NULL
      AND password_reset_previous_must_change IS NULL
    FROM public.staff_accounts
    WHERE user_id = '10000000-0000-0000-0000-000000000103'::uuid
  ),
  'successful reset leaves the must-change gate enabled and ownership cleared'
);

UPDATE public.staff_accounts
SET must_change_password = false
WHERE user_id = '10000000-0000-0000-0000-000000000103'::uuid;

SELECT is(
  (
    public.admin_begin_staff_password_reset(
      '10000000-0000-0000-0000-000000000101'::uuid,
      '10000000-0000-0000-0000-000000000103'::uuid,
      '30000000-0000-4000-8000-000000000009'::uuid
    ) ->> 'previous_value'
  )::boolean,
  false,
  'failed-reset fixture captures a false previous gate'
);

SELECT is(
  (
    public.admin_finish_staff_password_reset(
      '10000000-0000-0000-0000-000000000101'::uuid,
      '10000000-0000-0000-0000-000000000103'::uuid,
      '30000000-0000-4000-8000-000000000009'::uuid,
      false
    ) ->> 'applied'
  )::boolean,
  true,
  'current failed reset restores its captured previous gate'
);

SELECT ok(
  (
    SELECT
      must_change_password = false
      AND password_reset_operation_token IS NULL
      AND password_reset_previous_must_change IS NULL
    FROM public.staff_accounts
    WHERE user_id = '10000000-0000-0000-0000-000000000103'::uuid
  ),
  'failed reset restoration clears operation ownership without leaving a gate'
);

INSERT INTO public.user_roles (user_id, role)
VALUES (
  '10000000-0000-0000-0000-000000000103'::uuid,
  'team_admin'::public.app_role
);

SELECT is(
  (
    public.admin_begin_staff_password_reset(
      '10000000-0000-0000-0000-000000000101'::uuid,
      '10000000-0000-0000-0000-000000000103'::uuid,
      '30000000-0000-4000-8000-000000000011'::uuid
    ) ->> 'previous_value'
  )::boolean,
  false,
  'first of two usable admins can begin resetting the other'
);

SELECT throws_ok(
  $test$
    SELECT public.admin_begin_staff_password_reset(
      '10000000-0000-0000-0000-000000000103'::uuid,
      '10000000-0000-0000-0000-000000000101'::uuid,
      '30000000-0000-4000-8000-000000000012'::uuid
    )
  $test$,
  '42501',
  'staff_admin_forbidden',
  'mutual admin reset keeps one usable team admin'
);

SELECT throws_ok(
  $test$
    SELECT public.admin_begin_staff_active_operation(
      '10000000-0000-0000-0000-000000000103'::uuid,
      '10000000-0000-0000-0000-000000000101'::uuid,
      false,
      '30000000-0000-4000-8000-000000000013'::uuid
    )
  $test$,
  '42501',
  'last_active_team_admin_required',
  'reset then disable interleaving keeps one usable team admin'
);

SELECT is(
  (
    public.admin_finish_staff_password_reset(
      '10000000-0000-0000-0000-000000000101'::uuid,
      '10000000-0000-0000-0000-000000000103'::uuid,
      '30000000-0000-4000-8000-000000000011'::uuid,
      false
    ) ->> 'applied'
  )::boolean,
  true,
  'the first reset can restore the second admin after the interleaving checks'
);

SELECT is(
  (
    public.admin_begin_staff_password_reset(
      '10000000-0000-0000-0000-000000000103'::uuid,
      '10000000-0000-0000-0000-000000000101'::uuid,
      '30000000-0000-4000-8000-000000000014'::uuid
    ) ->> 'previous_value'
  )::boolean,
  false,
  'the reverse reset order starts while both admins are usable'
);

SELECT throws_ok(
  $test$
    SELECT public.admin_begin_staff_password_reset(
      '10000000-0000-0000-0000-000000000101'::uuid,
      '10000000-0000-0000-0000-000000000103'::uuid,
      '30000000-0000-4000-8000-000000000015'::uuid
    )
  $test$,
  '42501',
  'staff_admin_forbidden',
  'reverse mutual reset also preserves one usable team admin'
);

SELECT is(
  (
    public.admin_finish_staff_password_reset(
      '10000000-0000-0000-0000-000000000103'::uuid,
      '10000000-0000-0000-0000-000000000101'::uuid,
      '30000000-0000-4000-8000-000000000014'::uuid,
      false
    ) ->> 'applied'
  )::boolean,
  true,
  'the reverse reset restores the original admin'
);

DELETE FROM public.user_roles
WHERE user_id = '10000000-0000-0000-0000-000000000103'::uuid
  AND role = 'team_admin'::public.app_role;

RESET ROLE;

SET LOCAL ROLE authenticated;

SELECT throws_ok(
  $test$
    SELECT public.resolve_workbuddy_credential(repeat('1', 64))
  $test$,
  '42501',
  'permission denied for function resolve_workbuddy_credential',
  'browser-authenticated callers cannot resolve WorkBuddy credentials'
);

RESET ROLE;

SET LOCAL ROLE service_role;

INSERT INTO public.workbuddy_credentials (
  student_id,
  token_hash,
  token_prefix,
  source
)
SELECT
  student.id,
  repeat('1', 64),
  '11111111',
  'issued'
FROM public.students AS student
WHERE student.user_id = '10000000-0000-0000-0000-000000000001'::uuid;

INSERT INTO cloud_test_results (label, result)
VALUES (
  'active_credential',
  public.resolve_workbuddy_credential(repeat('1', 64))
);

SELECT ok(
  (
    SELECT
      resolved.result ->> 'status' = 'active'
      AND resolved.result ->> 'student_id' = credential.student_id::text
      AND resolved.result = pg_catalog.jsonb_build_object(
        'status', 'active',
        'student_id', credential.student_id
      )
      AND NOT resolved.result ? 'token_hash'
      AND NOT resolved.result ? 'token_prefix'
      AND credential.last_used_at IS NOT NULL
    FROM cloud_test_results AS resolved
    JOIN public.workbuddy_credentials AS credential
      ON credential.token_hash = repeat('1', 64)
    WHERE resolved.label = 'active_credential'
  ),
  'active credential resolution atomically records use and returns only status and student identity'
);

INSERT INTO public.workbuddy_credentials (
  student_id,
  token_hash,
  token_prefix,
  source,
  status,
  revoked_at
)
SELECT
  student.id,
  repeat('2', 64),
  '22222222',
  'issued',
  'revoked',
  now()
FROM public.students AS student
WHERE student.user_id = '10000000-0000-0000-0000-000000000001'::uuid;

SELECT is(
  public.resolve_workbuddy_credential(repeat('2', 64)) ->> 'status',
  'revoked',
  'revoked credential is distinguishable without exposing credential material'
);

SELECT is(
  public.resolve_workbuddy_credential(repeat('3', 64)) ->> 'status',
  'invalid',
  'unknown credential hash is reported as invalid'
);

DELETE FROM public.workbuddy_credentials
WHERE token_hash IN (repeat('1', 64), repeat('2', 64));

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

SELECT throws_ok(
  $test$
    SELECT public.create_mentor_message(
      _author_user_id => '10000000-0000-0000-0000-000000000102'::uuid,
      _session_id => (
        SELECT (result ->> 'session_id')::uuid
        FROM cloud_test_results
        WHERE label = 'first_ingest'
      ),
      _text => 'Disabled staff must not send'
    )
  $test$,
  '42501',
  'active_staff_account_required',
  'disabled staff cannot create mentor messages'
);

SELECT throws_ok(
  $test$
    SELECT public.create_mentor_message(
      _author_user_id => '10000000-0000-0000-0000-000000000104'::uuid,
      _session_id => (
        SELECT (result ->> 'session_id')::uuid
        FROM cloud_test_results
        WHERE label = 'first_ingest'
      ),
      _text => 'Password-change gate must block sending'
    )
  $test$,
  '42501',
  'active_staff_account_required',
  'password-change-required staff cannot create mentor messages'
);

INSERT INTO cloud_test_results (label, result)
SELECT
  'student_one_message',
  public.create_mentor_message(
    _author_user_id => '10000000-0000-0000-0000-000000000101'::uuid,
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
  'active.mentor',
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

SELECT throws_ok(
  $test$
    SELECT public.ingest_workbuddy_turn(
      _event_id => '20000000-0000-0000-0000-000000000001'::uuid,
      _student_id => (
        SELECT id
        FROM public.students
        WHERE user_id = '10000000-0000-0000-0000-000000000002'::uuid
      ),
      _source => 'mcp',
      _source_session_key => 'cross-student-replay',
      _session_title => 'Must not leak another student result',
      _payload_sha256 => repeat('a', 64),
      _prompt => 'Deterministic prompt one',
      _reply => 'Deterministic reply one'
    )
  $test$,
  'P4090',
  'workbuddy_event_conflict',
  'the same event id cannot be replayed across students even with the same payload hash'
);

INSERT INTO cloud_test_results (label, result)
SELECT
  'student_two_message',
  public.create_mentor_message(
    _author_user_id => '10000000-0000-0000-0000-000000000101'::uuid,
    _session_id => (
      SELECT (result ->> 'session_id')::uuid
      FROM cloud_test_results
      WHERE label = 'student_two_ingest'
    ),
    _text => 'Student two mentor message'
  );

SELECT ok(
  (
    SELECT
      snapshot.result ->> 'session_id'
        = (
          SELECT result ->> 'session_id'
          FROM cloud_test_results
          WHERE label = 'first_ingest'
        )
      AND EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_array_elements(snapshot.result -> 'items') AS entry
        WHERE entry -> 'timeline' ->> 'id' = (
          SELECT result ->> 'message_id'
          FROM cloud_test_results
          WHERE label = 'student_one_message'
        )
          AND entry -> 'delivery' ->> 'message_id'
            = entry -> 'timeline' ->> 'id'
      )
    FROM (
      SELECT public.get_timeline_delivery_snapshot(
        '10000000-0000-0000-0000-000000000001'::uuid,
        (
          SELECT (result ->> 'session_id')::uuid
          FROM cloud_test_results
          WHERE label = 'first_ingest'
        )
      ) AS result
    ) AS snapshot
  ),
  'student snapshot returns one coherent timeline and delivery join'
);

SELECT is(
  public.get_timeline_delivery_snapshot(
    '10000000-0000-0000-0000-000000000101'::uuid,
    (
      SELECT (result ->> 'session_id')::uuid
      FROM cloud_test_results
      WHERE label = 'first_ingest'
    )
  ) ->> 'session_id',
  (
    SELECT result ->> 'session_id'
    FROM cloud_test_results
    WHERE label = 'first_ingest'
  ),
  'active completed mentor can read the joined timeline snapshot'
);

SELECT throws_ok(
  $test$
    SELECT public.get_timeline_delivery_snapshot(
      '10000000-0000-0000-0000-000000000001'::uuid,
      (
        SELECT (result ->> 'session_id')::uuid
        FROM cloud_test_results
        WHERE label = 'student_two_ingest'
      )
    )
  $test$,
  '42501',
  'timeline_snapshot_forbidden',
  'student snapshot cannot read another student session'
);

RESET ROLE;

CREATE OR REPLACE FUNCTION public.cloud_test_force_delivery_failure()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.timeline_items AS item
    WHERE item.id = NEW.message_id
      AND item.text = 'force mentor delivery failure'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'forced_delivery_failure';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER cloud_test_force_delivery_failure
BEFORE INSERT ON public.mentor_message_deliveries
FOR EACH ROW
EXECUTE FUNCTION public.cloud_test_force_delivery_failure();

SET LOCAL ROLE service_role;

SELECT throws_ok(
  $test$
    SELECT public.create_mentor_message(
      _author_user_id => '10000000-0000-0000-0000-000000000101'::uuid,
      _session_id => (
        SELECT (result ->> 'session_id')::uuid
        FROM cloud_test_results
        WHERE label = 'first_ingest'
      ),
      _text => 'force mentor delivery failure'
    )
  $test$,
  'P0001',
  'forced_delivery_failure',
  'a delivery failure escapes the atomic mentor message RPC'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.timeline_items
    WHERE text = 'force mentor delivery failure'
  ),
  'a failed delivery insert rolls back the mentor timeline item'
);

RESET ROLE;

DROP TRIGGER cloud_test_force_delivery_failure
ON public.mentor_message_deliveries;
DROP FUNCTION public.cloud_test_force_delivery_failure();

CREATE OR REPLACE FUNCTION public.cloud_test_force_ai_response_failure()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  IF (
    NEW.kind = 'reply'::public.timeline_kind
    AND NEW.text = 'force ai reply failure'
  ) OR (
    NEW.kind = 'diagnosis'::public.timeline_kind
    AND NEW.text = 'force ai diagnosis failure'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'forced_ai_response_failure';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER cloud_test_force_ai_response_failure
BEFORE INSERT ON public.timeline_items
FOR EACH ROW
EXECUTE FUNCTION public.cloud_test_force_ai_response_failure();

SET LOCAL ROLE service_role;

SELECT throws_ok(
  $test$
    SELECT public.create_ai_response(
      _actor_user_id => '10000000-0000-0000-0000-000000000001'::uuid,
      _session_id => (
        SELECT (result ->> 'session_id')::uuid
        FROM cloud_test_results
        WHERE label = 'first_ingest'
      ),
      _reply => 'force ai reply failure',
      _diagnosis_text => NULL::text,
      _diagnosis_severity => NULL::public.severity,
      _tag => NULL::text
    )
  $test$,
  'P0001',
  'forced_ai_response_failure',
  'a failed AI reply escapes the atomic AI response RPC'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.timeline_items
    WHERE text = 'force ai reply failure'
  ),
  'a failed AI reply leaves no timeline row'
);

SELECT throws_ok(
  $test$
    SELECT public.create_ai_response(
      _actor_user_id => '10000000-0000-0000-0000-000000000001'::uuid,
      _session_id => (
        SELECT (result ->> 'session_id')::uuid
        FROM cloud_test_results
        WHERE label = 'first_ingest'
      ),
      _reply => 'reply must roll back after diagnosis failure',
      _diagnosis_text => 'force ai diagnosis failure',
      _diagnosis_severity => 'warn'::public.severity,
      _tag => 'rollback'
    )
  $test$,
  'P0001',
  'forced_ai_response_failure',
  'a failed diagnosis escapes the atomic AI response RPC'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.timeline_items
    WHERE text = 'reply must roll back after diagnosis failure'
  ),
  'a failed diagnosis rolls back the AI reply'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.timeline_items
    WHERE text = 'force ai diagnosis failure'
  ),
  'a failed diagnosis leaves no diagnosis row'
);

RESET ROLE;

DROP TRIGGER cloud_test_force_ai_response_failure
ON public.timeline_items;
DROP FUNCTION public.cloud_test_force_ai_response_failure();

CREATE OR REPLACE FUNCTION public.cloud_test_force_timeline_failure()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  IF NEW.text = 'force atomic ingest failure' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'forced_timeline_failure';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER cloud_test_force_timeline_failure
BEFORE INSERT ON public.timeline_items
FOR EACH ROW
EXECUTE FUNCTION public.cloud_test_force_timeline_failure();

SET LOCAL ROLE service_role;

SELECT throws_ok(
  $test$
    SELECT public.ingest_workbuddy_turn(
      _event_id => '20000000-0000-0000-0000-000000000099'::uuid,
      _student_id => (
        SELECT id
        FROM public.students
        WHERE user_id = '10000000-0000-0000-0000-000000000001'::uuid
      ),
      _source => 'connector',
      _source_session_key => 'forced-partial-failure',
      _session_title => 'Forced transaction rollback',
      _payload_sha256 => repeat('9', 64),
      _prompt => 'force atomic ingest failure',
      _reply => 'this row must never be inserted'
    )
  $test$,
  'P0001',
  'forced_timeline_failure',
  'a timeline failure escapes the atomic ingest RPC'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.workbuddy_ingest_events
    WHERE event_id = '20000000-0000-0000-0000-000000000099'::uuid
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public.sessions
    WHERE source = 'connector'
      AND source_session_key = 'forced-partial-failure'
  ),
  'a failed timeline insert leaves neither an ingest ledger row nor a resolved session'
);

RESET ROLE;

DROP TRIGGER cloud_test_force_timeline_failure
  ON public.timeline_items;
DROP FUNCTION public.cloud_test_force_timeline_failure();

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'students'
      AND column_name = 'workbuddy_token'
  ),
  'Task 6 removes the legacy plaintext student credential column'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname = 'public'
      AND procedure.proname = 'get_my_legacy_workbuddy_setup'
  ),
  'Task 6 removes the legacy plaintext transition RPC'
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
        WHERE user_id = '10000000-0000-0000-0000-000000000001'::uuid
      ),
      (
        SELECT (result ->> 'session_id')::uuid
        FROM cloud_test_results
        WHERE label = 'first_ingest'
      )
    )
  $test$,
  '42501',
  'permission denied for table mentor_message_deliveries',
  'service role cannot insert delivery rows directly'
);

SELECT throws_ok(
  $test$
    UPDATE public.mentor_message_deliveries
    SET web_seen_at = pg_catalog.now()
    WHERE false
  $test$,
  '42501',
  'permission denied for table mentor_message_deliveries',
  'service role cannot update delivery rows directly'
);

RESET ROLE;

SELECT throws_ok(
  $test$
    UPDATE public.mentor_message_deliveries
    SET session_id = (
      SELECT (result ->> 'session_id')::uuid
      FROM cloud_test_results
      WHERE label = 'student_two_ingest'
    )
    WHERE message_id = (
      SELECT (result ->> 'message_id')::uuid
      FROM cloud_test_results
      WHERE label = 'student_one_message'
    )
  $test$,
  '23514',
  'mentor_delivery_identity_immutable',
  'delivery identity columns are immutable'
);

-- Remove the trigger-created matching delivery so the next insert reaches the
-- composite message/session and session/student foreign keys instead of the
-- primary-key duplicate check.
DELETE FROM public.mentor_message_deliveries
WHERE message_id = (
  SELECT (result ->> 'message_id')::uuid
  FROM cloud_test_results
  WHERE label = 'student_one_message'
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
  'delivery rejects a session mismatched to its message'
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
        WHERE label = 'first_ingest'
      )
    )
  $test$,
  '23503',
  NULL,
  'delivery rejects a student mismatched to its session'
);

INSERT INTO public.mentor_message_deliveries (
  message_id,
  student_id,
  session_id
)
SELECT
  item.id,
  target_session.student_id,
  target_session.id
FROM public.timeline_items AS item
JOIN public.sessions AS target_session
  ON target_session.id = item.session_id
JOIN cloud_test_results AS message_result
  ON item.id = (message_result.result ->> 'message_id')::uuid
WHERE message_result.label = 'student_one_message';

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
  'mentor_delivery_message_invalid',
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
    SELECT public.get_workbuddy_credential_status(
      '10000000-0000-0000-0000-000000000001'::uuid
    )
  $test$,
  '42501',
  'permission denied for function get_workbuddy_credential_status',
  'authenticated browsers cannot read credential status directly'
);

SELECT throws_ok(
  $test$
    SELECT public.issue_workbuddy_credential(
      '10000000-0000-0000-0000-000000000001'::uuid,
      repeat('7', 64),
      'wb_browser',
      false
    )
  $test$,
  '42501',
  'permission denied for function issue_workbuddy_credential',
  'authenticated browsers cannot issue WorkBuddy credentials directly'
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
      item.author_username = 'active.mentor'
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

SET LOCAL request.jwt.claim.sub = '10000000-0000-0000-0000-000000000104';

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
      '10000000-0000-0000-0000-000000000104'::uuid
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
  has_function_privilege(
    'authenticated',
    'public.create_mentor_message(uuid,uuid,text,public.severity)',
    'EXECUTE'
  ),
  false,
  'student browser cannot call the service-only mentor message RPC'
);

SELECT is(
  has_function_privilege(
    'authenticated',
    'public.create_ai_response(uuid,uuid,text,text,public.severity,text)',
    'EXECUTE'
  ),
  false,
  'student browser cannot call the service-only AI response RPC'
);

SELECT is(
  has_function_privilege(
    'authenticated',
    'public.get_timeline_delivery_snapshot(uuid,uuid)',
    'EXECUTE'
  ),
  false,
  'student browser cannot call the service-only timeline snapshot RPC'
);

SELECT is(
  has_function_privilege(
    'authenticated',
    'public.get_workbuddy_credential_status(uuid)',
    'EXECUTE'
  ),
  false,
  'student browser cannot bypass the server-only credential manager'
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
SELECT is(
  (
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
INSERT INTO cloud_test_results (label, result)
SELECT
  'direct_web_item',
  pg_catalog.jsonb_build_object(
    'session_id', inserted_item.session_id,
    'created_at', inserted_item.created_at,
    'source_event_id', inserted_item.source_event_id,
    'event_ordinal', inserted_item.event_ordinal,
    'author_username', inserted_item.author_username
  )
FROM inserted_item;

SELECT ok(
  (
    SELECT
      inserted.result ->> 'source_event_id' IS NULL
      AND inserted.result ->> 'event_ordinal' IS NULL
      AND inserted.result ->> 'author_username' IS NULL
      AND target_session.last_severity = 'error'
      AND student.last_severity = 'error'
      AND student.last_active_at >=
        (inserted.result ->> 'created_at')::timestamptz
    FROM cloud_test_results AS inserted
    JOIN public.sessions AS target_session
      ON target_session.id = (inserted.result ->> 'session_id')::uuid
    JOIN public.students AS student
      ON student.id = target_session.student_id
    WHERE inserted.label = 'direct_web_item'
  ),
  'student direct timeline insert remains provenance-free; student direct timeline insert updates session and student aggregates'
);

SELECT results_eq(
  $actual$
    SELECT message_id::text
    FROM public.mentor_message_deliveries
    ORDER BY message_id
  $actual$,
  $expected$
    SELECT result ->> 'message_id'
    FROM cloud_test_results
    WHERE label IN ('student_one_message', 'direct_mentor_message')
    ORDER BY result ->> 'message_id'
  $expected$,
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

SET LOCAL ROLE service_role;

SELECT is(
  public.get_workbuddy_credential_status(
    '10000000-0000-0000-0000-000000000001'::uuid
  ) ->> 'status',
  'none',
  'student credential status starts without secret material'
);

INSERT INTO cloud_test_results (label, result)
VALUES (
  'first_credential',
  public.issue_workbuddy_credential(
    '10000000-0000-0000-0000-000000000001'::uuid,
    repeat('7', 64),
    'wb_first77',
    false
  )
);

SELECT ok(
  (
    SELECT
      result ->> 'status' = 'active'
      AND result -> 'credential' ->> 'prefix' = 'wb_first77'
      AND NOT (result ? 'token_hash')
      AND NOT ((result -> 'credential') ? 'token_hash')
    FROM cloud_test_results
    WHERE label = 'first_credential'
  ),
  'first credential issue returns only safe status and prefix fields'
);

SELECT throws_ok(
  $test$
    SELECT public.issue_workbuddy_credential(
      '10000000-0000-0000-0000-000000000001'::uuid,
      repeat('8', 64),
      'wb_second8',
      false
    )
  $test$,
  'P4090',
  'workbuddy_active_credential_exists',
  'create-first refuses a second active credential'
);

INSERT INTO cloud_test_results (label, result)
VALUES (
  'issued_credential_resolution',
  public.resolve_workbuddy_credential(repeat('7', 64))
);

SELECT ok(
  (
    SELECT
      resolved.result ->> 'status' = 'active'
      AND credential.last_used_at IS NOT NULL
    FROM public.workbuddy_credentials AS credential
    CROSS JOIN cloud_test_results AS resolved
    WHERE credential.token_hash = repeat('7', 64)
      AND resolved.label = 'issued_credential_resolution'
  ),
  'issued credential resolves through the shared hash-only bearer path'
);

INSERT INTO cloud_test_results (label, result)
VALUES (
  'rotated_credential',
  public.issue_workbuddy_credential(
    '10000000-0000-0000-0000-000000000001'::uuid,
    repeat('8', 64),
    'wb_rotated8',
    true
  )
);

SELECT is(
  (
    SELECT result -> 'credential' ->> 'prefix'
    FROM cloud_test_results
    WHERE label = 'rotated_credential'
  ),
  'wb_rotated8',
  'rotation returns the newly issued safe prefix'
);

SELECT ok(
  (
    SELECT
      pg_catalog.count(*) FILTER (WHERE status = 'active') = 1
      AND pg_catalog.count(*) FILTER (
        WHERE token_hash = repeat('7', 64)
          AND status = 'revoked'
          AND revoked_at IS NOT NULL
      ) = 1
      AND pg_catalog.count(*) FILTER (
        WHERE token_hash = repeat('8', 64)
          AND status = 'active'
          AND revoked_at IS NULL
      ) = 1
    FROM public.workbuddy_credentials
    WHERE student_id = (
      SELECT id
      FROM public.students
      WHERE user_id = '10000000-0000-0000-0000-000000000001'::uuid
    )
  ),
  'rotation atomically revokes every old active credential and leaves one active'
);

SELECT ok(
  (
    SELECT
      status.result ->> 'status' = 'active'
      AND status.result -> 'credential' ->> 'prefix' = 'wb_rotated8'
      AND NOT (status.result ? 'token_hash')
      AND NOT ((status.result -> 'credential') ? 'token_hash')
    FROM (
      SELECT public.get_workbuddy_credential_status(
        '10000000-0000-0000-0000-000000000001'::uuid
      ) AS result
    ) AS status
  ),
  'credential status never returns a token or hash'
);

INSERT INTO cloud_test_results (label, result)
VALUES (
  'revoked_credential',
  public.revoke_workbuddy_credential(
    '10000000-0000-0000-0000-000000000001'::uuid
  )
);

SELECT is(
  (
    SELECT result ->> 'status'
    FROM cloud_test_results
    WHERE label = 'revoked_credential'
  ),
  'revoked',
  'student can revoke the current credential'
);

SELECT is(
  (
    SELECT
      public.revoke_workbuddy_credential(
        '10000000-0000-0000-0000-000000000001'::uuid
      ) -> 'credential' ->> 'revoked_at'
  ),
  (
    SELECT result -> 'credential' ->> 'revoked_at'
    FROM cloud_test_results
    WHERE label = 'revoked_credential'
  ),
  'repeated revoke is idempotent and preserves the first revocation timestamp'
);

SELECT throws_ok(
  $test$
    SELECT public.get_workbuddy_credential_status(
      '10000000-0000-0000-0000-000000000101'::uuid
    )
  $test$,
  '42501',
  'student_identity_required',
  'service role cannot manage a staff identity as a student'
);

UPDATE public.timeline_items
SET created_at = '2026-07-23 12:00:00+00'::timestamptz
WHERE id IN (
  SELECT (result ->> 'message_id')::uuid
  FROM cloud_test_results
  WHERE label IN ('student_one_message', 'direct_mentor_message')
);

INSERT INTO cloud_test_results (label, result)
VALUES (
  'delivery_first_fetch',
  public.fetch_workbuddy_mentor_messages(
    (
      SELECT id
      FROM public.students
      WHERE user_id = '10000000-0000-0000-0000-000000000001'::uuid
    ),
    NULL,
    100,
    NULL,
    NULL
  )
);

SELECT ok(
  (
    SELECT
      pg_catalog.jsonb_array_length(result -> 'messages') = 2
      AND (result -> 'messages' -> 0 ->> 'created_at')
        = (result -> 'messages' -> 1 ->> 'created_at')
      AND (result -> 'messages' -> 0 ->> 'id')
        < (result -> 'messages' -> 1 ->> 'id')
      AND pg_catalog.bool_and(
        delivery.first_fetched_at IS NOT NULL
        AND delivery.last_fetched_at IS NOT NULL
        AND delivery.fetch_count = 1
      )
    FROM cloud_test_results
    CROSS JOIN public.mentor_message_deliveries AS delivery
    WHERE label = 'delivery_first_fetch'
      AND delivery.message_id IN (
        SELECT (message ->> 'id')::uuid
        FROM pg_catalog.jsonb_array_elements(result -> 'messages') AS message
      )
    GROUP BY result
  ),
  'first fetch is ordered by created_at and id and atomically initializes fetch state'
);

CREATE TEMP TABLE cloud_test_first_fetch_times
ON COMMIT DROP
AS
SELECT
  delivery.message_id,
  delivery.first_fetched_at
FROM public.mentor_message_deliveries AS delivery
WHERE delivery.message_id IN (
  SELECT (message ->> 'id')::uuid
  FROM cloud_test_results
  CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(result -> 'messages') AS message
  WHERE label = 'delivery_first_fetch'
);

INSERT INTO cloud_test_results (label, result)
VALUES (
  'delivery_repeat_fetch',
  public.fetch_workbuddy_mentor_messages(
    (
      SELECT id
      FROM public.students
      WHERE user_id = '10000000-0000-0000-0000-000000000001'::uuid
    ),
    NULL,
    100,
    NULL,
    NULL
  )
);

SELECT ok(
  (
    SELECT
      (
        SELECT pg_catalog.jsonb_agg(message ->> 'id' ORDER BY message ->> 'id')
        FROM pg_catalog.jsonb_array_elements(first.result -> 'messages') AS message
      ) = (
        SELECT pg_catalog.jsonb_agg(message ->> 'id' ORDER BY message ->> 'id')
        FROM pg_catalog.jsonb_array_elements(repeated.result -> 'messages') AS message
      )
      AND pg_catalog.bool_and(
        delivery.first_fetched_at = saved.first_fetched_at
        AND delivery.fetch_count = 2
      )
    FROM cloud_test_results AS first
    JOIN cloud_test_results AS repeated
      ON repeated.label = 'delivery_repeat_fetch'
    JOIN cloud_test_first_fetch_times AS saved
      ON true
    JOIN public.mentor_message_deliveries AS delivery
      ON delivery.message_id = saved.message_id
    WHERE first.label = 'delivery_first_fetch'
    GROUP BY first.result, repeated.result
  ),
  'repeat fetch returns the same unacknowledged messages and preserves first fetch time'
);

SELECT throws_ok(
  $test$
    SELECT public.fetch_workbuddy_mentor_messages(
      (
        SELECT id
        FROM public.students
        WHERE user_id = '10000000-0000-0000-0000-000000000001'::uuid
      ),
      (
        SELECT (result ->> 'session_id')::uuid
        FROM cloud_test_results
        WHERE label = 'student_two_ingest'
      )
    )
  $test$,
  'P4041',
  'workbuddy_session_not_owned',
  'session filter never accepts another student session'
);

INSERT INTO cloud_test_results (label, result)
SELECT
  'delivery_cursor_first',
  public.fetch_workbuddy_mentor_messages(
    (
      SELECT id
      FROM public.students
      WHERE user_id = '10000000-0000-0000-0000-000000000001'::uuid
    ),
    NULL,
    1,
    NULL,
    NULL
  );

INSERT INTO cloud_test_results (label, result)
SELECT
  'delivery_cursor_second',
  public.fetch_workbuddy_mentor_messages(
    (
      SELECT id
      FROM public.students
      WHERE user_id = '10000000-0000-0000-0000-000000000001'::uuid
    ),
    NULL,
    1,
    (first.result -> 'messages' -> 0 ->> 'created_at')::timestamptz,
    (first.result -> 'messages' -> 0 ->> 'id')::uuid
  )
FROM cloud_test_results AS first
WHERE first.label = 'delivery_cursor_first';

SELECT ok(
  (
    SELECT
      pg_catalog.jsonb_array_length(first.result -> 'messages') = 1
      AND pg_catalog.jsonb_array_length(second.result -> 'messages') = 1
      AND first.result -> 'messages' -> 0 ->> 'created_at'
        = second.result -> 'messages' -> 0 ->> 'created_at'
      AND first.result -> 'messages' -> 0 ->> 'id'
        < second.result -> 'messages' -> 0 ->> 'id'
    FROM cloud_test_results AS first
    JOIN cloud_test_results AS second
      ON second.label = 'delivery_cursor_second'
    WHERE first.label = 'delivery_cursor_first'
  ),
  'composite cursor retains messages that share an identical timestamp'
);

SELECT throws_ok(
  $test$
    SELECT public.ack_workbuddy_mentor_messages(
      (
        SELECT id
        FROM public.students
        WHERE user_id = '10000000-0000-0000-0000-000000000001'::uuid
      ),
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
    )
  $test$,
  'P4040',
  'workbuddy_delivery_not_owned',
  'mixed own and foreign acknowledgement IDs fail as one request'
);

SELECT ok(
  (
    SELECT pg_catalog.bool_and(delivery.acknowledged_at IS NULL)
    FROM public.mentor_message_deliveries AS delivery
    WHERE delivery.message_id IN (
      SELECT (result ->> 'message_id')::uuid
      FROM cloud_test_results
      WHERE label IN ('student_one_message', 'student_two_message')
    )
  ),
  'mixed acknowledgement failure makes no partial update'
);

INSERT INTO cloud_test_results (label, result)
VALUES (
  'delivery_first_ack',
  public.ack_workbuddy_mentor_messages(
    (
      SELECT id
      FROM public.students
      WHERE user_id = '10000000-0000-0000-0000-000000000001'::uuid
    ),
    ARRAY[
      (
        SELECT (result ->> 'message_id')::uuid
        FROM cloud_test_results
        WHERE label = 'student_one_message'
      )
    ]
  )
);

SELECT ok(
  (
    SELECT
      pg_catalog.jsonb_array_length(result -> 'acknowledged') = 1
      AND result -> 'acknowledged' -> 0 ->> 'acknowledged_at' IS NOT NULL
    FROM cloud_test_results
    WHERE label = 'delivery_first_ack'
  ),
  'owned message acknowledgement persists and returns its first timestamp'
);

SELECT is(
  (
    SELECT
      public.ack_workbuddy_mentor_messages(
        (
          SELECT id
          FROM public.students
          WHERE user_id = '10000000-0000-0000-0000-000000000001'::uuid
        ),
        ARRAY[
          (
            SELECT (result ->> 'message_id')::uuid
            FROM cloud_test_results
            WHERE label = 'student_one_message'
          )
        ]
      ) -> 'acknowledged' -> 0 ->> 'acknowledged_at'
  ),
  (
    SELECT result -> 'acknowledged' -> 0 ->> 'acknowledged_at'
    FROM cloud_test_results
    WHERE label = 'delivery_first_ack'
  ),
  'repeated acknowledgement is idempotent and preserves the first timestamp'
);

SELECT is(
  (
    SELECT pg_catalog.jsonb_array_length(result -> 'messages')
    FROM (
      SELECT public.fetch_workbuddy_mentor_messages(
        (
          SELECT id
          FROM public.students
          WHERE user_id = '10000000-0000-0000-0000-000000000001'::uuid
        ),
        (
          SELECT session_id
          FROM public.mentor_message_deliveries
          WHERE message_id = (
            SELECT (result ->> 'message_id')::uuid
            FROM cloud_test_results
            WHERE label = 'student_one_message'
          )
        ),
        100,
        NULL,
        NULL
      ) AS result
    ) AS fetched
  ),
  1,
  'fetch excludes acknowledged messages while retaining other pending session messages'
);

SELECT ok(
  (
    SELECT pg_catalog.bool_and(
      message ->> 'student_id' = student.id::text
    )
    FROM (
      SELECT public.fetch_workbuddy_mentor_messages(
        (
          SELECT id
          FROM public.students
          WHERE user_id = '10000000-0000-0000-0000-000000000002'::uuid
        ),
        NULL,
        100,
        NULL,
        NULL
      ) AS result
    ) AS fetched
    JOIN public.students AS student
      ON student.user_id = '10000000-0000-0000-0000-000000000002'::uuid
    CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(
      fetched.result -> 'messages'
    ) AS message
  ),
  'delivery fetch returns only the credential-owned student rows'
);

SELECT lives_ok(
  $test$
    SELECT public.create_mentor_message(
      '10000000-0000-0000-0000-000000000101'::uuid,
      (
        SELECT (result ->> 'session_id')::uuid
        FROM cloud_test_results
        WHERE label = 'first_ingest'
      ),
      pg_catalog.repeat('学', 8000),
      NULL
    )
  $test$,
  'service mentor creation accepts exactly 8000 Unicode characters'
);

SELECT throws_ok(
  $test$
    SELECT public.create_mentor_message(
      '10000000-0000-0000-0000-000000000101'::uuid,
      (
        SELECT (result ->> 'session_id')::uuid
        FROM cloud_test_results
        WHERE label = 'first_ingest'
      ),
      pg_catalog.repeat('学', 8001),
      NULL
    )
  $test$,
  '22023',
  'mentor_message_text_length_invalid',
  'service mentor creation rejects 8001 Unicode characters'
);

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub = '10000000-0000-0000-0000-000000000101';

SELECT lives_ok(
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
      pg_catalog.repeat('导', 8000),
      '10000000-0000-0000-0000-000000000101'::uuid
    )
  $test$,
  'authenticated mentor insert accepts exactly 8000 Unicode characters'
);

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
      pg_catalog.repeat('导', 8001),
      '10000000-0000-0000-0000-000000000101'::uuid
    )
  $test$,
  '22023',
  'mentor_message_text_length_invalid',
  'authenticated mentor insert rejects 8001 Unicode characters'
);

RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
