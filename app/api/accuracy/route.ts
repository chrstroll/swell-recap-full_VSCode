import { NextResponse } from 'next/server';

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const lat = parseFloat(searchParams.get('lat') || '');
    const lon = parseFloat(searchParams.get('lon') || '');
    const horizon = Math.max(1, Math.min(5, parseInt(searchParams.get('horizon') || '1', 10)));

    if (Number.isNaN(lat) || Number.isNaN(lon)) {
      return NextResponse.json({ error: 'Missing lat/lon' }, { status: 400 });
    }

    // Daily units: °C, km/h, mm, %
    const dailyVars = [
      'temperature_2m_max','temperature_2m_min',
      'windspeed_10m_max','relative_humidity_2m_mean',
      'rain_sum','snowfall_sum'
    ].join(',');
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
      + `&past_days=14&forecast_days=0&daily=${dailyVars}&timezone=auto`;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return NextResponse.json({ error: 'Upstream error' }, { status: 502 });
    const d = (await res.json())?.daily;

    const rows = (d?.time || []).map((t: string, i: number) => {
      const actual = {
        tmax: d.temperature_2m_max?.[i] ?? null,           // °C
        tmin: d.temperature_2m_min?.[i] ?? null,           // °C
        wind: d.windspeed_10m_max?.[i] ?? null,            // km/h
        humidity: d.relative_humidity_2m_mean?.[i] ?? null,// %
        rain: d.rain_sum?.[i] ?? null,                     // mm
        snow: d.snowfall_sum?.[i] ?? null                  // mm (liquid equiv)
      };
      const j = i - horizon;
      const predicted = j >= 0 ? {
        tmax: d.temperature_2m_max?.[j] ?? null,
        tmin: d.temperature_2m_min?.[j] ?? null,
        wind: d.windspeed_10m_max?.[j] ?? null,
        humidity: d.relative_humidity_2m_mean?.[j] ?? null,
        rain: d.rain_sum?.[j] ?? null,
        snow: d.snowfall_sum?.[j] ?? null
      } : { tmax:null, tmin:null, wind:null, humidity:null, rain:null, snow:null };

      // Raw deltas (pred - actual). We'll display absolute in UI.
      const deltas = (predicted.tmax!=null && actual.tmax!=null) ? {
        tmax: (predicted.tmax! - actual.tmax!),        // °C
        tmin: (predicted.tmin! - actual.tmin!),        // °C
        wind: (predicted.wind! - actual.wind!),        // km/h
        humidity: (predicted.humidity! - actual.humidity!), // %
        rain: (predicted.rain! - actual.rain!),        // mm
        snow: (predicted.snow! - actual.snow!)         // mm
      } : null;

      return { date: t, actual, predicted, deltas };
    });

    // Headline summary (temperature & wind)
    const valid = rows.filter((r:any)=>r.deltas);
    const mean = (arr:number[]) => arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0;
    const mae = mean(valid.map((r:any)=>Math.abs(r.deltas.tmax || 0)));     // °C
    const bias = mean(valid.map((r:any)=>(r.deltas.tmax || 0)));            // °C
    const windMAE = mean(valid.map((r:any)=>Math.abs(r.deltas.wind || 0))); // km/h

    return NextResponse.json({
      horizon,
      meta: { tempUnit:'C', windUnit:'km/h', precipUnit:'mm', humidityUnit:'%' },
      summary:{ mae, bias, windMAE },
      rows
    });
  } catch (e:any) {
    return NextResponse.json({ error: e?.message || 'Unknown error' }, { status: 500 });
  }
}
