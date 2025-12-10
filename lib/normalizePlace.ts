// app/api/lib/normalizePlace.ts

export async function normalizePlaceName(
  lat: number,
  lon: number,
  fallbackName: string
): Promise<string> {
  try {
    const url =
      `https://geocoding-api.open-meteo.com/v1/reverse?latitude=${lat}&longitude=${lon}` +
      `&language=en`;

    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return fallbackName;

    const data = await res.json();
    const result = data?.results?.[0];
    if (!result) return fallbackName;

    const city = result.name || fallbackName;
    const admin1 = result.admin1 as string | undefined; // state/province
    const admin2 = result.admin2 as string | undefined; // county/district
    const country = (result.country as string | undefined) || "";

    // OPTION A (your choice):
    // 1. If admin1 exists → City, admin1, Country
    // 2. Else if admin2 exists → City, admin2, Country
    // 3. Else → City, Country

    if (admin1 && country) {
      return `${city}, ${admin1}, ${country}`;
    }
    if (admin2 && country) {
      return `${city}, ${admin2}, ${country}`;
    }
    if (country) {
      return `${city}, ${country}`;
    }
    return city;
  } catch {
    return fallbackName;
  }
}
