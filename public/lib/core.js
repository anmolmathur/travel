// Shared flight logic. Pure functions, imported by both the browser app and the server.

export const DEFUNCT = {
  "9W": "Ceased operations, Apr 2019",
  "G8": "Ceased operations, May 2023",
  "UK": "Merged into Air India, Nov 2024",
  "I5": "Merged into Air India Express, Oct 2024",
};
export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const SEAT_TYPES = ["window", "middle", "aisle"];
export const CABINS = ["economy", "premium", "business", "first"];
export const REASONS = ["leisure", "business", "crew", "other"];
export const STATUSES = ["flown", "upcoming", "cancelled"];
const EARTH_KM = 6371.0088;

/** Turn the compact ref.json payload into lookup maps. */
export function createRef(raw) {
  const ap = new Map();
  for (const [code, name, city, cc, lat, lon] of raw.airports) ap.set(code, { code, name, city, cc, lat, lon });
  return { ap, countries: raw.countries, airlines: raw.airlines, planes: raw.planes };
}

export const todayISO = () => new Date().toISOString().slice(0, 10);

export function hav(a, b) {
  const r = Math.PI / 180, la1 = a.lat * r, la2 = b.lat * r, dl = (b.lon - a.lon) * r, dp = la2 - la1;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(h));
}
export const estDur = km => Math.round(30 + km / 780 * 60);
export function durMin(f) {
  if (f.duration && /^\d{1,2}:\d{2}$/.test(f.duration)) { const [h, m] = f.duration.split(":").map(Number); return h * 60 + m; }
  return estDur(f.distanceKm || 0);
}
export const hm = min => `${Math.floor(min / 60)}:${String(Math.round(min % 60)).padStart(2, "0")}`;
export const dayDiff = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
export function statusOf(f, today = todayISO()) {
  if (f.status === "cancelled") return "cancelled";
  return f.date > today ? "upcoming" : "flown";
}
export function fnPretty(f) { const s = (f.flight || "").toUpperCase(); return s.length > 2 ? s.slice(0, 2) + " " + s.slice(2) : s; }
export function niceDate(d) {
  return new Date(d + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}
export const airlineName = (ref, c) => ref.airlines[c]?.[0] || c || "Unknown";
export const planeName = (ref, c) => ref.planes[c] || c || "";
export const countryName = (ref, cc) => ref.countries[cc]?.[0] || cc;
export function family(ref, c) {
  const n = planeName(ref, c);
  if (/Airbus/i.test(n)) return "Airbus";
  if (/Boeing/i.test(n)) return "Boeing";
  if (/Bombardier|De Havilland|ATR|Embraer/i.test(n)) return "Regional";
  return c ? "Other" : "Unknown";
}

/** Fill derived fields and normalise casing. Does not mutate. */
export function normalize(doc, ref) {
  const f = { ...doc };
  f.from = String(f.from || "").trim().toUpperCase();
  f.to = String(f.to || "").trim().toUpperCase();
  f.flight = String(f.flight || "").replace(/[\s*]+/g, "").toUpperCase();
  if (!f.airline && f.flight) f.airline = f.flight.slice(0, 2);
  const a = ref.ap.get(f.from), b = ref.ap.get(f.to);
  if (!f.distanceKm && a && b) f.distanceKm = Math.round(hav(a, b));
  return f;
}

/** Returns an error message, or "" when the flight is valid. */
export function validate(f, ref) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.date || "")) return "Date must be YYYY-MM-DD.";
  if (!ref.ap.get(f.from)) return `Unknown departure airport "${f.from || ""}". Use a 3-letter IATA code.`;
  if (!ref.ap.get(f.to)) return `Unknown arrival airport "${f.to || ""}". Use a 3-letter IATA code.`;
  if (f.from === f.to) return "Departure and arrival are the same airport.";
  if (f.duration && !/^\d{1,2}:\d{2}$/.test(f.duration)) return "Duration must be h:mm, like 2:10.";
  if (f.time && !/^\d{2}:\d{2}$/.test(f.time)) return "Time must be HH:MM.";
  if (f.status && !STATUSES.includes(f.status)) return `Status must be one of ${STATUSES.join(", ")}.`;
  return "";
}

