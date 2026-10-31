-- Public-safe function: exposes only the channel verification status.
CREATE OR REPLACE FUNCTION public.get_channel_verification_status(
    p_channel_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT COALESCE(
        (
            SELECT cm.is_verified
            FROM public.channel_moderation AS cm
            WHERE cm.channel_id = p_channel_id
        ),
        false
    );
$$;

REVOKE ALL ON FUNCTION public.get_channel_verification_status(uuid)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.get_channel_verification_status(uuid)
TO anon, authenticated, service_role;
