// app/api/accuracy/route.ts
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
  "sea_level",
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

type AccuracyDay = {
  date: string;
  actual: DailySummary | null;
  predicted: DailySummary | null;
  diff: {
    swellHeight: number | null;
    swellPeriod: number | null;
    waveHeight: number | null;
    waterTemperature: number | null;
    tideHigh: number | null;
    tideLow: number | null;
  };
};

type AccuracyResponse = {
  lat: number;
  lon: number;
  centerDate: string;
  days: AccuracyDay[];
};

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number): Date {
  const copy = new Date(date);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

// Prefer noon, fall back to first hour for that date
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
function buildDailySummary(date: string, hourly: any): DailySummary | null {
  if (!hourly || !Array.isArray(hourly.time)) return null;

  const idx = pickIndexForDate(hourly.time, date);
  if (idx === null) return null;

  const get = (arr?: any[]) =>
    Array.isArray(arr) && arr.length > idx ? arr[idx] : null;

  // --- TIDES (max / min for that day) -------------------------
  const tideData = hourly.se_level ?? hourly.sea_level ?? null;

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
  // ------------------------------------------------------------

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

function diffNumber(a: number | null, b: number | null): number | null {
  if (a == null || b == null) return null;
  return a - b;
}

/**
 * POST /api/accuracy
 *
 * Body:
 * {
 *   "lat": number,
 *   "lon": number,
 *   "centerDate"?: "YYYY-MM-DD" // optional, defaults to yesterday (UTC)
 * }
 *
 * Returns accuracy over [centerDate - 1, centerDate, centerDate + 1]
 */
export async function POST(req: Request) {
  try {
    const { lat, lon, centerDate } = await req.json();

    if (typeof lat !== "number" || typeof lon !== "number") {
      return new Response("lat and lon are required", { status: 400 });
    }

    const rl = Math.round(lat * 1000) / 1000;
    const rlo = Math.round(lon * 1000) / 1000;

    // Default center date = yesterday (UTC)
    let center: string;
    if (typeof centerDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(centerDate)) {
      center = centerDate;
    } else {
      const today = new Date();
      const yesterday = addDays(today, -1);
      center = formatDate(yesterday);
    }

    const centerDateObj = new Date(center + "T00:00:00Z");
    const dates: string[] = [
      formatDate(addDays(centerDateObj, -1)),
      center,
      formatDate(addDays(centerDateObj, 1)),
    ];

    // 1) Load actuals from Redis snapshots
    const snapKeys = dates.map((d) => `tsr:snap:${d}:${rl},${rlo}`);
    const rawSnaps = await redis.mget(...snapKeys);

    const actualByDate: Record<string, DailySummary | null> = {};
    for (let i = 0; i < dates.length; i++) {
      const raw = rawSnaps[i];
      if (!raw) {
        actualByDate[dates[i]] = null;
        continue;
      }
      try {
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        actualByDate[dates[i]] = buildDailySummary(dates[i], parsed.hourly);
      } catch (e) {
        console.warn("[accuracy] failed to parse snapshot", snapKeys[i], e);
        actualByDate[dates[i]] = null;
      }
    }

    // 2) Fetch forecast covering these 3 dates
    const forecastStart = dates[0];
    const forecastEnd = dates[2];

    const url = new URL(MARINE_BASE_URL);
    url.searchParams.set("latitude", rl.toString());
    url.searchParams.set("longitude", rlo.toString());
    url.searchParams.set("start_date", forecastStart);
    url.searchParams.set("end_date", forecastEnd);
    url.searchParams.set("hourly", HOURLY_PARAMS);

    const res = await fetch(url.toString(), { cache: "no-store" });
    if (!res.ok) {
      console.error("[accuracy] marine API error", res.status, await res.text());
      return new Response("failed to fetch marine forecast", { status: 502 });
    }

    const forecast = await res.json();
    const hourly = forecast.hourly ?? { time: [] };

    const predictedByDate: Record<string, DailySummary | null> = {};
    for (const d of dates) {
      predictedByDate[d] = buildDailySummary(d, hourly);
    }

    // 3) Build accuracy entries
    const days: AccuracyDay[] = dates.map((d) => {
      const actual = actualByDate[d] ?? null;
      const predicted = predictedByDate[d] ?? null;

      return {
        date: d,
        actual,
        predicted,
        diff: {
          swellHeight: diffNumber(
            actual?.swell.height ?? null,
            predicted?.swell.height ?? null
          ),
          swellPeriod: diffNumber(
            actual?.swell.period ?? null,
            predicted?.swell.period ?? null
          ),
          waveHeight: diffNumber(
            actual?.waveHeight ?? null,
            predicted?.waveHeight ?? null
          ),
          waterTemperature: diffNumber(
            actual?.waterTemperature ?? null,
            predicted?.waterTemperature ?? null
          ),
          tideHigh: diffNumber(
            actual?.tideHigh ?? null,
            predicted?.tideHigh ?? null
          ),
          tideLow: diffNumber(
            actual?.tideLow ?? null,
            predicted?.tideLow ?? null
          ),
        },
      };
    });

    const payload: AccuracyResponse = {
      lat: rl,
      lon: rlo,
      centerDate: center,
      days,
    };

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: {
        "content-type": "application/json",
      },
    });
  } catch (err: any) {
    console.error("[accuracy] error", err);
    return new Response(err?.message || "internal error", { status: 500 });
  }
}
