//normalizePlaces

export async function normalizePlaceName(
  lat: number,
  lon: number,
  fallbackName: string
): Promise<string> {
  console.log("[normalizePlaceName] input", { lat, lon, fallbackName });

  try {
    const url =
      `https://geocoding-api.open-meteo.com/v1/reverse?latitude=${lat}&longitude=${lon}` +
      `&language=en`;

    const res = await fetch(url, { cache: "no-store" });
    console.log("[normalizePlaceName] fetch status", res.status);

    if (!res.ok) {
      console.log("[normalizePlaceName] non-OK response, returning fallback");
      return fallbackName;
    }

    const data = await res.json();
    const result = data?.results?.[0];
    console.log("[normalizePlaceName] result[0]", result);

    if (!result) return fallbackName;

    const city = result.name || fallbackName;
    const admin1 = result.admin1 as string | undefined; // state/province
    const admin2 = result.admin2 as string | undefined; // county/district
    const country = (result.country as string | undefined) || "";

    if (admin1 && country) {
      const v = `${city}, ${admin1}, ${country}`;
      console.log("[normalizePlaceName] using admin1", v);
      return v;
    }
    if (admin2 && country) {
      const v = `${city}, ${admin2}, ${country}`;
      console.log("[normalizePlaceName] using admin2", v);
      return v;
    }
    if (country) {
      const v = `${city}, ${country}`;
      console.log("[normalizePlaceName] using country only", v);
      return v;
    }

    console.log("[normalizePlaceName] no admin/country, returning city", city);
    return city;
  } catch (err) {
    console.error("[normalizePlaceName] error", err);
    return fallbackName;
  }
}
