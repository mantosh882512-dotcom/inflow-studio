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

const ACTIONS = [
  "verify_channel",
  "unverify_channel",
  "suspend_channel",
  "restore_channel",
];

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

    const client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const token = authHeader.substring(7).trim();
    const { data: { user }, error: authError } =
      await client.auth.getUser(token);

    if (authError || !user) {
      return response({ error: "Invalid session" }, 401);
    }

    const { data: admin, error: adminError } = await client
      .from("studio_admins")
      .select("user_id")
      .eq("user_id", user.id)
      .maybeSingle();

    if (adminError) {
      console.error("Admin verification failed:", adminError.message);
      return response({ error: "Admin verification failed" }, 500);
    }
    if (!admin) return response({ error: "Forbidden" }, 403);

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

    const channelId = String(body.channelId ?? "").trim();
    const action = body.action;
    const reason = body.reason == null ? null : body.reason;

    if (!UUID_RE.test(channelId)) {
      return response({ error: "Invalid channel ID" }, 400);
    }
    if (typeof action !== "string" || !ACTIONS.includes(action)) {
      return response({ error: "Invalid channel action" }, 400);
    }
    if (reason !== null && (typeof reason !== "string" || reason.length > 500)) {
      return response({ error: "Reason must be 500 characters or fewer" }, 400);
    }

    const { data: result, error: rpcError } = await client.rpc(
      "admin_apply_channel_action",
      {
        p_actor_user_id: user.id,
        p_channel_id: channelId,
        p_action: action,
        p_reason: reason,
      },
    );

    if (rpcError) {
      console.error("Atomic channel action failed:", rpcError.message);
      return response({ error: "Unable to apply channel action" }, 500);
    }

    if (!result || typeof result !== "object" || result.success !== true) {
      const message = typeof result?.error === "string"
        ? result.error
        : "Unable to apply channel action";

      const status = message === "Forbidden" ? 403
        : message === "Channel not found" ? 404
        : message.includes("already has") ? 409
        : 400;

      return response({ error: message }, status);
    }

    return response({
      success: true,
      action,
      channelId,
      auditLogged: true,
    });
  } catch (error) {
    console.error("admin-channel-action error:", error);
    return response({ error: "Internal server error" }, 500);
  }
});
