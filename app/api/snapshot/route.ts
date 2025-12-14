import { Redis } from "@upstash/redis";

export const dynamic = "force-dynamic";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

// Open-Meteo Marine base URL
const MARINE_BASE_URL = "https://marine-api.open-meteo.com/v1/marine";

// Hourly parameters we care about for Swell Recap
const HOURLY_PARAMS = [
  "wave_height",
  "wave_direction",
  "wave_period",
  "swell_wave_height",
  "swell_wave_direction",
  "swell_wave_period",
  "secondary_swell_wave_height",
  "secondary_swell_wave_direction",
  "secondary_swell_wave_period",
  "tertiary_swell_wave_height",
  "tertiary_swell_wave_direction",
  "tertiary_swell_wave_period",
  "sea_surface_temperature"
].join(",");

type MarineSnapshot = {
  lat: number;
  lon: number;
  date: string;
    hourly: {
    time: string[];
    swell_wave_height?: number[];
    swell_wave_period?: number[];
    swell_wave_direction?: number[];
    wave_height?: number[];
    wave_period?: number[];
    wave_direction?: number[];
    secondary_swell_wave_height?: number[];
    secondary_swell_wave_period?: number[];
    secondary_swell_wave_direction?: number[];
    tertiary_swell_wave_height?: number[];
    tertiary_swell_wave_period?: number[];
    tertiary_swell_wave_direction?: number[];
    sea_surface_temperature?: number[];
  };
};

/**
 * POST /api/snapshot
 *
 * Body:
 * {
 *   "lat": number,
 *   "lon": number,
 *   "date"?: "YYYY-MM-DD" // optional, defaults to today in UTC
 * }
 *
 * This:
 *  - fetches hourly marine data for that day from Open-Meteo
 *  - stores it in Redis under tsr:snap:<date>:<lat>,<lon>
 *  - returns the snapshot JSON
 */
export async function POST(req: Request) {
  try {
    const { lat, lon, date } = await req.json();

    if (typeof lat !== "number" || typeof lon !== "number") {
      return new Response("lat and lon are required", { status: 400 });
    }

    const targetDate =
      typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)
        ? date
        : new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC

    // Slight rounding so keys are stable but still precise enough
    const rl = Math.round(lat * 1000) / 1000;
    const rlo = Math.round(lon * 1000) / 1000;

    const url = new URL(MARINE_BASE_URL);
    url.searchParams.set("latitude", rl.toString());
    url.searchParams.set("longitude", rlo.toString());
    url.searchParams.set("start_date", targetDate);
    url.searchParams.set("end_date", targetDate);
    url.searchParams.set("hourly", HOURLY_PARAMS);
    // you can add timezone param later if you want local time
    // url.searchParams.set("timezone", "auto");

    const res = await fetch(url.toString(), { cache: "no-store" });
    if (!res.ok) {
      console.error("[snapshot-surf] marine API error", res.status, await res.text());
      return new Response("failed to fetch marine data", { status: 502 });
    }

    const data = await res.json();

    const snapshot: MarineSnapshot = {
      lat: rl,
      lon: rlo,
      date: targetDate,
      hourly: data.hourly ?? {
        time: [],
      },
    };

    const key = `tsr:snap:${targetDate}:${rl},${rlo}`;

    await redis.set(key, JSON.stringify(snapshot));

    return new Response(JSON.stringify(snapshot), {
      status: 200,
      headers: {
        "content-type": "application/json",
      },
    });
  } catch (err: any) {
    console.error("[snapshot-surf] error", err);
    return new Response(err?.message || "internal error", { status: 500 });
  }
}
