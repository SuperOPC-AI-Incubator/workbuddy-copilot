
-- Roles
CREATE TYPE public.app_role AS ENUM ('mentor','student');

CREATE TABLE public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);
GRANT SELECT ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "read own roles" ON public.user_roles FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role);
$$;

-- Link a student record to an auth user
ALTER TABLE public.students ADD COLUMN user_id uuid UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE;

-- Auto-provision role + student profile on signup
CREATE OR REPLACE FUNCTION public.handle_new_user() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _role public.app_role;
  _display text;
BEGIN
  _role := COALESCE(NULLIF(NEW.raw_user_meta_data ->> 'role','')::public.app_role, 'student');
  _display := COALESCE(NULLIF(NEW.raw_user_meta_data ->> 'display_name',''), split_part(NEW.email, '@', 1));
  INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, _role)
    ON CONFLICT (user_id, role) DO NOTHING;
  IF _role = 'student' THEN
    INSERT INTO public.students (user_id, display_name) VALUES (NEW.id, _display)
      ON CONFLICT (user_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Replace permissive policies with role-scoped ones
DROP POLICY IF EXISTS "auth read students" ON public.students;
DROP POLICY IF EXISTS "auth write students" ON public.students;
DROP POLICY IF EXISTS "auth update students" ON public.students;
DROP POLICY IF EXISTS "auth delete students" ON public.students;

CREATE POLICY "students read own or mentor" ON public.students FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.has_role(auth.uid(),'mentor'));
CREATE POLICY "students update self" ON public.students FOR UPDATE TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY "students mentor manage" ON public.students FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'mentor'))
  WITH CHECK (public.has_role(auth.uid(),'mentor'));

DROP POLICY IF EXISTS "auth read sessions" ON public.sessions;
DROP POLICY IF EXISTS "auth write sessions" ON public.sessions;
DROP POLICY IF EXISTS "auth update sessions" ON public.sessions;
DROP POLICY IF EXISTS "auth delete sessions" ON public.sessions;

CREATE POLICY "sessions read own or mentor" ON public.sessions FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(),'mentor')
    OR EXISTS (SELECT 1 FROM public.students s WHERE s.id = sessions.student_id AND s.user_id = auth.uid())
  );
CREATE POLICY "sessions owner insert" ON public.sessions FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.students s WHERE s.id = student_id AND s.user_id = auth.uid())
  );
CREATE POLICY "sessions owner update" ON public.sessions FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.students s WHERE s.id = student_id AND s.user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.students s WHERE s.id = student_id AND s.user_id = auth.uid()));
CREATE POLICY "sessions owner delete" ON public.sessions FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.students s WHERE s.id = student_id AND s.user_id = auth.uid()));

DROP POLICY IF EXISTS "auth read timeline" ON public.timeline_items;
DROP POLICY IF EXISTS "auth write timeline" ON public.timeline_items;
DROP POLICY IF EXISTS "auth update timeline" ON public.timeline_items;
DROP POLICY IF EXISTS "auth delete timeline" ON public.timeline_items;

CREATE POLICY "timeline read own or mentor" ON public.timeline_items FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(),'mentor')
    OR EXISTS (
      SELECT 1 FROM public.sessions se
      JOIN public.students st ON st.id = se.student_id
      WHERE se.id = timeline_items.session_id AND st.user_id = auth.uid()
    )
  );
CREATE POLICY "timeline student insert own session" ON public.timeline_items FOR INSERT TO authenticated
  WITH CHECK (
    author_id = auth.uid()
    AND kind IN ('prompt','reply','diagnosis')
    AND EXISTS (
      SELECT 1 FROM public.sessions se
      JOIN public.students st ON st.id = se.student_id
      WHERE se.id = session_id AND st.user_id = auth.uid()
    )
  );
CREATE POLICY "timeline mentor insert" ON public.timeline_items FOR INSERT TO authenticated
  WITH CHECK (
    public.has_role(auth.uid(),'mentor')
    AND author_id = auth.uid()
    AND kind IN ('mentor','diagnosis')
  );
CREATE POLICY "timeline author delete" ON public.timeline_items FOR DELETE TO authenticated
  USING (author_id = auth.uid());
