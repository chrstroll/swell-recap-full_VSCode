// app/api/lib/normalizePlace.ts

/**
 * Normalize a place name from lat/lon using OpenStreetMap Nominatim.
 * Desired format (when possible):
 *   City, State/Province, Country
 * Falls back to the provided name if anything goes wrong.
 */
export async function normalizePlaceName(
  lat: number,
  lon: number,
  fallbackName: string
): Promise<string> {
  console.log("[normalizePlaceName] input", { lat, lon, fallbackName });

  try {
    const url =
      `https://nominatim.openstreetmap.org/reverse?` +
      `lat=${lat}&lon=${lon}&format=jsonv2`;

    const res = await fetch(url, {
      // Nominatim requires a User-Agent identifying the app
      headers: {
        "User-Agent":
          "weather-recap/1.0 (+https://weather-recap-full-v2.vercel.app)",
      },
      cache: "no-store",
    });

    console.log("[normalizePlaceName] fetch status", res.status);

    if (!res.ok) {
      console.log("[normalizePlaceName] non-OK response, returning fallback");
      return fallbackName;
    }

    const data = await res.json();
    const addr = data?.address ?? {};
    console.log("[normalizePlaceName] address", addr);

    // 1) Get a "city-ish" label from Nominatim if possible
    let rawCity: string | undefined =
      addr.city ||
      addr.town ||
      addr.village ||
      addr.hamlet ||
      addr.suburb ||
      undefined;

    // 2) If Nominatim has no city-ish field, use the *base* of the fallback
    //    (strip anything after the first comma so we don't get
    //    "Point Reyes, United States" as the "city").
    if (!rawCity) {
      const baseFromFallback = fallbackName.split(",")[0].trim();
      rawCity = baseFromFallback || fallbackName;
    }

    const state: string | undefined = addr.state || addr.region;
    const country: string | undefined = addr.country;

    // 3) Build parts and de-duplicate to avoid things like
    //    "Point Reyes, United States, California, United States".
    const parts = [rawCity, state, country].filter(
      (p): p is string => !!p && p.trim().length > 0
    );

    const uniqueParts: string[] = [];
    for (const p of parts) {
      if (!uniqueParts.includes(p)) {
        uniqueParts.push(p);
      }
    }

    if (uniqueParts.length > 0) {
      const v = uniqueParts.join(", ");
      console.log("[normalizePlaceName] final", v);
      return v;
    }

    // 4) Ultimate fallback
    console.log("[normalizePlaceName] fallback to fallbackName", fallbackName);
    return fallbackName;
  } catch (err) {
    console.error("[normalizePlaceName] error", err);
    return fallbackName;
  }
}
