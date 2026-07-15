CREATE SCHEMA IF NOT EXISTS private;

CREATE OR REPLACE FUNCTION private.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles
    WHERE user_id = _user_id
      AND role = _role
  );
$$;

REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.has_role(uuid, public.app_role) FROM PUBLIC, anon, authenticated;

DROP POLICY IF EXISTS "students read own or mentor" ON public.students;
DROP POLICY IF EXISTS "students mentor manage" ON public.students;
DROP POLICY IF EXISTS "sessions read own or mentor" ON public.sessions;
DROP POLICY IF EXISTS "timeline read own or mentor" ON public.timeline_items;
DROP POLICY IF EXISTS "timeline mentor insert" ON public.timeline_items;

CREATE POLICY "students read own or mentor" ON public.students FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR private.has_role(auth.uid(),'mentor'));

CREATE POLICY "students mentor manage" ON public.students FOR ALL TO authenticated
  USING (private.has_role(auth.uid(),'mentor'))
  WITH CHECK (private.has_role(auth.uid(),'mentor'));

CREATE POLICY "sessions read own or mentor" ON public.sessions FOR SELECT TO authenticated
  USING (
    private.has_role(auth.uid(),'mentor')
    OR EXISTS (SELECT 1 FROM public.students s WHERE s.id = sessions.student_id AND s.user_id = auth.uid())
  );

CREATE POLICY "timeline read own or mentor" ON public.timeline_items FOR SELECT TO authenticated
  USING (
    private.has_role(auth.uid(),'mentor')
    OR EXISTS (
      SELECT 1 FROM public.sessions se
      JOIN public.students st ON st.id = se.student_id
      WHERE se.id = timeline_items.session_id AND st.user_id = auth.uid()
    )
  );

CREATE POLICY "timeline mentor insert" ON public.timeline_items FOR INSERT TO authenticated
  WITH CHECK (
    private.has_role(auth.uid(),'mentor')
    AND author_id = auth.uid()
    AND kind IN ('mentor','diagnosis')
  );

DROP FUNCTION IF EXISTS public.has_role(uuid, public.app_role);

REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_updated_at() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.on_timeline_insert() FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA private REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;