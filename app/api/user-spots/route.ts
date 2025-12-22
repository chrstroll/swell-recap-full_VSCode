// app/api/user-spots/route.ts
import { NextResponse } from "next/server";
import { Redis } from "@upstash/redis";

export const dynamic = "force-dynamic";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

// Keys:
// - User saved spots list: tsr:user:spots:<userId>  (Redis Set of spotIds)
// Optional: last-updated timestamp: tsr:user:spots:ts:<userId>

function normalizeUserId(v: any): string | null {
  if (typeof v !== "string") return null;
  const id = v.trim();
  if (!id) return null;
  // keep it simple; prevent absurdly long ids
  if (id.length > 200) return null;
  return id;
}

function normalizeSpotId(v: any): string | null {
  if (typeof v !== "string") return null;
  const id = v.trim();
  if (!id) return null;
  if (id.length > 200) return null;
  return id;
}

/**
 * GET /api/user-spots?userId=...
 * Returns: { userId, spotIds: string[] }
 */
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const userId = normalizeUserId(searchParams.get("userId"));
    if (!userId) return new Response("userId is required", { status: 400 });

    const key = `tsr:user:spots:${userId}`;
    const spotIds = (await redis.smembers<string[]>(key)) ?? [];

    return NextResponse.json({
      userId,
      spotIds: Array.isArray(spotIds) ? spotIds : [],
    });
  } catch (err: any) {
    console.error("[user-spots GET] error", err?.message ?? err);
    return new Response(err?.message || "internal error", { status: 500 });
  }
}

/**
 * POST /api/user-spots
 * Body:
 * {
 *   "userId": string,
 *   "op": "add" | "remove" | "set",
 *   "spotId"?: string,        // for add/remove
 *   "spotIds"?: string[]      // for set
 * }
 *
 * Returns: { userId, spotIds: string[] }
 */
export async function POST(req: Request) {
  try {
    const body = await req.json();

    const userId = normalizeUserId(body.userId);
    if (!userId) return new Response("userId is required", { status: 400 });

    const op = body.op;
    if (!["add", "remove", "set"].includes(op)) {
      return new Response('op must be "add", "remove", or "set"', { status: 400 });
    }

    const key = `tsr:user:spots:${userId}`;
    const tsKey = `tsr:user:spots:ts:${userId}`;

    if (op === "add") {
      const spotId = normalizeSpotId(body.spotId);
      if (!spotId) return new Response("spotId is required for add", { status: 400 });

      await redis.sadd(key, spotId);
      await redis.set(tsKey, Date.now().toString());
    }

    if (op === "remove") {
      const spotId = normalizeSpotId(body.spotId);
      if (!spotId) return new Response("spotId is required for remove", { status: 400 });

      await redis.srem(key, spotId);
      await redis.set(tsKey, Date.now().toString());
    }

    if (op === "set") {
      const spotIdsRaw = Array.isArray(body.spotIds) ? body.spotIds : null;
      if (!spotIdsRaw) return new Response("spotIds[] is required for set", { status: 400 });

      const clean = Array.from(
        new Set(spotIdsRaw.map(normalizeSpotId).filter(Boolean) as string[])
      );

      // Replace set: delete then add
      await redis.del(key);
      for (const id of clean) {
        await redis.sadd(key, id);
      }
      await redis.set(tsKey, Date.now().toString());
    }

    const spotIds = (await redis.smembers<string[]>(key)) ?? [];
    return NextResponse.json({
      userId,
      spotIds: Array.isArray(spotIds) ? spotIds : [],
    });
  } catch (err: any) {
    console.error("[user-spots POST] error", err?.message ?? err);
    return new Response(err?.message || "internal error", { status: 500 });
  }
}
