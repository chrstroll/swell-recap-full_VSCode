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

function median(values: number[] | null | undefined): number | null {
  if (!values || !values.length) return null;
  const v = values.filter((x) => x != null).map(Number).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

function mostCommonDirection(degs: (number | null | undefined)[]): number | null {
  const clean = degs
    .filter((d) => d != null && !isNaN(Number(d)))
    .map((d) => {
      let dd = Number(d) % 360;
      if (dd < 0) dd += 360;
      return Math.round(dd);
    });

  if (!clean.length) return null;

  const buckets: Record<number, number> = {};
  for (const d of clean) {
    const bucket = Math.round(d / 10) * 10; // 10° bins
    buckets[bucket] = (buckets[bucket] || 0) + 1;
  }

  let best: number | null = null;
  let bestCount = -1;
  for (const k of Object.keys(buckets)) {
    const cnt = buckets[+k];
    if (cnt > bestCount) {
      bestCount = cnt;
      best = +k;
    }
  }
  return best;
}

type TideEvent = { time: string; height: number };

function tideEventsForDay(times: string[], heights: (number | null | undefined)[], date: string) {
  const prefix = date + "T";
  const idxs: number[] = [];
  for (let i = 0; i < times.length && i < heights.length; i++) {
    if (times[i]?.startsWith(prefix) && heights[i] != null && !isNaN(Number(heights[i]))) {
      idxs.push(i);
    }
  }

  if (idxs.length < 3) {
    return { highs: [] as TideEvent[], lows: [] as TideEvent[], tideHigh: null, tideHighTime: null, tideLow: null, tideLowTime: null };
  }

  const candidatesHigh: TideEvent[] = [];
  const candidatesLow: TideEvent[] = [];

  // turning points within day
  for (let k = 1; k < idxs.length - 1; k++) {
    const i0 = idxs[k - 1];
    const i1 = idxs[k];
    const i2 = idxs[k + 1];

    const h0 = Number(heights[i0]);
    const h1 = Number(heights[i1]);
    const h2 = Number(heights[i2]);

    if (h1 > h0 && h1 > h2) candidatesHigh.push({ time: times[i1], height: h1 });
    if (h1 < h0 && h1 < h2) candidatesLow.push({ time: times[i1], height: h1 });
  }

  // fallback if no turning points (flat-ish day)
  if (candidatesHigh.length === 0 || candidatesLow.length === 0) {
    let hi: TideEvent | null = null;
    let lo: TideEvent | null = null;
    for (const i of idxs) {
      const h = Number(heights[i]);
      if (!hi || h > hi.height) hi = { time: times[i], height: h };
      if (!lo || h < lo.height) lo = { time: times[i], height: h };
    }
    return {
      highs: hi ? [hi] : [],
      lows: lo ? [lo] : [],
      tideHigh: hi ? Number(hi.height.toFixed(3)) : null,
      tideHighTime: hi ? hi.time : null,
      tideLow: lo ? Number(lo.height.toFixed(3)) : null,
      tideLowTime: lo ? lo.time : null,
    };
  }

  // pick top 2 highs and bottom 2 lows by height
  const highsTop = [...candidatesHigh].sort((a, b) => b.height - a.height).slice(0, 2).sort((a, b) => a.time.localeCompare(b.time));
  const lowsTop = [...candidatesLow].sort((a, b) => a.height - b.height).slice(0, 2).sort((a, b) => a.time.localeCompare(b.time));

  // also compute daily max/min for compatibility
  const tideHighEvt = highsTop.length ? highsTop.reduce((p, c) => (c.height > p.height ? c : p), highsTop[0]) : null;
  const tideLowEvt = lowsTop.length ? lowsTop.reduce((p, c) => (c.height < p.height ? c : p), lowsTop[0]) : null;

  return {
    highs: highsTop.map((e) => ({ time: e.time, height: Number(e.height.toFixed(3)) })),
    lows: lowsTop.map((e) => ({ time: e.time, height: Number(e.height.toFixed(3)) })),
    tideHigh: tideHighEvt ? Number(tideHighEvt.height.toFixed(3)) : null,
    tideHighTime: tideHighEvt ? tideHighEvt.time : null,
    tideLow: tideLowEvt ? Number(tideLowEvt.height.toFixed(3)) : null,
    tideLowTime: tideLowEvt ? tideLowEvt.time : null,
  };
}

type MarineSnapshot = {
  lat: number;
  lon: number;
  date: string;
  hourly: Record<string, any>;
  summary?: Record<string, any>;
};

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

    // round coords for consistent keys
    const rl = Math.round(lat * 1000) / 1000;
    const rlo = Math.round(lon * 1000) / 1000;

    // marine URL
    const marineUrl = new URL(MARINE_BASE_URL);
    marineUrl.searchParams.set("latitude", rl.toString());
    marineUrl.searchParams.set("longitude", rlo.toString());
    marineUrl.searchParams.set("start_date", targetDate);
    marineUrl.searchParams.set("end_date", targetDate);
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

    // forecast URL (wind)
    const forecastUrl = new URL(FORECAST_BASE_URL);
    forecastUrl.searchParams.set("latitude", rl.toString());
    forecastUrl.searchParams.set("longitude", rlo.toString());
    forecastUrl.searchParams.set("start_date", targetDate);
    forecastUrl.searchParams.set("end_date", targetDate);
    forecastUrl.searchParams.set("hourly", ["wind_speed_10m", "wind_direction_10m"].join(","));
    forecastUrl.searchParams.set("timezone", "auto");

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
      : Array.isArray(forecastHourly?.time)
      ? forecastHourly.time
      : [];

    const safeArr = (source: any, name: string) =>
      Array.isArray(source?.[name]) ? source[name] : [];

    const primaryH = safeArr(marineHourly, "swell_wave_height").map((v: any) => (v == null ? null : Number(v)));
    const primaryP = safeArr(marineHourly, "swell_wave_period").map((v: any) => (v == null ? null : Number(v)));
    const primaryD = safeArr(marineHourly, "swell_wave_direction").map((v: any) => (v == null ? null : Number(v)));

    const secondaryH = safeArr(marineHourly, "secondary_swell_wave_height").map((v: any) => (v == null ? null : Number(v)));
    const secondaryP = safeArr(marineHourly, "secondary_swell_wave_period").map((v: any) => (v == null ? null : Number(v)));
    const secondaryD = safeArr(marineHourly, "secondary_swell_wave_direction").map((v: any) => (v == null ? null : Number(v)));

    const tertiaryH = safeArr(marineHourly, "tertiary_swell_wave_height").map((v: any) => (v == null ? null : Number(v)));
    const tertiaryP = safeArr(marineHourly, "tertiary_swell_wave_period").map((v: any) => (v == null ? null : Number(v)));
    const tertiaryD = safeArr(marineHourly, "tertiary_swell_wave_direction").map((v: any) => (v == null ? null : Number(v)));

    const waveH = safeArr(marineHourly, "wave_height").map((v: any) => (v == null ? null : Number(v)));
    const waveP = safeArr(marineHourly, "wave_period").map((v: any) => (v == null ? null : Number(v)));
    const waveD = safeArr(marineHourly, "wave_direction").map((v: any) => (v == null ? null : Number(v)));

    const sst = safeArr(marineHourly, "sea_surface_temperature").map((v: any) => (v == null ? null : Number(v)));
    const seaLevel = safeArr(marineHourly, "sea_level_height_msl").map((v: any) => (v == null ? null : Number(v)));

    const windSpeedArr = safeArr(forecastHourly, "wind_speed_10m").map((v: any) => (v == null ? null : Number(v)));
    const windDirArr = safeArr(forecastHourly, "wind_direction_10m").map((v: any) => (v == null ? null : Number(v)));

    const windSpeeds: (number | null)[] = times.map((_, i) => (windSpeedArr[i] == null ? null : Number(windSpeedArr[i])));
    const windDirs: (number | null)[] = times.map((_, i) => (windDirArr[i] == null ? null : Number(windDirArr[i])));

    const primaryHeight = median(primaryH.filter((v) => v != null) as number[]);
    const primaryPeriod = median(primaryP.filter((v) => v != null) as number[]);
    const primaryDirection = mostCommonDirection(primaryD);

    const secondaryHeight = median(secondaryH.filter((v) => v != null) as number[]);
    const secondaryPeriod = median(secondaryP.filter((v) => v != null) as number[]);
    const secondaryDirection = mostCommonDirection(secondaryD);

    const tertiaryHeight = median(tertiaryH.filter((v) => v != null) as number[]);
    const tertiaryPeriod = median(tertiaryP.filter((v) => v != null) as number[]);
    const tertiaryDirection = mostCommonDirection(tertiaryD);

    const windSpeedRepresentative = median(windSpeeds.filter((v) => v != null) as number[]);
    const windDirectionRepresentative = mostCommonDirection(windDirs);

    const waterTempRepresentative = median(sst.filter((v) => v != null) as number[]);

    const tide = tideEventsForDay(times, seaLevel, targetDate);

    const hourly: Record<string, any> = {
      time: times,
      swell_wave_height: primaryH,
      swell_wave_period: primaryP,
      swell_wave_direction: primaryD,
      secondary_swell_wave_height: secondaryH,
      secondary_swell_wave_period: secondaryP,
      secondary_swell_wave_direction: secondaryD,
      tertiary_swell_wave_height: tertiaryH,
      tertiary_swell_wave_period: tertiaryP,
      tertiary_swell_wave_direction: tertiaryD,
      wave_height: waveH,
      wave_period: waveP,
      wave_direction: waveD,
      sea_surface_temperature: sst,
      sea_level_height_msl: seaLevel,
      wind_speed_10m: windSpeeds,
      wind_direction_10m: windDirs,
    };

    const snapshot: MarineSnapshot = {
      lat: rl,
      lon: rlo,
      date: targetDate,
      hourly,
      summary: {
        swell: {
          primary: { height: primaryHeight, period: primaryPeriod, direction: primaryDirection },
          secondary: secondaryHeight ? { height: secondaryHeight, period: secondaryPeriod, direction: secondaryDirection } : null,
          tertiary: tertiaryHeight ? { height: tertiaryHeight, period: tertiaryPeriod, direction: tertiaryDirection } : null,
        },
        wind: { speed: windSpeedRepresentative ?? null, direction: windDirectionRepresentative ?? null },
        waterTemperature: waterTempRepresentative ?? null,

        // Backward-compatible single hi/lo:
        tideHigh: tide.tideHigh,
        tideHighTime: tide.tideHighTime,
        tideLow: tide.tideLow,
        tideLowTime: tide.tideLowTime,

        // ✅ New: up to 2 highs + 2 lows
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