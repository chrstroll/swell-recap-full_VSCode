import { Redis } from "@upstash/redis";
import { normalizePlaceName } from "../../../lib/normalizePlace";

export const dynamic = "force-dynamic";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

export async function POST(req: Request) {
  try {
    const { name, lat, lon, userId } = await req.json();

    if (typeof lat !== "number" || typeof lon !== "number" || !userId) {
      return new Response("Bad request", { status: 400 });
    }

    // Use the same normalizer for now — it will turn “lat/lon” into a readable label.
    const cleanName = await normalizePlaceName(
      lat,
      lon,
      name ?? "Unknown surf spot"
    );

    // Slight rounding so we don’t explode Redis cardinality on tiny coord changes.
    const rl = Math.round(lat * 1000) / 1000;
    const rlo = Math.round(lon * 1000) / 1000;

    // Per-user key for their set of surf spots (Swell Recap namespace: tsr = The Swell Recap)
    const spotsKey = `tsr:user:${userId}:spots`;

    await redis.sadd(
      spotsKey,
      JSON.stringify({ name: cleanName, lat: rl, lon: rlo })
    );

    return new Response("ok");
  } catch (e: any) {
    console.error("[track-surf] error", e);
    return new Response(e?.message || "error", { status: 500 });
  }
}
