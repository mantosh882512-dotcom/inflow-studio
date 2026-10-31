-- Channel moderation state is kept separate from profiles and auth.users.
CREATE TABLE public.channel_moderation (
    channel_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
    is_verified boolean NOT NULL DEFAULT false,
    is_suspended boolean NOT NULL DEFAULT false,
    suspension_reason text,
    updated_by uuid REFERENCES auth.users(id),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT channel_suspension_reason_length
        CHECK (suspension_reason IS NULL OR length(suspension_reason) <= 500)
);

ALTER TABLE public.channel_moderation ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.channel_moderation FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.channel_moderation TO service_role;

-- Public-safe helper for RLS and discovery functions.
CREATE OR REPLACE FUNCTION public.is_channel_suspended(p_channel_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT COALESCE(
        (
            SELECT cm.is_suspended
            FROM public.channel_moderation AS cm
            WHERE cm.channel_id = p_channel_id
        ),
        false
    );
$$;

REVOKE ALL ON FUNCTION public.is_channel_suspended(uuid)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.is_channel_suspended(uuid)
TO anon, authenticated, service_role;

-- Audit log for channel verification and suspension actions.
CREATE TABLE public.admin_channel_action_logs (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    actor_user_id uuid NOT NULL REFERENCES auth.users(id),
    channel_id uuid NOT NULL REFERENCES public.profiles(id),
    action text NOT NULL CHECK (
        action IN ('channel_verified', 'channel_unverified',
                   'channel_suspended', 'channel_restored')
    ),
    old_value text,
    new_value text,
    reason text,
    created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.admin_channel_action_logs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.admin_channel_action_logs FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.admin_channel_action_logs TO service_role;

-- Atomic channel moderation action.
CREATE OR REPLACE FUNCTION public.admin_apply_channel_action(
    p_actor_user_id uuid,
    p_channel_id uuid,
    p_action text,
    p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_old_value text;
    v_new_value text;
    v_reason text;
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM public.studio_admins
        WHERE user_id = p_actor_user_id
    ) THEN
        RETURN jsonb_build_object('success', false, 'error', 'Forbidden');
    END IF;

    IF p_channel_id IS NULL OR p_action IS NULL OR p_action NOT IN (
        'verify_channel', 'unverify_channel',
        'suspend_channel', 'restore_channel'
    ) THEN
        RETURN jsonb_build_object('success', false, 'error', 'Invalid channel action');
    END IF;

    IF p_reason IS NOT NULL AND length(p_reason) > 500 THEN
        RETURN jsonb_build_object('success', false, 'error', 'Reason must be 500 characters or fewer');
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM public.profiles WHERE id = p_channel_id
    ) THEN
        RETURN jsonb_build_object('success', false, 'error', 'Channel not found');
    END IF;

    INSERT INTO public.channel_moderation (channel_id)
    VALUES (p_channel_id)
    ON CONFLICT (channel_id) DO NOTHING;

    SELECT CASE
        WHEN p_action IN ('verify_channel', 'unverify_channel')
            THEN is_verified::text
        ELSE is_suspended::text
    END
    INTO v_old_value
    FROM public.channel_moderation
    WHERE channel_id = p_channel_id
    FOR UPDATE;

    v_new_value := CASE p_action
        WHEN 'verify_channel' THEN 'true'
        WHEN 'unverify_channel' THEN 'false'
        WHEN 'suspend_channel' THEN 'true'
        WHEN 'restore_channel' THEN 'false'
    END;

    IF v_old_value = v_new_value THEN
        RETURN jsonb_build_object('success', false, 'error', 'Channel already has this status');
    END IF;

    v_reason := NULLIF(trim(p_reason), '');

    UPDATE public.channel_moderation
    SET
        is_verified = CASE
            WHEN p_action IN ('verify_channel', 'unverify_channel')
                THEN v_new_value::boolean
            ELSE is_verified
        END,
        is_suspended = CASE
            WHEN p_action IN ('suspend_channel', 'restore_channel')
                THEN v_new_value::boolean
            ELSE is_suspended
        END,
        suspension_reason = CASE
            WHEN p_action = 'suspend_channel' THEN v_reason
            WHEN p_action = 'restore_channel' THEN NULL
            ELSE suspension_reason
        END,
        updated_by = p_actor_user_id,
        updated_at = now()
    WHERE channel_id = p_channel_id;

    INSERT INTO public.admin_channel_action_logs (
        actor_user_id, channel_id, action, old_value, new_value, reason
    )
    VALUES (
        p_actor_user_id,
        p_channel_id,
        CASE p_action
            WHEN 'verify_channel' THEN 'channel_verified'
            WHEN 'unverify_channel' THEN 'channel_unverified'
            WHEN 'suspend_channel' THEN 'channel_suspended'
            WHEN 'restore_channel' THEN 'channel_restored'
        END,
        v_old_value,
        v_new_value,
        v_reason
    );

    RETURN jsonb_build_object(
        'success', true,
        'actionApplied', true,
        'auditLogged', true,
        'channelId', p_channel_id,
        'action', p_action,
        'value', v_new_value
    );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_apply_channel_action(uuid, uuid, text, text)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.admin_apply_channel_action(uuid, uuid, text, text)
TO service_role;

-- Public channel discovery excludes suspended channels.
CREATE OR REPLACE FUNCTION public.get_public_profiles()
RETURNS TABLE(
    id uuid,
    full_name text,
    username text,
    avatar_url text,
    banner_url text,
    description text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT
        p.id,
        p.full_name,
        p.username,
        p.avatar_url,
        p.banner_url,
        p.description
    FROM public.profiles AS p
    WHERE NOT public.is_channel_suspended(p.id);
$$;

-- Public video access excludes suspended channels.
-- Owners can still access their own videos.
DROP POLICY IF EXISTS videos_select_policy ON public.videos;

CREATE POLICY videos_select_policy
ON public.videos
FOR SELECT
USING (
    auth.uid() = user_id
    OR (
        lower(visibility) = 'public'
        AND NOT public.is_channel_suspended(user_id)
    )
);

-- Remove duplicate permissive subscription INSERT policies.
DROP POLICY IF EXISTS "Inflow insert own subscriptions" ON public.subscriptions;
DROP POLICY IF EXISTS subscriptions_insert_policy ON public.subscriptions;

CREATE POLICY subscriptions_insert_policy
ON public.subscriptions
FOR INSERT
WITH CHECK (
    auth.uid() = subscriber_id
    AND auth.uid() <> creator_id
    AND NOT public.is_channel_suspended(creator_id)
);
