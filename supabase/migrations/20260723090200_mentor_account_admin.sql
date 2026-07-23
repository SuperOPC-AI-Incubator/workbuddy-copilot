-- Cross-system mentor-account mutations use row-owned operation tokens. Auth
-- changes happen outside PostgreSQL, so database state is fail-closed until the
-- service confirms the exact operation/version it observed.
ALTER TABLE public.staff_accounts
  ADD COLUMN password_reset_operation_token uuid,
  ADD COLUMN password_reset_previous_must_change boolean,
  ADD COLUMN active_operation_token uuid,
  ADD COLUMN active_operation_desired boolean,
  ADD COLUMN active_state_version bigint NOT NULL DEFAULT 0,
  ADD CONSTRAINT staff_accounts_password_reset_operation_check
    CHECK (
      (password_reset_operation_token IS NULL
        AND password_reset_previous_must_change IS NULL)
      OR
      (password_reset_operation_token IS NOT NULL
        AND password_reset_previous_must_change IS NOT NULL)
    ),
  ADD CONSTRAINT staff_accounts_active_operation_check
    CHECK (
      (active_operation_token IS NULL AND active_operation_desired IS NULL)
      OR
      (active_operation_token IS NOT NULL AND active_operation_desired IS NOT NULL)
    );

CREATE OR REPLACE FUNCTION public.admin_begin_staff_active_operation(
  _actor_user_id uuid,
  _target_user_id uuid,
  _is_active boolean,
  _operation_token uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  target_account public.staff_accounts%ROWTYPE;
  active_admin_count integer;
BEGIN
  IF _actor_user_id IS NULL
    OR _target_user_id IS NULL
    OR _is_active IS NULL
    OR _operation_token IS NULL
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22004',
      MESSAGE = 'staff_admin_state_input_required';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('mentor-admin-state', 0)
  );

  SELECT target.*
  INTO target_account
  FROM public.staff_accounts AS target
  WHERE target.user_id = _target_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'staff_account_not_found';
  END IF;

  IF NOT _is_active AND _actor_user_id = _target_user_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'staff_self_disable_forbidden';
  END IF;

  -- This invariant is deliberately evaluated before actor authorization. The
  -- RPC is service-role-only, while the service has already authorized the
  -- actor. Keeping the invariant first also permits a distinct-actor pgTAP
  -- negative control when the target is the sole usable team administrator.
  IF NOT _is_active
    AND target_account.is_active
    AND target_account.must_change_password = false
    AND EXISTS (
      SELECT 1
      FROM public.user_roles AS target_role
      WHERE target_role.user_id = _target_user_id
        AND target_role.role = 'team_admin'::public.app_role
    )
  THEN
    SELECT pg_catalog.count(*)::integer
    INTO active_admin_count
    FROM public.staff_accounts AS active_admin
    JOIN public.user_roles AS active_admin_role
      ON active_admin_role.user_id = active_admin.user_id
    WHERE active_admin.is_active = true
      AND active_admin.must_change_password = false
      AND active_admin_role.role = 'team_admin'::public.app_role;

    IF active_admin_count <= 1 THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'last_active_team_admin_required';
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.staff_accounts AS actor
    JOIN public.user_roles AS actor_role
      ON actor_role.user_id = actor.user_id
    WHERE actor.user_id = _actor_user_id
      AND actor.is_active = true
      AND actor.must_change_password = false
      AND actor_role.role = 'team_admin'::public.app_role
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'staff_admin_forbidden';
  END IF;

  UPDATE public.staff_accounts
  SET
    active_operation_token = _operation_token,
    active_operation_desired = _is_active,
    active_state_version = active_state_version + 1,
    is_active = false,
    disabled_at = CASE
      WHEN disabled_at IS NULL THEN pg_catalog.now()
      ELSE disabled_at
    END,
    disabled_by = CASE
      WHEN disabled_by IS NULL THEN _actor_user_id
      ELSE disabled_by
    END
  WHERE user_id = _target_user_id;

  RETURN pg_catalog.jsonb_build_object(
    'user_id', _target_user_id,
    'previous_active', target_account.is_active,
    'desired_active', _is_active,
    'operation_token', _operation_token,
    'version', target_account.active_state_version + 1
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_begin_staff_active_operation(
  uuid,
  uuid,
  boolean,
  uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_begin_staff_active_operation(
  uuid,
  uuid,
  boolean,
  uuid
) TO service_role;

CREATE OR REPLACE FUNCTION public.admin_get_staff_active_sync_state(
  _actor_user_id uuid,
  _target_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  target_account public.staff_accounts%ROWTYPE;
BEGIN
  IF _actor_user_id IS NULL OR _target_user_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22004',
      MESSAGE = 'staff_admin_state_input_required';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.staff_accounts AS actor
    JOIN public.user_roles AS actor_role
      ON actor_role.user_id = actor.user_id
    WHERE actor.user_id = _actor_user_id
      AND actor.is_active = true
      AND actor.must_change_password = false
      AND actor_role.role = 'team_admin'::public.app_role
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'staff_admin_forbidden';
  END IF;

  SELECT target.*
  INTO target_account
  FROM public.staff_accounts AS target
  WHERE target.user_id = _target_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'staff_account_not_found';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'user_id', _target_user_id,
    'version', target_account.active_state_version,
    'operation_token', target_account.active_operation_token,
    'desired_active', COALESCE(
      target_account.active_operation_desired,
      target_account.is_active
    )
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_get_staff_active_sync_state(
  uuid,
  uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_get_staff_active_sync_state(
  uuid,
  uuid
) TO service_role;

CREATE OR REPLACE FUNCTION public.admin_confirm_staff_active_sync(
  _actor_user_id uuid,
  _target_user_id uuid,
  _observed_version bigint,
  _operation_token uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  target_account public.staff_accounts%ROWTYPE;
  confirmed_active boolean;
BEGIN
  IF _actor_user_id IS NULL
    OR _target_user_id IS NULL
    OR _observed_version IS NULL
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22004',
      MESSAGE = 'staff_admin_state_input_required';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.staff_accounts AS actor
    JOIN public.user_roles AS actor_role
      ON actor_role.user_id = actor.user_id
    WHERE actor.user_id = _actor_user_id
      AND actor.is_active = true
      AND actor.must_change_password = false
      AND actor_role.role = 'team_admin'::public.app_role
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'staff_admin_forbidden';
  END IF;

  SELECT target.*
  INTO target_account
  FROM public.staff_accounts AS target
  WHERE target.user_id = _target_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'staff_account_not_found';
  END IF;

  IF target_account.active_state_version <> _observed_version
    OR target_account.active_operation_token IS DISTINCT FROM _operation_token
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'confirmed', false,
      'active', target_account.is_active
    );
  END IF;

  IF target_account.active_operation_token IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'confirmed', true,
      'active', target_account.is_active
    );
  END IF;

  confirmed_active := target_account.active_operation_desired;

  UPDATE public.staff_accounts
  SET
    is_active = confirmed_active,
    disabled_at = CASE
      WHEN confirmed_active THEN NULL
      ELSE COALESCE(disabled_at, pg_catalog.now())
    END,
    disabled_by = CASE
      WHEN confirmed_active THEN NULL
      ELSE COALESCE(disabled_by, _actor_user_id)
    END,
    active_operation_token = NULL,
    active_operation_desired = NULL,
    active_state_version = active_state_version + 1
  WHERE user_id = _target_user_id;

  RETURN pg_catalog.jsonb_build_object(
    'confirmed', true,
    'active', confirmed_active
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_confirm_staff_active_sync(
  uuid,
  uuid,
  bigint,
  uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_confirm_staff_active_sync(
  uuid,
  uuid,
  bigint,
  uuid
) TO service_role;

CREATE OR REPLACE FUNCTION public.admin_begin_staff_password_reset(
  _actor_user_id uuid,
  _target_user_id uuid,
  _operation_token uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  target_account public.staff_accounts%ROWTYPE;
  active_admin_count integer;
BEGIN
  IF _actor_user_id IS NULL
    OR _target_user_id IS NULL
    OR _operation_token IS NULL
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22004',
      MESSAGE = 'staff_admin_password_state_input_required';
  END IF;

  IF _actor_user_id = _target_user_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'staff_self_password_reset_forbidden';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('mentor-admin-state', 0)
  );

  IF NOT EXISTS (
    SELECT 1
    FROM public.staff_accounts AS actor
    JOIN public.user_roles AS actor_role
      ON actor_role.user_id = actor.user_id
    WHERE actor.user_id = _actor_user_id
      AND actor.is_active = true
      AND actor.must_change_password = false
      AND actor_role.role = 'team_admin'::public.app_role
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'staff_admin_forbidden';
  END IF;

  SELECT target.*
  INTO target_account
  FROM public.staff_accounts AS target
  WHERE target.user_id = _target_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'staff_account_not_found';
  END IF;

  IF target_account.is_active
    AND target_account.must_change_password = false
    AND EXISTS (
      SELECT 1
      FROM public.user_roles AS target_role
      WHERE target_role.user_id = _target_user_id
        AND target_role.role = 'team_admin'::public.app_role
    )
  THEN
    SELECT pg_catalog.count(*)::integer
    INTO active_admin_count
    FROM public.staff_accounts AS active_admin
    JOIN public.user_roles AS active_admin_role
      ON active_admin_role.user_id = active_admin.user_id
    WHERE active_admin.is_active = true
      AND active_admin.must_change_password = false
      AND active_admin_role.role = 'team_admin'::public.app_role;

    IF active_admin_count <= 1 THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'last_active_team_admin_required';
    END IF;
  END IF;

  UPDATE public.staff_accounts
  SET
    must_change_password = true,
    password_reset_operation_token = _operation_token,
    password_reset_previous_must_change = target_account.must_change_password
  WHERE user_id = _target_user_id;

  RETURN pg_catalog.jsonb_build_object(
    'user_id', _target_user_id,
    'previous_value', target_account.must_change_password,
    'operation_token', _operation_token
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_begin_staff_password_reset(
  uuid,
  uuid,
  uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_begin_staff_password_reset(
  uuid,
  uuid,
  uuid
) TO service_role;

CREATE OR REPLACE FUNCTION public.admin_finish_staff_password_reset(
  _actor_user_id uuid,
  _target_user_id uuid,
  _operation_token uuid,
  _succeeded boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  target_account public.staff_accounts%ROWTYPE;
BEGIN
  IF _actor_user_id IS NULL
    OR _target_user_id IS NULL
    OR _operation_token IS NULL
    OR _succeeded IS NULL
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22004',
      MESSAGE = 'staff_admin_password_state_input_required';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.staff_accounts AS actor
    JOIN public.user_roles AS actor_role
      ON actor_role.user_id = actor.user_id
    WHERE actor.user_id = _actor_user_id
      AND actor.is_active = true
      AND actor.must_change_password = false
      AND actor_role.role = 'team_admin'::public.app_role
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'staff_admin_forbidden';
  END IF;

  SELECT target.*
  INTO target_account
  FROM public.staff_accounts AS target
  WHERE target.user_id = _target_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'staff_account_not_found';
  END IF;

  IF target_account.password_reset_operation_token IS DISTINCT FROM _operation_token
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'applied', false,
      'must_change_password', target_account.must_change_password
    );
  END IF;

  UPDATE public.staff_accounts
  SET
    must_change_password = CASE
      WHEN _succeeded THEN true
      ELSE target_account.password_reset_previous_must_change
    END,
    password_reset_operation_token = NULL,
    password_reset_previous_must_change = NULL
  WHERE user_id = _target_user_id;

  RETURN pg_catalog.jsonb_build_object(
    'applied', true,
    'must_change_password', CASE
      WHEN _succeeded THEN true
      ELSE target_account.password_reset_previous_must_change
    END
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_finish_staff_password_reset(
  uuid,
  uuid,
  uuid,
  boolean
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_finish_staff_password_reset(
  uuid,
  uuid,
  uuid,
  boolean
) TO service_role;
