// app/api/overview/route.ts
import { Redis } from "@upstash/redis";

export const dynamic = "force-dynamic";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const MARINE_BASE_URL = "https://marine-api.open-meteo.com/v1/marine";
const FORECAST_BASE_URL = "https://api.open-meteo.com/v1/forecast";

// === MARINE HOURLY PARAMS (WORKING SET) =======================
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
  "sea_level",
  // These are harmless here even if marine doesn’t use them;
  // real wind will come from the FORECAST API below.
  "wind_speed_10m",
  "wind_direction_10m",
].join(",");

// FORECAST HOURLY PARAMS (for wind)
const FORECAST_HOURLY_PARAMS = [
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
  const copy = new Date(date);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
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

// Build a DailySummary from a marine "hourly" object for one date
function buildDailySummary(
  date: string,
  hourly: any
): DailySummary | null {
  if (!hourly || !Array.isArray(hourly.time)) return null;

  const idx = pickIndexForDate(hourly.time, date);
  if (idx === null) return null;

  // Helper to safely read hourly arrays
  const get = (arr?: any[]) =>
    Array.isArray(arr) && arr.length > idx ? arr[idx] : null;

  // --- TIDE CALCULATION ---------------------------------------
  const tideData = hourly.se_level ?? hourly.sea_level ?? null;

  let tideHigh: number | null = null;
  let tideHighTime: string | null = null;
  let tideLow: number | null = null;
  let tideLowTime: string | null = null;

  if (Array.isArray(tideData)) {
    const prefix = date + "T";

    for (let i = 0; i < hourly.time.length; i++) {
      const t = hourly.time[i]; // "YYYY-MM-DDTHH:00"
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
  // -------------------------------------------------------------

  return {
    date,
    swell: {
      height: get(hourly.swell_wave_height),
      period: get(hourly.swell_wave_period),
      direction: get(hourly.swell_wave_direction),
    },
    waveHeight: get(hourly.wave_height),
    wind: {
      // will be filled in later from forecast API
      speed: null,
      direction: null,
    },
    waterTemperature: get(hourly.sea_surface_temperature),
    tideHigh,
    tideHighTime,
    tideLow,
    tideLowTime,
  };
}

// Fill wind on existing summaries using forecast hourly data
function setWindFromForecast(
  summaries: DailySummary[],
  forecastHourly: any
) {
  if (!forecastHourly || !Array.isArray(forecastHourly.time)) return;

  const times: string[] = forecastHourly.time;
  const ws = forecastHourly.wind_speed_10m ?? [];
  const wd = forecastHourly.wind_direction_10m ?? [];

  for (const s of summaries) {
    const idx = pickIndexForDate(times, s.date);
    if (idx === null) continue;

    const speed =
      Array.isArray(ws) && ws.length > idx ? ws[idx] : null;
    const direction =
      Array.isArray(wd) && wd.length > idx ? wd[idx] : null;

    s.wind = { speed, direction };
  }
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
        const parsed: any = typeof raw === "string" ? JSON.parse(raw) : raw;
        const summary = buildDailySummary(pastDates[i], parsed.hourly);
        if (summary) pastSummaries.push(summary);
      } catch (e) {
        console.warn("[overview] failed to parse snapshot", pastKeys[i], e);
      }
    }

    // === 2. Fetch next 6 days of marine forecast (for swell/tide/temp) ===
    const futureStart = todayStr;
    const futureEnd = formatDate(addDays(today, 6)); // inclusive

    const marineUrl = new URL(MARINE_BASE_URL);
    marineUrl.searchParams.set("latitude", rl.toString());
    marineUrl.searchParams.set("longitude", rlo.toString());
    marineUrl.searchParams.set("start_date", futureStart);
    marineUrl.searchParams.set("end_date", futureEnd);
    marineUrl.searchParams.set("hourly", HOURLY_PARAMS);

    console.log("[DEBUG] Marine URL:", marineUrl.toString());

    const marineRes = await fetch(marineUrl.toString(), { cache: "no-store" });
    if (!marineRes.ok) {
      console.error(
        "[overview] marine API error",
        marineRes.status,
        await marineRes.text()
      );
      return new Response("failed to fetch marine forecast", { status: 502 });
    }

    const marineForecast = await marineRes.json();
    const marineHourly = marineForecast.hourly ?? { time: [] };

    const futureSummaries: DailySummary[] = [];
    for (let i = 0; i <= 6; i++) {
      const d = formatDate(addDays(today, i));
      const summary = buildDailySummary(d, marineHourly);
      if (summary) futureSummaries.push(summary);
    }

    // === 3. Fetch wind from FORECAST API for the combined window ===
    const windStart = pastDates[0]; // earliest past day (even if no snapshots)
    const windEnd = futureEnd;

    try {
      const forecastUrl = new URL(FORECAST_BASE_URL);
      forecastUrl.searchParams.set("latitude", rl.toString());
      forecastUrl.searchParams.set("longitude", rlo.toString());
      forecastUrl.searchParams.set("start_date", windStart);
      forecastUrl.searchParams.set("end_date", windEnd);
      forecastUrl.searchParams.set("hourly", FORECAST_HOURLY_PARAMS);
      forecastUrl.searchParams.set("timezone", "auto");

      const forecastRes = await fetch(forecastUrl.toString(), {
        cache: "no-store",
      });

      if (!forecastRes.ok) {
        console.error(
          "[overview] forecast API error (wind)",
          forecastRes.status,
          await forecastRes.text()
        );
        // We still return marine-only data if wind fails
      } else {
        const forecastData = await forecastRes.json();
        const forecastHourly = forecastData.hourly ?? { time: [] };

        // Fill wind on both past + future summaries
        setWindFromForecast(pastSummaries, forecastHourly);
        setWindFromForecast(futureSummaries, forecastHourly);
      }
    } catch (e) {
      console.error("[overview] error fetching forecast wind", e);
      // Still return marine data
    }

    const payload: OverviewResponse = {
      lat: rl,
      lon: rlo,
      past: pastSummaries,
      future: futureSummaries,
    };

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: {
        "content-type": "application/json",
      },
    });
  } catch (err: any) {
    console.error("[overview] error", err);
    return new Response(err?.message || "internal error", { status: 500 });
  }
}
