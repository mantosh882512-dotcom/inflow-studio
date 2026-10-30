CREATE OR REPLACE FUNCTION public.admin_apply_video_action(
  p_actor_user_id uuid,
  p_action text,
  p_report_id bigint DEFAULT NULL,
  p_video_id uuid DEFAULT NULL,
  p_value text DEFAULT NULL,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_report public.video_reports%ROWTYPE;
  v_video public.videos%ROWTYPE;
  v_old_value text;
  v_log_action text;
  v_audit_video_id uuid;
BEGIN
  -- Verify that the actor is an authorized Super Admin.
  IF NOT EXISTS (
    SELECT 1
    FROM public.studio_admins
    WHERE user_id = p_actor_user_id
  ) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Forbidden'
    );
  END IF;

  IF p_reason IS NOT NULL AND length(p_reason) > 500 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Reason must be 500 characters or fewer'
    );
  END IF;

  -- Report moderation.
  IF p_action = 'set_report_status' THEN
    IF p_report_id IS NULL
       OR p_value IS NULL
       OR p_value NOT IN ('reviewing', 'resolved', 'rejected') THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'Invalid report action'
      );
    END IF;

    SELECT *
    INTO v_report
    FROM public.video_reports
    WHERE id = p_report_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'Report not found'
      );
    END IF;

    v_old_value := lower(coalesce(v_report.status, ''));

    IF NOT (
      (v_old_value = 'pending'
        AND p_value IN ('reviewing', 'resolved', 'rejected'))
      OR
      (v_old_value = 'reviewing'
        AND p_value IN ('resolved', 'rejected'))
    ) THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'This report status transition is not allowed',
        'currentStatus', v_old_value
      );
    END IF;

    UPDATE public.video_reports
    SET status = p_value
    WHERE id = p_report_id;

    v_log_action := CASE p_value
      WHEN 'reviewing' THEN 'report_reviewing'
      WHEN 'resolved' THEN 'report_resolved'
      WHEN 'rejected' THEN 'report_rejected'
    END;

    IF v_report.video_id ~*
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    THEN
      v_audit_video_id := v_report.video_id::uuid;
    ELSE
      v_audit_video_id := NULL;
    END IF;

    INSERT INTO public.admin_video_action_logs (
      actor_user_id,
      video_id,
      report_id,
      action,
      old_value,
      new_value,
      reason
    )
    VALUES (
      p_actor_user_id,
      v_audit_video_id,
      p_report_id,
      v_log_action,
      v_report.status,
      p_value,
      p_reason
    );

    RETURN jsonb_build_object(
      'success', true,
      'actionApplied', true,
      'auditLogged', true,
      'reportId', p_report_id,
      'status', p_value
    );

  -- Video visibility.
  ELSIF p_action = 'set_video_visibility' THEN
    IF p_video_id IS NULL
       OR p_value IS NULL
       OR p_value NOT IN ('Public', 'Private') THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'Invalid video visibility action'
      );
    END IF;

    SELECT *
    INTO v_video
    FROM public.videos
    WHERE id = p_video_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'Video not found'
      );
    END IF;

    IF v_video.visibility IS NOT DISTINCT FROM p_value THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'Video already has this visibility'
      );
    END IF;

    UPDATE public.videos
    SET visibility = p_value
    WHERE id = p_video_id;

    INSERT INTO public.admin_video_action_logs (
      actor_user_id,
      video_id,
      action,
      old_value,
      new_value,
      reason
    )
    VALUES (
      p_actor_user_id,
      p_video_id,
      'video_visibility',
      v_video.visibility,
      p_value,
      p_reason
    );

    RETURN jsonb_build_object(
      'success', true,
      'actionApplied', true,
      'auditLogged', true,
      'videoId', p_video_id,
      'visibility', p_value
    );
  END IF;

  RETURN jsonb_build_object(
    'success', false,
    'error', 'Unsupported action'
  );
END;
$$;

-- Only the Edge Function's service role may execute this RPC.
REVOKE ALL ON FUNCTION public.admin_apply_video_action(
  uuid, text, bigint, uuid, text, text
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.admin_apply_video_action(
  uuid, text, bigint, uuid, text, text
) TO service_role;
