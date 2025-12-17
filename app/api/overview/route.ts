// app/api/overview/route.ts
import { Redis } from "@upstash/redis";

export const dynamic = "force-dynamic";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const MARINE_BASE_URL = "https://marine-api.open-meteo.com/v1/marine";

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
  "sea_surface_temperature",
  "sea_level_height_msl",
  "wind_speed_10m",
  "wind_direction_10m",
].join(",");

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
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

// Pick a representative hourly index for a day (prefer 12:00, else first hour)
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

function computeTideForDate(date: string, hourly: any) {
  if (
    !hourly ||
    !Array.isArray(hourly.time) ||
    !Array.isArray(hourly.sea_level_height_msl)
  ) {
    return {
      tideHigh: null as number | null,
      tideHighTime: null as string | null,
      tideLow: null as number | null,
      tideLowTime: null as string | null,
    };
  }

  const prefix      = date + "T";
  let tideHigh: number | null = null;
  let tideHighTime: string | null = null;
  let tideLow: number | null = null;
  let tideLowTime: string | null = null;

  for (let i = 0; i < hourly.time.length; i++) {
    const t = hourly.time[i] as string;
    if (!t.startsWith(prefix)) continue;

    const val = hourly.sea_level_height_msl[i] as number | null;
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

  return { tideHigh, tideHighTime, tideLow, tideLowTime };
}

// Build a DailySummary from a marine "hourly" object for one date
function buildDailySummary(date: string, hourly: any): DailySummary | null {
  if (!hourly || !Array.isArray(hourly.time)) return null;

  const idx = pickIndexForDate(hourly.time, date);
  if (idx === null) return null;

  const get = (arr?: any[]) =>
    Array.isArray(arr) && arr.length > idx ? arr[idx] : null;

  const { tideHigh, tideHighTime, tideLow, tideLowTime } = computeTideForDate(
    date,
    hourly
  );

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

    // === 1. Load past 7 days of stored snapshots (including today) ===
    const pastDates: string[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = addDays(today, -i);
      pastDates.push(formatDate(d));
    }

    const pastKeys = pastDates.map(
      (d) => `tsr:snap:${d}:${rl},${rlo}`
    );

    const rawSnaps = await redis.mget(...pastKeys);

    const pastSummaries: DailySummary[] = [];
    for (let i = 0; i < pastDates.length; i++) {
      const raw = rawSnaps[i];
      if (!raw) continue;

      try {
        const parsed =
          typeof raw === "string" ? JSON.parse(raw) : (raw as any);

        const summary = buildDailySummary(pastDates[i], parsed.hourly);
        if (summary) pastSummaries.push(summary);
      } catch (e) {
        console.warn("[overview] failed to parse snapshot", pastKeys[i], e);
      }
    }

    // === 2. Fetch next 6 days of forecast from marine API ===
    const futureStart = todayStr;
    const futureEnd = formatDate(addDays(today, 6)); // inclusive

    const url = new URL(MARINE_BASE_URL);
    url.searchParams.set("latitude", rl.toString());
    url.searchParams.set("longitude", rlo.toString());
    url.searchParams.set("start_date", futureStart);
    url.searchParams.set("end_date", futureEnd);
    url.searchParams.set("hourly", HOURLY_PARAMS);

    const res = await fetch(url.toString(), { cache: "no-store" });
    if (!res.ok) {
      console.error("[overview] marine API error", res.status, await res.text());
      return new Response("failed to fetch marine forecast", { status: 502 });
    }

    const forecast = await res.json();
    const hourly = forecast.hourly ?? { time: [] };

    const futureSummaries: DailySummary[] = [];
    for (let i = 0; i <= 6; i++) {
      const d = formatDate(addDays(today, i));
      const summary = buildDailySummary(d, hourly);
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
