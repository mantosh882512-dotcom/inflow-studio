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

    const page = Number(body.page ?? 1);
    const perPage = Number(body.perPage ?? 50);
    const search = typeof body.search === "string" ? body.search.trim() : "";

    if (
      !Number.isInteger(page) || page < 1 ||
      !Number.isInteger(perPage) || perPage < 1 || perPage > 50 ||
      search.length > 80
    ) {
      return response({ error: "Invalid pagination or search parameters" }, 400);
    }

    // Restrict search syntax to prevent PostgREST filter injection.
    if (search && !/^[\p{L}\p{N} ._@-]+$/u.test(search)) {
      return response({ error: "Search contains unsupported characters" }, 400);
    }

    let query = client
      .from("profiles")
      .select("id,full_name,username,avatar_url,created_at", { count: "exact" })
      .order("created_at", { ascending: false });

    if (search) {
      const term = `%${search}%`;
      query = query.or(`full_name.ilike.${term},username.ilike.${term}`);
    }

    const from = (page - 1) * perPage;
    const { data: profiles, error: profileError, count } = await query
      .range(from, from + perPage);

    if (profileError) {
      console.error("Channel list failed:", profileError.message);
      return response({ error: "Unable to load channels" }, 500);
    }

    const fetched = profiles ?? [];
    const hasMore = fetched.length > perPage;
    const channels = fetched.slice(0, perPage);
    const ids = channels.map((p) => String(p.id));

    const moderationMap = new Map<string, Record<string, unknown>>();
    const subscriberCounts = new Map<string, number>();
    const videoCounts = new Map<string, number>();

    if (ids.length > 0) {
      const [moderationResult, subscriptionsResult, videosResult] =
        await Promise.all([
          client.from("channel_moderation")
            .select("channel_id,is_verified,is_suspended,suspension_reason")
            .in("channel_id", ids),
          client.from("subscriptions")
            .select("creator_id")
            .in("creator_id", ids),
          client.from("videos")
            .select("user_id")
            .in("user_id", ids),
        ]);

      if (moderationResult.error || subscriptionsResult.error || videosResult.error) {
        console.error("Channel details lookup failed:",
          moderationResult.error?.message ||
          subscriptionsResult.error?.message ||
          videosResult.error?.message);
        return response({ error: "Unable to load channel details" }, 500);
      }

      for (const row of moderationResult.data ?? []) {
        moderationMap.set(String(row.channel_id), row);
      }
      for (const row of subscriptionsResult.data ?? []) {
        const id = String(row.creator_id);
        subscriberCounts.set(id, (subscriberCounts.get(id) ?? 0) + 1);
      }
      for (const row of videosResult.data ?? []) {
        const id = String(row.user_id);
        videoCounts.set(id, (videoCounts.get(id) ?? 0) + 1);
      }
    }

    const result = channels.map((p) => {
      const id = String(p.id);
      const moderation = moderationMap.get(id);
      return {
        id,
        fullName: p.full_name ?? "",
        username: p.username ?? "",
        avatarUrl: p.avatar_url ?? "",
        createdAt: p.created_at,
        subscriberCount: subscriberCounts.get(id) ?? 0,
        videoCount: videoCounts.get(id) ?? 0,
        isVerified: moderation?.is_verified === true,
        isSuspended: moderation?.is_suspended === true,
        suspensionReason: moderation?.suspension_reason ?? "",
      };
    });

    return response({
      success: true,
      isAdmin: true,
      page,
      perPage,
      count: result.length,
      totalCount: count ?? 0,
      hasMore,
      channels: result,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("admin-channels error:", error);
    return response({ error: "Internal server error" }, 500);
  }
});
