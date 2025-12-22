// scripts/seed_snapshots.mjs
// Node 18+ (Node 24 is fine). Uses global fetch.
//
// Examples:
//
// Seed first 50 spots in spots.json for 7 days starting 2025-12-15:
//   node scripts/seed_snapshots.mjs --date 2025-12-15 --days 7 --limit 50 --concurrency 6
//
// Seed specific spotIds for explicit dates:
//   node scripts/seed_snapshots.mjs --dates 2025-12-15,2025-12-16 --spotIds spot-2932,spot-2672 --concurrency 4
//
// Point at local dev server:
//   node scripts/seed_snapshots.mjs --baseUrl http://localhost:3000 --date 2025-12-15 --days 1 --limit 10

import fs from "fs";
import path from "path";

function getArg(name, fallback = null) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}

function parseCSV(s) {
  if (!s) return [];
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}

function formatDateUTC(d) {
  return d.toISOString().slice(0, 10);
}

function addDaysUTC(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return formatDateUTC(d);
}

// Normalize lat/lon from various datasets (lat/lon, latitude/longitude, lat/lng)
function getLatLon(spot) {
  const latRaw = spot.lat ?? spot.latitude;
  const lonRaw = spot.lon ?? spot.lng ?? spot.longitude;

  const lat = latRaw != null ? Number(latRaw) : NaN;
  const lon = lonRaw != null ? Number(lonRaw) : NaN;

  return { lat, lon };
}

async function postSnapshot(baseUrl, lat, lon, date) {
  const resp = await fetch(`${baseUrl}/api/snapshot`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lat, lon, date }),
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status} ${txt}`);
  }
  return resp.json();
}

async function worker(name, queue, results, baseUrl) {
  while (queue.length) {
    const job = queue.shift();
    if (!job) return;

    const { spot, date } = job;
    const label = `${spot.id ?? "no-id"} ${spot.name ?? "no-name"} ${date}`;

    try {
      await postSnapshot(baseUrl, spot.lat, spot.lon, date);
      results.ok++;
      if (results.ok % 25 === 0) console.log(`OK ${results.ok}…`);
    } catch (e) {
      results.fail++;
      console.error(`FAIL ${label}: ${e.message || e}`);
    }
  }
}

async function main() {
  const baseUrl = getArg("baseUrl", "https://swell-recap-full-vs-code.vercel.app");
  const concurrency = Math.max(1, Number(getArg("concurrency", "6")));
  const limit = Math.max(1, Number(getArg("limit", "50")));

  const date = getArg("date", null); // start date
  const days = Math.max(1, Number(getArg("days", "1")));
  const datesArg = getArg("dates", null);
  const spotIdsArg = getArg("spotIds", null);

  const spotsPath = path.join(process.cwd(), "public", "spots.json");
  if (!fs.existsSync(spotsPath)) {
    console.error(`Missing ${spotsPath}. Put your dataset at public/spots.json`);
    process.exit(1);
  }

  const spotsRaw = fs.readFileSync(spotsPath, "utf8");
  const allSpots = JSON.parse(spotsRaw);
  if (!Array.isArray(allSpots)) {
    console.error("public/spots.json must be a JSON array");
    process.exit(1);
  }

  // Build date list
  let dateList = parseCSV(datesArg);
  if (!dateList.length) {
    if (!date) {
      console.error("Provide --date YYYY-MM-DD (and optionally --days N) OR --dates d1,d2,...");
      process.exit(1);
    }
    dateList = [];
    for (let i = 0; i < days; i++) dateList.push(addDaysUTC(date, i));
  }

  // Pick spots
  let chosen = [];
  const spotIds = parseCSV(spotIdsArg);

  if (spotIds.length) {
    const map = new Map(allSpots.map((s) => [String(s.id), s]));
    chosen = spotIds.map((id) => map.get(id)).filter(Boolean);
  } else {
    chosen = allSpots.slice(0, limit);
  }

  // Normalize chosen spots to have numeric lat/lon
  const normalized = [];
  for (let i = 0; i < chosen.length; i++) {
    const s = chosen[i];
    const { lat, lon } = getLatLon(s);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    normalized.push({
      ...s,
      id: String(s.id ?? s._id ?? s.slug ?? `spot-${i}`),
      name: String(s.name ?? s.title ?? `Spot ${i}`),
      lat,
      lon,
    });
  }

  // Build job queue
  const queue = [];
  for (const spot of normalized) {
    for (const d of dateList) {
      queue.push({ spot, date: d });
    }
  }

  console.log(`Base URL: ${baseUrl}`);
  console.log(`Spots (requested): ${spotIds.length ? spotIds.length : limit}`);
  console.log(`Spots (usable coords): ${normalized.length}`);
  console.log(`Dates: ${dateList.join(", ")}`);
  console.log(`Jobs: ${queue.length}`);
  console.log(`Concurrency: ${concurrency}`);

  if (queue.length === 0) {
    console.log("Done. ok=0 fail=0 (no jobs queued — check dataset coords)");
    return;
  }

  const results = { ok: 0, fail: 0 };
  const workers = Array.from({ length: concurrency }, (_, i) =>
    worker(`w${i + 1}`, queue, results, baseUrl)
  );

  await Promise.all(workers);

  console.log(`Done. ok=${results.ok} fail=${results.fail}`);
}

main().catch((e) => {
  console.error("Fatal:", e?.message ?? e);
  process.exit(1);
});
