
BEGIN;

-- Ensure RLS remains enabled
ALTER TABLE public.crash_reports
ENABLE ROW LEVEL SECURITY;

-- Remove all direct access from public roles
REVOKE ALL PRIVILEGES
ON TABLE public.crash_reports
FROM PUBLIC;

REVOKE ALL PRIVILEGES
ON TABLE public.crash_reports
FROM anon;

REVOKE ALL PRIVILEGES
ON TABLE public.crash_reports
FROM authenticated;

-- Give server-side service role only required permissions
GRANT SELECT, INSERT, UPDATE, DELETE
ON TABLE public.crash_reports
TO service_role;

COMMIT;
