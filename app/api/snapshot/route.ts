// app/api/snapshot/route.ts
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

// NOTE: adjust your redis client code if different; this example uses fetch to Upstash REST
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL!;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN!;

if (!UPSTASH_URL || !UPSTASH_TOKEN) {
  console.warn("Missing Upstash env vars");
}

function median(values: number[]) {
  if (!values?.length) return null;
  const v = [...values].sort((a,b)=>a-b);
  const mid = Math.floor(v.length/2);
  return v.length % 2 ? v[mid] : (v[mid-1]+v[mid]) / 2;
}

function mean(values: number[]) {
  if (!values?.length) return null;
  return values.reduce((a,b)=>a+b,0)/values.length;
}

function mostCommonDirection(degs: number[]) {
  if (!degs?.length) return null;
  // Normalize to 0-359 and bucket into 10° bins then return bucket center
  const buckets: Record<number, number> = {};
  for (let d of degs) {
    if (d == null || isNaN(d)) continue;
    d = ((Math.round(d) % 360) + 360) % 360;
    const bucket = Math.round(d / 10) * 10;
    buckets[bucket] = (buckets[bucket] || 0) + 1;
  }
  let best = null, bestCount = 0;
  for (const k of Object.keys(buckets)) {
    const cnt = buckets[+k];
    if (cnt > bestCount) { bestCount = cnt; best = +k; }
  }
  return best ?? null;
}

function findTideExtrema(times: string[], heights: number[]) {
  // returns {high, highTime, low, lowTime} for the day using simple scan
  if (!times?.length || !heights?.length) return { tideHigh: null, tideHighTime: null, tideLow: null, tideLowTime: null };
  let high = -Infinity, low = Infinity, highIdx = -1, lowIdx = -1;
  for (let i=0;i<heights.length;i++){
    const h = heights[i];
    if (h == null || isNaN(h)) continue;
    if (h > high) { high = h; highIdx = i; }
    if (h < low) { low = h; lowIdx = i; }
  }
  return {
    tideHigh: highIdx >= 0 ? Number(high.toFixed(3)) : null,
    tideHighTime: highIdx >= 0 ? times[highIdx] : null,
    tideLow: lowIdx >= 0 ? Number(low.toFixed(3)) : null,
    tideLowTime: lowIdx >= 0 ? times[lowIdx] : null
  };
}

