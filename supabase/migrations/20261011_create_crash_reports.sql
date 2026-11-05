CREATE TABLE IF NOT EXISTS public.crash_reports (
id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
error_type text NOT NULL DEFAULT 'flutter_error',
error_message text NOT NULL,
stack_trace text,
app_version text,
platform text,
user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
created_at timestamptz NOT NULL DEFAULT now(),
resolved boolean NOT NULL DEFAULT false,
ai_analysis text,
ai_suggested_fix text
);
ALTER TABLE public.crash_reports ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS crash_reports_created_at_idx
ON public.crash_reports (created_at DESC);
CREATE INDEX IF NOT EXISTS crash_reports_resolved_idx
ON public.crash_reports (resolved);
