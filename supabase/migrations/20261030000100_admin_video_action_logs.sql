CREATE TABLE IF NOT EXISTS public.admin_video_action_logs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_user_id uuid NOT NULL REFERENCES auth.users(id),
  video_id uuid REFERENCES public.videos(id),
  report_id bigint REFERENCES public.video_reports(id),
  action text NOT NULL CHECK (
    action IN (
      'report_reviewing',
      'report_resolved',
      'report_rejected',
      'video_visibility'
    )
  ),
  old_value text,
  new_value text,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.admin_video_action_logs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.admin_video_action_logs FROM anon, authenticated;
GRANT ALL ON public.admin_video_action_logs TO service_role;
