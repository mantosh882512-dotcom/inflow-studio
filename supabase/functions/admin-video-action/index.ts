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

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
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

    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return response({ error: "Unauthorized" }, 401);
    }

    const adminClient = createClient(url, key, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });

    const token = authHeader.substring(7).trim();
    const { data: { user }, error: authError } =
      await adminClient.auth.getUser(token);

    if (authError || !user) {
      return response({ error: "Invalid session" }, 401);
    }

    const { data: admin, error: adminError } = await adminClient
      .from("studio_admins")
      .select("user_id")
      .eq("user_id", user.id)
      .maybeSingle();

    if (adminError) {
      console.error("Admin verification failed:", adminError.message);
      return response({ error: "Admin verification failed" }, 500);
    }

    if (!admin) {
      return response({ error: "Forbidden" }, 403);
    }

    let body: Record<string, unknown>;

    try {
      const parsed = await req.json();
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return response({ error: "Invalid request body" }, 400);
      }
      body = parsed;
    } catch {
      return response({ error: "Invalid JSON body" }, 400);
    }

    const reason = body.reason == null ? null : body.reason;

    if (
      reason !== null &&
      (typeof reason !== "string" || reason.length > 500)
    ) {
      return response({ error: "Reason must be 500 characters or fewer" }, 400);
    }

    let reportId: number | null = null;
    let videoId: string | null = null;
    let value: string | null = null;

    if (body.action === "set_report_status") {
      reportId = Number(body.reportId);
      value = typeof body.status === "string" ? body.status : null;

      if (!Number.isSafeInteger(reportId) || reportId < 1) {
        return response({ error: "Invalid report ID" }, 400);
      }
      if (!value || !["reviewing", "resolved", "rejected"].includes(value)) {
        return response({ error: "Invalid report status" }, 400);
      }
    } else if (body.action === "set_video_visibility") {
      videoId = typeof body.videoId === "string" ? body.videoId : "";
      value = typeof body.visibility === "string" ? body.visibility : null;

      if (!UUID_RE.test(videoId)) {
        return response({ error: "Invalid video ID" }, 400);
      }
      if (!value || !["Public", "Private"].includes(value)) {
        return response({ error: "Invalid video visibility" }, 400);
      }
    } else {
      return response({ error: "Unsupported action" }, 400);
    }

    // Apply the change and write its audit record atomically.
    const { data: result, error: rpcError } = await adminClient.rpc(
      "admin_apply_video_action",
      {
        p_actor_user_id: user.id,
        p_action: body.action,
        p_report_id: reportId,
        p_video_id: videoId,
        p_value: value,
        p_reason: reason,
      },
    );

    if (rpcError) {
      console.error("Atomic admin video action failed:", rpcError.message);
      return response({ error: "Unable to apply admin video action" }, 500);
    }

    if (!result || typeof result !== "object" || result.success !== true) {
      const errorMessage =
        result && typeof result.error === "string"
          ? result.error
          : "Unable to apply admin video action";

      const status = errorMessage === "Forbidden"
        ? 403
        : errorMessage === "Report not found" || errorMessage === "Video not found"
        ? 404
        : errorMessage.includes("transition") || errorMessage.includes("already has")
        ? 409
        : 400;

      return response({
        error: errorMessage,
        ...(typeof result?.currentStatus === "string"
          ? { currentStatus: result.currentStatus }
          : {}),
      }, status);
    }

    return response(result, 200);
  } catch (error) {
    console.error("admin-video-action error:", error);
    return response({ error: "Internal server error" }, 500);
  }
});
