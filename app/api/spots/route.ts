// app/api/spots/route.ts
import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";

export const dynamic = "force-dynamic";

type Spot = {
  id: string;
  name: string;
  lat: number;
  lon: number;
  country?: string | null;
  region?: string | null;
  breakType?: string | null; // point | reef | beach | etc
  orientation?: number | null;
  [k: string]: any;
};

let CACHE: { ts: number; spots: Spot[] } | null = null;
const CACHE_TTL_MS = 1000 * 60 * 10;

async function loadSpots(): Promise<Spot[]> {
  if (CACHE && Date.now() - CACHE.ts < CACHE_TTL_MS) return CACHE.spots;

  const publicPath = path.join(process.cwd(), "public", "spots.json");
  const raw = await fs.readFile(publicPath, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("spots.json must be an array");

  const spots: Spot[] = parsed.map((s: any, i: number) => {
    const id = String(s.id ?? s._id ?? s.slug ?? `spot-${i}`);
    const name = String(s.name ?? s.title ?? `Spot ${i}`);

    const latRaw = s.lat ?? s.latitude;
    const lonRaw = s.lon ?? s.lng ?? s.longitude; // IMPORTANT: lng support

    const lat = latRaw != null ? Number(latRaw) : NaN;
    const lon = lonRaw != null ? Number(lonRaw) : NaN;

    return {
      // keep original fields first
      ...s,

      // then override with normalized fields so types are correct
      id,
      name,
      lat: Number.isFinite(lat) ? lat : 0,
      lon: Number.isFinite(lon) ? lon : 0,

      country: s.country ?? s.country_code ?? null,
      region: s.region ?? s.state ?? null,
      breakType: s.breakType ?? s.break_type ?? s.type ?? null,
      orientation: s.orientation ?? s.bearing ?? null,
    };
  });

  CACHE = { ts: Date.now(), spots };
  return spots;
}

function filterSpots(
  spots: Spot[],
  q?: string,
  filters?: { breakType?: string; region?: string; country?: string }
) {
  let out = spots;

  if (q) {
    const qq = q.trim().toLowerCase();
    out = out.filter((s) => {
      const name = (s.name ?? "").toLowerCase();
      const region = (s.region ?? "").toLowerCase();
      const country = (s.country ?? "").toLowerCase();
      return name.includes(qq) || region.includes(qq) || country.includes(qq);
    });
  }

  if (filters?.breakType) {
    const bt = filters.breakType.toLowerCase();
    out = out.filter((s) => (s.breakType ?? "").toLowerCase() === bt);
  }

  if (filters?.region) {
    const r = filters.region.toLowerCase();
    out = out.filter((s) => (s.region ?? "").toLowerCase().includes(r));
  }

  if (filters?.country) {
    const c = filters.country.toLowerCase();
    out = out.filter((s) => (s.country ?? "").toLowerCase().includes(c));
  }

  return out;
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const q = url.searchParams.get("q") ?? undefined;
    const id = url.searchParams.get("id") ?? undefined;

    const limit = Math.max(1, Math.min(1000, Number(url.searchParams.get("limit") ?? "100")));
    const offset = Math.max(0, Number(url.searchParams.get("offset") ?? "0"));

    const breakType = url.searchParams.get("breakType") ?? undefined;
    const region = url.searchParams.get("region") ?? undefined;
    const country = url.searchParams.get("country") ?? undefined;

    const spots = await loadSpots();

    if (id) {
      const found = spots.find((s) => s.id === id);
      if (!found) return NextResponse.json({ error: "not_found" }, { status: 404 });
      return NextResponse.json(found);
    }

    const filtered = filterSpots(spots, q, { breakType, region, country });
    const total = filtered.length;
    const results = filtered.slice(offset, offset + limit);

    return NextResponse.json({ total, offset, limit, results });
  } catch (err: any) {
    console.error("[spots] error", err?.message ?? err);
    return new Response(err?.message ?? "internal error", { status: 500 });
  }
}
