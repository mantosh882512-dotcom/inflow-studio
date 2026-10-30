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

    if (
      !Number.isInteger(page) || page < 1 ||
      !Number.isInteger(perPage) || perPage < 1 || perPage > 50
    ) {
      return response({ error: "Invalid pagination parameters" }, 400);
    }

    const from = (page - 1) * perPage;
    const to = from + perPage - 1;

    const { data: videos, error: videosError, count: videoCount } =
      await adminClient
        .from("videos")
        .select(
          "id,title,video_url,thumbnail_url,channel_name,user_id,views,likes,created_at,visibility,status,is_short,duration,duration_seconds,description",
          { count: "exact" },
        )
        .order("created_at", { ascending: false })
        .range(from, to);

    if (videosError) {
      console.error("Video list failed:", videosError.message);
      return response({ error: "Unable to load videos" }, 500);
    }

    const { data: reports, error: reportsError, count: reportCount } =
      await adminClient
        .from("video_reports")
        .select("id,video_id,reporter_id,reason,details,status,created_at", {
          count: "exact",
        })
        .order("created_at", { ascending: false })
        .range(0, 49);

    if (reportsError) {
      console.error("Video reports failed:", reportsError.message);
      return response({ error: "Unable to load video reports" }, 500);
    }

    const reportVideoIds = [
      ...new Set((reports ?? []).map((r) => String(r.video_id)).filter(Boolean)),
    ];

    let reportVideoMap = new Map<string, Record<string, unknown>>();

    if (reportVideoIds.length > 0) {
      const { data: reportVideos, error: reportVideosError } =
        await adminClient
          .from("videos")
          .select("id,title,channel_name,thumbnail_url")
          .in("id", reportVideoIds);

      if (reportVideosError) {
        console.error("Reported video lookup failed:", reportVideosError.message);
        return response({ error: "Unable to load reported video details" }, 500);
      }

      reportVideoMap = new Map(
        (reportVideos ?? []).map((v) => [String(v.id), v]),
      );
    }

    const safeReports = (reports ?? []).map((r) => ({
      id: r.id,
      videoId: r.video_id,
      reporterId: r.reporter_id,
      reason: r.reason,
      details: r.details,
      status: r.status,
      createdAt: r.created_at,
      video: reportVideoMap.get(String(r.video_id)) ?? null,
    }));

    return response({
      success: true,
      isAdmin: true,
      page,
      perPage,
      count: videos?.length ?? 0,
      videoCount: videoCount ?? 0,
      hasMore: from + (videos?.length ?? 0) < (videoCount ?? 0),
      videos: videos ?? [],
      reportCount: reportCount ?? 0,
      reports: safeReports,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("admin-videos error:", error);
    return response({ error: "Internal server error" }, 500);
  }
});
