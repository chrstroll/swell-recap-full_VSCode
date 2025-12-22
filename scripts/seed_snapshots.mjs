// scripts/seed_snapshots.mjs
// Run with: node scripts/seed_snapshots.mjs --date 2025-12-15 --days 7 --limit 50
// or:      node scripts/seed_snapshots.mjs --dates 2025-12-15,2025-12-16 --spotIds spot-2932,spot-123
//
// Requires: Node 18+ (has fetch)

import fs from "fs";
import path from "path";

function getArg(name, fallback = null) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}

function parseCSV(s) {
  if (!s) return [];
  return s.split(",").map(x => x.trim()).filter(Boolean);
}

function formatDateUTC(d) {
  return d.toISOString().slice(0, 10);
}

function addDaysUTC(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return formatDateUTC(d);
}

const baseUrl = getArg("baseUrl", "https://swell-recap-full-vs-code.vercel.app");
const concurrency = Number(getArg("concurrency", "6"));
const limit = Number(getArg("limit", "50"));

const date = getArg("date", null);          // start date
const days = Number(getArg("days", "1"));   // number of days starting from date
const datesArg = getArg("dates", null);     // explicit list
const spotIdsArg = getArg("spotIds", null); // explicit list of ids

const spotsPath = path.join(process.cwd(), "public", "spots.json");
if (!fs.existsSync(spotsPath)) {
  console.error(`Missing ${spotsPath}. Put your dataset at public/spots.json`);
  process.exit(1);
}

const spotsRaw = fs.readFileSync(spotsPath, "utf8");
const spots = JSON.parse(spotsRaw);

function pickSpotList() {
  const spotIds = parseCSV(spotIdsArg);
  if (spotIds.length) {
    const map = new Map(spots.map(s => [String(s.id), s]));
    return spotIds.map(id => map.get(id)).filter(Boolean);
  }
  // default: first N spots
  return spots.slice(0, limit);
}

function buildDateList() {
  const explicit = parseCSV(datesArg);
  if (explicit.length) return explicit;
  if (!date) {
    console.error("Provide --date YYYY-MM-DD (and optionally --days N) OR --dates d1,d2,...");
    process.exit(1);
  }
  const out = [];
  for (let i = 0; i < days; i++) out.push(addDaysUTC(date, i));
  return out;
}

const chosenSpots = pickSpotList();
const dateList = buildDateList();

console.log(`Base URL: ${baseUrl}`);
console.log(`Spots: ${chosenSpots.length}`);
console.log(`Dates: ${dateList.join(", ")}`);
console.log(`Concurrency: ${concurrency}`);

async function postSnapshot(lat, lon, d) {
  const resp = await fetch(`${baseUrl}/api/snapshot`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lat, lon, date: d })
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status} ${txt}`);
  }
  return resp.json();
}

async function worker(queue, results) {
  while (queue.length) {
    const job = queue.shift();
    if (!job) return;
    const { spot, d } = job;
    const label = `${spot.id} ${spot.name} ${d}`;
    try {
      await postSnapshot(Number(spot.lat), Number(spot.lon), d);
      results.ok++;
      if (results.ok % 25 === 0) console.log(`OK ${results.ok}…`);
    } catch (e) {
      results.fail++;
      console.error(`FAIL ${label}:`, e.message || e);
    }
  }
}

const queue = [];
for (const spot of chosenSpots) {
  // Skip broken coords
  if (!Number.isFinite(Number(spot.lat)) || !Number.isFinite(Number(spot.lon))) continue;
  for (const d of dateList) queue.push({ spot, d });
}

const results = { ok: 0, fail: 0 };
const workers = Array.from({ length: concurrency }, () => worker(queue, results));
await Promise.all(workers);

console.log(`Done. ok=${results.ok} fail=${results.fail}`);
