// app/api/history/route.ts
import { NextResponse } from "next/server";
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

type DayValues = {
  swellHeight: number | null;
  swellPeriod: number | null;
  swellDirection: number | null;

  waveHeight: number | null; // kept for compatibility (you can remove later)
  windSpeed: number | null;
  windDirection: number | null;

  waterTemperature: number | null;

  tideHigh: number | null;
  tideHighTime: string | null;
  tideLow: number | null;
  tideLowTime: string | null;
};

type HistoryDay = {
  date: string;
  actual: DayValues | null;
  predicted: DayValues | null;
};

type HistoryResponse = {
  lat: number;
  lon: number;
  centerDate: string;
  days: HistoryDay[];
};

function formatDateUTC(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function addDaysUTC(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return formatDateUTC(d);
}

function pickIndexForDate(times: string[], date: string): number | null {
  const prefix = date + "T";
  let first: number | null = null;
  let noon: number | null = null;
  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    if (!t?.startsWith(prefix)) continue;
    if (first === null) first = i;
    if (t.startsWith(date + "T12")) {
      noon = i;
      break;
    }
  }
  return noon ?? first;
}

function tideExtremaForDate(hourly: any, date: string) {
  const times: string[] = Array.isArray(hourly?.time) ? hourly.time : [];
  const sea: any[] = Array.isArray(hourly?.sea_level_height_msl) ? hourly.sea_level_height_msl : [];

  let tideHigh: number | null = null;
  let tideHighTime: string | null = null;
  let tideLow: number | null = null;
  let tideLowTime: string | null = null;

  const prefix = date + "T";
  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    if (!t?.startsWith(prefix)) continue;
    const v = sea[i];
    if (v == null || isNaN(Number(v))) continue;
    const vv = Number(v);

    if (tideHigh === null || vv > tideHigh) {
      tideHigh = vv;
      tideHighTime = t;
    }
    if (tideLow === null || vv < tideLow) {
      tideLow = vv;
      tideLowTime = t;
    }
  }

  return { tideHigh, tideHighTime, tideLow, tideLowTime };
}

function buildFromHourly(hourly: any, date: string): DayValues | null {
  if (!hourly || !Array.isArray(hourly.time)) return null;
  const idx = pickIndexForDate(hourly.time, date);
  if (idx === null) return null;

  const get = (arr?: any[]) =>
    Array.isArray(arr) && arr.length > idx ? (arr[idx] == null ? null : Number(arr[idx])) : null;

  const { tideHigh, tideHighTime, tideLow, tideLowTime } = tideExtremaForDate(hourly, date);

  return {
    swellHeight: get(hourly.swell_wave_height),
    swellPeriod: get(hourly.swell_wave_period),
    swellDirection: get(hourly.swell_wave_direction),

    waveHeight: get(hourly.wave_height),
    windSpeed: get(hourly.wind_speed_10m),
    windDirection: get(hourly.wind_direction_10m),

    waterTemperature: get(hourly.sea_surface_temperature),

    tideHigh,
    tideHighTime,
    tideLow,
    tideLowTime,
  };
}

function pickSummary(snapshot: any, path: string) {
  try {
    let cur = snapshot?.summary;
    for (const p of path.split(".")) {
      if (cur == null) return null;
      cur = cur[p];
    }
    return cur ?? null;
  } catch {
    return null;
  }
}

// Prefer snapshot.summary if available; else fall back to hourly
function buildActualFromSnapshot(snapshot: any, date: string): DayValues | null {
  if (!snapshot) return null;

  const sH = pickSummary(snapshot, "swell.primary.height");
  const sP = pickSummary(snapshot, "swell.primary.period");
  const sD = pickSummary(snapshot, "swell.primary.direction");

  const wS = pickSummary(snapshot, "wind.speed");
  const wD = pickSummary(snapshot, "wind.direction");

  const wt = pickSummary(snapshot, "waterTemperature");

  const tH = pickSummary(snapshot, "tideHigh");
  const tHT = pickSummary(snapshot, "tideHighTime");
  const tL = pickSummary(snapshot, "tideLow");
  const tLT = pickSummary(snapshot, "tideLowTime");

  // If we have *any* summary values, use them (and fill remaining from hourly)
  const hourlyBuilt = buildFromHourly(snapshot.hourly ?? null, date);

  const hasAnySummary =
    sH != null || sP != null || sD != null || wS != null || wD != null || wt != null || tH != null || tL != null;

  if (!hasAnySummary) return hourlyBuilt;

  return {
    swellHeight: sH ?? hourlyBuilt?.swellHeight ?? null,
    swellPeriod: sP ?? hourlyBuilt?.swellPeriod ?? null,
    swellDirection: sD ?? hourlyBuilt?.swellDirection ?? null,

    waveHeight: hourlyBuilt?.waveHeight ?? null,

    windSpeed: wS ?? hourlyBuilt?.windSpeed ?? null,
    windDirection: wD ?? hourlyBuilt?.windDirection ?? null,

    waterTemperature: wt ?? hourlyBuilt?.waterTemperature ?? null,

    tideHigh: tH ?? hourlyBuilt?.tideHigh ?? null,
    tideHighTime: tHT ?? hourlyBuilt?.tideHighTime ?? null,
    tideLow: tL ?? hourlyBuilt?.tideLow ?? null,
    tideLowTime: tLT ?? hourlyBuilt?.tideLowTime ?? null,
  };
}

