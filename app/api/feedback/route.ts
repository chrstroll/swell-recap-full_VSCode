// app/api/feedback/route.ts
import { NextResponse } from "next/server";
import { Redis } from "@upstash/redis";

export const dynamic = "force-dynamic";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

// ----------------------- Existing surf feedback -----------------------
type SizeOption =
  | "tiny"
  | "small"
  | "medium"
  | "head_high"
  | "overhead"
  | "2x_overhead";
type QualityOption = "poor" | "fair" | "good" | "epic";

type FeedbackAggregate = {
  totalCount: number;
  size: Record<SizeOption, number>;
  quality: Record<QualityOption, number>;
};

type UserFeedback = {
  size: SizeOption | null;
  quality: QualityOption | null;
};

function isValidSize(v: any): v is SizeOption {
  return ["tiny", "small", "medium", "head_high", "overhead", "2x_overhead"].includes(v);
}
function isValidQuality(v: any): v is QualityOption {
  return ["poor", "fair", "good", "epic"].includes(v);
}

function emptyAggregate(): FeedbackAggregate {
  return {
    totalCount: 0,
    size: {
      tiny: 0,
      small: 0,
      medium: 0,
      head_high: 0,
      overhead: 0,
      "2x_overhead": 0,
    },
    quality: {
      poor: 0,
      fair: 0,
      good: 0,
      epic: 0,
    },
  };
}

// ----------------------- NEW: spot metadata votes -----------------------
type BreakTypeOption = "beach" | "reef" | "point" | "not_sure";

type SpotMetaAggregate = {
  totalCount: number;
  breakType: Record<BreakTypeOption, number>;
};

type UserSpotMetaVote = {
  breakType: BreakTypeOption | null;
};

function isValidBreakType(v: any): v is BreakTypeOption {
  return ["beach", "reef", "point", "not_sure"].includes(v);
}

function emptySpotMetaAggregate(): SpotMetaAggregate {
  return {
    totalCount: 0,
    breakType: {
      beach: 0,
      reef: 0,
      point: 0,
      not_sure: 0,
    },
  };
}

function parseMaybeJSON<T>(raw: any): T | null {
  if (!raw) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }
  return raw as T;
}

/**
 * GET /api/feedback?lat=..&lon=..&date=YYYY-MM-DD
 * -> existing surf feedback aggregate
 *
 * GET /api/feedback?spotId=abc123
 * -> NEW spot break-type aggregate
 */
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);

    // If spotId is present, serve spot metadata aggregate
    const spotId = searchParams.get("spotId");
    if (spotId) {
      const aggKey = `tsr:spotmeta:${spotId}`;
      const raw = await redis.get(aggKey);
      const agg = parseMaybeJSON<SpotMetaAggregate>(raw) ?? emptySpotMetaAggregate();
      return NextResponse.json(agg);
    }

    // Otherwise serve existing surf feedback
    const lat = parseFloat(searchParams.get("lat") || "NaN");
    const lon = parseFloat(searchParams.get("lon") || "NaN");
    const date = searchParams.get("date");

    if (Number.isNaN(lat) || Number.isNaN(lon) || !date) {
      return new Response("lat, lon, and date are required", { status: 400 });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return new Response("date must be YYYY-MM-DD", { status: 400 });
    }

    const rl = Math.round(lat * 1000) / 1000;
    const rlo = Math.round(lon * 1000) / 1000;

    const aggKey = `tsr:feedback:${date}:${rl},${rlo}`;
    const raw = await redis.get(aggKey);
    const agg = parseMaybeJSON<FeedbackAggregate>(raw) ?? emptyAggregate();

    return NextResponse.json(agg);
  } catch (err: any) {
    console.error("[feedback GET] error", err?.message ?? err);
    return new Response(err?.message || "internal error", { status: 500 });
  }
}

/**
 * POST /api/feedback
 *
 * Existing surf feedback mode:
 * {
 *   "lat": number,
 *   "lon": number,
 *   "date": "YYYY-MM-DD",
 *   "userId": string,
 *   "size"?: SizeOption,
 *   "quality"?: QualityOption
 * }
 *
 * NEW spot metadata mode:
 * {
 *   "spotId": string,
 *   "userId": string,
 *   "breakType": "beach" | "reef" | "point" | "not_sure"
 * }
 */
