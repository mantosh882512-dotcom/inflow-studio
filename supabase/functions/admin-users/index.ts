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

    let body: Record<string, unknown> = {};

    try {
      body = await req.json();
    } catch {
      body = {};
    }

    const page = Number(body.page ?? 1);
    const perPage = Number(body.perPage ?? 50);

    if (
      !Number.isInteger(page) || page < 1 ||
      !Number.isInteger(perPage) || perPage < 1 || perPage > 99
    ) {
      return response({ error: "Invalid pagination parameters" }, 400);
    }

    const { data, error } = await adminClient.auth.admin.listUsers({
      page,
      perPage: perPage + 1,
    });

    if (error) {
      console.error("User list failed:", error.message);
      return response({ error: "Unable to load users" }, 500);
    }

    const fetchedUsers = data.users ?? [];
    const hasMore = fetchedUsers.length > perPage;
    const authUsers = fetchedUsers.slice(0, perPage);
    const ids = authUsers.map((u) => u.id);

    let profileMap = new Map<string, Record<string, unknown>>();

    if (ids.length > 0) {
      const { data: profiles, error: profileError } = await adminClient
        .from("profiles")
        .select("id, full_name, username, avatar_url, created_at")
        .in("id", ids);

      if (profileError) {
        console.error("Profile lookup failed:", profileError.message);
        return response({ error: "Unable to load user profiles" }, 500);
      }

      profileMap = new Map(
        (profiles ?? []).map((p) => [String(p.id), p]),
      );
    }

    const users = authUsers.map((u) => {
      const profile = profileMap.get(u.id);

      return {
        id: u.id,
        email: u.email ?? "",
        fullName: profile?.full_name ?? "",
        username: profile?.username ?? "",
        avatarUrl: profile?.avatar_url ?? "",
        createdAt: u.created_at,
        lastSignInAt: u.last_sign_in_at ?? null,
        bannedUntil: u.banned_until ?? null,
      };
    });

    return response({
      success: true,
      isAdmin: true,
      page,
      perPage,
      count: users.length,
      hasMore,
      users,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("admin-users error:", error);
    return response({ error: "Internal server error" }, 500);
  }
});
