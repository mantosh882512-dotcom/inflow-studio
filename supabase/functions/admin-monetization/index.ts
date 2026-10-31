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

    const header = req.headers.get("Authorization");
    if (!header?.startsWith("Bearer ")) {
      return response({ error: "Unauthorized" }, 401);
    }

    const client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const token = header.substring(7).trim();
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
      console.error("Admin check:", adminError.message);
      return response({ error: "Admin verification failed" }, 500);
    }

    if (!admin) {
      return response({ error: "Forbidden" }, 403);
    }

    // Count distinct creators from actual video records.
    const creatorIds = new Set<string>();
    let videoOffset = 0;
    const pageSize = 1000;

    while (true) {
      const { data, error } = await client
        .from("videos")
        .select("user_id")
        .order("id", { ascending: true })
        .range(videoOffset, videoOffset + pageSize - 1);

      if (error) {
        console.error("Videos:", error.message);
        return response({ error: "Unable to load creator data" }, 500);
      }

      for (const row of data ?? []) {
        if (row.user_id) creatorIds.add(String(row.user_id));
      }

      if (!data || data.length < pageSize) break;
      videoOffset += pageSize;
    }

    // Read tracked eligibility analytics using service role.
    let watchSeconds = 0;
    let shortsViews = 0;
    let analyticsRows = 0;
    let analyticsAvailable = true;
    let analyticsOffset = 0;

    while (true) {
      const { data, error } = await client
        .from("creator_eligibility_daily")
        .select("id, public_longform_watch_seconds, public_shorts_views")
        .order("id", { ascending: true })
        .range(analyticsOffset, analyticsOffset + pageSize - 1);

      if (error) {
        console.error("Eligibility analytics:", error.message);
        analyticsAvailable = false;
        break;
      }

      analyticsRows += data?.length ?? 0;

      for (const row of data ?? []) {
        watchSeconds += Number(row.public_longform_watch_seconds ?? 0);
        shortsViews += Number(row.public_shorts_views ?? 0);
      }

      if (!data || data.length < pageSize) break;
      analyticsOffset += pageSize;
    }

    return response({
      success: true,
      isAdmin: true,
      generatedAt: new Date().toISOString(),
      metrics: {
        totalCreators: creatorIds.size,
        watchHours: analyticsAvailable ? watchSeconds / 3600 : null,
        shortsViews: analyticsAvailable ? shortsViews : null,
        analyticsRows: analyticsAvailable ? analyticsRows : null,
        analyticsAvailable,

        monetizedCreators: null,
        eligibleCreators: null,
        pendingApplications: null,
        totalRevenue: null,
        creatorRevenue: null,
        platformRevenue: null,
        pendingPayouts: null,
        processingPayouts: null,
        completedPayouts: null,
        failedPayouts: null,
      },
    });
  } catch (error) {
    console.error("admin-monetization:", error);
    return response({ error: "Internal server error" }, 500);
  }
});
