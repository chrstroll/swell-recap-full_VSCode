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
  "sea_surface_temperature"
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
};

type HistoryDay = {
  date: string;
  actual: DailySummary | null;
  predicted: DailySummary | null;
};

type HistoryResponse = {
  lat: number;
  lon: number;
  centerDate: string;
  days: HistoryDay[]; // center -3 ... center +3
};

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
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

function buildDailySummary(date: string, hourly: any): DailySummary | null {
  if (!hourly || !Array.isArray(hourly.time)) return null;

  const idx = pickIndexForDate(hourly.time, date);
  if (idx === null) return null;

  const get = (arr?: any[]) =>
    Array.isArray(arr) && arr.length > idx ? arr[idx] : null;

  return {
    date,
    swell: {
      height: get(hourly.swell_wave_height),
      period: get(hourly.swell_wave_period),
      direction: get(hourly.swell_wave_direction),
    },
    waveHeight: get(hourly.wave_height),
    wind: {
      speed: null, // wind not wired yet
      direction: null,
    },
    waterTemperature: get(hourly.sea_surface_temperature),
  };
}

/**
 * POST /api/history
 *
 * Body:
 * {
 *   "lat": number,
 *   "lon": number,
 *   "centerDate": "YYYY-MM-DD"   // required for history
 * }
 *
 * Returns centerDate ± 3 days with actual and predicted.
 */
export async function POST(req: Request) {
  try {
    const { lat, lon, centerDate } = await req.json();

    if (typeof lat !== "number" || typeof lon !== "number") {
      return new Response("lat and lon are required", { status: 400 });
    }

    if (
      typeof centerDate !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(centerDate)
    ) {
      return new Response("centerDate must be YYYY-MM-DD", { status: 400 });
    }

    const rl = Math.round(lat * 1000) / 1000;
    const rlo = Math.round(lon * 1000) / 1000;

    const centerDateObj = new Date(centerDate + "T00:00:00Z");

    // Only get centerDate ±1 day (total 3 days: center -1, center, center +1)
    const dates: string[] = [
        formatDate(addDays(centerDateObj, -1)),  // center -1
        centerDate,  // center
        formatDate(addDays(centerDateObj, 1)),   // center +1
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
        let parsed: any;
        if (typeof raw === "string") {
          parsed = JSON.parse(raw);
        } else {
          parsed = raw;
        }
        actualByDate[dates[i]] = buildDailySummary(dates[i], parsed.hourly);
      } catch (e) {
        console.warn("[history] failed to parse snapshot", snapKeys[i], e);
        actualByDate[dates[i]] = null;
      }
    }

    // 2) Fetch forecast covering this window (even if some days are in the past/future)
    const forecastStart = dates[0];
    const forecastEnd = dates[dates.length - 1];

    const url = new URL(MARINE_BASE_URL);
    url.searchParams.set("latitude", rl.toString());
    url.searchParams.set("longitude", rlo.toString());
    url.searchParams.set("start_date", forecastStart);
    url.searchParams.set("end_date", forecastEnd);
    url.searchParams.set("hourly", HOURLY_PARAMS);

    const res = await fetch(url.toString(), { cache: "no-store" });
    if (!res.ok) {
      console.error("[history] marine API error", res.status, await res.text());
      return new Response("failed to fetch marine forecast", { status: 502 });
    }

    const forecast = await res.json();
    const hourly = forecast.hourly ?? { time: [] };

    const predictedByDate: Record<string, DailySummary | null> = {};
    for (const d of dates) {
      predictedByDate[d] = buildDailySummary(d, hourly);
    }

    const days: HistoryDay[] = dates.map((d) => ({
      date: d,
      actual: actualByDate[d] ?? null,
      predicted: predictedByDate[d] ?? null,
    }));

    const payload: HistoryResponse = {
      lat: rl,
      lon: rlo,
      centerDate,
      days,
    };

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: {
        "content-type": "application/json",
      },
    });
  } catch (err: any) {
    console.error("[history] error", err);
    return new Response(err?.message || "internal error", { status: 500 });
  }
}
