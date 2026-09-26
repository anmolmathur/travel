// Optional flight lookup through AeroDataBox (RapidAPI). Best effort: the response
// shape is parsed defensively and anything missing is left blank.

export function createAeroDataBox({ apiKey, host = "aerodatabox.p.rapidapi.com", fetchImpl = fetch }) {
  if (!apiKey) return null;
  const cache = new Map();
  return async function lookup(flight, date) {
    const key = `${flight}:${date}`;
    if (cache.has(key)) return cache.get(key);
    const res = await fetchImpl(`https://${host}/flights/number/${encodeURIComponent(flight)}/${date}?withAircraftImage=false&withLocation=false`, {
      headers: { "X-RapidAPI-Key": apiKey, "X-RapidAPI-Host": host },
    });
    if (res.status === 204 || res.status === 404) return [];
    if (!res.ok) { const e = new Error(`Flight lookup failed (HTTP ${res.status}).`); e.status = res.status === 429 ? 429 : 502; throw e; }
    const data = await res.json();
    const list = (Array.isArray(data) ? data : [data]).map(x => {
      const dep = x.departure || {}, arr = x.arrival || {};
      const local = dep.scheduledTime?.local || dep.scheduledTimeLocal || "";
      const t1 = Date.parse(dep.scheduledTime?.utc || dep.scheduledTimeUtc || ""), t2 = Date.parse(arr.scheduledTime?.utc || arr.scheduledTimeUtc || "");
      const mins = Number.isFinite(t1) && Number.isFinite(t2) && t2 > t1 ? Math.round((t2 - t1) / 60000) : null;
      return {
        flight, date: local.slice(0, 10) || date, time: local.slice(11, 16) || "",
        from: dep.airport?.iata || "", to: arr.airport?.iata || "",
        duration: mins ? `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, "0")}` : "",
        aircraftModel: x.aircraft?.model || "", registration: x.aircraft?.reg || "",
        status: x.status || "", airline: x.airline?.name || "",
      };
    }).filter(x => x.from && x.to);
    cache.set(key, list);
    return list;
  };
}
