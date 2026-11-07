// Visas: validation, status and stay tracking. Shared by the server and the browser, so it works offline too.
// A visa belongs to one person and one country (or the Schengen area). Its "entries used" and "days stayed"
// come from the logbook: every logged arrival into that country inside the visa's validity window.

/** Schengen members (2025): one visa covers them all, and stays count across the whole area. */
export const SCHENGEN = ["AT", "BE", "BG", "CH", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GR", "HR", "HU", "IS", "IT", "LI", "LT", "LU", "LV", "MT", "NL", "NO", "PL", "PT", "RO", "SE", "SI", "SK"];
export const VISA_ZONES = { SCHENGEN: { name: "Schengen area", countries: SCHENGEN } };
export const VISA_ENTRIES = { single: "Single entry", double: "Double entry", multiple: "Multiple entry" };
export const VISA_KINDS = ["Tourist", "Business", "Visit", "Transit", "Student", "Work", "Employment", "Conference", "Medical", "Residence", "e-Visa", "Visa on arrival", "Other"];
export const EXPIRING_DAYS = 60;

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const str = (v, n) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const date = v => { const s = str(v, 10); return ISO.test(s) && !Number.isNaN(Date.parse(s)) ? s : ""; };
const dayDiff = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
const addDays = (d, n) => new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10);

/** The countries a visa covers: a zone's members, or the one country. */
export const visaCountries = v => VISA_ZONES[v.country]?.countries || [v.country];
export const visaPlace = (v, countryName = c => c) => VISA_ZONES[v.country]?.name || countryName(v.country);

/**
 * Tidy a visa from a form, the AI or the API. Returns { visa } or { error }.
 * `known` is the set of country codes the app knows; `people` the set of traveller ids.
 */
export function cleanVisa(input = {}, { known, people } = {}) {
  const country = str(input.country, 10).toUpperCase();
  const entriesRaw = str(input.entries, 12).toLowerCase();
  const entries = /^(m|multi)/.test(entriesRaw) || Number(entriesRaw) > 2 ? "multiple" : /^(d|2)/.test(entriesRaw) ? "double" : /^(s|1)/.test(entriesRaw) ? "single" : "";
  const maxStay = Math.round(Number(input.maxStay)) || 0;
  const v = {
    person: str(input.person, 32) || "me",
    country,
    kind: str(input.kind, 40),
    category: str(input.category, 40),
    entries,
    number: str(input.number, 30).toUpperCase(),
    issued: date(input.issued),
    validFrom: date(input.validFrom),
    validUntil: date(input.validUntil),
    maxStay: maxStay > 0 && maxStay < 3700 ? maxStay : 0,
    issuedAt: str(input.issuedAt, 60),
    name: str(input.name, 80),
    passportNo: str(input.passportNo, 20).toUpperCase(),
    passportExpiry: date(input.passportExpiry),
    notes: str(input.notes, 500),
  };
  if (!v.country) return { error: "Choose the country the visa is for." };
  if (!VISA_ZONES[v.country] && (!/^[A-Z]{2}$/.test(v.country) || (known && !known.has(v.country)))) return { error: `Unknown country "${v.country}". Use a 2-letter code like GB, or SCHENGEN.` };
  if (people && !people.has(v.person)) return { error: `Unknown person "${v.person}". Add them under People first.` };
  if (!v.validUntil) return { error: "Add the date the visa expires (valid until)." };
  if (!v.validFrom) v.validFrom = v.issued || "";
  if (v.validFrom && v.validFrom > v.validUntil) return { error: "The visa can't start after it expires. Check the dates." };
  return { visa: v };
}

