// app/api/snapshot/route.ts
import { Redis } from "@upstash/redis";

export const dynamic = "force-dynamic";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

// Open-Meteo endpoints
const MARINE_BASE_URL = "https://marine-api.open-meteo.com/v1/marine";
const FORECAST_BASE_URL = "https://api.open-meteo.com/v1/forecast";

// Marine variables: swell, waves, SST, sea level
const MARINE_HOURLY_PARAMS = [
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
  "sea_surface_temperature",
  "sea_level_height_msl",
].join(",");

// Wind from the standard forecast API
const WIND_HOURLY_PARAMS = ["wind_speed_10m", "wind_direction_10m"].join(",");

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

    sea_level_height_msl?: number[];

    wind_speed_10m?: number[];
    wind_direction_10m?: number[];
  };
};

/**
 * POST /api/snapshot
 *
 * Body:
 * {
 *   "lat": number,
 *   "lon": number,
 *   "date"?: "YYYY-MM-DD" // optional, defaults to today (UTC)
 * }
 *
 * Fetches marine + wind data for that day, stores in Redis, and returns it.
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

    const rl = Math.round(lat * 1000) / 1000;
    const rlo = Math.round(lon * 1000) / 1000;

    // --- Build URLs -------------------------------------------------------
    const marineUrl = new URL(MARINE_BASE_URL);
    marineUrl.searchParams.set("latitude", rl.toString());
    marineUrl.searchParams.set("longitude", rlo.toString());
    marineUrl.searchParams.set("start_date", targetDate);
    marineUrl.searchParams.set("end_date", targetDate);
    marineUrl.searchParams.set("hourly", MARINE_HOURLY_PARAMS);

    const forecastUrl = new URL(FORECAST_BASE_URL);
    forecastUrl.searchParams.set("latitude", rl.toString());
    forecastUrl.searchParams.set("longitude", rlo.toString());
    forecastUrl.searchParams.set("start_date", targetDate);
    forecastUrl.searchParams.set("end_date", targetDate);
    forecastUrl.searchParams.set("hourly", WIND_HOURLY_PARAMS);
    forecastUrl.searchParams.set("timezone", "auto");

    const [marineRes, forecastRes] = await Promise.all([
      fetch(marineUrl.toString(), { cache: "no-store" }),
      fetch(forecastUrl.toString(), { cache: "no-store" }),
    ]);

    if (!marineRes.ok) {
      console.error(
        "[snapshot-surf] marine API error",
        marineRes.status,
        await marineRes.text()
      );
      return new Response("failed to fetch marine data", { status: 502 });
    }

    const marine = await marineRes.json();
    const marineHourly: any = marine.hourly ?? { time: [] };

    let forecastHourly: any | null = null;
    if (forecastRes.ok) {
      const forecast = await forecastRes.json();
      forecastHourly = forecast.hourly ?? null;
    } else {
      console.warn(
        "[snapshot-surf] forecast wind API error",
        forecastRes.status,
        await forecastRes.text()
      );
    }

    const hourly: any = {
      time: marineHourly.time ?? forecastHourly?.time ?? [],

      swell_wave_height: marineHourly.swell_wave_height,
      swell_wave_period: marineHourly.swell_wave_period,
      swell_wave_direction: marineHourly.swell_wave_direction,

      wave_height: marineHourly.wave_height,
      wave_period: marineHourly.wave_period,
      wave_direction: marineHourly.wave_direction,

      secondary_swell_wave_height: marineHourly.secondary_swell_wave_height,
      secondary_swell_wave_period: marineHourly.secondary_swell_wave_period,
      secondary_swell_wave_direction: marineHourly.secondary_swell_wave_direction,

      tertiary_swell_wave_height: marineHourly.tertiary_swell_wave_height,
      tertiary_swell_wave_period: marineHourly.tertiary_swell_wave_period,
      tertiary_swell_wave_direction: marineHourly.tertiary_swell_wave_direction,

      sea_surface_temperature: marineHourly.sea_surface_temperature,

      sea_level_height_msl: marineHourly.sea_level_height_msl,
    };

    if (forecastHourly) {
      hourly.wind_speed_10m = forecastHourly.wind_speed_10m;
      hourly.wind_direction_10m = forecastHourly.wind_direction_10m;
    }

    const snapshot: MarineSnapshot = {
      lat: rl,
      lon: rlo,
      date: targetDate,
      hourly,
    };

    const key = `tsr:snap:${targetDate}:${rl},${rlo}`;
    await redis.set(key, JSON.stringify(snapshot));

    return new Response(JSON.stringify(snapshot), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (err: any) {
    console.error("[snapshot-surf] error", err);
    return new Response(err?.message || "internal error", { status: 500 });
  }
}
