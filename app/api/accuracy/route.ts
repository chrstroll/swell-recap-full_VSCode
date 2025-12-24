// app/api/accuracy/route.ts
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

type SwellComponents = {
  primary: SwellComponent | null;
  secondary: SwellComponent | null;
  tertiary: SwellComponent | null;
};

type TideBundle = { highs: TideEvent[]; lows: TideEvent[] };

type AccuracyDaySide = {
  // Back-compat fields (your iOS currently expects these)
  swellHeight: number | null;
  swellPeriod: number | null;
  swellDirection: number | null;

  // New: multi-component swell (for upcoming iOS toggles)
  swell?: SwellComponents;

  // still used in payloads today
  waveHeight: number | null;
  windSpeed: number | null;
  windDirection: number | null;
  waterTemperature: number | null;

  tideHigh: number | null;
  tideHighTime: string | null;
  tideLow: number | null;
  tideLowTime: string | null;

  // New: up to 2 highs + 2 lows (and sometimes 3 events)
  tides?: TideBundle;

  // Optional back-compat convenience for secondary/tertiary until iOS updates
  secondarySwellHeight?: number | null;
  secondarySwellPeriod?: number | null;
  secondarySwellDirection?: number | null;

  tertiarySwellHeight?: number | null;
  tertiarySwellPeriod?: number | null;
  tertiarySwellDirection?: number | null;
};

type AccuracyDayDiffs = Record<string, number | null>;