/* ---------- machine-readable zone (the two lines of <<< at the bottom of a visa) ---------- */
const MRZ_VAL = c => (c === "<" ? 0 : /\d/.test(c) ? Number(c) : c.charCodeAt(0) - 55);
export const mrzCheck = s => String([...s].reduce((sum, c, i) => sum + MRZ_VAL(c) * [7, 3, 1][i % 3], 0) % 10);
const mrzDate = (s, future) => {
  if (!/^\d{6}$/.test(s)) return "";
  const yy = Number(s.slice(0, 2)), now = new Date().getUTCFullYear() % 100;
  const century = future ? 2000 : yy > now ? 1900 : 2000; // a visa's expiry is this century; a birth year can be the last
  return `${century + yy}-${s.slice(2, 4)}-${s.slice(4, 6)}`;
};
/**
 * Read an ICAO 9303 machine-readable visa (MRV-A, 44 characters a line, or MRV-B, 36). Every field comes with its
 * check digit, so a misread is caught here rather than trusted. Returns null when the text isn't a visa MRZ.
 */
export function parseVisaMrz(text) {
  const lines = String(text || "").toUpperCase().replace(/[ \t]/g, "").split(/\r?\n/).map(l => l.replace(/[^A-Z0-9<]/g, "")).filter(l => l.length >= 30);
  const i = lines.findIndex(l => l.startsWith("V"));
  if (i < 0 || !lines[i + 1]) return null;
  const [l1, l2] = [lines[i], lines[i + 1]];
  const names = l1.slice(5).split("<<");
  const num = l2.slice(0, 9), dob = l2.slice(13, 19), exp = l2.slice(21, 27);
  return {
    issuer: l1.slice(2, 5).replace(/</g, ""),
    surname: (names[0] || "").replace(/</g, " ").trim(),
    given: (names.slice(1).join(" ") || "").replace(/</g, " ").replace(/\s+/g, " ").trim(),
    number: num.replace(/</g, ""), numberOk: mrzCheck(num) === l2[9],
    nationality: l2.slice(10, 13).replace(/</g, ""),
    dob: mrzDate(dob, false), dobOk: mrzCheck(dob) === l2[19],
    sex: l2[20] === "<" ? "" : l2[20],
    validUntil: mrzDate(exp, true), validUntilOk: mrzCheck(exp) === l2[27],
  };
}

/* ---------- status ---------- */
/**
 * Visits into the visa's country from the logbook: an arrival from outside opens a stay, the next departure to
 * outside closes it. Legs inside the country (or inside Schengen) don't count as new entries.
 * `legs` are normalised flights/ground legs for this person, `ccOf(code)` gives an airport's country.
 */
export function staysIn(countries, legs, ccOf) {
  const inside = new Set(countries), stays = [];
  const sorted = [...legs].filter(f => f.status !== "cancelled").sort((a, b) => (a.date + (a.time || "")).localeCompare(b.date + (b.time || "")));
  let open = null;
  for (const f of sorted) {
    const a = inside.has(ccOf(f.from)), b = inside.has(ccOf(f.to));
    if (!a && b && !open) open = { in: f.date, inLeg: f.id, out: "", outLeg: null };
    else if (a && !b) {
      if (open) { open.out = f.date; open.outLeg = f.id; stays.push(open); open = null; }
      else stays.push({ in: "", inLeg: null, out: f.date, outLeg: f.id }); // left without a logged arrival
    }
  }
  if (open) stays.push(open);
  return stays;
}

/**
 * Where a visa stands today: state, days left, entries used and left, each stay against the limit, and warnings.
 * state: "upcoming" (not valid yet), "valid", "expiring" (within EXPIRING_DAYS), "expired".
 */
