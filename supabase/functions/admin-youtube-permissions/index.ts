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

    const body = await req.json().catch(() => ({}));
    const page = Number(body.page ?? 1);
    const perPage = Number(body.perPage ?? 50);
    const status = typeof body.status === "string" ? body.status : "pending";

    if (!Number.isInteger(page) || page < 1 ||
        !Number.isInteger(perPage) || perPage < 1 || perPage > 50 ||
        !["pending", "approved", "rejected", "all"].includes(status)) {
      return response({ error: "Invalid parameters" }, 400);
    }

    let query = client
      .from("youtube_permission_requests")
      .select("id,user_id,channel_url,status,requested_at,reviewed_at,reviewed_by,admin_note", { count: "exact" })
      .order("requested_at", { ascending: false });

    if (status !== "all") query = query.eq("status", status);

    const from = (page - 1) * perPage;
    const { data: rows, error, count } = await query.range(from, from + perPage - 1);

    if (error) {
      console.error("Request list failed:", error.message);
      return response({ error: "Unable to load requests" }, 500);
    }

    const requests = await Promise.all((rows ?? []).map(async (row) => {
      const { data: profile } = await client
        .from("profiles")
        .select("full_name,username")
        .eq("id", row.user_id)
        .maybeSingle();

      const { data: authUser } = await client.auth.admin.getUserById(row.user_id);

      return {
        ...row,
        fullName: profile?.full_name ?? "",
        username: profile?.username ?? "",
        email: authUser?.user?.email ?? "",
      };
    }));

    return response({
      success: true,
      isAdmin: true,
      requests,
      totalCount: count ?? 0,
      page,
      perPage,
      hasMore: from + requests.length < (count ?? 0),
    });
  } catch (error) {
    console.error("admin-youtube-permissions error:", error);
    return response({ error: "Internal server error" }, 500);
  }
});
