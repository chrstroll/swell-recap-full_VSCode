import { Redis } from '@upstash/redis';

export const dynamic = 'force-dynamic';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

type Place = {
  name: string;
  lat: number;
  lon: number;
};

type Snapshot = {
  place: Place;
  snapshotDate: string;
  daily: {
    time: string[];
    temperature_2m_max: number[];
    temperature_2m_min: number[];
    rain_sum: number[];
    snowfall_sum: number[];
    relative_humidity_2m_mean: number[];
    windspeed_10m_max: number[];
  };
};

function scoreFromSnapshot(snap: Snapshot) {
  const temps = snap.daily.temperature_2m_max || [];
  if (!temps.length) return null;

  const max = Math.max(...temps);
  const min = Math.min(...temps);
  const range = max - min;
  const raw = Math.max(0, 100 - range * 5);

  return Math.round(raw);
}

/* -----------------------------------------------------------
   Helper: get latest snapshot (today OR fallback to last one)
------------------------------------------------------------ */
async function getLatestSnapshot(lat: number, lon: number): Promise<Snapshot | null> {
  const today = new Date().toISOString().slice(0, 10);
  const todayKey = `twr:snap:${today}:${lat},${lon}`;

  // 1. Try today first
  let snapJson = await redis.get(todayKey);

  // 2. If missing, look at index of all snapshots
  if (!snapJson) {
    const indexKey = `twr:index:${lat},${lon}`;

    // smembers returns unknown[] so we cast to string[]
    const keys = (await redis.smembers(indexKey)) as string[];

    if (!keys || keys.length === 0) return null;

    // Sort keys alphabetically → latest date is last
    const latestKey = keys.sort().at(-1)!;

    snapJson = await redis.get(latestKey);
    if (!snapJson) return null;
  }

  // If stored as JSON string
  if (typeof snapJson === 'string') {
    return JSON.parse(snapJson) as Snapshot;
  }

  // If stored as structured object
  return snapJson as Snapshot;
}

/* -----------------------------------------------------------
   GET handler
------------------------------------------------------------ */
export async function GET() {
  try {
    const places = (await redis.smembers('twr:places')) as Place[];

    if (!places || places.length === 0) {
      return Response.json({ status: 'no-places', items: [] });
    }

    const today = new Date().toISOString().slice(0, 10);

    const items = await Promise.all(
      places.map(async (place) => {
        const snap = await getLatestSnapshot(place.lat, place.lon);

        if (!snap) {
          return {
            place,
            snapshotDate: today,
            score: null,
          };
        }

        const score = scoreFromSnapshot(snap);

        return {
          place: snap.place,
          snapshotDate: snap.snapshotDate, // actual date stored in Redis
          score,
        };
      })
    );

    return Response.json({ status: 'ok', items });
  } catch (e: any) {
    return Response.json(
      { status: 'error', detail: String(e?.message || e) },
      { status: 500 }
    );
  }
}
