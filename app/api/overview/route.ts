// app/api/overview/route.ts
import { Redis } from "@upstash/redis";

export const dynamic = "force-dynamic";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const MARINE_BASE_URL = "https://marine-api.open-meteo.com/v1/marine";
const FORECAST_BASE_URL = "https://api.open-meteo.com/v1/forecast";

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

const WIND_HOURLY_PARAMS = ["wind_speed_10m", "wind_direction_10m"].join(",");

type DailySummary = {
  date: string;
  swell: {
    height: number | null;
    period: number | null;
    direction: number | null;
  };
  waveHeight: number | null;
  wind: {
    speed: number | null;
    direction: number | null;
  };
  waterTemperature: number | null;
  tideHigh: number | null;
  tideHighTime: string | null;
  tideLow: number | null;
  tideLowTime: string | null;
};

type OverviewResponse = {
  lat: number;
  lon: number;
  past: DailySummary[];
  future: DailySummary[];
};

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number): Date {
  const copy = new Date(date);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function pickIndexForDate(times: string[], date: string): number | null {
  const prefix = date + "T";
  let firstMatch: number | null = null;
  let noonIndex: number | null = null;

  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    if (!t.startsWith(prefix)) continue;
    if (firstMatch === null) firstMatch = i;
    if (t.startsWith(date + "T12")) {
      noonIndex = i;
      break;
    }
  }

  return noonIndex ?? firstMatch;
}

// Build a DailySummary from a merged "hourly" object for one date
function buildDailySummary(date: string, hourly: any): DailySummary | null {
  if (!hourly || !Array.isArray(hourly.time)) return null;

  const idx = pickIndexForDate(hourly.time, date);
  if (idx === null) return null;

  const get = (arr?: any[]) =>
    Array.isArray(arr) && arr.length > idx ? arr[idx] : null;

  // Tides from sea_level_height_msl: max & min within that day
  const tideData = hourly.sea_level_height_msl;
  let tideHigh: number | null = null;
  let tideHighTime: string | null = null;
  let tideLow: number | null = null;
  let tideLowTime: string | null = null;

  if (Array.isArray(tideData)) {
    const prefix = date + "T";
    for (let i = 0; i < hourly.time.length; i++) {
      const t = hourly.time[i];
      if (!t.startsWith(prefix)) continue;
      const val = tideData[i];
      if (val == null) continue;

      if (tideHigh === null || val > tideHigh) {
        tideHigh = val;
        tideHighTime = t;
      }
      if (tideLow === null || val < tideLow) {
        tideLow = val;
        tideLowTime = t;
      }
    }
  }

  return {
    date,
    swell: {
      height: get(hourly.swell_wave_height),
      period: get(hourly.swell_wave_period),
      direction: get(hourly.swell_wave_direction),
    },
    waveHeight: get(hourly.wave_height),
    wind: {
      speed: get(hourly.wind_speed_10m),
      direction: get(hourly.wind_direction_10m),
    },
    waterTemperature: get(hourly.sea_surface_temperature),
    tideHigh,
    tideHighTime,
    tideLow,
    tideLowTime,
  };
}

/**
 * POST /api/overview
 *
 * Body:
 * {
 *   "lat": number,
 *   "lon": number
 * }
 *
 * Returns 7 days of past actuals (if in Redis) and 7 days of forecast.
 */
export async function POST(req: Request) {
  try {
    const { lat, lon } = await req.json();

    if (typeof lat !== "number" || typeof lon !== "number") {
      return new Response("lat and lon are required", { status: 400 });
    }

    const rl = Math.round(lat * 1000) / 1000;
    const rlo = Math.round(lon * 1000) / 1000;

    const today = new Date();
    const todayStr = formatDate(today);

    // === 1. Past 7 days (snapshots) ======================================
    const pastDates: string[] = [];
    for (let i = 6; i >= 0; i--) {
      pastDates.push(formatDate(addDays(today, -i)));
    }

    const pastKeys = pastDates.map((d) => `tsr:snap:${d}:${rl},${rlo}`);
    const rawSnaps = await redis.mget(...pastKeys);

    const pastSummaries: DailySummary[] = [];
    for (let i = 0; i < pastDates.length; i++) {
      const raw = rawSnaps[i];
      if (!raw) continue;

      try {
        const parsed: any = typeof raw === "string" ? JSON.parse(raw) : raw;
        const hourly = parsed.hourly ?? { time: [] };
        const summary = buildDailySummary(pastDates[i], hourly);
        if (summary) pastSummaries.push(summary);
      } catch (e) {
        console.warn("[overview] failed to parse snapshot", pastKeys[i], e);
      }
    }

    // === 2. Marine + wind forecast for today + next 6 days ===============
    const futureStart = todayStr;
    const futureEnd = formatDate(addDays(today, 6));

    const marineUrl = new URL(MARINE_BASE_URL);
    marineUrl.searchParams.set("latitude", rl.toString());
    marineUrl.searchParams.set("longitude", rlo.toString());
    marineUrl.searchParams.set("start_date", futureStart);
    marineUrl.searchParams.set("end_date", futureEnd);
    marineUrl.searchParams.set("hourly", MARINE_HOURLY_PARAMS);

    const forecastUrl = new URL(FORECAST_BASE_URL);
    forecastUrl.searchParams.set("latitude", rl.toString());
    forecastUrl.searchParams.set("longitude", rlo.toString());
    forecastUrl.searchParams.set("start_date", futureStart);
    forecastUrl.searchParams.set("end_date", futureEnd);
    forecastUrl.searchParams.set("hourly", WIND_HOURLY_PARAMS);
    forecastUrl.searchParams.set("timezone", "auto");

    const [marineRes, forecastRes] = await Promise.all([
      fetch(marineUrl.toString(), { cache: "no-store" }),
      fetch(forecastUrl.toString(), { cache: "no-store" }),
    ]);

    if (!marineRes.ok) {
      console.error(
        "[overview] marine API error",
        marineRes.status,
        await marineRes.text()
      );
      return new Response("failed to fetch marine forecast", { status: 502 });
    }

    const marine = await marineRes.json();
    const marineHourly: any = marine.hourly ?? { time: [] };

    let forecastHourly: any | null = null;
    if (forecastRes.ok) {
      const forecast = await forecastRes.json();
      forecastHourly = forecast.hourly ?? null;
    } else {
      console.warn(
        "[overview] forecast wind API error",
        forecastRes.status,
        await forecastRes.text()
      );
    }

    const hourlyCombined: any = {
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
      hourlyCombined.wind_speed_10m = forecastHourly.wind_speed_10m;
      hourlyCombined.wind_direction_10m = forecastHourly.wind_direction_10m;
    }

    const futureSummaries: DailySummary[] = [];
    for (let i = 0; i <= 6; i++) {
      const d = formatDate(addDays(today, i));
      const summary = buildDailySummary(d, hourlyCombined);
      if (summary) futureSummaries.push(summary);
    }

    const payload: OverviewResponse = {
      lat: rl,
      lon: rlo,
      past: pastSummaries,
      future: futureSummaries,
    };

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (err: any) {
    console.error("[overview] error", err);
    return new Response(err?.message || "internal error", { status: 500 });
  }
}
