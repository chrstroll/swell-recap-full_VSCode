import { Redis } from "@upstash/redis";
import { normalizePlaceName } from "../../../lib/normalizePlace";

export const dynamic = "force-dynamic";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

export async function POST(req: Request) {
  try {
    const { name, lat, lon } = await req.json();

    if (typeof lat !== "number" || typeof lon !== "number") {
      return new Response("Bad request", { status: 400 });
    }

    // Round to ~1km to dedupe & avoid precision noise
    const rl = Math.round(lat * 100) / 100;
    const rlo = Math.round(lon * 100) / 100;

    // NEW: normalize the place name using reverse geocoding.
    // If anything fails, we fall back to the provided name (or empty string).
    const fallbackName = (name as string) || "";
    const cleanName = await normalizePlaceName(rl, rlo, fallbackName);

    await redis.sadd(
      "twr:places",
      JSON.stringify({ name: cleanName, lat: rl, lon: rlo })
    );

    return new Response("ok");
  } catch (e: any) {
    return new Response(e?.message || "error", { status: 500 });
  }
}
