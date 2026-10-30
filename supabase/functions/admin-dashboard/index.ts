import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
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
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !serviceRoleKey) {
      console.error("Missing Supabase server configuration");
      return jsonResponse({ error: "Server configuration error" }, 500);
    }

    const authHeader = req.headers.get("Authorization");

    if (!authHeader?.startsWith("Bearer ")) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }

    const token = authHeader.substring(7).trim();

    if (!token) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });

    // 1. Verify the logged-in user's JWT.
    const {
      data: { user },
      error: authError,
    } = await adminClient.auth.getUser(token);

    if (authError || !user) {
      return jsonResponse({ error: "Invalid session" }, 401);
    }

    // 2. Verify that this exact user is a Super Admin.
    const { data: admin, error: adminError } = await adminClient
      .from("studio_admins")
      .select("user_id")
      .eq("user_id", user.id)
      .maybeSingle();

    if (adminError) {
      console.error("Admin verification failed:", adminError.message);
      return jsonResponse({ error: "Admin verification failed" }, 500);
    }

    if (!admin) {
      return jsonResponse({ error: "Forbidden" }, 403);
    }

    // 3. Fetch exact database counts.
    const [
      profilesResult,
      videosResult,
      viewEventsResult,
      subscriptionsResult,
      videoReportsResult,
      channelReportsResult,
      ] = await Promise.all([
      adminClient.from("profiles").select("*", { count: "exact", head: true }),
      adminClient.from("videos").select("*", { count: "exact", head: true }),
      adminClient.from("video_views").select("*", { count: "exact", head: true }),
      adminClient.from("subscriptions").select("*", { count: "exact", head: true }),
      adminClient.from("video_reports").select("*", { count: "exact", head: true }),
      adminClient.from("channel_reports").select("*", { count: "exact", head: true }),
    ]);

    const results = [
      profilesResult,
      videosResult,
      viewEventsResult,
      subscriptionsResult,
      videoReportsResult,
      channelReportsResult,
      ];

    const failedQuery = results.find((result) => result.error);

    if (failedQuery?.error) {
      console.error("Dashboard query failed:", failedQuery.error.message);
      return jsonResponse({ error: "Unable to load dashboard data" }, 500);
    }

    // 4. Count distinct creators and sum displayed video views.
    const creatorIds = new Set<string>();
    let displayedViews = 0;

    const pageSize = 1000;
    let offset = 0;

    while (true) {
      const { data: videoPage, error: videoPageError } = await adminClient
        .from("videos")
        .select("id, user_id, views")
        .order("id", { ascending: true })
        .range(offset, offset + pageSize - 1);

      if (videoPageError) {
        console.error("Video metrics query failed:", videoPageError.message);
        return jsonResponse({ error: "Unable to load video metrics" }, 500);
      }

      for (const video of videoPage ?? []) {
        if (video.user_id) {
          creatorIds.add(String(video.user_id));
        }

        const views = Number(video.views ?? 0);
        if (Number.isFinite(views)) {
          displayedViews += views;
        }
      }

      if (!videoPage || videoPage.length < pageSize) break;
      offset += pageSize;
    }

    // 5. Count all Auth users using pagination.
    let totalUsers = 0;
    let page = 1;
    const perPage = 1000;

    while (true) {
      const { data, error } = await adminClient.auth.admin.listUsers({
        page,
        perPage,
      });

      if (error) {
        console.error("User count failed:", error.message);
        return jsonResponse({ error: "Unable to load user count" }, 500);
      }

      totalUsers += data.users.length;

      if (data.users.length < perPage) {
        break;
      }

      page++;
    }

    // 6. Return data only after successful admin verification.
    return jsonResponse({
      success: true,
      isAdmin: true,
      metrics: {
        totalUsers,
        totalProfiles: profilesResult.count ?? 0,
        totalVideos: videosResult.count ?? 0,
        totalViewEvents: viewEventsResult.count ?? 0,
        displayedViews,
        totalSubscriptions: subscriptionsResult.count ?? 0,
        totalVideoReports: videoReportsResult.count ?? 0,
        totalChannelReports: channelReportsResult.count ?? 0,
        videoCreators: creatorIds.size,
      },
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("admin-dashboard error:", error);
    return jsonResponse({ error: "Internal server error" }, 500);
  }
});
