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

async function fetchDaily(lat: number, lon: number) {
  const daily = [
    'temperature_2m_max',
    'temperature_2m_min',
    'rain_sum',
    'snowfall_sum',
    'relative_humidity_2m_mean',
    'windspeed_10m_max',
  ].join(',');

  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&forecast_days=7&daily=${daily}&timezone=auto`;

  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error('upstream');
  return (await res.json())?.daily;
}

export async function GET() {
  try {
    // items are already objects like { name, lat, lon }
    const rawItems = (await redis.smembers('twr:places')) as any[];
    const items = rawItems as Place[];

    if (!items || items.length === 0) {
      return Response.json({ status: 'no-places' });
    }

    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    await Promise.all(
      items.map(async (place) => {
        const { name, lat, lon } = place;

        const daily = await fetchDaily(lat, lon);

        const key = `twr:snap:${today}:${lat},${lon}`;
        const payload = { place: { name, lat, lon }, snapshotDate: today, daily };
        const payloadJson = JSON.stringify(payload);

        await redis.set(key, payloadJson, { ex: 60 * 60 * 24 * 120 });
        await redis.sadd(`twr:index:${lat},${lon}`, key);
      })
    );

    return Response.json({ status: 'snapshotted-redis' });
  } catch (e: any) {
    return Response.json(
      { error: 'snapshot-failed', detail: String(e?.message || e) },
      { status: 500 }
    );
  }
}
