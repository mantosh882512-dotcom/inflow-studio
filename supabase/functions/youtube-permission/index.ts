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

    const token = header.substring(7).trim();
    const { data: { user }, error: authError } = await client.auth.getUser(token);
    if (authError || !user) return response({ error: "Invalid session" }, 401);

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return response({ error: "Invalid request body" }, 400);
    }

    const action = body.action;

    if (action === "status") {
      const { data, error } = await client
        .from("youtube_permission_requests")
        .select("id,channel_url,status,requested_at,reviewed_at,admin_note")
        .eq("user_id", user.id)
        .order("requested_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) return response({ error: "Could not load permission status" }, 500);

      const { data: approved, error: approvalError } = await client
        .from("youtube_permission_requests")
        .select("id")
        .eq("user_id", user.id)
        .eq("status", "approved")
        .limit(1);

      if (approvalError) return response({ error: "Could not verify approval" }, 500);

      return response({
        success: true,
        status: approved?.length ? "approved" : (data?.status ?? "not_requested"),
        request: data ?? null,
      });
    }

    if (action !== "request") return response({ error: "Invalid action" }, 400);

    const channelUrl = typeof body.channelUrl === "string" ? body.channelUrl.trim() : "";
    if (channelUrl.length < 12 || channelUrl.length > 300) {
      return response({ error: "Please enter a valid YouTube channel URL" }, 400);
    }

    let parsed: URL;
    try {
      parsed = new URL(channelUrl);
    } catch {
      return response({ error: "Invalid channel URL" }, 400);
    }

    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    if (
      !["youtube.com", "m.youtube.com"].includes(host) ||
      !(/^\/(@[A-Za-z0-9._-]+|channel\/UC[A-Za-z0-9_-]+|c\/[A-Za-z0-9._-]+|user\/[A-Za-z0-9._-]+)\/?$/.test(parsed.pathname))
    ) {
      return response({ error: "Enter your YouTube channel URL, not a video URL" }, 400);
    }

    const { data: approved, error: approvedError } = await client
      .from("youtube_permission_requests")
      .select("id")
      .eq("user_id", user.id)
      .eq("status", "approved")
      .limit(1);

    if (approvedError) return response({ error: "Could not check approval" }, 500);
    if (approved?.length) return response({ success: true, status: "approved", message: "You already have permission." });

    const { data: pending, error: pendingError } = await client
      .from("youtube_permission_requests")
      .select("id")
      .eq("user_id", user.id)
      .eq("status", "pending")
      .limit(1)
      .maybeSingle();

    if (pendingError) return response({ error: "Could not check existing request" }, 500);
    if (pending) return response({ success: true, status: "pending", message: "Your request is already pending." });

    const { data, error } = await client
      .from("youtube_permission_requests")
      .insert({ user_id: user.id, channel_url: channelUrl, status: "pending" })
      .select("id,channel_url,status,requested_at")
      .single();

    if (error) {
      console.error("Permission request insert failed:", error.message);
      return response({ error: "Could not submit your request" }, 500);
    }

    return response({ success: true, status: "pending", request: data });
  } catch (error) {
    console.error("youtube-permission error:", error);
    return response({ error: "Internal server error" }, 500);
  }
});