export async function POST(req: Request) {
  try {
    const body = await req.json();

    // ---------- NEW: spot metadata mode ----------
    if (typeof body.spotId === "string") {
      const spotId = body.spotId.trim();
      const userId = typeof body.userId === "string" ? body.userId.trim() : "";

      if (!spotId) return new Response("spotId is required", { status: 400 });
      if (!userId) return new Response("userId is required", { status: 400 });
      if (!isValidBreakType(body.breakType)) return new Response("invalid breakType", { status: 400 });

      const breakType: BreakTypeOption = body.breakType;

      const aggKey = `tsr:spotmeta:${spotId}`;
      const userKey = `tsr:spotmeta:user:${userId}:${spotId}`;

      const [rawAgg, rawUser] = await redis.mget(aggKey, userKey);

      const agg = parseMaybeJSON<SpotMetaAggregate>(rawAgg) ?? emptySpotMetaAggregate();
      const prev = parseMaybeJSON<UserSpotMetaVote>(rawUser);

      // Decrement previous vote if updating
      if (prev?.breakType && agg.breakType[prev.breakType] !== undefined) {
        agg.breakType[prev.breakType] = Math.max(agg.breakType[prev.breakType] - 1, 0);
        // totalCount unchanged
      } else {
        // new voter
        agg.totalCount += 1;
      }

      // Apply new vote
      agg.breakType[breakType] = (agg.breakType[breakType] ?? 0) + 1;

      const newVote: UserSpotMetaVote = { breakType };

      await redis.mset({
        [aggKey]: JSON.stringify(agg),
        [userKey]: JSON.stringify(newVote),
      });

      return NextResponse.json(agg);
    }

    // ---------- Existing surf feedback mode ----------
    const { lat, lon, date, userId, size, quality } = body;

    if (typeof lat !== "number" || typeof lon !== "number") {
      return new Response("lat and lon are required", { status: 400 });
    }
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return new Response("date must be YYYY-MM-DD", { status: 400 });
    }
    if (typeof userId !== "string" || !userId.trim()) {
      return new Response("userId is required", { status: 400 });
    }

    const hasSize = size !== undefined;
    const hasQuality = quality !== undefined;
    if (!hasSize && !hasQuality) {
      return new Response("size or quality is required", { status: 400 });
    }

    let sizeValue: SizeOption | null = null;
    let qualityValue: QualityOption | null = null;

    if (hasSize) {
      if (!isValidSize(size)) return new Response("invalid size", { status: 400 });
      sizeValue = size;
    }
    if (hasQuality) {
      if (!isValidQuality(quality)) return new Response("invalid quality", { status: 400 });
      qualityValue = quality;
    }

    const rl = Math.round(lat * 1000) / 1000;
    const rlo = Math.round(lon * 1000) / 1000;

    const aggKey = `tsr:feedback:${date}:${rl},${rlo}`;
    const userKey = `tsr:feedback:user:${userId}:${date}:${rl},${rlo}`;

    const [rawAgg, rawUser] = await redis.mget(aggKey, userKey);

    const agg = parseMaybeJSON<FeedbackAggregate>(rawAgg) ?? emptyAggregate();
    const prev = parseMaybeJSON<UserFeedback>(rawUser);

    if (prev) {
      if (prev.size && agg.size[prev.size] !== undefined) {
        agg.size[prev.size] = Math.max(agg.size[prev.size] - 1, 0);
      }
      if (prev.quality && agg.quality[prev.quality] !== undefined) {
        agg.quality[prev.quality] = Math.max(agg.quality[prev.quality] - 1, 0);
      }
      // totalCount unchanged on update
    } else {
      agg.totalCount += 1;
    }

    if (sizeValue && agg.size[sizeValue] !== undefined) agg.size[sizeValue] += 1;
    if (qualityValue && agg.quality[qualityValue] !== undefined) agg.quality[qualityValue] += 1;

    const newUserFeedback: UserFeedback = { size: sizeValue, quality: qualityValue };

    await redis.mset({
      [aggKey]: JSON.stringify(agg),
      [userKey]: JSON.stringify(newUserFeedback),
    });

    return NextResponse.json(agg);
  } catch (err: any) {
    console.error("[feedback POST] error", err?.message ?? err);
    return new Response(err?.message || "internal error", { status: 500 });
  }
}
