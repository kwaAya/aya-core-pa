const db = require('./db');

const WMO_CONDITIONS = {
  0:'clear', 1:'mostly clear', 2:'partly cloudy', 3:'overcast',
  45:'foggy', 48:'foggy', 51:'light drizzle', 53:'drizzle', 55:'heavy drizzle',
  61:'light rain', 63:'rain', 65:'heavy rain', 71:'light snow', 73:'snow', 75:'heavy snow',
  80:'rain showers', 81:'rain showers', 82:'heavy rain showers',
  95:'thunderstorms', 96:'thunderstorms', 99:'thunderstorms',
};

const weatherCache = new Map(); // userId -> { data, fetchedAt }

async function fetchWeatherFor(lat, lon) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,apparent_temperature,weather_code,precipitation_probability` +
    `&hourly=temperature_2m,precipitation_probability,weather_code&forecast_days=1&timezone=auto`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`open-meteo ${r.status}`);
  const raw = await r.json();
  const nowHourIdx = raw.hourly.time.findIndex(t => t === raw.current.time.slice(0, 13) + ':00');
  const upcoming = raw.hourly.time.slice(Math.max(nowHourIdx, 0)).map((t, i) => ({
    time: t,
    temp: Math.round(raw.hourly.temperature_2m[nowHourIdx + i]),
    rainChance: raw.hourly.precipitation_probability[nowHourIdx + i],
    code: raw.hourly.weather_code[nowHourIdx + i],
  }));
  const nextRain = upcoming.find(h => h.rainChance >= 50 && h.time !== upcoming[0]?.time);
  return {
    temp: Math.round(raw.current.temperature_2m),
    feelsLike: Math.round(raw.current.apparent_temperature),
    condition: WMO_CONDITIONS[raw.current.weather_code] || 'unknown',
    rainChance: raw.current.precipitation_probability,
    nextRainAt: nextRain ? nextRain.time.slice(11, 16) : null,
    hourly: upcoming.slice(0, 6),
  };
}

// Cached, per-user weather lookup — shared by /api/weather and the AI system prompt.
// Returns null (never throws) if the user has no saved location yet or the call fails,
// so callers can just skip the weather line rather than handling an error.
async function getUserWeather(userId) {
  const cached = weatherCache.get(userId);
  if (cached && Date.now() - cached.fetchedAt < 10 * 60 * 1000) return cached.data;
  try {
    const latRow = await db.prepare(`SELECT value FROM settings WHERE key = ?`).get(`u${userId}_weather_lat`);
    const lonRow = await db.prepare(`SELECT value FROM settings WHERE key = ?`).get(`u${userId}_weather_lon`);
    if (!latRow || !lonRow) return null;
    const data = await fetchWeatherFor(latRow.value, lonRow.value);
    weatherCache.set(userId, { data, fetchedAt: Date.now() });
    return data;
  } catch (err) {
    console.error('[weather] lookup failed:', err.message);
    return null;
  }
}

function invalidateWeatherCache(userId) {
  weatherCache.delete(userId);
}

module.exports = { fetchWeatherFor, getUserWeather, invalidateWeatherCache, WMO_CONDITIONS };