// app/api/overview/route.ts
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

type TideEvent = { time: string; height: number };

type SwellComponent = {
  height: number | null;
  period: number | null;
  direction: number | null;
};

type DailySummary = {
  date: string;

  // NEW: multi-component swell
  swell: {
    primary: SwellComponent | null;
    secondary: SwellComponent | null;
    tertiary: SwellComponent | null;
  };

  waveHeight: number | null;

  wind: { speed: number | null; direction: number | null };
  waterTemperature: number | null;

  // Back-compat
  tideHigh: number | null;
  tideHighTime: string | null;
  tideLow: number | null;
  tideLowTime: string | null;

  // NEW: up to 2 highs + 2 lows
  tides: { highs: TideEvent[]; lows: TideEvent[] };
};

type OverviewResponse = { lat: number; lon: number; past: DailySummary[]; future: DailySummary[] };

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function addDays(date: Date, days: number): Date {
  const copy = new Date(date);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function numArr(arr: any): (number | null)[] {
  if (!Array.isArray(arr)) return [];
  return arr.map((v) => (v == null || isNaN(Number(v)) ? null : Number(v)));
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const v = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

function mostCommonDirection(degs: (number | null)[]): number | null {
  const clean = degs
    .filter((d) => d != null && !isNaN(Number(d)))
    .map((d) => {
      let dd = Number(d) % 360;
      if (dd < 0) dd += 360;
      return Math.round(dd);
    });

  if (!clean.length) return null;

  const bins: Record<number, number> = {};
  for (const d of clean) {
    const b = Math.round(d / 10) * 10;
    bins[b] = (bins[b] || 0) + 1;
  }

  let best: number | null = null;
  let bestCount = -1;
  for (const k of Object.keys(bins)) {
    const cnt = bins[+k];
    if (cnt > bestCount) {
      bestCount = cnt;
      best = +k;
    }
  }
  return best;
}

function buildTideSummary(highs: TideEvent[], lows: TideEvent[]) {
  const fix = (x: number) => Number(x.toFixed(3));

  const hi =
    highs.length > 0
      ? highs.reduce((p, c) => (c.height > p.height ? c : p), highs[0])
      : null;
  const lo =
    lows.length > 0
      ? lows.reduce((p, c) => (c.height < p.height ? c : p), lows[0])
      : null;

  return {
    highs: highs.map((e) => ({ time: e.time, height: fix(e.height) })),
    lows: lows.map((e) => ({ time: e.time, height: fix(e.height) })),
    tideHigh: hi ? fix(hi.height) : null,
    tideHighTime: hi ? hi.time : null,
    tideLow: lo ? fix(lo.height) : null,
    tideLowTime: lo ? lo.time : null,
  };
}

// Uses the FULL time series neighbors to detect turning points, but only returns events on `date`.
function tideEventsForDate(times: string[], heights: (number | null)[], date: string) {
  const prefix = date + "T";
  const highs: TideEvent[] = [];
  const lows: TideEvent[] = [];

  for (let i = 1; i < times.length - 1; i++) {
    const t = times[i];
    if (!t?.startsWith(prefix)) continue;

    const h0 = heights[i - 1];
    const h1 = heights[i];
    const h2 = heights[i + 1];
    if (h0 == null || h1 == null || h2 == null) continue;

    if (h1 > h0 && h1 > h2) highs.push({ time: t, height: h1 });
    if (h1 < h0 && h1 < h2) lows.push({ time: t, height: h1 });
  }

  // fallback (min/max within day)
  if (!highs.length || !lows.length) {
    let maxEvt: TideEvent | null = null;
    let minEvt: TideEvent | null = null;

    for (let i = 0; i < times.length; i++) {
      const t = times[i];
      if (!t?.startsWith(prefix)) continue;
      const h = heights[i];
      if (h == null) continue;

      if (!maxEvt || h > maxEvt.height) maxEvt = { time: t, height: h };
      if (!minEvt || h < minEvt.height) minEvt = { time: t, height: h };
    }

    return buildTideSummary(maxEvt ? [maxEvt] : [], minEvt ? [minEvt] : []);
  }

  const topHighs = highs
    .slice()
    .sort((a, b) => b.height - a.height)
    .slice(0, 2)
    .sort((a, b) => a.time.localeCompare(b.time));

  const topLows = lows
    .slice()
    .sort((a, b) => a.height - b.height)
    .slice(0, 2)
    .sort((a, b) => a.time.localeCompare(b.time));

  return buildTideSummary(topHighs, topLows);
}

// Read `a.b.c` from snapshot.summary
function pickSummary(snapshot: any, path: string) {
  try {
    if (!snapshot?.summary) return null;
    const parts = path.split(".");
    let cur = snapshot.summary;
    for (const p of parts) {
      if (cur == null) return null;
      cur = cur[p];
    }
    return cur ?? null;
  } catch {
    return null;
  }
}

function buildDailyFromHourly(date: string, hourly: any): DailySummary | null {
  if (!hourly || !Array.isArray(hourly.time)) return null;

  const times: string[] = hourly.time;
  const prefix = date + "T";
  const idxs: number[] = [];
  for (let i = 0; i < times.length; i++) if (times[i]?.startsWith(prefix)) idxs.push(i);
  if (!idxs.length) return null;

  const slice = (arr: (number | null)[]) => idxs.map((i) => (i < arr.length ? arr[i] : null));
  const clean = (arr: (number | null)[]) => arr.filter((v): v is number => v != null && !isNaN(Number(v)));

  const pH = slice(numArr(hourly.swell_wave_height));
  const pP = slice(numArr(hourly.swell_wave_period));
  const pD = slice(numArr(hourly.swell_wave_direction));

  const sH = slice(numArr(hourly.secondary_swell_wave_height));
  const sP = slice(numArr(hourly.secondary_swell_wave_period));
  const sD = slice(numArr(hourly.secondary_swell_wave_direction));

  const tH = slice(numArr(hourly.tertiary_swell_wave_height));
  const tP = slice(numArr(hourly.tertiary_swell_wave_period));
  const tD = slice(numArr(hourly.tertiary_swell_wave_direction));

  const waveH = slice(numArr(hourly.wave_height));
  const windS = slice(numArr(hourly.wind_speed_10m));
  const windD = slice(numArr(hourly.wind_direction_10m));
  const waterT = slice(numArr(hourly.sea_surface_temperature));

  const seaLevelFull = numArr(hourly.sea_level_height_msl); // NOTE: use full series for tides
  const tide = tideEventsForDate(times, seaLevelFull, date);

  const primary: SwellComponent | null =
    clean(pH).length || clean(pP).length || clean(pD).length
      ? { height: median(clean(pH)), period: median(clean(pP)), direction: mostCommonDirection(pD) }
      : null;

  const secondary: SwellComponent | null =
    clean(sH).length || clean(sP).length || clean(sD).length
      ? { height: median(clean(sH)), period: median(clean(sP)), direction: mostCommonDirection(sD) }
      : null;

  const tertiary: SwellComponent | null =
    clean(tH).length || clean(tP).length || clean(tD).length
      ? { height: median(clean(tH)), period: median(clean(tP)), direction: mostCommonDirection(tD) }
      : null;

  return {
    date,
    swell: { primary, secondary, tertiary },
    waveHeight: median(clean(waveH)),
    wind: { speed: median(clean(windS)), direction: mostCommonDirection(windD) },
    waterTemperature: median(clean(waterT)),
    tideHigh: tide.tideHigh,
    tideHighTime: tide.tideHighTime,
    tideLow: tide.tideLow,
    tideLowTime: tide.tideLowTime,
    tides: { highs: tide.highs, lows: tide.lows },
  };
}

// Prefer snapshot.summary when present; fallback to built-from-hourly
function mergeSnapshotAndBuilt(snapshot: any, built: DailySummary | null): DailySummary | null {
  if (!built && !snapshot) return null;
  const date = built?.date ?? snapshot?.date ?? "";

  const sp = (which: "primary" | "secondary" | "tertiary"): SwellComponent | null => {
    const h = pickSummary(snapshot, `swell.${which}.height`);
    const p = pickSummary(snapshot, `swell.${which}.period`);
    const d = pickSummary(snapshot, `swell.${which}.direction`);

    const any = h != null || p != null || d != null;
    if (any) return { height: h ?? null, period: p ?? null, direction: d ?? null };

    // fallback to built
    const b = built?.swell?.[which] ?? null;
    return b;
  };

  // tides (new arrays)
  const tidesHighs = pickSummary(snapshot, "tides.highs") ?? pickSummary(snapshot, "tides.highs"); // defensive
  const tidesLows = pickSummary(snapshot, "tides.lows") ?? pickSummary(snapshot, "tides.lows");

  const tidesFromSnap =
    snapshot?.summary?.tides?.highs || snapshot?.summary?.tides?.lows
      ? {
          highs: (snapshot.summary.tides.highs ?? []).map((e: any) => ({ time: e.time, height: Number(e.height) })),
          lows: (snapshot.summary.tides.lows ?? []).map((e: any) => ({ time: e.time, height: Number(e.height) })),
        }
      : null;

  return {
    date,
    swell: {
      primary: sp("primary"),
      secondary: sp("secondary"),
      tertiary: sp("tertiary"),
    },
    waveHeight: pickSummary(snapshot, "waveHeight") ?? built?.waveHeight ?? null,
    wind: {
      speed: pickSummary(snapshot, "wind.speed") ?? built?.wind.speed ?? null,
      direction: pickSummary(snapshot, "wind.direction") ?? built?.wind.direction ?? null,
    },
    waterTemperature: pickSummary(snapshot, "waterTemperature") ?? built?.waterTemperature ?? null,

    // Back-compat hi/lo
    tideHigh: pickSummary(snapshot, "tideHigh") ?? built?.tideHigh ?? null,
    tideHighTime: pickSummary(snapshot, "tideHighTime") ?? built?.tideHighTime ?? null,
    tideLow: pickSummary(snapshot, "tideLow") ?? built?.tideLow ?? null,
    tideLowTime: pickSummary(snapshot, "tideLowTime") ?? built?.tideLowTime ?? null,

    // New tides arrays
    tides: tidesFromSnap ?? built?.tides ?? { highs: [], lows: [] },
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

    // ----- Past window: today-6 .. today (only return what exists in Redis)
    const pastDates: string[] = [];
    for (let i = 6; i >= 0; i--) pastDates.push(formatDate(addDays(today, -i)));

    const pastKeys = pastDates.map((d) => `tsr:snap:${d}:${rl},${rlo}`);
    const rawSnaps = await redis.mget(...pastKeys);

    const past: DailySummary[] = [];
    for (let i = 0; i < pastDates.length; i++) {
      const raw = rawSnaps[i];
      if (!raw) continue;
      try {
        const snap = typeof raw === "string" ? JSON.parse(raw) : raw;
        const built = buildDailyFromHourly(pastDates[i], {
          ...(snap?.hourly ?? {}),
          // snapshot.hourly is already day-only; tides arrays should come from summary anyway
          time: snap?.hourly?.time ?? [],
        });
        const merged = mergeSnapshotAndBuilt(snap, built);
        if (merged) past.push(merged);
      } catch (e) {
        console.warn("[overview] failed to parse snapshot", pastKeys[i], e);
      }
    }

    // ----- Future window: today .. today+6 (pad marine by ±1 day for better tide turning points)
    const futureStart = todayStr;
    const futureEnd = formatDate(addDays(today, 6));

    const padStart = formatDate(addDays(today, -1));
    const padEnd = formatDate(addDays(today, 7));

    const marineUrl = new URL(MARINE_BASE_URL);
    marineUrl.searchParams.set("latitude", rl.toString());
    marineUrl.searchParams.set("longitude", rlo.toString());
    marineUrl.searchParams.set("start_date", padStart);
    marineUrl.searchParams.set("end_date", padEnd);
    marineUrl.searchParams.set("hourly", MARINE_HOURLY_PARAMS);
    marineUrl.searchParams.set("timezone", "auto");

    const forecastUrl = new URL(FORECAST_BASE_URL);
    forecastUrl.searchParams.set("latitude", rl.toString());
    forecastUrl.searchParams.set("longitude", rlo.toString());
    forecastUrl.searchParams.set("start_date", padStart);
    forecastUrl.searchParams.set("end_date", padEnd);
    forecastUrl.searchParams.set("hourly", WIND_HOURLY_PARAMS);
    forecastUrl.searchParams.set("timezone", "auto");

    const [marineRes, forecastRes] = await Promise.all([
      fetch(marineUrl.toString(), { cache: "no-store" }),
      fetch(forecastUrl.toString(), { cache: "no-store" }),
    ]);

    if (!marineRes.ok) {
      const txt = await marineRes.text().catch(() => "");
      console.error("[overview] marine API error", marineRes.status, txt);
      return new Response("failed to fetch marine forecast", { status: 502 });
    }

    const marine = await marineRes.json();
    const marineHourly: any = marine.hourly ?? { time: [] };

    let forecastHourly: any = null;
    if (forecastRes.ok) {
      const forecast = await forecastRes.json();
      forecastHourly = forecast.hourly ?? null;
    } else {
      const txt = await forecastRes.text().catch(() => "");
      console.warn("[overview] forecast wind API error", forecastRes.status, txt);
    }

    const hourlyCombined: any = {
      time: marineHourly.time ?? forecastHourly?.time ?? [],
      swell_wave_height: marineHourly.swell_wave_height,
      swell_wave_period: marineHourly.swell_wave_period,
      swell_wave_direction: marineHourly.swell_wave_direction,

      secondary_swell_wave_height: marineHourly.secondary_swell_wave_height,
      secondary_swell_wave_period: marineHourly.secondary_swell_wave_period,
      secondary_swell_wave_direction: marineHourly.secondary_swell_wave_direction,

      tertiary_swell_wave_height: marineHourly.tertiary_swell_wave_height,
      tertiary_swell_wave_period: marineHourly.tertiary_swell_wave_period,
      tertiary_swell_wave_direction: marineHourly.tertiary_swell_wave_direction,

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

    const future: DailySummary[] = [];
    for (let i = 0; i <= 6; i++) {
      const d = formatDate(addDays(today, i));
      const built = buildDailyFromHourly(d, hourlyCombined);
      if (built) future.push(built);
    }

    const payload: OverviewResponse = { lat: rl, lon: rlo, past, future };
    return NextResponse.json(payload);
  } catch (err: any) {
    console.error("[overview] error", err?.message ?? err);
    return new Response(err?.message ?? "internal error", { status: 500 });
  }
}