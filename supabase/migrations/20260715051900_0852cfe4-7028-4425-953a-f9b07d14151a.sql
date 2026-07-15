DROP TRIGGER IF EXISTS set_students_updated_at ON public.students;
CREATE TRIGGER set_students_updated_at
BEFORE UPDATE ON public.students
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS set_sessions_updated_at ON public.sessions;
CREATE TRIGGER set_sessions_updated_at
BEFORE UPDATE ON public.sessions
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS timeline_items_after_insert ON public.timeline_items;
CREATE TRIGGER timeline_items_after_insert
AFTER INSERT ON public.timeline_items
FOR EACH ROW
EXECUTE FUNCTION public.on_timeline_insert();