/** Build a clean stored document from loose input. Call validate() first. */
export function toDoc(f, ref, extra = {}, today = todayISO()) {
  const a = ref.ap.get(String(f.from).toUpperCase()), b = ref.ap.get(String(f.to).toUpperCase());
  const km = Math.round(hav(a, b));
  const flight = String(f.flight || "").replace(/[\s*]+/g, "").toUpperCase();
  let duration = f.duration && /^\d{1,2}:\d{2}$/.test(f.duration) ? f.duration.padStart(5, "0") : hm(estDur(km)).padStart(5, "0");
  const pick = (v, list, d) => (list.includes(v) ? v : d);
  const status = f.status === "cancelled" ? "cancelled" : f.date > today ? "upcoming" : "flown";
  return {
    date: f.date, time: f.time || "", from: a.code, to: b.code, flight, airline: flight.slice(0, 2),
    distanceKm: km, duration, seat: String(f.seat || "").toUpperCase(), seatType: pick(f.seatType, SEAT_TYPES, ""),
    cabin: pick(f.cabin, CABINS, "economy"), reason: pick(f.reason, REASONS, "leisure"),
    aircraft: String(f.aircraft || "").toUpperCase(), registration: String(f.registration || "").toUpperCase(),
    trip: f.trip || "", note: f.note || "", status, ...extra,
  };
}

export function newId(f) {
  return `${f.date.replace(/-/g, "")}-${f.from}-${f.to}-${f.flight || "X"}-${Math.random().toString(36).slice(2, 6)}`;
}

