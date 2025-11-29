import { Redis } from '@upstash/redis';

export const dynamic = 'force-dynamic';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

export async function GET() {
  try {
    const items = await redis.smembers('twr:places');

    return Response.json({
      status: 'snapshot-reads-redis-ok',
      count: items.length,
      items,
    });
  } catch (e: any) {
    return Response.json(
      {
        status: 'snapshot-redis-error',
        detail: String(e?.message || e),
      },
      { status: 500 }
    );
  }
}
