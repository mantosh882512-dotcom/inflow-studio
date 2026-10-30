import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-client-info",
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

    const {
      data: { user },
      error: authError,
    } = await adminClient.auth.getUser(token);

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
      body = await req.json();
    } catch {
      return response({ error: "Invalid JSON body" }, 400);
    }

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return response({ error: "Invalid request body" }, 400);
    }

    const action = body.action;
    const targetUserId = String(body.targetUserId ?? "").trim();

    if (body.reason !== undefined && typeof body.reason !== "string") {
      return response({ error: "Reason must be text" }, 400);
    }

    const reason = (body.reason ?? "").trim();

    if (action !== "suspend_user" && action !== "restore_user") {
      return response({ error: "Invalid action" }, 400);
    }

    const uuidPattern =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    if (!uuidPattern.test(targetUserId)) {
      return response({ error: "Invalid target user ID" }, 400);
    }

    if (targetUserId === user.id) {
      return response({ error: "You cannot suspend or restore yourself" }, 403);
    }

    if (reason.length > 500) {
      return response({ error: "Reason must be 500 characters or less" }, 400);
    }

    const { data: targetData, error: targetError } =
      await adminClient.auth.admin.getUserById(targetUserId);

    if (targetError || !targetData.user) {
      return response({ error: "Target user not found" }, 404);
    }

    const banDuration =
      action === "suspend_user" ? "876000h" : "none";

    const { data: updatedData, error: updateError } =
      await adminClient.auth.admin.updateUserById(targetUserId, {
        ban_duration: banDuration,
      });

    if (updateError || !updatedData.user) {
      console.error("User action failed:", updateError?.message);
      return response({ error: "Unable to update user status" }, 500);
    }

    const { error: logError } = await adminClient
      .from("admin_action_logs")
      .insert({
        actor_user_id: user.id,
        target_user_id: targetUserId,
        action,
        reason: reason || null,
      });

    if (logError) {
      console.error("Audit log insert failed:", logError.message);
      return response({
        success: false,
        actionApplied: true,
        auditLogged: false,
        error: "User status changed, but audit logging failed. Contact support.",
      }, 500);
    }

    return response({
      success: true,
      action,
      targetUserId,
      bannedUntil: updatedData.user.banned_until ?? null,
      auditLogged: true,
    });
  } catch (error) {
    console.error("admin-user-action error:", error);
    return response({ error: "Internal server error" }, 500);
  }
});