/* ---------------- statistics ---------------- */
export function computeStats(list, ref) {
  const countryOf = c => ref.ap.get(c)?.cc;
  const s = {
    n: list.length, km: 0, min: 0, airports: new Map(), carriers: new Map(), countries: new Map(), planes: new Map(), routes: new Map(),
    cabin: {}, reason: {}, seat: {}, years: new Map(), months: Array(12).fill(0), dows: Array(7).fill(0), ym: new Map(),
    dom: 0, intl: 0, bands: [0, 0, 0, 0], fam: {},
  };
  for (const f of list) {
    const d = f.distanceKm || 0, m = durMin(f);
    s.km += d; s.min += m;
    for (const c of [f.from, f.to]) {
      s.airports.set(c, (s.airports.get(c) || 0) + 1);
      const cc = countryOf(c);
      if (cc && (!s.countries.has(cc) || f.date < s.countries.get(cc))) s.countries.set(cc, f.date);
    }
    if (f.airline) s.carriers.set(f.airline, (s.carriers.get(f.airline) || 0) + 1);
    if (f.aircraft) s.planes.set(f.aircraft, (s.planes.get(f.aircraft) || 0) + 1);
    const fam = family(ref, f.aircraft); s.fam[fam] = (s.fam[fam] || 0) + 1;
    const pair = [f.from, f.to].sort(), rk = pair.join("-");
    const r = s.routes.get(rk) || { n: 0, km: d, a: pair }; r.n++; s.routes.set(rk, r);
    const cab = f.cabin || "economy", rea = f.reason || "leisure", st = f.seatType || "unknown";
    s.cabin[cab] = (s.cabin[cab] || 0) + 1; s.reason[rea] = (s.reason[rea] || 0) + 1; s.seat[st] = (s.seat[st] || 0) + 1;
    const y = f.date.slice(0, 4), yy = s.years.get(y) || { n: 0, km: 0, min: 0 }; yy.n++; yy.km += d; yy.min += m; s.years.set(y, yy);
    const ymk = f.date.slice(0, 7); s.ym.set(ymk, (s.ym.get(ymk) || 0) + 1);
    const dt = new Date(f.date + "T00:00:00Z"); s.months[dt.getUTCMonth()]++; s.dows[(dt.getUTCDay() + 6) % 7]++;
    if (countryOf(f.from) && countryOf(f.from) === countryOf(f.to)) s.dom++; else s.intl++;
    s.bands[d < 800 ? 0 : d < 2500 ? 1 : d < 5000 ? 2 : 3]++;
  }
  const byKm = [...list].sort((a, b) => (b.distanceKm || 0) - (a.distanceKm || 0));
  s.longest = byKm[0]; s.shortest = byKm[byKm.length - 1];
  const aps = [...s.airports.keys()].map(c => ref.ap.get(c)).filter(Boolean);
  const ext = keep => aps.reduce((m, a) => (m && keep(m, a) ? m : a), null);
  s.north = ext((m, a) => m.lat >= a.lat); s.south = ext((m, a) => m.lat <= a.lat);
  s.east = ext((m, a) => m.lon >= a.lon); s.west = ext((m, a) => m.lon <= a.lon);
  s.home = [...s.airports.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (s.home) {
    const h = ref.ap.get(s.home);
    s.far = aps.reduce((m, a) => { const k = hav(h, a); return !m || k > m.k ? { a, k } : m; }, null);
    s.homeShare = list.filter(f => f.from === s.home || f.to === s.home).length / Math.max(1, list.length);
  }
  const sorted = [...list].sort((a, b) => a.date.localeCompare(b.date));
  s.first = sorted[0]; s.last = sorted[sorted.length - 1];
  let gap = null;
  for (let i = 1; i < sorted.length; i++) { const g = dayDiff(sorted[i - 1].date, sorted[i].date); if (!gap || g > gap.d) gap = { d: g, a: sorted[i - 1], b: sorted[i] }; }
  s.gap = gap;
  s.busiestMonth = [...s.ym.entries()].sort((a, b) => b[1] - a[1])[0];
  const seen = new Set(); s.newAp = new Map();
  for (const f of sorted) for (const c of [f.from, f.to]) if (!seen.has(c)) { seen.add(c); const y = f.date.slice(0, 4); s.newAp.set(y, (s.newAp.get(y) || 0) + 1); }
  return s;
}

/* ---------------- review heuristics ---------------- */
/**
 * Finds flights that were probably booked but not flown.
 * Returns { groups, flags } where flags maps flight id -> [{sev, msg}].
 */
export function computeFlags(flights, today = todayISO()) {
  const flags = new Map(), groups = [];
  const live = flights.filter(f => statusOf(f, today) !== "cancelled")
    .sort((a, b) => (a.date + (a.time || "")).localeCompare(b.date + (b.time || "")) || a.id.localeCompare(b.id));
  const add = (id, sev, msg) => { const a = flags.get(id) || []; a.push({ sev, msg }); flags.set(id, a); };
  const byDate = new Map();
  live.forEach(f => { const a = byDate.get(f.date) || []; a.push(f); byDate.set(f.date, a); });
  const handled = new Set();

  for (const [date, fs] of byDate) {
    if (fs.length < 2) continue;
    const seenRoute = new Map();
    for (const f of fs) {
      const k = f.from + ">" + f.to;
      if (!seenRoute.has(k)) { seenRoute.set(k, f); continue; }
      const o = seenRoute.get(k);
      if (f.reviewed) continue;
      const codeshare = o.airline !== f.airline;
      const msg = codeshare
        ? `${fnPretty(o)} and ${fnPretty(f)} fly the same route on the same day. This is usually one codeshare flight logged twice.`
        : `${fnPretty(f)} ${f.from}→${f.to} appears twice on ${niceDate(date)}.`;
      groups.push({ sev: "high", kind: codeshare ? "codeshare" : "duplicate", title: codeshare ? "Codeshare logged twice" : "Duplicate entry", msg, items: [o, f], suggest: f.id });
      add(f.id, "high", msg); handled.add(f.id); handled.add(o.id);
    }
    const rest = fs.filter(f => !flags.has(f.id));
    const bal = new Map();
    rest.forEach(f => { bal.set(f.from, (bal.get(f.from) || 0) + 1); bal.set(f.to, (bal.get(f.to) || 0) - 1); });
    const starts = [...bal.values()].filter(v => v > 0).reduce((a, v) => a + v, 0);
    const items = rest.filter(f => !f.reviewed);
    if (starts > 1 && items.length > 1) {
      const msg = `These ${items.length} flights on ${niceDate(date)} can't all be one journey: you'd have to be in two places at once. One or more were probably booked and not taken.`;
      groups.push({ sev: "high", kind: "conflict", title: "Itinerary doesn't connect", msg, items });
      items.forEach(f => add(f.id, "high", msg));
    }
  }

  const lowGroups = new Map();
  for (let i = 0; i < live.length; i++) {
    const f = live[i];
    if (f.reviewed || handled.has(f.id)) continue;
    for (let j = i + 1; j < live.length; j++) {
      const g = live[j], dd = dayDiff(f.date, g.date);
      if (dd > 4) break;
      if (g.from !== f.from || g.to !== f.to || dd <= 0) continue;
      const back = live.slice(i + 1, j).some(k => k.to === f.from);
      if (!back) {
        const msg = `${f.from}→${f.to} again on ${niceDate(g.date)} with no return flight in between. The ${niceDate(f.date)} booking may have been changed.`;
        groups.push({ sev: "med", kind: "rebooked", title: "Same route twice without a return", msg, items: [f, g], suggest: f.id });
        add(f.id, "med", msg); handled.add(f.id);
        break;
      }
      if (dd === 1 && f.flight && f.flight === g.flight) {
        const key = f.flight + f.from + f.to, lg = lowGroups.get(key);
        const msg = `${fnPretty(f)} ${f.from}→${f.to} on consecutive days. Possible, but worth a look.`;
        if (lg && dayDiff(lg.items[lg.items.length - 1].date, f.date) <= 2) {
          for (const x of [f, g]) if (!lg.items.includes(x)) lg.items.push(x);
          lg.msg = `${fnPretty(f)} ${f.from}→${f.to} is logged on ${lg.items.length} days in a row from ${niceDate(lg.items[0].date)}. Possible, but worth a look.`;
        } else {
          const ng = { sev: "low", kind: "repeat", title: "Same flight on back-to-back days", msg, items: [f, g] };
          lowGroups.set(key, ng); groups.push(ng);
        }
        add(f.id, "low", msg);
        break;
      }
    }
  }

  for (const f of flights) {
    if (f.status === "upcoming" && f.date < today && !f.reviewed) {
      const msg = `${fnPretty(f) || f.from + "→" + f.to} on ${niceDate(f.date)} was planned. Did you take it?`;
      groups.push({ sev: "med", kind: "past-planned", title: "Planned flight date has passed", msg, items: [f] });
      add(f.id, "med", msg);
    }
  }
  const order = { high: 0, med: 1, low: 2 };
  groups.sort((a, b) => order[a.sev] - order[b.sev] || b.items[0].date.localeCompare(a.items[0].date));
  return { groups, flags };
}

/* ---------------- trips ---------------- */
/**
 * Stitches flights into trips: a trip leaves home and ends when you land back home,
 * or when there are more than 21 days between consecutive flights.
 */
export function buildTrips(flights, ref, home, today = todayISO()) {
  const live = flights.filter(f => statusOf(f, today) !== "cancelled").sort((a, b) => (a.date + (a.time || "")).localeCompare(b.date + (b.time || "")) || a.id.localeCompare(b.id));
  const trips = [];
  let cur = null;
  const close = () => { if (cur) { trips.push(cur); cur = null; } };
  for (const f of live) {
    if (cur && (f.from === home || dayDiff(cur.flights[cur.flights.length - 1].date, f.date) > 21)) close();
    if (!cur) cur = { flights: [] };
    cur.flights.push(f);
    if (f.to === home) close();
  }
  close();
  return trips.map(t => {
    const fs = t.flights, codes = [];
    for (const f of fs) for (const c of [f.from, f.to]) if (c !== home && !codes.includes(c)) codes.push(c);
    const places = codes.map(c => ref.ap.get(c)).filter(Boolean);
    const countries = [...new Set(places.map(p => p.cc))];
    const cities = [...new Set(places.map(p => (p.city || p.name).replace(/ \(.*\)$/, "")))];
    const km = fs.reduce((a, f) => a + (f.distanceKm || 0), 0);
    const start = fs[0].date, end = fs[fs.length - 1].date;
    const when = `${MONTHS[+start.slice(5, 7) - 1]} ${start.slice(0, 4)}`;
    const homeCC = ref.ap.get(home)?.cc;
    const abroad = countries.filter(c => c !== homeCC).map(c => countryName(ref, c));
    const list3 = xs => xs.length <= 2 ? xs.join(" & ") : `${xs.slice(0, 2).join(", ")} & ${xs.length > 3 ? `${xs.length - 2} more` : xs[2]}`;
    const label = abroad.length ? list3(abroad) : cities.length ? list3(cities) : "Round trip";
    const upcoming = fs.some(f => statusOf(f, today) === "upcoming");
    return { id: fs[0].id, flights: fs, start, end, days: dayDiff(start, end) + 1, codes, countries, cities, km, name: `${label}`, when, upcoming,
      international: countries.some(c => c !== ref.ap.get(home)?.cc) };
  }).reverse();
}

/* ---------------- CSV ---------------- */
export function parseCSV(text) {
  const rows = []; let row = [], cur = "", q = false;
  text = text.replace(/^﻿/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cur); rows.push(row); row = []; cur = ""; }
    else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows.filter(r => r.length > 1);
}

