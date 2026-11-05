import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return response({ error: "Method not allowed" }, 405);

  try {
    const url = Deno.env.get("SUPABASE_URL");
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !key) return response({ error: "Server configuration error" }, 500);

    const header = req.headers.get("Authorization") ?? "";
    if (!header.startsWith("Bearer ")) return response({ error: "Unauthorized" }, 401);

    const client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: { user }, error: authError } =
      await client.auth.getUser(header.substring(7).trim());

    if (authError || !user) return response({ error: "Invalid session" }, 401);

    const { data: admin, error: adminError } = await client
      .from("studio_admins")
      .select("user_id")
      .eq("user_id", user.id)
      .maybeSingle();

    if (adminError) return response({ error: "Admin verification failed" }, 500);
    if (!admin) return response({ error: "Forbidden" }, 403);

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return response({ error: "Invalid request body" }, 400);
    }

    const requestId = typeof body.requestId === "string" ? body.requestId : "";
    const action = body.action;
    const note = typeof body.adminNote === "string" ? body.adminNote.trim() : "";

    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId) ||
        !["approve", "reject"].includes(action) || note.length > 500) {
      return response({ error: "Invalid action parameters" }, 400);
    }

    const newStatus = action === "approve" ? "approved" : "rejected";

    const { data: request, error: requestError } = await client
      .from("youtube_permission_requests")
      .select("id,user_id,status")
      .eq("id", requestId)
      .maybeSingle();

    if (requestError) return response({ error: "Could not load request" }, 500);
    if (!request) return response({ error: "Request not found" }, 404);
    if (request.status !== "pending") return response({ error: "Request is no longer pending" }, 409);

    const { data: updated, error: updateError } = await client
      .from("youtube_permission_requests")
      .update({
        status: newStatus,
        reviewed_at: new Date().toISOString(),
        reviewed_by: user.id,
        admin_note: note || null,
      })
      .eq("id", requestId)
      .eq("status", "pending")
      .select("id,status,user_id")
      .maybeSingle();

    if (updateError) {
      console.error("Permission action update failed:", updateError.message);
      return response({ error: "Could not update request" }, 500);
    }
    if (!updated) return response({ error: "Request was already reviewed" }, 409);

    const { error: logError } = await client
      .from("youtube_permission_action_logs")
      .insert({
        request_id: requestId,
        user_id: request.user_id,
        admin_id: user.id,
        action: newStatus,
        admin_note: note || null,
      });

    if (logError) {
      console.error("Permission audit log failed:", logError.message);
      return response({ error: "Action saved but audit logging failed. Contact support." }, 500);
    }

    return response({ success: true, isAdmin: true, status: newStatus, auditLogged: true });
  } catch (error) {
    console.error("admin-youtube-permission-action error:", error);
    return response({ error: "Internal server error" }, 500);
  }
});
