// app/api/spots/route.ts
import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";

export const dynamic = "force-dynamic";

/**
 * Service reads public/spots.json at runtime (cached in-memory) and serves:
 * - GET /api/spots            -> full list (paginated)
 * - GET /api/spots?q=rincon   -> search by name (case-insensitive substring)
 * - GET /api/spots?id=abc123  -> lookup single spot by id
 * - GET /api/spots?limit=50&offset=100
 * - GET /api/spots?breakType=point
 * - GET /api/spots?region=Santa%20Barbara
 *
 * Ensure you place the file at: <repo>/public/spots.json
 */

type Spot = {
  id: string;
  name: string;
  lat: number;
  lon: number;
  country?: string;
  region?: string;
  breakType?: string; // "point" | "reef" | "beach" | etc.
  orientation?: number | null; // optional bearing in degrees
  [k: string]: any;
};

// in-memory cache for the deployed server instance
let CACHE: { ts: number; spots: Spot[] } | null = null;
const CACHE_TTL_MS = 1000 * 60 * 10; // 10 minutes

async function loadSpots(): Promise<Spot[]> {
  if (CACHE && Date.now() - CACHE.ts < CACHE_TTL_MS) return CACHE.spots;
  const publicPath = path.join(process.cwd(), "public", "spots.json");
  const raw = await fs.readFile(publicPath, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("spots.json must be an array");
  // minimal normalization: ensure id, name, lat, lon exist
  const spots = parsed.map((s: any, i: number) => {
    const id = s.id ?? s._id ?? s.slug ?? `spot-${i}`;
    return {
      id,
      name: s.name ?? s.title ?? `Spot ${i}`,
      lat: Number(s.lat ?? s.latitude ?? 0),
      lon: Number(s.lon ?? s.longitude ?? 0),
      country: s.country ?? s.country_code ?? null,
      region: s.region ?? s.state ?? null,
      breakType: s.breakType ?? s.break_type ?? s.type ?? null,
      orientation: s.orientation ?? s.bearing ?? null,
      ...s,
    } as Spot;
  });
  CACHE = { ts: Date.now(), spots };
  return spots;
}

function filterSpots(spots: Spot[], q?: string, filters?: Record<string, string>) {
  let out = spots;
  if (q) {
    const qq = q.trim().toLowerCase();
    out = out.filter((s) => (s.name ?? "").toLowerCase().includes(qq) || (s.region ?? "").toLowerCase().includes(qq));
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
      const found = spots.find((s) => s.id === id || s.name === id);
      if (!found) return NextResponse.json({ error: "not_found" }, { status: 404 });
      return NextResponse.json(found);
    }

    const filtered = filterSpots(spots, q, { breakType: breakType ?? "", region: region ?? "", country: country ?? "" });
    const total = filtered.length;
    const page = filtered.slice(offset, offset + limit);

    return NextResponse.json({ total, offset, limit, results: page });
  } catch (err: any) {
    console.error("[spots] error", err?.message ?? err);
    return new Response(err?.message ?? "internal error", { status: 500 });
  }
}