/** Parses an OpenFlights export (or Wander's own export) into loose flight objects. */
export function fromOpenFlightsCSV(text) {
  const rows = parseCSV(text);
  if (!rows.length) return { flights: [], error: "The file is empty." };
  const h = rows.shift().map(s => s.trim());
  const ix = k => h.indexOf(k);
  if (ix("From") < 0 || ix("To") < 0 || ix("Date") < 0) return { flights: [], error: "That doesn't look like an OpenFlights export. It needs Date, From and To columns." };
  const seat = { W: "window", A: "aisle", M: "middle" }, cab = { Y: "economy", P: "premium", C: "business", F: "first" }, rs = { L: "leisure", B: "business", C: "crew", O: "other" };
  const flights = rows.map(r => {
    const g = k => (ix(k) >= 0 ? (r[ix(k)] || "").trim() : "");
    const [date, time = ""] = g("Date").split(" ");
    const st = g("Status");
    return {
      date, time: time.slice(0, 5), from: g("From").toUpperCase(), to: g("To").toUpperCase(),
      flight: g("Flight_Number").replace(/[*\s]/g, "").toUpperCase(), duration: g("Duration"), seat: g("Seat"),
      seatType: seat[g("Seat_Type")] || "", cabin: cab[g("Class")] || "economy", reason: rs[g("Reason")] || "leisure",
      aircraft: g("Plane"), registration: g("Registration"), trip: g("Trip"), note: g("Note"),
      status: st === "cancelled" ? "cancelled" : undefined,
    };
  });
  return { flights, error: "" };
}