export function visaStatus(v, { legs = [], ccOf, today }) {
  const daysLeft = dayDiff(today, v.validUntil);
  const state = daysLeft < 0 ? "expired" : v.validFrom && v.validFrom > today ? "upcoming" : daysLeft <= EXPIRING_DAYS ? "expiring" : "valid";
  const span = v.validFrom ? dayDiff(v.validFrom, v.validUntil) + 1 : 0;
  const elapsed = v.validFrom ? Math.min(span, Math.max(0, dayDiff(v.validFrom, today) + 1)) : 0;
  const within = d => d && (!v.validFrom || d >= v.validFrom) && d <= v.validUntil;
  const stays = staysIn(visaCountries(v), legs, ccOf)
    .filter(s => within(s.in) || (!s.in && within(s.out)))
    .map(s => {
      const end = s.out || (s.in <= today ? today : s.in);
      const days = s.in ? dayDiff(s.in, end) + 1 : 0;
      const planned = (s.in || s.out) > today;
      return { ...s, days, planned, open: !s.out, over: v.maxStay > 0 && days > v.maxStay };
    });
  const used = stays.filter(s => s.in && !s.planned).length, planned = stays.filter(s => s.planned).length;
  const allowed = v.entries === "single" ? 1 : v.entries === "double" ? 2 : Infinity;
  const left = allowed === Infinity ? null : Math.max(0, allowed - used);
  const warnings = [];
  const current = stays.find(s => s.in && s.in <= today && (!s.out || s.out >= today));
  if (current && v.maxStay) {
    const leaveBy = addDays(current.in, v.maxStay - 1);
    if (current.open || current.out > leaveBy) warnings.push({ kind: current.out > leaveBy || today > leaveBy ? "bad" : "info", text: `This stay can last until ${leaveBy} (${v.maxStay} days from entry).` });
  }
  for (const s of stays) if (s.over && s !== current) warnings.push({ kind: "bad", text: `The stay from ${s.in} is ${s.days} days, over the ${v.maxStay}-day limit.` });
  if (allowed !== Infinity && used + planned > allowed) warnings.push({ kind: "bad", text: `${used + planned} entries logged or planned, but this visa allows ${allowed}.` });
  for (const s of stays) if (s.planned && s.in > v.validUntil) warnings.push({ kind: "bad", text: `A trip arriving ${s.in} is after this visa expires.` });
  if (current && !v.maxStay && daysLeft >= 0) warnings.push({ kind: "info", text: `You're there now. The visa expires on ${v.validUntil}.` });
  if (v.passportExpiry) {
    if (v.passportExpiry < v.validUntil) warnings.push({ kind: "warn", text: `The passport expires (${v.passportExpiry}) before this visa. Most countries won't honour a visa in an expired passport.` });
    else if (dayDiff(today, v.passportExpiry) < 183 && v.passportExpiry >= today) warnings.push({ kind: "warn", text: `The passport expires within six months (${v.passportExpiry}). Many countries refuse entry then.` });
  }
  // Schengen: 90 days in any 180. Count days spent in the area in the 180 days up to today.
  let days180 = null;
  if (v.country === "SCHENGEN") {
    const from = addDays(today, -179);
    days180 = stays.filter(s => s.in && s.in <= today).reduce((n, s) => {
      const a = s.in > from ? s.in : from, b = (s.out || today) < today ? s.out || today : today;
      return n + Math.max(0, dayDiff(a, b) + 1);
    }, 0);
    if (days180 > 90) warnings.push({ kind: "bad", text: `${days180} days in the Schengen area in the last 180: over the 90-day rule.` });
  }
  return { state, daysLeft, span, elapsed, stays, used, planned, allowed: allowed === Infinity ? null : allowed, left, days180, warnings };
}

/** The visa (if any) of this person that covers this country on this date. */
export function visaFor(visas, person, cc, day) {
  const mine = visas.filter(v => v.person === person && visaCountries(v).includes(cc));
  if (!mine.length) return { has: false };
  const ok = mine.filter(v => (!v.validFrom || v.validFrom <= day) && v.validUntil >= day).sort((a, b) => b.validUntil.localeCompare(a.validUntil))[0];
  return { has: true, visa: ok || null, latest: mine.sort((a, b) => b.validUntil.localeCompare(a.validUntil))[0] };
}

/** "AB1234567" -> "•••••4567": numbers stay hidden on screen until tapped. */
export const maskNo = s => (s ? (s.length > 4 ? "•".repeat(Math.min(6, s.length - 4)) + s.slice(-4) : s) : "");