async function upstashSet(key: string, value: any) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return;
  const body = JSON.stringify({ command: "SET", args: [key, JSON.stringify(value)]});
  await fetch(UPSTASH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${UPSTASH_TOKEN}`
    },
    body
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const lat = body.lat;
    const lon = body.lon;
    const date = body.date || new Date().toISOString().slice(0,10);

    // Build Open-Meteo URL (marine / hourly fields). Adjust timezone param as needed.
    const omUrl = new URL("https://marine-api.open-meteo.com/v1/marine");
    omUrl.searchParams.set("latitude", String(lat));
    omUrl.searchParams.set("longitude", String(lon));
    omUrl.searchParams.set("start_date", date);
    omUrl.searchParams.set("end_date", date);
    omUrl.searchParams.set("hourly", [
      "swell_wave_height","swell_wave_period","swell_wave_direction",
      "secondary_swell_wave_height","secondary_swell_wave_period","secondary_swell_wave_direction",
      "tertiary_swell_wave_height","tertiary_swell_wave_period","tertiary_swell_wave_direction",
      "wave_height","wave_period","wave_direction",
      "sea_surface_temperature","sea_level_height_msl",
      // wind fields - include all candidate names as fallbacks
      "wind_speed_10m","wind_direction_10m","wind_speed_10m_max","wind_speed_10m_mean"
    ].join(","));
    const resp = await fetch(omUrl.toString());
    if (!resp.ok) throw new Error(`Open-Meteo failed: ${resp.status}`);
    const data = await resp.json();

    const h = data.hourly ?? {};
    const times: string[] = h.time ?? [];

    // helper to safely read arrays
    const arr = (name: string) => (Array.isArray(h[name]) ? h[name] : []);

    // Candidate wind arrays: prefer wind_speed_10m > wind_speed_10m_mean > wind_speed_10m_max
    const windSpeedArrays = [arr("wind_speed_10m"), arr("wind_speed_10m_mean"), arr("wind_speed_10m_max")];
    const windDirArrays = [arr("wind_direction_10m")];

    // Merge into single numeric arrays aligned with times length:
    const windSpeeds: number[] = [];
    for (let i=0;i<times.length;i++){
      let val: number|null = null;
      for (const a of windSpeedArrays) {
        if (a && a[i] != null && !isNaN(Number(a[i]))) { val = Number(a[i]); break; }
      }
      windSpeeds.push(val);
    }
    const windDirs: number[] = [];
    for (let i=0;i<times.length;i++){
      let val: number|null = null;
      for (const a of windDirArrays) {
        if (a && a[i] != null && !isNaN(Number(a[i]))) { val = Number(a[i]); break; }
      }
      windDirs.push(val);
    }

    // build swell arrays for primary/secondary/tertiary
    const primaryH = arr("swell_wave_height").map((v:any) => v==null ? null : Number(v));
    const primaryP = arr("swell_wave_period").map((v:any) => v==null ? null : Number(v));
    const primaryD = arr("swell_wave_direction").map((v:any) => v==null ? null : Number(v));

    const secondaryH = arr("secondary_swell_wave_height").map((v:any)=> v==null? null: Number(v));
    const secondaryP = arr("secondary_swell_wave_period").map((v:any)=> v==null? null: Number(v));
    const secondaryD = arr("secondary_swell_wave_direction").map((v:any)=> v==null? null: Number(v));

    // water temp
    const sst = arr("sea_surface_temperature").map((v:any)=> v==null? null: Number(v));

    // tide
    const seaLevel = arr("sea_level_height_msl").map((v:any)=> v==null? null: Number(v));

    // reduce to representative values for the day:
    const primaryHeight = median(primaryH.filter(v=>v!=null));
    const primaryPeriod = median(primaryP.filter(v=>v!=null));
    const primaryDirection = mostCommonDirection(primaryD.filter(v=>v!=null));

    const secondaryHeight = median(secondaryH.filter(v=>v!=null));
    const secondaryPeriod = median(secondaryP.filter(v=>v!=null));
    const secondaryDirection = mostCommonDirection(secondaryD.filter(v=>v!=null));

    const windSpeedRepresentative = median(windSpeeds.filter(v=>v!=null));
    const windDirectionRepresentative = mostCommonDirection(windDirs.filter(v=>v!=null));

    const waterTempRepresentative = median(sst.filter(v=>v!=null));

    const {tideHigh, tideHighTime, tideLow, tideLowTime} = findTideExtrema(times, seaLevel);

    const snapshot = {
      lat, lon, date,
      hourly: {
        time: times,
        swell_wave_height: primaryH,
        swell_wave_period: primaryP,
        swell_wave_direction: primaryD,
        secondary_swell_wave_height: secondaryH,
        secondary_swell_wave_period: secondaryP,
        secondary_swell_wave_direction: secondaryD,
        wave_height: arr("wave_height"),
        wave_period: arr("wave_period"),
        wave_direction: arr("wave_direction"),
        sea_surface_temperature: sst,
        sea_level_height_msl: seaLevel,
        wind_speed_10m: windSpeeds,
        wind_direction_10m: windDirs
      },
      summary: {
        swell: {
          primary: {
            height: primaryHeight,
            period: primaryPeriod,
            direction: primaryDirection
          },
          secondary: secondaryHeight ? {
            height: secondaryHeight,
            period: secondaryPeriod,
            direction: secondaryDirection
          } : null
        },
        wind: {
          speed: windSpeedRepresentative ?? null,
          direction: windDirectionRepresentative ?? null
        },
        waterTemperature: waterTempRepresentative ?? null,
        tideHigh: tideHigh ?? null,
        tideHighTime: tideHighTime ?? null,
        tideLow: tideLow ?? null,
        tideLowTime: tideLowTime ?? null
      }
    };

    // debug log for Vercel to help if something still goes wrong
    console.log(`[snapshot] ${lat},${lon} ${date} windSpeed=${snapshot.summary.wind.speed} windDir=${snapshot.summary.wind.direction} tideHigh=${snapshot.summary.tideHigh}`);

    // store in Redis (Upstash REST)
    const redisKey = `tsr:snap:${date}:${lat},${lon}`;
    await upstashSet(redisKey, snapshot);

    return NextResponse.json(snapshot);
  } catch (err: any) {
    console.error("snapshot route error:", err?.message ?? err);
    return new Response(JSON.stringify({ error: err?.message ?? String(err) }), { status: 500 });
  }
}
