-- GoTrue's admin createUser flow may persist raw_app_meta_data only after the
-- initial auth.users INSERT trigger has fired. The deterministic internal
-- staff email is already present at INSERT time, so use its exact versioned
-- shape as a second non-privileged signal to avoid transient student rows.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  provisioned_display_name text;
BEGIN
  IF NEW.raw_app_meta_data ->> 'account_kind' = 'staff'
    OR NEW.email ~ '^u1_[A-Za-z0-9_-]{43}@auth\.copilot\.sg\.superbrain-ai\.com$'
  THEN
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