export function toOpenFlightsCSV(flights, ref, today = todayISO()) {
  const invS = { window: "W", aisle: "A", middle: "M" }, invC = { economy: "Y", premium: "P", business: "C", first: "F" }, invR = { leisure: "L", business: "B", crew: "C", other: "O" };
  const q = s => (/[",\n]/.test(String(s ?? "")) ? `"${String(s).replace(/"/g, '""')}"` : String(s ?? ""));
  const lines = ["Date,From,To,Flight_Number,Airline,Distance,Duration,Seat,Seat_Type,Class,Reason,Plane,Registration,Trip,Note,Status"];
  [...flights].sort((a, b) => b.date.localeCompare(a.date)).forEach(f => lines.push([
    f.date + (f.time ? ` ${f.time}:00` : ""), f.from, f.to, f.flight, airlineName(ref, f.airline), Math.round((f.distanceKm || 0) / 1.609344),
    f.duration, f.seat, invS[f.seatType] || "", invC[f.cabin] || "Y", invR[f.reason] || "L", f.aircraft, f.registration, f.trip, f.note, statusOf(f, today),
  ].map(q).join(",")));
  return lines.join("\n") + "\n";
}

/** A compact, token-cheap text table of flights, for giving an LLM context. */
export function flightsAsText(flights, ref, today = todayISO()) {
  return [...flights].sort((a, b) => a.date.localeCompare(b.date)).map(f => {
    const A = ref.ap.get(f.from), B = ref.ap.get(f.to);
    return [f.date, f.flight || "-", `${f.from}(${A?.city || ""},${A?.cc || ""})`, `${f.to}(${B?.city || ""},${B?.cc || ""})`,
      airlineName(ref, f.airline), `${f.distanceKm || 0}km`, f.duration || "", f.aircraft || "", f.seat || "", f.cabin || "", statusOf(f, today)].join(" | ");
  }).join("\n");
}
