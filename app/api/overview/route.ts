import { Redis } from "@upstash/redis";

export const dynamic = "force-dynamic";

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

/* ---------- scoring helper ---------- */

function scoreFromSnapshot(snap: Snapshot) {
  const temps = snap.daily.temperature_2m_max || [];
  if (!temps.length) return null;

  const max = Math.max(...temps);
  const min = Math.min(...temps);
  const range = max - min;
  const raw = Math.max(0, 100 - range * 5);

  return Math.round(raw);
}

/* ---------- latest snapshot helper ---------- */

async function getLatestSnapshot(
  lat: number,
  lon: number
): Promise<Snapshot | null> {
  const today = new Date().toISOString().slice(0, 10);
  const todayKey = `twr:snap:${today}:${lat},${lon}`;

  // 1. Try today first
  let snapJson = await redis.get(todayKey);

  // 2. If missing, look at index of all snapshots
  if (!snapJson) {
    const indexKey = `twr:index:${lat},${lon}`;
    const keys = (await redis.smembers(indexKey)) as string[];

    if (!keys || keys.length === 0) return null;

    const latestKey = keys.sort().at(-1)!;
    snapJson = await redis.get(latestKey);
    if (!snapJson) return null;
  }

  if (typeof snapJson === "string") {
    return JSON.parse(snapJson) as Snapshot;
  }

  return snapJson as Snapshot;
}

/* ---------- starter places for new users ---------- */

const STARTER_PLACES: Place[] = [
  {
    name: "San Francisco, California, United States",
    lat: 37.77,
    lon: -122.42,
  },
  {
    name: "London, England, United Kingdom",
    lat: 51.51,
    lon: -0.13,
  },
];

/* ---------- GET handler (per user) ---------- */

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const userId = url.searchParams.get("userId");

    if (!userId) {
      return Response.json(
        { status: "missing-user-id", items: [] },
        { status: 400 }
      );
    }

    const placesKey = `twr:user:${userId}:places`;

    // Load this user's places
    let rawPlaces = (await redis.smembers(placesKey)) as any[];

    // If this is a brand-new user, seed with starter places
    if (!rawPlaces || rawPlaces.length === 0) {
      await Promise.all(
        STARTER_PLACES.map((p) =>
          redis.sadd(placesKey, JSON.stringify(p))
        )
      );
      rawPlaces = (await redis.smembers(placesKey)) as any[];
    }

    if (!rawPlaces || rawPlaces.length === 0) {
      // Shouldn't happen, but be defensive.
      return Response.json({ status: "no-places", items: [] });
    }

    // Parse places from stored JSON
    const places: Place[] = rawPlaces.map((p) =>
      typeof p === "string" ? (JSON.parse(p) as Place) : (p as Place)
    );

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
          place: snap.place, // includes normalized name
          snapshotDate: snap.snapshotDate,
          score,
        };
      })
    );

    return Response.json({ status: "ok", items });
  } catch (e: any) {
    return Response.json(
      { status: "error", detail: String(e?.message || e) },
      { status: 500 }
    );
  }
}
