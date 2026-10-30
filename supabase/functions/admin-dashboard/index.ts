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
          pendingVideoReportsResult,
      channelReportsResult,
      ] = await Promise.all([
      adminClient.from("profiles").select("*", { count: "exact", head: true }),
      adminClient.from("videos").select("*", { count: "exact", head: true }),
      adminClient.from("video_views").select("*", { count: "exact", head: true }),
      adminClient.from("subscriptions").select("*", { count: "exact", head: true }),
      adminClient.from("video_reports").select("*", { count: "exact", head: true }),
          adminClient.from("video_reports").select("*", { count: "exact", head: true }).eq("status", "pending"),
      adminClient.from("channel_reports").select("*", { count: "exact", head: true }),
    ]);

    const results = [
      profilesResult,
      videosResult,
      viewEventsResult,
      subscriptionsResult,
      videoReportsResult,
          pendingVideoReportsResult,
      channelReportsResult,
      ];

    const failedQuery = results.find((result) => result.error);

    if (failedQuery?.error) {
      console.error("Dashboard query failed:", failedQuery.error.message);
      return jsonResponse({ error: "Unable to load dashboard data" }, 500);
    }

    // 4. Build creator and video performance metrics.
      const creatorIds = new Set<string>();
      let displayedViews = 0;
      let shortsCount = 0;
      let longVideosCount = 0;
      let publishedVideosCount = 0;

      const creatorStats = new Map<string, {
        videoCount: number;
        views: number;
        subscribers: number;
        channelName: string;
      }>();

      const topVideos: Array<{
        id: string;
        title: string;
        channelName: string;
        views: number;
        likes: number;
        isShort: boolean;
      }> = [];

      const pageSize = 1000;
      let offset = 0;

      while (true) {
        const { data: videoPage, error: videoPageError } = await adminClient
          .from("videos")
          .select("id, title, user_id, channel_name, views, likes, is_short, status")
          .order("id", { ascending: true })
          .range(offset, offset + pageSize - 1);

        if (videoPageError) {
          console.error("Video metrics query failed:", videoPageError.message);
          return jsonResponse({ error: "Unable to load video metrics" }, 500);
        }

        for (const video of videoPage ?? []) {
          const views = Number(video.views ?? 0);
          const likes = Number(video.likes ?? 0);
          const ownerId = video.user_id ? String(video.user_id) : "";
          const isShort = video.is_short === true;

          if (ownerId) {
            creatorIds.add(ownerId);
            const stats = creatorStats.get(ownerId) ?? {
              videoCount: 0,
              views: 0,
              subscribers: 0,
              channelName: String(video.channel_name ?? ""),
            };
            stats.videoCount++;
            if (Number.isFinite(views)) stats.views += views;
            if (!stats.channelName && video.channel_name) {
              stats.channelName = String(video.channel_name);
            }
            creatorStats.set(ownerId, stats);
          }

          if (Number.isFinite(views)) displayedViews += views;
          if (isShort) shortsCount++;
          else longVideosCount++;
          if (video.status === "published") publishedVideosCount++;

          topVideos.push({
            id: String(video.id),
            title: String(video.title ?? "Untitled"),
            channelName: String(video.channel_name ?? ""),
            views: Number.isFinite(views) ? views : 0,
            likes: Number.isFinite(likes) ? likes : 0,
            isShort,
          });
        }

        if (!videoPage || videoPage.length < pageSize) break;
        offset += pageSize;
      }

      // Resolve creator display names.
      const profileNames = new Map<string, string>();
      let profileOffset = 0;

      while (true) {
        const { data, error } = await adminClient
          .from("profiles")
          .select("id, full_name, username")
          .order("id", { ascending: true })
          .range(profileOffset, profileOffset + pageSize - 1);

        if (error) {
          console.error("Creator profiles query failed:", error.message);
          return jsonResponse({ error: "Unable to load creator profiles" }, 500);
        }

        for (const profile of data ?? []) {
          profileNames.set(
            String(profile.id),
            String(profile.full_name || profile.username || ""),
          );
        }

        if (!data || data.length < pageSize) break;
        profileOffset += pageSize;
      }

      // Aggregate subscriber counts.
      let subscriptionOffset = 0;

      while (true) {
        const { data, error } = await adminClient
          .from("subscriptions")
          .select("creator_id")
          .order("id", { ascending: true })
          .range(subscriptionOffset, subscriptionOffset + pageSize - 1);

        if (error) {
          console.error("Creator subscriptions query failed:", error.message);
          return jsonResponse({ error: "Unable to load creator subscriptions" }, 500);
        }

        for (const subscription of data ?? []) {
          const stats = creatorStats.get(String(subscription.creator_id ?? ""));
          if (stats) stats.subscribers++;
        }

        if (!data || data.length < pageSize) break;
        subscriptionOffset += pageSize;
      }

      const topCreators = Array.from(creatorStats.entries())
        .map(([userId, stats]) => ({
          userId,
          name: profileNames.get(userId) || stats.channelName || "Unknown creator",
          videoCount: stats.videoCount,
          views: stats.views,
          subscribers: stats.subscribers,
        }))
        .sort((a, b) => b.views - a.views)
        .slice(0, 10);

      topVideos.sort((a, b) => b.views - a.views);
      topVideos.splice(10);

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
              pendingVideoReports: pendingVideoReportsResult.count ?? 0,
        totalChannelReports: channelReportsResult.count ?? 0,
        videoCreators: creatorIds.size,
        shortsCount,
        longVideosCount,
        publishedVideosCount,
        topCreators,
        topVideos,
      },
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("admin-dashboard error:", error);
    return jsonResponse({ error: "Internal server error" }, 500);
  }
});
