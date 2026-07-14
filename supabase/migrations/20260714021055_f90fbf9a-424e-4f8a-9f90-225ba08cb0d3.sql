
CREATE TYPE public.severity AS ENUM ('ok','warn','error');
CREATE TYPE public.timeline_kind AS ENUM ('prompt','reply','diagnosis','mentor');
CREATE TYPE public.session_group AS ENUM ('space','task');

CREATE TABLE public.students (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text NOT NULL,
  last_severity public.severity NOT NULL DEFAULT 'ok',
  last_active_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id uuid NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  session_title text NOT NULL,
  session_group public.session_group NOT NULL DEFAULT 'task',
  last_severity public.severity NOT NULL DEFAULT 'ok',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.timeline_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  kind public.timeline_kind NOT NULL,
  text text NOT NULL,
  severity public.severity,
  tag text,
  author_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.students TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sessions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.timeline_items TO authenticated;
GRANT ALL ON public.students TO service_role;
GRANT ALL ON public.sessions TO service_role;
GRANT ALL ON public.timeline_items TO service_role;

ALTER TABLE public.students ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.timeline_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth read students" ON public.students FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth write students" ON public.students FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "auth update students" ON public.students FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth delete students" ON public.students FOR DELETE TO authenticated USING (true);

CREATE POLICY "auth read sessions" ON public.sessions FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth write sessions" ON public.sessions FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "auth update sessions" ON public.sessions FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth delete sessions" ON public.sessions FOR DELETE TO authenticated USING (true);

CREATE POLICY "auth read timeline" ON public.timeline_items FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth write timeline" ON public.timeline_items FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "auth update timeline" ON public.timeline_items FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth delete timeline" ON public.timeline_items FOR DELETE TO authenticated USING (true);

CREATE OR REPLACE FUNCTION public.set_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER trg_students_updated BEFORE UPDATE ON public.students FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_sessions_updated BEFORE UPDATE ON public.sessions FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE OR REPLACE FUNCTION public.on_timeline_insert() RETURNS TRIGGER AS $$
BEGIN
  UPDATE public.sessions SET updated_at = now(),
    last_severity = COALESCE(NEW.severity, last_severity)
    WHERE id = NEW.session_id;
  UPDATE public.students SET last_active_at = now(),
    last_severity = COALESCE(NEW.severity, last_severity)
    WHERE id = (SELECT student_id FROM public.sessions WHERE id = NEW.session_id);
  RETURN NEW;
END; $$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER trg_timeline_insert AFTER INSERT ON public.timeline_items
  FOR EACH ROW EXECUTE FUNCTION public.on_timeline_insert();

ALTER PUBLICATION supabase_realtime ADD TABLE public.students;
ALTER PUBLICATION supabase_realtime ADD TABLE public.sessions;
ALTER PUBLICATION supabase_realtime ADD TABLE public.timeline_items;
ALTER TABLE public.students REPLICA IDENTITY FULL;
ALTER TABLE public.sessions REPLICA IDENTITY FULL;
ALTER TABLE public.timeline_items REPLICA IDENTITY FULL;

DO $seed$
DECLARE s_id uuid; sess_id uuid;
BEGIN
  INSERT INTO public.students (display_name, last_severity) VALUES ('陈子墨','warn') RETURNING id INTO s_id;
  INSERT INTO public.sessions (student_id, session_title, session_group, last_severity)
    VALUES (s_id, '梯形图 · 电机启停互锁', 'task', 'warn') RETURNING id INTO sess_id;
  INSERT INTO public.timeline_items (session_id, kind, text, severity, tag) VALUES
    (sess_id, 'prompt', '老师，我用 SET/RESET 做电机启停互锁，按启动键后停止键按下没反应，是不是扫描周期的问题？', NULL, NULL),
    (sess_id, 'reply', 'SET/RESET 组合优先级取决于程序段的先后。建议改用自保持回路（Start ANDN Stop OR Q），把 Stop 放在与门前。', NULL, NULL),
    (sess_id, 'diagnosis', '学员对『扫描周期 vs 逻辑优先级』概念混淆，倾向归因到硬件层。建议引导画一次扫描周期时序图。', 'warn', '概念混淆');

  INSERT INTO public.students (display_name, last_severity) VALUES ('李澜舟','error') RETURNING id INTO s_id;
  INSERT INTO public.sessions (student_id, session_title, session_group, last_severity)
    VALUES (s_id, 'ST · 温度 PID 调参', 'task', 'error') RETURNING id INTO sess_id;
  INSERT INTO public.timeline_items (session_id, kind, text, severity, tag) VALUES
    (sess_id, 'prompt', 'PID 输出一直饱和在 100%，Kp 已经降到 0.3 了还是不行。', NULL, NULL),
    (sess_id, 'reply', '先检查采样是否稳定：如果反馈存在阶跃噪声，积分项会持续累积。可以先关闭 Ki 只用 P 观察响应。', NULL, NULL),
    (sess_id, 'diagnosis', '积分饱和 (Integral Windup) 高置信度。建议启用抗饱和逻辑，Ti 从 60s 起调。', 'error', '积分饱和');

  INSERT INTO public.students (display_name, last_severity) VALUES ('王思远','ok') RETURNING id INTO s_id;
  INSERT INTO public.sessions (student_id, session_title, session_group)
    VALUES (s_id, 'IEC 61131-3 数据类型', 'space') RETURNING id INTO sess_id;
  INSERT INTO public.timeline_items (session_id, kind, text, severity, tag) VALUES
    (sess_id, 'prompt', 'REAL 和 LREAL 在实际项目里怎么选？', NULL, NULL),
    (sess_id, 'reply', '常规工艺量（温度、压力、流量）REAL 精度足够；能耗/计量、长时间积分建议 LREAL 避免累计误差。', NULL, NULL),
    (sess_id, 'diagnosis', '掌握良好：能主动追问精度权衡，可推进到浮点异常与 NaN 传播章节。', 'ok', '进阶就绪');

  INSERT INTO public.students (display_name, last_severity) VALUES ('赵一凡','ok');
  INSERT INTO public.students (display_name, last_severity) VALUES ('刘明轩','warn');
END
$seed$;
