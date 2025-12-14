import { Redis } from "@upstash/redis";

export const dynamic = "force-dynamic";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

type SizeOption = "tiny" | "small" | "medium" | "head_high" | "overhead" | "2x_overhead";
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

/**
 * GET /api/feedback?lat=..&lon=..&date=YYYY-MM-DD
 * Returns aggregate feedback histogram for that spot/date.
 */
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);

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

    let agg: FeedbackAggregate;
    if (!raw) {
      agg = emptyAggregate();
    } else if (typeof raw === "string") {
      agg = JSON.parse(raw);
    } else {
      agg = raw as FeedbackAggregate;
    }

    return new Response(JSON.stringify(agg), {
      status: 200,
      headers: {
        "content-type": "application/json",
      },
    });
  } catch (err: any) {
    console.error("[feedback GET] error", err);
    return new Response(err?.message || "internal error", { status: 500 });
  }
}

/**
 * POST /api/feedback
 *
 * Body:
 * {
 *   "lat": number,
 *   "lon": number,
 *   "date": "YYYY-MM-DD",
 *   "userId": string,           // device/user identifier
 *   "size"?: SizeOption,
 *   "quality"?: QualityOption
 * }
 *
 * Records or updates this user's feedback and returns updated aggregate.
 */
export async function POST(req: Request) {
  try {
    const { lat, lon, date, userId, size, quality } = await req.json();

    if (typeof lat !== "number" || typeof lon !== "number") {
      return new Response("lat and lon are required", { status: 400 });
    }

    if (
      typeof date !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date)
    ) {
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
      if (!isValidSize(size)) {
        return new Response("invalid size", { status: 400 });
      }
      sizeValue = size;
    }

    if (hasQuality) {
      if (!isValidQuality(quality)) {
        return new Response("invalid quality", { status: 400 });
      }
      qualityValue = quality;
    }

    const rl = Math.round(lat * 1000) / 1000;
    const rlo = Math.round(lon * 1000) / 1000;

    const aggKey = `tsr:feedback:${date}:${rl},${rlo}`;
    const userKey = `tsr:feedback:user:${userId}:${date}:${rl},${rlo}`;

    // Load previous user feedback (if any) and aggregate
    const [rawAgg, rawUser] = await redis.mget(aggKey, userKey);

    let agg: FeedbackAggregate;
    if (!rawAgg) {
      agg = emptyAggregate();
    } else if (typeof rawAgg === "string") {
      agg = JSON.parse(rawAgg);
    } else {
      agg = rawAgg as FeedbackAggregate;
    }

    let prev: UserFeedback | null = null;
    if (rawUser) {
      if (typeof rawUser === "string") {
        prev = JSON.parse(rawUser);
      } else {
        prev = rawUser as UserFeedback;
      }
    }

    // If the user already had feedback, decrement their old vote
    if (prev) {
      if (prev.size && agg.size[prev.size] !== undefined) {
        agg.size[prev.size] = Math.max(agg.size[prev.size] - 1, 0);
      }
      if (prev.quality && agg.quality[prev.quality] !== undefined) {
        agg.quality[prev.quality] = Math.max(agg.quality[prev.quality] - 1, 0);
      }
      // totalCount stays the same for update
    } else {
      // New contributor
      agg.totalCount += 1;
    }

    // Apply the new feedback
    if (sizeValue && agg.size[sizeValue] !== undefined) {
      agg.size[sizeValue] += 1;
    }

    if (qualityValue && agg.quality[qualityValue] !== undefined) {
      agg.quality[qualityValue] += 1;
    }

    const newUserFeedback: UserFeedback = {
      size: sizeValue,
      quality: qualityValue,
    };

    // Save updated aggregate & user feedback
    await redis.mset({
      [aggKey]: JSON.stringify(agg),
      [userKey]: JSON.stringify(newUserFeedback),
    });

    return new Response(JSON.stringify(agg), {
      status: 200,
      headers: {
        "content-type": "application/json",
      },
    });
  } catch (err: any) {
    console.error("[feedback POST] error", err);
    return new Response(err?.message || "internal error", { status: 500 });
  }
}
