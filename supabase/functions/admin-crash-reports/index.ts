import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return respond({ success: true });
  }

  if (req.method !== "POST") {
    return respond({ error: "Method not allowed" }, 405);
  }

  try {
    const url = Deno.env.get("SUPABASE_URL");
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!url || !key) {
      return respond({ error: "Server configuration error" }, 500);
    }

    const auth = req.headers.get("Authorization");

    if (!auth?.startsWith("Bearer ")) {
      return respond({ error: "Unauthorized" }, 401);
    }

    const client = createClient(url, key, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });

    const { data: { user }, error: authError } =
      await client.auth.getUser(auth.substring(7).trim());

    if (authError || !user) {
      return respond({ error: "Invalid session" }, 401);
    }

    const { data: admin, error: adminError } = await client
      .from("studio_admins")
      .select("user_id")
      .eq("user_id", user.id)
      .maybeSingle();

    if (adminError) {
      return respond({ error: "Admin verification failed" }, 500);
    }

    if (!admin) {
      return respond({ error: "Forbidden" }, 403);
    }

    const body = await req.json();

    if (body.action === "resolve") {
      if (
        typeof body.id !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.id) ||
        typeof body.resolved !== "boolean"
      ) {
        return respond({ error: "Invalid report update" }, 400);
      }

      const update: Record<string, unknown> = {
        resolved: body.resolved,
      };

      if (body.ai_analysis !== undefined) {
        if (typeof body.ai_analysis !== "string" || body.ai_analysis.length > 10000) {
          return respond({ error: "Invalid AI analysis" }, 400);
        }
        update.ai_analysis = body.ai_analysis;
      }

      if (body.ai_suggested_fix !== undefined) {
        if (typeof body.ai_suggested_fix !== "string" || body.ai_suggested_fix.length > 10000) {
          return respond({ error: "Invalid suggested fix" }, 400);
        }
        update.ai_suggested_fix = body.ai_suggested_fix;
      }

      const { data, error } = await client
        .from("crash_reports")
        .update(update)
        .eq("id", body.id)
        .select("id, resolved")
        .maybeSingle();

      if (error) {
        return respond({ error: "Unable to update report" }, 500);
      }

      if (!data) {
        return respond({ error: "Report not found" }, 404);
      }

      return respond({ success: true, report: data });
    }

    if (body.action !== "list") {
      return respond({ error: "Invalid action" }, 400);
    }

    const page = Math.max(1, Math.min(100000, Number(body.page) || 1));
    const limit = Math.max(1, Math.min(100, Number(body.limit) || 25));

    let query = client
      .from("crash_reports")
      .select(
        "id, user_id, error_type, error_message, stack_trace, platform, app_version, created_at, resolved, ai_analysis, ai_suggested_fix",
        { count: "exact" },
      )
      .order("created_at", { ascending: false });

    if (body.resolved === true || body.resolved === false) {
      query = query.eq("resolved", body.resolved);
    }

    const { data, error, count } = await query.range(
      (page - 1) * limit,
      page * limit - 1,
    );

    if (error) {
      return respond({ error: "Unable to load crash reports" }, 500);
    }

    const { count: pending } = await client
      .from("crash_reports")
      .select("*", { count: "exact", head: true })
      .eq("resolved", false);

    const { count: resolved } = await client
      .from("crash_reports")
      .select("*", { count: "exact", head: true })
      .eq("resolved", true);

    return respond({
      success: true,
      isAdmin: true,
      reports: data ?? [],
      total: count ?? 0,
      pending: pending ?? 0,
      resolved: resolved ?? 0,
      page,
      limit,
    });

  } catch (error) {
    console.error("Admin crash reports error:", error);
    return respond({ error: "Internal server error" }, 500);
  }
});
