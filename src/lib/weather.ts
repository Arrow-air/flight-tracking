/**
 * Open-Meteo weather auto-fill (keyless API) for quick-log: given site
 * coordinates + a timestamp, fetch the nearest hour's conditions.
 * Recent dates use the forecast API (past_days window); older dates use the
 * historical archive API. No API key, no account.
 */

export interface WeatherSnapshot {
  hourIso: string;
  temperature_c: number | null;
  humidity_pct: number | null;
  precipitation_mm: number | null;
  wind_speed_kmh: number | null;
  wind_gusts_kmh: number | null;
  wind_direction_deg: number | null;
  source: 'open-meteo-archive' | 'open-meteo-forecast';
}

const HOURLY_VARS =
  'temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m,wind_gusts_10m,wind_direction_10m';

interface HourlyPayload {
  hourly?: {
    time?: string[];
    temperature_2m?: (number | null)[];
    relative_humidity_2m?: (number | null)[];
    precipitation?: (number | null)[];
    wind_speed_10m?: (number | null)[];
    wind_gusts_10m?: (number | null)[];
    wind_direction_10m?: (number | null)[];
  };
}

function isoDateUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function pick(
  payload: HourlyPayload,
  when: Date,
  source: WeatherSnapshot['source'],
): WeatherSnapshot | null {
  const h = payload.hourly;
  if (!h?.time?.length) return null;
  const target = when.getTime();
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < h.time.length; i++) {
    const t = new Date(`${h.time[i]}:00Z`).getTime();
    const dist = Math.abs(t - target);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  if (best < 0 || bestDist > 2 * 3600 * 1000) return null;
  const at = (arr?: (number | null)[]) => arr?.[best] ?? null;
  const snap: WeatherSnapshot = {
    hourIso: `${h.time[best]}Z`,
    temperature_c: at(h.temperature_2m),
    humidity_pct: at(h.relative_humidity_2m),
    precipitation_mm: at(h.precipitation),
    wind_speed_kmh: at(h.wind_speed_10m),
    wind_gusts_kmh: at(h.wind_gusts_10m),
    wind_direction_deg: at(h.wind_direction_10m),
    source,
  };
  if (snap.temperature_c == null && snap.wind_speed_kmh == null) return null;
  return snap;
}

async function fetchJson(url: string): Promise<HourlyPayload | null> {
  const res = await fetch(url);
  if (!res.ok) return null;
  return (await res.json()) as HourlyPayload;
}

export async function fetchWeatherAt(
  lat: number,
  lon: number,
  when: Date,
): Promise<WeatherSnapshot | null> {
  const ageDays = (Date.now() - when.getTime()) / 864e5;
  const date = isoDateUtc(when);
  const base = `latitude=${lat}&longitude=${lon}&hourly=${HOURLY_VARS}&timezone=UTC`;

  // Recent (or future-dated clock skew): forecast API holds ~last 92 days.
  if (ageDays < 6) {
    const past = Math.min(92, Math.max(1, Math.ceil(ageDays) + 1));
    const payload = await fetchJson(
      `https://api.open-meteo.com/v1/forecast?${base}&past_days=${past}&forecast_days=1`,
    );
    const snap = payload && pick(payload, when, 'open-meteo-forecast');
    if (snap) return snap;
  }
  // Historical archive (few-day publication delay, unlimited history).
  const payload = await fetchJson(
    `https://archive-api.open-meteo.com/v1/archive?${base}&start_date=${date}&end_date=${date}`,
  );
  const snap = payload && pick(payload, when, 'open-meteo-archive');
  if (snap) return snap;
  // Archive empty (too recent) and forecast didn't hit — try forecast anyway.
  if (ageDays >= 6 && ageDays < 92) {
    const p2 = await fetchJson(
      `https://api.open-meteo.com/v1/forecast?${base}&past_days=${Math.min(92, Math.ceil(ageDays) + 1)}&forecast_days=1`,
    );
    return (p2 && pick(p2, when, 'open-meteo-forecast')) ?? null;
  }
  return null;
}

/** One-line human summary for the flight notes field. */
export function weatherLine(w: WeatherSnapshot): string {
  const parts: string[] = [];
  if (w.temperature_c != null) parts.push(`${w.temperature_c.toFixed(1)} °C`);
  if (w.humidity_pct != null) parts.push(`RH ${Math.round(w.humidity_pct)}%`);
  if (w.wind_speed_kmh != null) {
    let wind = `wind ${w.wind_speed_kmh.toFixed(1)} km/h`;
    if (w.wind_direction_deg != null) {
      wind += ` from ${Math.round(w.wind_direction_deg)}°`;
    }
    if (w.wind_gusts_kmh != null) {
      wind += ` gusting ${w.wind_gusts_kmh.toFixed(0)} km/h`;
    }
    parts.push(wind);
  }
  if (w.precipitation_mm != null) {
    parts.push(`precip ${w.precipitation_mm.toFixed(1)} mm`);
  }
  return `Weather (Open-Meteo, ${w.hourIso}): ${parts.join(', ')}`;
}
