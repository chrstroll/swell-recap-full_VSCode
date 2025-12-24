// app/api/snapshot/route.ts
import { NextResponse } from "next/server";
import { Redis } from "@upstash/redis";

export const dynamic = "force-dynamic";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const MARINE_BASE_URL = "https://marine-api.open-meteo.com/v1/marine";
const FORECAST_BASE_URL = "https://api.open-meteo.com/v1/forecast";

function toYYYYMMDD(d: Date) {
  return d.toISOString().slice(0, 10);
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

  // 10° bins to stabilize noise
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

type TideEvent = { time: string; height: number };

function tideEventsForDate(
  times: string[],
  heights: (number | null)[],
  date: string
) {
  const prefix = date + "T";

  const highs: TideEvent[] = [];
  const lows: TideEvent[] = [];

  // Find local extrema using FULL series neighbors
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

  // If hourly extrema detection yields nothing (can happen on flat/noisy days),
  // fall back to min/max within the target date.
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

    const highsOut = maxEvt ? [maxEvt] : [];
    const lowsOut = minEvt ? [minEvt] : [];

    return buildTideSummary(highsOut, lowsOut);
  }

  // Choose up to 2 highs (highest) and 2 lows (lowest), then order by time
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

function buildTideSummary(highs: TideEvent[], lows: TideEvent[]) {
  const hi =
    highs.length > 0
      ? highs.reduce((p, c) => (c.height > p.height ? c : p), highs[0])
      : null;

  const lo =
    lows.length > 0
      ? lows.reduce((p, c) => (c.height < p.height ? c : p), lows[0])
      : null;

  // keep more precision in backend (UI can format to 2 decimals)
  const fix = (x: number) => Number(x.toFixed(3));

  return {
    highs: highs.map((e) => ({ time: e.time, height: fix(e.height) })),
    lows: lows.map((e) => ({ time: e.time, height: fix(e.height) })),
    tideHigh: hi ? fix(hi.height) : null,
    tideHighTime: hi ? hi.time : null,
    tideLow: lo ? fix(lo.height) : null,
    tideLowTime: lo ? lo.time : null,
  };
}

function safeNumberArray(source: any, key: string): (number | null)[] {
  const arr = source?.[key];
  if (!Array.isArray(arr)) return [];
  return arr.map((v: any) => (v == null ? null : Number(v)));
}

function pickByIdxs<T>(arr: T[], idxs: number[]): T[] {
  return idxs.map((i) => arr[i]);
}

export async function POST(req: Request) {
  try {
    const body = await req.json();

    const lat = body.lat;
    const lon = body.lon;
    const dateParam = body.date;

    if (typeof lat !== "number" || typeof lon !== "number") {
      return new Response("lat and lon are required", { status: 400 });
    }

    const targetDate =
      typeof dateParam === "string" && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)
        ? dateParam
        : new Date().toISOString().slice(0, 10);

    // Round for stable keys
    const rl = Math.round(lat * 1000) / 1000;
    const rlo = Math.round(lon * 1000) / 1000;

    // Compute ±1 day window
    const base = new Date(targetDate + "T00:00:00Z");
    const prev = new Date(base);
    prev.setUTCDate(prev.getUTCDate() - 1);
    const next = new Date(base);
    next.setUTCDate(next.getUTCDate() + 1);

    const startDate = toYYYYMMDD(prev);
    const endDate = toYYYYMMDD(next);

    // Marine: fetch 3 days so we can detect tide turning points at day edges
    const marineUrl = new URL(MARINE_BASE_URL);
    marineUrl.searchParams.set("latitude", rl.toString());
    marineUrl.searchParams.set("longitude", rlo.toString());
    marineUrl.searchParams.set("start_date", startDate);
    marineUrl.searchParams.set("end_date", endDate);
    marineUrl.searchParams.set("timezone", "auto");
    marineUrl.searchParams.set(
      "hourly",
      [
        "swell_wave_height",
        "swell_wave_period",
        "swell_wave_direction",
        "secondary_swell_wave_height",
        "secondary_swell_wave_period",
        "secondary_swell_wave_direction",
        "tertiary_swell_wave_height",
        "tertiary_swell_wave_period",
        "tertiary_swell_wave_direction",
        "wave_height",
        "wave_period",
        "wave_direction",
        "sea_surface_temperature",
        "sea_level_height_msl",
      ].join(",")
    );

    // Forecast (wind): we only need target day, but keeping ±1 doesn’t hurt;
    // we’ll filter output to target day anyway.
    const forecastUrl = new URL(FORECAST_BASE_URL);
    forecastUrl.searchParams.set("latitude", rl.toString());
    forecastUrl.searchParams.set("longitude", rlo.toString());
    forecastUrl.searchParams.set("start_date", startDate);
    forecastUrl.searchParams.set("end_date", endDate);
    forecastUrl.searchParams.set("timezone", "auto");
    forecastUrl.searchParams.set(
      "hourly",
      ["wind_speed_10m", "wind_direction_10m"].join(",")
    );

    const [marineRes, forecastRes] = await Promise.all([
      fetch(marineUrl.toString(), { cache: "no-store" }),
      fetch(forecastUrl.toString(), { cache: "no-store" }),
    ]);

    if (!marineRes.ok) {
      const text = await marineRes.text().catch(() => "");
      console.error("[snapshot] marine API error", marineRes.status, text);
      return new Response("failed to fetch marine data", { status: 502 });
    }

    const marine = await marineRes.json();
    const marineHourly: any = marine.hourly ?? { time: [] };

    let forecastHourly: any = null;
    if (forecastRes.ok) {
      const forecast = await forecastRes.json();
      forecastHourly = forecast.hourly ?? null;
    } else {
      const txt = await forecastRes.text().catch(() => "");
      console.warn("[snapshot] forecast wind API error", forecastRes.status, txt);
    }

    const times: string[] = Array.isArray(marineHourly.time)
      ? marineHourly.time
      : [];

    // Determine indices for the target day (so hourly output is 24h)
    const prefix = targetDate + "T";
    const dayIdxs = times
      .map((t, i) => (t?.startsWith(prefix) ? i : -1))
      .filter((i) => i >= 0);

    // Marine arrays (full 3 days)
    const primaryH_full = safeNumberArray(marineHourly, "swell_wave_height");
    const primaryP_full = safeNumberArray(marineHourly, "swell_wave_period");
    const primaryD_full = safeNumberArray(marineHourly, "swell_wave_direction");

    const secondaryH_full = safeNumberArray(marineHourly, "secondary_swell_wave_height");
    const secondaryP_full = safeNumberArray(marineHourly, "secondary_swell_wave_period");
    const secondaryD_full = safeNumberArray(marineHourly, "secondary_swell_wave_direction");

    const tertiaryH_full = safeNumberArray(marineHourly, "tertiary_swell_wave_height");
    const tertiaryP_full = safeNumberArray(marineHourly, "tertiary_swell_wave_period");
    const tertiaryD_full = safeNumberArray(marineHourly, "tertiary_swell_wave_direction");

    const waveH_full = safeNumberArray(marineHourly, "wave_height");
    const waveP_full = safeNumberArray(marineHourly, "wave_period");
    const waveD_full = safeNumberArray(marineHourly, "wave_direction");

    const sst_full = safeNumberArray(marineHourly, "sea_surface_temperature");
    const seaLevel_full = safeNumberArray(marineHourly, "sea_level_height_msl");

    // Wind arrays (full 3 days, but may be empty if forecastHourly missing)
    const windSpeed_full = Array.isArray(forecastHourly?.wind_speed_10m)
      ? (forecastHourly.wind_speed_10m as any[]).map((v) => (v == null ? null : Number(v)))
      : [];
    const windDir_full = Array.isArray(forecastHourly?.wind_direction_10m)
      ? (forecastHourly.wind_direction_10m as any[]).map((v) => (v == null ? null : Number(v)))
      : [];

    // Slice to target day for HOURLY output + summary stats (except tides)
    const times_day = pickByIdxs(times, dayIdxs);

    const primaryH_day = pickByIdxs(primaryH_full, dayIdxs);
    const primaryP_day = pickByIdxs(primaryP_full, dayIdxs);
    const primaryD_day = pickByIdxs(primaryD_full, dayIdxs);

    const secondaryH_day = pickByIdxs(secondaryH_full, dayIdxs);
    const secondaryP_day = pickByIdxs(secondaryP_full, dayIdxs);
    const secondaryD_day = pickByIdxs(secondaryD_full, dayIdxs);

    const tertiaryH_day = pickByIdxs(tertiaryH_full, dayIdxs);
    const tertiaryP_day = pickByIdxs(tertiaryP_full, dayIdxs);
    const tertiaryD_day = pickByIdxs(tertiaryD_full, dayIdxs);

    const waveH_day = pickByIdxs(waveH_full, dayIdxs);
    const waveP_day = pickByIdxs(waveP_full, dayIdxs);
    const waveD_day = pickByIdxs(waveD_full, dayIdxs);

    const sst_day = pickByIdxs(sst_full, dayIdxs);
    const seaLevel_day = pickByIdxs(seaLevel_full, dayIdxs);

    const windSpeed_day =
      windSpeed_full.length ? pickByIdxs(windSpeed_full, dayIdxs) : new Array(times_day.length).fill(null);
    const windDir_day =
      windDir_full.length ? pickByIdxs(windDir_full, dayIdxs) : new Array(times_day.length).fill(null);

    // Summary stats (from target day only)
    const num = (arr: (number | null)[]) => arr.filter((v): v is number => v != null && !isNaN(Number(v)));

    const primaryHeight = median(num(primaryH_day));
    const primaryPeriod = median(num(primaryP_day));
    const primaryDirection = mostCommonDirection(primaryD_day);

    const secondaryHeight = median(num(secondaryH_day));
    const secondaryPeriod = median(num(secondaryP_day));
    const secondaryDirection = mostCommonDirection(secondaryD_day);

    const tertiaryHeight = median(num(tertiaryH_day));
    const tertiaryPeriod = median(num(tertiaryP_day));
    const tertiaryDirection = mostCommonDirection(tertiaryD_day);

    const windSpeedRep = median(num(windSpeed_day));
    const windDirRep = mostCommonDirection(windDir_day);

    const waterTempRep = median(num(sst_day));

    // Tide events computed from FULL 3-day series, filtered to targetDate events
    const tide = tideEventsForDate(times, seaLevel_full, targetDate);

    const hourly: Record<string, any> = {
      time: times_day,
      swell_wave_height: primaryH_day,
      swell_wave_period: primaryP_day,
      swell_wave_direction: primaryD_day,
      secondary_swell_wave_height: secondaryH_day,
      secondary_swell_wave_period: secondaryP_day,
      secondary_swell_wave_direction: secondaryD_day,
      tertiary_swell_wave_height: tertiaryH_day,
      tertiary_swell_wave_period: tertiaryP_day,
      tertiary_swell_wave_direction: tertiaryD_day,
      wave_height: waveH_day,
      wave_period: waveP_day,
      wave_direction: waveD_day,
      sea_surface_temperature: sst_day,
      sea_level_height_msl: seaLevel_day,
      wind_speed_10m: windSpeed_day,
      wind_direction_10m: windDir_day,
    };

    const snapshot = {
      lat: rl,
      lon: rlo,
      date: targetDate,
      hourly,
      summary: {
        swell: {
          primary: { height: primaryHeight, period: primaryPeriod, direction: primaryDirection },
          secondary:
            secondaryHeight != null
              ? { height: secondaryHeight, period: secondaryPeriod, direction: secondaryDirection }
              : null,
          tertiary:
            tertiaryHeight != null
              ? { height: tertiaryHeight, period: tertiaryPeriod, direction: tertiaryDirection }
              : null,
        },
        wind: { speed: windSpeedRep, direction: windDirRep },
        waterTemperature: waterTempRep,

        // Backward compatible single Hi/Lo
        tideHigh: tide.tideHigh,
        tideHighTime: tide.tideHighTime,
        tideLow: tide.tideLow,
        tideLowTime: tide.tideLowTime,

        // New: up to 2 highs + 2 lows
        tides: {
          highs: tide.highs,
          lows: tide.lows,
        },
      },
    };

    const key = `tsr:snap:${targetDate}:${rl},${rlo}`;
    await redis.set(key, JSON.stringify(snapshot));

    return NextResponse.json(snapshot);
  } catch (err: any) {
    console.error("[snapshot] error", err?.message ?? err);
    return new Response(err?.message ?? "internal error", { status: 500 });
  }
}