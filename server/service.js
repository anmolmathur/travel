// Flight operations shared by the REST API and the MCP endpoint.
import { createHash } from "node:crypto";
import {
  normalize, validate, toDoc, newId, statusOf, computeStats, computeFlags, buildTrips, fromOpenFlightsCSV,
  toOpenFlightsCSV, flightsAsText, todayISO, airlineName, countryName, hm, travellersOf, cleanTravellers, forPerson, slug,
} from "../public/lib/core.js";

export class InputError extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }

export function createService({ db, ref, gemini, lookupProvider, defaultPeople = "" }) {
  const all = () => db.list().map(f => normalize(f, ref));
  const today = () => todayISO();

  /* ---------- people ---------- */
  // "me" is always the owner. Seeded from WANDER_PEOPLE ("me:Anmol,kruti:Kruti") the first time.
  function people() {
    const saved = db.kvGet("people");
    if (saved) return saved;
    const seeded = String(defaultPeople).split(",").map(x => x.trim()).filter(Boolean).map(x => { const [id, ...n] = x.split(":"); return { id: slug(id), name: (n.join(":") || id).trim() }; });
    const list = seeded.some(p => p.id === "me") ? seeded : [{ id: "me", name: "Me" }, ...seeded];
    db.kvPut("people", list);
    return list;
  }
  function setPeople(list) {
    if (!Array.isArray(list)) throw new InputError("Send a list of people.");
    const out = [], ids = new Set();
    for (const p of list) {
      const id = slug(p.id || p.name), name = String(p.name || "").trim().slice(0, 40);
      if (!id || !name) throw new InputError("Every person needs a name.");
      if (ids.has(id)) throw new InputError(`"${name}" is listed twice.`);
      ids.add(id); out.push({ id, name });
    }
    if (!ids.has("me")) throw new InputError("The owner (me) can't be removed.");
    const inUse = new Set(all().flatMap(travellersOf));
    const gone = people().filter(p => !ids.has(p.id) && inUse.has(p.id));
    if (gone.length) throw new InputError(`${gone.map(p => p.name).join(", ")} still ${gone.length > 1 ? "have" : "has"} flights. Reassign them first.`);
    db.kvPut("people", out);
    return out;
  }
  function checkTravellers(list) {
    if (list === undefined) return undefined;
    const known = new Set(people().map(p => p.id));
    const unknown = list.filter(id => !known.has(id));
    if (unknown.length) throw new InputError(`Unknown traveller "${unknown[0]}". Add them under People first.`);
    return list;
  }
  /** Set, add or remove travellers on many flights at once (e.g. everyone on a trip). */
  function setTravellers(ids, { travellers, add, remove } = {}) {
    if (!Array.isArray(ids) || !ids.length) throw new InputError("Send the flight ids.");
    const set = checkTravellers(cleanTravellers(travellers)), plus = checkTravellers(cleanTravellers(add)) || [], minus = new Set(cleanTravellers(remove) || []);
    const changed = [];
    for (const id of ids) {
      const f = db.get(id); if (!f) continue;
      let next = set ?? [...travellersOf(f)];
      next = [...new Set([...next, ...plus])].filter(x => !minus.has(x));
      db.put(id, { ...f, travellers: next }); changed.push(id);
    }
    return { updated: changed.length, ids: changed };
  }

  function create(input, source = "manual") {
    const f = normalize(input, ref);
    const err = validate(f, ref); if (err) throw new InputError(err);
    const doc = toDoc(f, ref, { source, createdAt: new Date().toISOString(), travellers: checkTravellers(cleanTravellers(input.travellers)) ?? ["me"] }, today());
    return db.put(newId(doc), doc);
  }
  function replace(id, input) {
    const old = db.get(id); if (!old) throw new InputError("No flight with that id.", 404);
    const f = normalize({ ...input }, ref);
    const err = validate(f, ref); if (err) throw new InputError(err);
    const doc = toDoc(f, ref, { source: old.source || "manual", createdAt: old.createdAt, reviewed: input.reviewed ?? old.reviewed,
      travellers: checkTravellers(cleanTravellers(input.travellers)) ?? travellersOf(old) }, today());
    if (input.status === "cancelled" || (input.status === undefined && old.status === "cancelled")) doc.status = "cancelled";
    return db.put(id, doc);
  }
  function patch(id, fields) {
    const old = db.get(id); if (!old) throw new InputError("No flight with that id.", 404);
    const allowed = ["status", "reviewed", "note", "trip", "seat", "seatType", "cabin", "reason", "aircraft", "registration", "time", "duration"];
    const next = { ...old };
    for (const k of allowed) if (k in fields) next[k] = fields[k];
    if ("travellers" in fields) next.travellers = checkTravellers(cleanTravellers(fields.travellers)) ?? ["me"];
    if (next.status === "flown" || next.status === "upcoming") next.status = next.date > today() ? "upcoming" : "flown";
    if (fields.status === "cancelled") next.cancelledAt = new Date().toISOString();
    const err = validate(normalize(next, ref), ref); if (err) throw new InputError(err);
    return db.put(id, next);
  }
  /** Swap one airport for another on every matching flight (or only the given ids), e.g. HKT picked by mistake for HKG. */
  function replaceAirport(oldCode, newCode, ids) {
    const from = String(oldCode || "").trim().toUpperCase(), to = String(newCode || "").trim().toUpperCase();
    if (!ref.ap.get(to)) throw new InputError(`Unknown airport "${to}". Use a 3-letter IATA code.`);
    if (from === to) throw new InputError("That's the same airport.");
    const only = Array.isArray(ids) && ids.length ? new Set(ids) : null;
    const hits = all().filter(f => (f.from === from || f.to === from) && (!only || only.has(f.id)));
    if (!hits.length) throw new InputError(`No flights use ${from}.`, 404);
    const swap = f => ({ ...f, from: f.from === from ? to : f.from, to: f.to === from ? to : f.to, distanceKm: undefined });
    const bad = hits.find(f => { const n = swap(f); return n.from === n.to; });
    if (bad) throw new InputError(`That would make ${fnPrettyRoute(bad)} start and end at ${to}.`);
    for (const f of hits) replace(f.id, swap(f));
    return { replaced: hits.length, ids: hits.map(f => f.id), from, to };
  }
  const fnPrettyRoute = f => `${f.flight || "the flight"} ${f.from}→${f.to} on ${f.date}`;

  function remove(id) { if (!db.del(id)) throw new InputError("No flight with that id.", 404); return { deleted: id }; }

  function importCSV(text) {
    const { flights, error } = fromOpenFlightsCSV(text);
    if (error) throw new InputError(error);
    const known = people(), newIds = [...new Set(flights.flatMap(f => f.travellers || []))].filter(id => !known.some(p => p.id === id));
    if (newIds.length) db.kvPut("people", [...known, ...newIds.map(id => ({ id, name: id[0].toUpperCase() + id.slice(1) }))]);
    const existing = new Set(all().map(f => `${f.date}|${f.from}|${f.to}|${f.flight}`));
    const entries = []; let skipped = 0; const bad = [];
    flights.forEach((raw, i) => {
      const f = normalize(raw, ref);
      if (f.duration && !/^\d{1,2}:\d{2}$/.test(f.duration)) f.duration = "";
      const err = validate(f, ref);
      if (err) { bad.push({ row: i + 2, error: err }); return; }
      const key = `${f.date}|${f.from}|${f.to}|${f.flight}`;
      if (existing.has(key)) { skipped++; return; }
      existing.add(key);
      const doc = toDoc(f, ref, { source: "import", createdAt: new Date().toISOString(), travellers: f.travellers ?? ["me"] }, today());
      entries.push([newId(doc), doc]);
    });
    db.putMany(entries);
    return { added: entries.length, skipped, failed: bad.length, errors: bad.slice(0, 20) };
  }

  function query({ year, from, to, airport, airline, status, traveller, q, limit = 50 } = {}) {
    let list = traveller ? (traveller === "unassigned" ? all().filter(f => !travellersOf(f).length) : forPerson(all(), slug(traveller))) : all();
    if (year) list = list.filter(f => f.date.startsWith(String(year)));
    if (from) list = list.filter(f => f.from === String(from).toUpperCase());
    if (to) list = list.filter(f => f.to === String(to).toUpperCase());
    if (airport) { const a = String(airport).toUpperCase(); list = list.filter(f => f.from === a || f.to === a); }
    if (airline) list = list.filter(f => f.airline === String(airline).toUpperCase());
    if (status) list = list.filter(f => statusOf(f, today()) === status);
    if (q) { const t = String(q).toLowerCase(); list = list.filter(f => JSON.stringify(f).toLowerCase().includes(t)); }
    return list.sort((a, b) => b.date.localeCompare(a.date)).slice(0, Math.min(500, Number(limit) || 50));
  }

  function summaryText(list) {
    const flown = list.filter(f => statusOf(f, today()) === "flown");
    const s = computeStats(flown, ref);
    const top = (m, n, fmt) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(fmt).join(", ");
    return [
      `Flights flown: ${s.n}; distance ${Math.round(s.km)} km (${(s.km / 40075).toFixed(2)}x around Earth); time in air ${hm(s.min)} h:mm.`,
      `Airports: ${s.airports.size}; countries: ${s.countries.size}; airlines: ${s.carriers.size}; aircraft types: ${s.planes.size}.`,
      `Home base: ${s.home || "-"}. Upcoming flights: ${list.filter(f => statusOf(f, today()) === "upcoming").length}. Marked not flown: ${list.filter(f => f.status === "cancelled").length}.`,
      `Top airlines: ${top(s.carriers, 6, ([c, n]) => `${airlineName(ref, c)} ${n}`)}.`,
      `Countries: ${[...s.countries.keys()].map(c => countryName(ref, c)).join(", ")}.`,
      `Flights by year: ${[...s.years.entries()].sort().map(([y, v]) => `${y}:${v.n}`).join(" ")}.`,
    ].join("\n");
  }

  function stats(year, person = "me") {
    const list = forPerson(all(), person).filter(f => !year || f.date.startsWith(String(year)));
    const flown = list.filter(f => statusOf(f, today()) === "flown");
    const s = computeStats(flown, ref);
    return {
      flights: s.n, km: Math.round(s.km), minutesInAir: s.min, airports: s.airports.size, countries: s.countries.size,
      airlines: s.carriers.size, aircraftTypes: s.planes.size, home: s.home, upcoming: list.filter(f => statusOf(f, today()) === "upcoming").length,
      notFlown: list.filter(f => f.status === "cancelled").length,
      longest: s.longest && { id: s.longest.id, route: `${s.longest.from}-${s.longest.to}`, km: s.longest.distanceKm },
      topRoutes: [...s.routes.values()].sort((a, b) => b.n - a.n).slice(0, 5).map(r => ({ route: r.a.join("-"), flights: r.n })),
      byYear: Object.fromEntries([...s.years.entries()].sort().map(([y, v]) => [y, { flights: v.n, km: Math.round(v.km) }])),
    };
  }

  const reviewQueue = () => computeFlags(all(), today()).groups.map(g => ({
    severity: g.sev, kind: g.kind, title: g.title, message: g.msg, suggestedNotFlown: g.suggest || null,
    flights: g.items.map(f => ({ id: f.id, date: f.date, flight: f.flight, route: `${f.from}-${f.to}` })),
  }));

  /* ---------- AI ---------- */
  function needAI() { if (!gemini) throw new InputError("AI features are off. Set GEMINI_API_KEY on the server to turn them on.", 503); }

  async function aiStatus() {
    if (!gemini) return { configured: false, error: "GEMINI_API_KEY is not set on the server." };
    return gemini.status();
  }

  async function aiExtract({ text, image }) {
    needAI();
    if (!text && !image) throw new InputError("Send booking text or an image.");
    let img = null;
    if (image) {
      const m = /^data:(image\/(?:png|jpeg|webp|gif|heic));base64,([A-Za-z0-9+/=]+)$/.exec(image);
      if (!m) throw new InputError("The image must be a PNG, JPEG, WebP, GIF or HEIC data URL.");
      img = { mimeType: m[1], data: m[2] };
    }
    const rows = await gemini.extract({ text, image: img, today: today() });
    return rows.map(r => {
      const f = normalize({ ...r, flight: String(r.flight || "") }, ref);
      if (f.duration && !/^\d{1,2}:\d{2}$/.test(f.duration)) f.duration = "";
      return { ...f, error: validate(f, ref) || null };
    });
  }

  async function aiAsk(question) {
    needAI();
    if (!question || !String(question).trim()) throw new InputError("Ask a question.");
    const list = all();
    const names = people().map(p => `${p.id} = ${p.name}`).join(", ");
    return gemini.ask({ question: `${question}\n(Travellers column ids: ${names}. "me" is the owner asking. Unless the question names someone else, count only flights that include "me".)`, table: flightsAsText(list, ref, today()), summary: summaryText(forPerson(list, "me")), today: today() });
  }

  async function aiStory(year) {
    needAI();
    const list = forPerson(all(), "me").filter(f => f.date.startsWith(String(year)) && statusOf(f, today()) !== "cancelled");
    if (!list.length) throw new InputError(`No flights in ${year}.`);
    const sig = createHash("sha1").update(list.map(f => f.id + f.status).sort().join(",")).digest("hex");
    const cached = db.kvGet(`story:${year}`);
    if (cached && cached.sig === sig) return cached.value;
    const value = await gemini.story({ year, table: flightsAsText(list, ref, today()), summary: summaryText(list) });
    db.kvPut(`story:${year}`, { sig, value });
    return value;
  }

  // The family shares one home: the owner's most-used airport.
  const homeAirport = () => computeStats(forPerson(all(), "me").filter(f => statusOf(f, today()) === "flown"), ref).home;
  function trips(person = "me") {
    const list = forPerson(all(), person);
    const s = { home: homeAirport() || computeStats(list.filter(f => statusOf(f, today()) === "flown"), ref).home };
    const ts = buildTrips(list, ref, s.home, today());
    const names = db.kvGet("tripNames") || {};
    return { home: s.home, person, trips: ts.map(t => ({ ...t, flights: t.flights.map(f => f.id), travellers: [...new Set(t.flights.flatMap(travellersOf))], ai: names[t.id + ":" + t.codes.join("")] || null })) };
  }

  async function aiNameTrips(person = "me") {
    needAI();
    const { trips: ts } = trips(person);
    const names = db.kvGet("tripNames") || {};
    const todo = ts.filter(t => !names[t.id + ":" + t.codes.join("")]).slice(0, 40);
    if (!todo.length) return { named: 0 };
    const out = await gemini.nameTrips(todo.map(t => ({ id: t.id, when: t.when, days: t.days, places: t.codes.map(c => { const a = ref.ap.get(c); return `${a?.city || c}, ${countryName(ref, a?.cc)}`; }) })));
    for (const [i, o] of out.entries()) {
      const t = todo.find(x => x.id === o.id) || (out.length === todo.length ? todo[i] : null);
      if (t && o.name) names[t.id + ":" + t.codes.join("")] = { name: String(o.name).slice(0, 60), summary: String(o.summary || "").slice(0, 160) };
    }
    db.kvPut("tripNames", names);
    return { named: out.length };
  }

  async function aiWhereNext() {
    needAI();
    const flown = forPerson(all(), "me").filter(f => statusOf(f, today()) === "flown");
    const s = computeStats(flown, ref);
    const key = `next:${s.home}:${s.countries.size}:${flown.length}`;
    const cached = db.kvGet("whereNext");
    if (cached && cached.key === key) return cached.value;
    const value = (await gemini.whereNext({
      home: `${s.home} (${ref.ap.get(s.home)?.city || ""})`, today: today(),
      visited: [...s.countries.keys()].map(c => countryName(ref, c)),
      topRoutes: [...s.routes.values()].sort((a, b) => b.n - a.n).slice(0, 8).map(r => r.a.join("-")),
    })).map(x => ({ ...x, iata: x.iata || x.IATA || x.code || x.airport || "" })).filter(x => x && x.city);
    if (!value.length) throw new InputError("Gemini didn't return any destinations. Try again.", 502);
    db.kvPut("whereNext", { key, value });
    return value;
  }

  async function lookup(flight, date) {
    if (!lookupProvider) throw new InputError("Flight lookup is off. Set AERODATABOX_API_KEY on the server to turn it on.", 503);
    if (!/^[A-Z0-9]{2}\d{1,4}[A-Z]?$/i.test(String(flight || "").replace(/\s+/g, ""))) throw new InputError("Flight number looks wrong. Use a form like 6E5297.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) throw new InputError("Date must be YYYY-MM-DD.");
    return lookupProvider(String(flight).replace(/\s+/g, "").toUpperCase(), date);
  }

  return {
    all, create, replace, patch, remove, replaceAirport, people, setPeople, setTravellers, importCSV, query, stats, reviewQueue, trips,
    exportCSV: () => toOpenFlightsCSV(all(), ref, today()),
    aiStatus, aiExtract, aiAsk, aiStory, aiNameTrips, aiWhereNext, lookup,
    features: { ai: Boolean(gemini), lookup: Boolean(lookupProvider) },
  };
}
