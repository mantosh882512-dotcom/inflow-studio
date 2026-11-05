-- YouTube creator permission requests
CREATE TABLE IF NOT EXISTS public.youtube_permission_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    channel_url text NOT NULL,
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'rejected')),
    requested_at timestamptz NOT NULL DEFAULT now(),
    reviewed_at timestamptz,
    reviewed_by uuid REFERENCES auth.users(id),
    admin_note text
);

CREATE INDEX IF NOT EXISTS youtube_permission_user_status_idx
ON public.youtube_permission_requests(user_id, status);

CREATE INDEX IF NOT EXISTS youtube_permission_status_date_idx
ON public.youtube_permission_requests(status, requested_at DESC);

CREATE TABLE IF NOT EXISTS public.youtube_permission_action_logs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id uuid NOT NULL REFERENCES public.youtube_permission_requests(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    admin_id uuid NOT NULL REFERENCES auth.users(id),
    action text NOT NULL CHECK (action IN ('approved', 'rejected')),
    admin_note text,
    created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.youtube_permission_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.youtube_permission_action_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS youtube_permission_select_own
ON public.youtube_permission_requests;

CREATE POLICY youtube_permission_select_own
ON public.youtube_permission_requests
FOR SELECT TO authenticated
USING (auth.uid() = user_id);

-- Users cannot directly approve or modify requests.
REVOKE INSERT, UPDATE, DELETE
ON public.youtube_permission_requests
FROM anon, authenticated;

REVOKE ALL
ON public.youtube_permission_action_logs
FROM anon, authenticated;

-- Database-level protection: every YouTube URL requires approval,
-- regardless of the client-provided category.
CREATE OR REPLACE FUNCTION public.enforce_youtube_creator_permission()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.video_url ~* '^https?://([^/]+\.)?(youtube\.com|youtu\.be|youtube-nocookie\.com)([:/]|$)' THEN

        IF NEW.user_id IS NULL OR NOT EXISTS (
            SELECT 1
            FROM public.youtube_permission_requests r
            WHERE r.user_id = NEW.user_id
              AND r.status = 'approved'
        ) THEN
            RAISE EXCEPTION 'YouTube permission required. Please request admin approval first.'
                USING ERRCODE = '42501';
        END IF;

    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_youtube_creator_permission_trigger
ON public.videos;

CREATE TRIGGER enforce_youtube_creator_permission_trigger
BEFORE INSERT OR UPDATE OF video_url, user_id
ON public.videos
FOR EACH ROW
EXECUTE FUNCTION public.enforce_youtube_creator_permission();

GRANT SELECT
ON public.youtube_permission_requests
TO authenticated;
