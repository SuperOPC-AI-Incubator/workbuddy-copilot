ALTER TABLE public.students
  ADD COLUMN IF NOT EXISTS workbuddy_token TEXT UNIQUE
    DEFAULT ('wb_' || replace(replace(encode(gen_random_bytes(24), 'base64'), '/', '_'), '+', '-'));

UPDATE public.students
  SET workbuddy_token = ('wb_' || replace(replace(encode(gen_random_bytes(24), 'base64'), '/', '_'), '+', '-'))
  WHERE workbuddy_token IS NULL;

ALTER TABLE public.students ALTER COLUMN workbuddy_token SET NOT NULL;