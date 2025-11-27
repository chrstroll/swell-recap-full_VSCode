import { kv } from '@vercel/kv';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const { name, lat, lon } = await req.json();
    if (typeof lat !== 'number' || typeof lon !== 'number') {
      return new Response('Bad request', { status: 400 });
    }

    // round ~1km to dedupe & avoid precision
    const rl = Math.round(lat * 100) / 100;
    const rlo = Math.round(lon * 100) / 100;

    await kv.sadd('twr:places', JSON.stringify({ name: name || '', lat: rl, lon: rlo }));
    return new Response('ok');
  } catch (e: any) {
    return new Response(e?.message || 'error', { status: 500 });
  }
}
