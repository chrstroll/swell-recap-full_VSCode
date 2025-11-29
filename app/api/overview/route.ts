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

export async function GET() {
  try {
    const places = (await redis.smembers('twr:places')) as any[];
    if (!places || places.length === 0) {
      return Response.json({ status: 'no-places', items: [] });
    }

    const today = new Date().toISOString().slice(0, 10);

    const items = await Promise.all(
      places.map(async (p) => {
        const place = p as Place;
        const key = `twr:snap:${today}:${place.lat},${place.lon}`;
        const rawValue = await redis.get(key as string);

        if (!rawValue) {
          return { place, snapshotDate: today, score: null };
        }

        // 👇 handle both stored-as-object and stored-as-JSON-string
        let snap: Snapshot;
        if (typeof rawValue === 'string') {
          snap = JSON.parse(rawValue) as Snapshot;
        } else {
          snap = rawValue as Snapshot;
        }

        const score = scoreFromSnapshot(snap);
        return {
          place: snap.place,
          snapshotDate: snap.snapshotDate,
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
