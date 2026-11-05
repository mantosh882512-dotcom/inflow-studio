import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

function clean(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;

  return value
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/(access_token|refresh_token|service_role|password)\s*[:=]\s*["']?[^"'\s,}]+/gi, "$1=[REDACTED]")
    .slice(0, max)
    .trim() || null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return response({ success: true });
  }

  if (req.method !== "POST") {
    return response({ error: "Method not allowed" }, 405);
  }

  try {
    const url = Deno.env.get("SUPABASE_URL");
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!url || !key) {
      return response({ error: "Server configuration error" }, 500);
    }

    const auth = req.headers.get("Authorization");

    if (!auth?.startsWith("Bearer ")) {
      return response({ error: "Authentication required" }, 401);
    }

    const adminClient = createClient(url, key, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });

    const { data: { user }, error: authError } =
      await adminClient.auth.getUser(auth.substring(7).trim());

    if (authError || !user) {
      return response({ error: "Invalid session" }, 401);
    }

    const payload = await req.json();

    const errorMessage = clean(payload.error_message, 4000);

    if (!errorMessage) {
      return response({ error: "Error message required" }, 400);
    }

    const report = {
      user_id: user.id,
      error_type: clean(payload.error_type, 100) ?? "flutter_error",
      error_message: errorMessage,
      stack_trace: clean(payload.stack_trace, 10000),
      platform: clean(payload.platform, 50),
      app_version: clean(payload.app_version, 50),
    };

    const { data, error } = await adminClient
      .from("crash_reports")
      .insert(report)
      .select("id")
      .single();

    if (error) {
      console.error("Crash report insert failed:", error.message);
      return response({ error: "Unable to save crash report" }, 500);
    }

    return response({
      success: true,
      reportId: data.id,
    }, 201);

  } catch (error) {
    console.error("Crash reporting error:", error);
    return response({ error: "Internal server error" }, 500);
  }
});
