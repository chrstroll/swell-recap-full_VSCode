// app/api/user-spots/route.ts
import { NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import fs from "fs/promises";
import path from "path";

export const dynamic = "force-dynamic";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

type Spot = {
  id: string;
  name?: string;
  lat?: number | string;
  lon?: number | string;
  lng?: number | string;
  latitude?: number | string;
  longitude?: number | string;
  [k: string]: any;
};

function normalizeUserId(v: any): string | null {
  if (typeof v !== "string") return null;
  const id = v.trim();
  if (!id) return null;
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

function formatDateUTC(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function addDaysUTC(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return formatDateUTC(d);
}

function getLatLon(spot: Spot): { lat: number; lon: number } | null {
  const latRaw = (spot as any).lat ?? (spot as any).latitude;
  const lonRaw = (spot as any).lon ?? (spot as any).lng ?? (spot as any).longitude;

  const lat = latRaw != null ? Number(latRaw) : NaN;
  const lon = lonRaw != null ? Number(lonRaw) : NaN;

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

async function loadSpotById(spotId: string): Promise<Spot | null> {
  const publicPath = path.join(process.cwd(), "public", "spots.json");
  const raw = await fs.readFile(publicPath, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) return null;

  // Support synthetic ids from /api/spots: "spot-<index>"
  // Example: spot-2932 -> parsed[2932]
  const m = /^spot-(\d+)$/.exec(spotId);
  if (m) {
    const idx = Number(m[1]);
    if (Number.isInteger(idx) && idx >= 0 && idx < parsed.length) {
      return parsed[idx] as Spot;
    }
  }

  // If the dataset later includes real IDs, this will work too:
  const found = parsed.find((s: any) => String(s.id ?? "") === spotId);
  return found ?? null;
}

async function seedSnapshotsForSpot(baseUrl: string, lat: number, lon: number, dates: string[]) {
  // Call your existing snapshot endpoint (same deployment)
  for (const date of dates) {
    const resp = await fetch(`${baseUrl}/api/snapshot`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lat, lon, date }),
      cache: "no-store",
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      console.warn(`[user-spots seed] snapshot failed ${date}: ${resp.status} ${txt}`);
    }
  }
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
 *   "spotIds"?: string[],     // for set
 *
 *   // optional enrollment to avoid "never snapshotted" bug
 *   "seed"?: boolean,         // if true and op=add, trigger snapshot calls
 *   "seedDays"?: number       // default 2 (today + yesterday), max 7
 * }
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

      // Optional seed snapshots to avoid "never snapshotted" bug
      const seed = Boolean(body.seed);
      if (seed) {
        const seedDaysRaw = Number(body.seedDays ?? 2);
        const seedDays = Math.max(1, Math.min(7, Number.isFinite(seedDaysRaw) ? seedDaysRaw : 2));

        const spot = await loadSpotById(spotId);
        const ll = spot ? getLatLon(spot) : null;

        if (ll) {
          const today = formatDateUTC(new Date());
          const dates: string[] = [];
          for (let i = 0; i < seedDays; i++) dates.push(addDaysUTC(today, -i));

          const baseUrl = new URL(req.url).origin;
          // fire-and-wait (keeps it simple/reliable)
          await seedSnapshotsForSpot(baseUrl, ll.lat, ll.lon, dates);
        } else {
          console.warn(`[user-spots seed] could not find coords for spotId=${spotId}`);
        }
      }
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

      const clean = Array.from(new Set(spotIdsRaw.map(normalizeSpotId).filter(Boolean) as string[]));

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
