import { Redis } from "@upstash/redis";
import { normalizePlaceName } from "../../../lib/normalizePlace";

export const dynamic = "force-dynamic";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

export async function GET() {
  try {
    const places = (await redis.smembers("twr:places")) as any[];

    if (!places || places.length === 0) {
      return Response.json({ status: "no-places" });
    }

    // clear old set
    await redis.del("twr:places");

    for (const p of places) {
      const name = p.name;
      const lat = p.lat;
      const lon = p.lon;

      const cleanName = await normalizePlaceName(lat, lon, name);

      await redis.sadd(
        "twr:places",
        JSON.stringify({ name: cleanName, lat, lon })
      );
    }

    return Response.json({ status: "fixed" });
  } catch (e: any) {
    return Response.json(
      { status: "error", detail: String(e?.message || e) },
      { status: 500 }
    );
  }
}
