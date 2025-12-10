// app/api/lib/normalizePlace.ts

/**
 * Normalize a place name from lat/lon using OpenStreetMap Nominatim.
 * Falls back to the provided name if anything goes wrong.
 *
 * Desired format (when possible):
 *   City, State/Province, Country
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

    // Try to choose a sensible "cityish" label
    const city: string =
      addr.city ||
      addr.town ||
      addr.village ||
      addr.hamlet ||
      addr.suburb ||
      fallbackName;

    const state: string | undefined = addr.state || addr.region;
    const country: string | undefined = addr.country;

    if (city && state && country) {
      const v = `${city}, ${state}, ${country}`;
      console.log("[normalizePlaceName] city+state+country", v);
      return v;
    }

    if (city && country) {
      const v = `${city}, ${country}`;
      console.log("[normalizePlaceName] city+country", v);
      return v;
    }

    if (country) {
      console.log("[normalizePlaceName] country only", country);
      return country;
    }

    console.log("[normalizePlaceName] fallback to city/fallbackName", city);
    return city || fallbackName;
  } catch (err) {
    console.error("[normalizePlaceName] error", err);
    return fallbackName;
  }
}