async function fetchPredictedHourly(rl: number, rlo: number, start: string, end: string) {
  const marineUrl = new URL(MARINE_BASE_URL);
  marineUrl.searchParams.set("latitude", rl.toString());
  marineUrl.searchParams.set("longitude", rlo.toString());
  marineUrl.searchParams.set("start_date", start);
  marineUrl.searchParams.set("end_date", end);
  marineUrl.searchParams.set("hourly", MARINE_HOURLY_PARAMS);

  const forecastUrl = new URL(FORECAST_BASE_URL);
  forecastUrl.searchParams.set("latitude", rl.toString());
  forecastUrl.searchParams.set("longitude", rlo.toString());
  forecastUrl.searchParams.set("start_date", start);
  forecastUrl.searchParams.set("end_date", end);
  forecastUrl.searchParams.set("hourly", WIND_HOURLY_PARAMS);
  forecastUrl.searchParams.set("timezone", "auto");

  const [marineRes, forecastRes] = await Promise.all([
    fetch(marineUrl.toString(), { cache: "no-store" }),
    fetch(forecastUrl.toString(), { cache: "no-store" }),
  ]);

  if (!marineRes.ok) {
    const txt = await marineRes.text().catch(() => "");
    throw new Error(`failed to fetch marine forecast: ${marineRes.status} ${txt}`);
  }

  const marine = await marineRes.json();
  const marineHourly = marine.hourly ?? { time: [] };

  let forecastHourly: any | null = null;
  if (forecastRes.ok) {
    const forecast = await forecastRes.json();
    forecastHourly = forecast.hourly ?? null;
  }

  const hourlyCombined: any = {
    time: marineHourly.time ?? forecastHourly?.time ?? [],
    swell_wave_height: marineHourly.swell_wave_height,
    swell_wave_period: marineHourly.swell_wave_period,
    swell_wave_direction: marineHourly.swell_wave_direction,
    wave_height: marineHourly.wave_height,
    wave_period: marineHourly.wave_period,
    wave_direction: marineHourly.wave_direction,
    sea_surface_temperature: marineHourly.sea_surface_temperature,
    sea_level_height_msl: marineHourly.sea_level_height_msl,
  };

  if (forecastHourly) {
    hourlyCombined.wind_speed_10m = forecastHourly.wind_speed_10m;
    hourlyCombined.wind_direction_10m = forecastHourly.wind_direction_10m;
  }

  return hourlyCombined;
}

export async function POST(req: Request) {
  try {
    const { lat, lon, centerDate } = await req.json();

    if (typeof lat !== "number" || typeof lon !== "number") {
      return new Response("lat and lon are required", { status: 400 });
    }
    const cd =
      typeof centerDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(centerDate)
        ? centerDate
        : formatDateUTC(new Date());

    const rl = Math.round(lat * 1000) / 1000;
    const rlo = Math.round(lon * 1000) / 1000;

    const dates = [addDaysUTC(cd, -1), cd, addDaysUTC(cd, 1)];
    const keys = dates.map((d) => `tsr:snap:${d}:${rl},${rlo}`);
    const rawSnaps = await redis.mget(...keys);

    const start = dates[0];
    const end = dates[2];
    const predictedHourly = await fetchPredictedHourly(rl, rlo, start, end);

    const days: HistoryDay[] = [];
    for (let i = 0; i < dates.length; i++) {
      const d = dates[i];
      const raw = rawSnaps[i];
      const snap = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : null;

      const actual = buildActualFromSnapshot(snap, d);
      const predicted = buildFromHourly(predictedHourly, d);

      days.push({ date: d, actual, predicted });
    }

    const payload: HistoryResponse = { lat: rl, lon: rlo, centerDate: cd, days };
    return NextResponse.json(payload);
  } catch (err: any) {
    console.error("[history] error", err?.message ?? err);
    return new Response(err?.message ?? "internal error", { status: 500 });
  }
}