type AccuracyDay = {
  date: string;
  actual: AccuracyDaySide | null;
  predicted: AccuracyDaySide | null;
  diffs: AccuracyDayDiffs;
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

function buildSideFromHourly(date: string, hourly: any): AccuracyDaySide | null {
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

  const seaLevelFull = numArr(hourly.sea_level_height_msl);
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

  const swell: SwellComponents = { primary, secondary, tertiary };

  return {
    // back-compat = primary
    swellHeight: primary?.height ?? null,
    swellPeriod: primary?.period ?? null,
    swellDirection: primary?.direction ?? null,

    swell,

    // convenience back-compat for secondary/tertiary
    secondarySwellHeight: secondary?.height ?? null,
    secondarySwellPeriod: secondary?.period ?? null,
    secondarySwellDirection: secondary?.direction ?? null,
    tertiarySwellHeight: tertiary?.height ?? null,
    tertiarySwellPeriod: tertiary?.period ?? null,
    tertiarySwellDirection: tertiary?.direction ?? null,

    waveHeight: median(clean(waveH)),
    windSpeed: median(clean(windS)),
    windDirection: mostCommonDirection(windD),
    waterTemperature: median(clean(waterT)),

    tideHigh: tide.tideHigh,
    tideHighTime: tide.tideHighTime,
    tideLow: tide.tideLow,
    tideLowTime: tide.tideLowTime,

    tides: { highs: tide.highs, lows: tide.lows },
  };
}

function sideFromSnapshotSummary(snapshot: any): AccuracyDaySide | null {
  if (!snapshot?.summary) return null;

  const s = snapshot.summary;

  const primary = s?.swell?.primary ?? null;
  const secondary = s?.swell?.secondary ?? null;
  const tertiary = s?.swell?.tertiary ?? null;

  const swell: SwellComponents = {
    primary: primary ? { height: primary.height ?? null, period: primary.period ?? null, direction: primary.direction ?? null } : null,
    secondary: secondary ? { height: secondary.height ?? null, period: secondary.period ?? null, direction: secondary.direction ?? null } : null,
    tertiary: tertiary ? { height: tertiary.height ?? null, period: tertiary.period ?? null, direction: tertiary.direction ?? null } : null,
  };

  const tidesFromSnap: TideBundle | null =
    s?.tides?.highs || s?.tides?.lows
      ? {
          highs: (s.tides.highs ?? []).map((e: any) => ({ time: e.time, height: Number(e.height) })),
          lows: (s.tides.lows ?? []).map((e: any) => ({ time: e.time, height: Number(e.height) })),
        }
      : null;

  return {
    // back-compat = primary
    swellHeight: swell.primary?.height ?? null,
    swellPeriod: swell.primary?.period ?? null,
    swellDirection: swell.primary?.direction ?? null,

    swell,

    secondarySwellHeight: swell.secondary?.height ?? null,
    secondarySwellPeriod: swell.secondary?.period ?? null,
    secondarySwellDirection: swell.secondary?.direction ?? null,
    tertiarySwellHeight: swell.tertiary?.height ?? null,
    tertiarySwellPeriod: swell.tertiary?.period ?? null,
    tertiarySwellDirection: swell.tertiary?.direction ?? null,

    waveHeight: snapshot?.waveHeight ?? null,

    windSpeed: s?.wind?.speed ?? null,
    windDirection: s?.wind?.direction ?? null,
    waterTemperature: s?.waterTemperature ?? null,

    tideHigh: s?.tideHigh ?? null,
    tideHighTime: s?.tideHighTime ?? null,
    tideLow: s?.tideLow ?? null,
    tideLowTime: s?.tideLowTime ?? null,

    tides: tidesFromSnap ?? undefined,
  };
}

function diffNum(a: number | null | undefined, b: number | null | undefined) {
  if (a == null || b == null) return null;
  return a - b;
}

function computeDiffs(actual: AccuracyDaySide | null, predicted: AccuracyDaySide | null): AccuracyDayDiffs {
  const diffs: AccuracyDayDiffs = {
    swellHeight: diffNum(actual?.swellHeight, predicted?.swellHeight),
    swellPeriod: diffNum(actual?.swellPeriod, predicted?.swellPeriod),
    swellDirection: diffNum(actual?.swellDirection, predicted?.swellDirection),

    waveHeight: diffNum(actual?.waveHeight, predicted?.waveHeight),

    windSpeed: diffNum(actual?.windSpeed, predicted?.windSpeed),
    windDirection: diffNum(actual?.windDirection, predicted?.windDirection),

    waterTemperature: diffNum(actual?.waterTemperature, predicted?.waterTemperature),

    tideHigh: diffNum(actual?.tideHigh, predicted?.tideHigh),
    tideLow: diffNum(actual?.tideLow, predicted?.tideLow),

    secondarySwellHeight: diffNum(actual?.secondarySwellHeight, predicted?.secondarySwellHeight),
    secondarySwellPeriod: diffNum(actual?.secondarySwellPeriod, predicted?.secondarySwellPeriod),
    secondarySwellDirection: diffNum(actual?.secondarySwellDirection, predicted?.secondarySwellDirection),

    tertiarySwellHeight: diffNum(actual?.tertiarySwellHeight, predicted?.tertiarySwellHeight),
    tertiarySwellPeriod: diffNum(actual?.tertiarySwellPeriod, predicted?.tertiarySwellPeriod),
    tertiarySwellDirection: diffNum(actual?.tertiarySwellDirection, predicted?.tertiarySwellDirection),
  };

  return diffs;
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const lat = body.lat;
    const lon = body.lon;
    const centerDate: string | undefined = body.centerDate;

    if (typeof lat !== "number" || typeof lon !== "number") {
      return new Response("lat and lon are required", { status: 400 });
    }
    if (!centerDate || !/^\d{4}-\d{2}-\d{2}$/.test(centerDate)) {
      return new Response("centerDate (yyyy-mm-dd) is required", { status: 400 });
    }

    const rl = Math.round(lat * 1000) / 1000;
    const rlo = Math.round(lon * 1000) / 1000;

    const base = new Date(centerDate + "T00:00:00Z");
    const dPrev = addDays(base, -1);
    const dNext = addDays(base, 1);

    const dates = [formatDate(dPrev), formatDate(base), formatDate(dNext)];

    // ---- Actual: from snapshots if they exist
    const snapKeys = dates.map((d) => `tsr:snap:${d}:${rl},${rlo}`);
    const rawSnaps = await redis.mget(...snapKeys);

    const actualByDate: Record<string, AccuracyDaySide | null> = {};
    for (let i = 0; i < dates.length; i++) {
      const raw = rawSnaps[i];
      if (!raw) {
        actualByDate[dates[i]] = null;
        continue;
      }
      try {
        const snap = typeof raw === "string" ? JSON.parse(raw) : raw;
        actualByDate[dates[i]] = sideFromSnapshotSummary(snap);
      } catch {
        actualByDate[dates[i]] = null;
      }
    }

    // ---- Predicted: build from forecast hourly (pad ±2 days for tide edge detection)
    const padStart = formatDate(addDays(base, -2));
    const padEnd = formatDate(addDays(base, 2));

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
      console.error("[accuracy] marine API error", marineRes.status, txt);
      return new Response("failed to fetch marine forecast", { status: 502 });
    }

    const marine = await marineRes.json();
    const marineHourly: any = marine.hourly ?? { time: [] };

    let forecastHourly: any = null;
    if (forecastRes.ok) {
      const forecast = await forecastRes.json();
      forecastHourly = forecast.hourly ?? null;
    }

    const hourlyCombined: any = {
      time: marineHourly.time ?? [],
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

    const predictedByDate: Record<string, AccuracyDaySide | null> = {};
    for (const d of dates) {
      predictedByDate[d] = buildSideFromHourly(d, hourlyCombined);
    }

    // ---- Build response days
    const days: AccuracyDay[] = dates.map((d) => {
      const actual = actualByDate[d] ?? null;
      const predicted = predictedByDate[d] ?? null;
      const diffs = computeDiffs(actual, predicted);
      return { date: d, actual, predicted, diffs };
    });

    const payload: AccuracyResponse = {
      lat: rl,
      lon: rlo,
      centerDate,
      days,
    };

    return NextResponse.json(payload);
  } catch (err: any) {
    console.error("[accuracy] error", err?.message ?? err);
    return new Response(err?.message ?? "internal error", { status: 500 });
  }
}