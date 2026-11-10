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

/* ---------- tidying what the AI read off a photo ---------- */
// ISO 3166-1 alpha-3 to alpha-2 (from the iso-codes list), plus the odd codes visas and MRZs use.
const A3 = Object.fromEntries("ABWAW AFGAF AGOAO AIAAI ALAAX ALBAL ANDAD AREAE ARGAR ARMAM ASMAS ATAAQ ATFTF ATGAG AUSAU AUTAT AZEAZ BDIBI BELBE BENBJ BESBQ BFABF BGDBD BGRBG BHRBH BHSBS BIHBA BLMBL BLRBY BLZBZ BMUBM BOLBO BRABR BRBBB BRNBN BTNBT BVTBV BWABW CAFCF CANCA CCKCC CHECH CHLCL CHNCN CIVCI CMRCM CODCD COGCG COKCK COLCO COMKM CPVCV CRICR CUBCU CUWCW CXRCX CYMKY CYPCY CZECZ DEUDE DJIDJ DMADM DNKDK DOMDO DZADZ ECUEC EGYEG ERIER ESHEH ESPES ESTEE ETHET FINFI FJIFJ FLKFK FRAFR FROFO FSMFM GABGA GBRGB GEOGE GGYGG GHAGH GIBGI GINGN GLPGP GMBGM GNBGW GNQGQ GRCGR GRDGD GRLGL GTMGT GUFGF GUMGU GUYGY HKGHK HMDHM HNDHN HRVHR HTIHT HUNHU IDNID IMNIM INDIN IOTIO IRLIE IRNIR IRQIQ ISLIS ISRIL ITAIT JAMJM JEYJE JORJO JPNJP KAZKZ KENKE KGZKG KHMKH KIRKI KNAKN KORKR KWTKW LAOLA LBNLB LBRLR LBYLY LCALC LIELI LKALK LSOLS LTULT LUXLU LVALV MACMO MAFMF MARMA MCOMC MDAMD MDGMG MDVMV MEXMX MHLMH MKDMK MLIML MLTMT MMRMM MNEME MNGMN MNPMP MOZMZ MRTMR MSRMS MTQMQ MUSMU MWIMW MYSMY MYTYT NAMNA NCLNC NERNE NFKNF NGANG NICNI NIUNU NLDNL NORNO NPLNP NRUNR NZLNZ OMNOM PAKPK PANPA PCNPN PERPE PHLPH PLWPW PNGPG POLPL PRIPR PRKKP PRTPT PRYPY PSEPS PYFPF QATQA REURE ROURO RUSRU RWARW SAUSA SDNSD SENSN SGPSG SGSGS SHNSH SJMSJ SLBSB SLESL SLVSV SMRSM SOMSO SPMPM SRBRS SSDSS STPST SURSR SVKSK SVNSI SWESE SWZSZ SXMSX SYCSC SYRSY TCATC TCDTD TGOTG THATH TJKTJ TKLTK TKMTM TLSTL TONTO TTOTT TUNTN TURTR TUVTV TWNTW TZATZ UGAUG UKRUA UMIUM URYUY USAUS UZBUZ VATVA VCTVC VENVE VGBVG VIRVI VNMVN VUTVU WLFWF WSMWS YEMYE ZAFZA ZMBZM ZWEZW".split(" ").map(x => [x.slice(0, 3), x.slice(3)]));
Object.assign(A3, { D: "DE", RKS: "XK", GBD: "GB", GBN: "GB", GBO: "GB", GBS: "GB", GBP: "GB", UNK: "XK" });
const ALIASES = { UK: "GB", "GREAT BRITAIN": "GB", BRITAIN: "GB", ENGLAND: "GB", USA: "US", "U.S.A.": "US", "U.S.": "US", AMERICA: "US", "UNITED STATES OF AMERICA": "US",
  UAE: "AE", "U.A.E.": "AE", EMIRATES: "AE", KOREA: "KR", "REPUBLIC OF KOREA": "KR", CZECHIA: "CZ", "TÜRKIYE": "TR", TURKIYE: "TR", HOLLAND: "NL", "RUSSIAN FEDERATION": "RU",
  "VIET NAM": "VN", "HONG KONG": "HK", MACAU: "MO", "PEOPLE'S REPUBLIC OF CHINA": "CN", "SCHENGEN AREA": "SCHENGEN", "SCHENGEN STATES": "SCHENGEN", "ETATS SCHENGEN": "SCHENGEN" };
const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, SEPT: 9, OCT: 10, NOV: 11, DEC: 12,
  JANV: 1, FEV: 2, FEVR: 2, MARS: 3, AVR: 4, MAI: 5, JUIN: 6, JUIL: 7, AOUT: 8, SEPTEMBRE: 9, OKT: 10, DEZ: 12, MRZ: 3 };

/** A country as a code Wander knows: alpha-2, alpha-3, a name, or SCHENGEN. "" when it can't tell. */
export function toCountry(v, names = {}) {
  const s = String(v ?? "").trim().toUpperCase().replace(/\s+/g, " ");
  if (!s) return "";
  if (VISA_ZONES[s] || /SCHENGEN/.test(s)) return "SCHENGEN";
  if (ALIASES[s]) return ALIASES[s];
  if (/^[A-Z]{2}$/.test(s) && (!Object.keys(names).length || names[s])) return s;
  if (A3[s]) return A3[s];
  const hit = Object.entries(names).find(([, n]) => String(Array.isArray(n) ? n[0] : n).toUpperCase() === s);
  return hit ? hit[0] : "";
}

/** A date as YYYY-MM-DD from the ways visas print them (day first unless the year leads). "" when unclear. */
export function toISODate(v) {
  let s = String(v ?? "").trim().toUpperCase().replace(/[,]/g, " ").replace(/\s+/g, " ");
  if (!s) return "";
  const ok = (y, m, d) => { y = Number(y); if (y < 100) y += 2000; m = Number(m); d = Number(d);
    if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31 && y > 1900 && y < 2200)) return "";
    const iso = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    return new Date(iso + "T00:00:00Z").getUTCDate() === d ? iso : ""; };
  let m;
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/))) return ok(m[1], m[2], m[3]);
  if ((m = s.match(/^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{2,4})$/))) return ok(m[3], m[2], m[1]);
  if ((m = s.match(/^(\d{1,2})[-/. ]?([A-Z]{3,9})\.?[-/. ]?(\d{2,4})$/))) { const mo = MONTHS[m[2].slice(0, 4)] || MONTHS[m[2].slice(0, 3)]; if (mo) return ok(m[3], mo, m[1]); }
  if ((m = s.match(/^([A-Z]{3,9})\.? (\d{1,2}) (\d{4})$/)) && MONTHS[m[1].slice(0, 3)]) return ok(m[3], MONTHS[m[1].slice(0, 3)], m[2]);
  return "";
}

/**
 * Turn what the AI read (and the MRZ, if any) into form values, filling every gap it can: country from a name or
 * code, dates in any common layout, stay length from "90 DAYS", the holder's name from the MRZ, whose visa it is
 * from that name, and the passport's expiry from an earlier visa in the same passport. Returns { visa, filled }.
 */
export function tidyRead(raw = {}, { mrz = null, names = {}, people = [], visas = [] } = {}) {
  const r = { ...raw }, out = {};
  out.country = toCountry(r.country, names) || toCountry(r.validFor, names) || (mrz ? toCountry(mrz.issuer, names) : "");
  // A uniform (type C) visa valid for the Schengen states is one visa for the whole area.
  if (out.country && SCHENGEN.includes(out.country) && (/SCHENGEN/i.test(`${r.validFor || ""} ${r.notes || ""}`) || String(r.category || "").trim().toUpperCase() === "C")) out.country = "SCHENGEN";
  for (const k of ["issued", "validFrom", "validUntil", "passportExpiry"]) out[k] = toISODate(r[k]);
  if (mrz?.validUntilOk && mrz.validUntil) out.validUntil = mrz.validUntil;
  if (!out.validFrom && out.issued) out.validFrom = out.issued;
  const stay = String(r.maxStay ?? "").match(/\d{1,4}/); out.maxStay = stay ? Number(stay[0]) : 0;
  const e = String(r.entries ?? "").trim().toUpperCase();
  out.entries = /^(M|MULT)/.test(e) || Number(e) > 2 ? "multiple" : /^(D|2)/.test(e) ? "double" : /^(S|1)/.test(e) ? "single" : "";
  for (const k of ["kind", "category", "issuedAt", "notes"]) out[k] = String(r[k] ?? "").trim();
  out.number = String(r.number ?? "").replace(/\s+/g, "").toUpperCase() || (mrz?.numberOk ? mrz.number : "");
  out.passportNo = String(r.passportNo ?? "").replace(/\s+/g, "").toUpperCase();
  out.name = String(r.name ?? "").trim() || (mrz ? [mrz.given, mrz.surname].filter(Boolean).join(" ") : "");
  // Whose visa: the person whose name shares a word with the name on the visa (only when exactly one does).
  const words = new Set(out.name.toUpperCase().split(/[^A-Z]+/).filter(w => w.length > 1));
  const who = people.filter(p => String(p.name || "").toUpperCase().split(/[^A-Z]+/).some(w => w.length > 1 && words.has(w)));
  if (who.length === 1) out.person = who[0].id;
  // The passport's expiry isn't on a visa, but an earlier visa in the same passport may know it.
  if (!out.passportExpiry && out.passportNo) out.passportExpiry = visas.find(v => v.passportNo === out.passportNo && v.passportExpiry)?.passportExpiry || "";
  if (!out.person && out.passportNo) out.person = visas.find(v => v.passportNo === out.passportNo)?.person || "";
  const visa = Object.fromEntries(Object.entries(out).filter(([, v]) => v !== "" && v !== 0 && v != null));
  return { visa, filled: Object.keys(visa) };
}

/** Newest first: by issue date, else first day of validity, else expiry. Ties go to the later expiry. */
export const visaDate = v => v.issued || v.validFrom || v.validUntil || "";
export const byRecent = (a, b) => visaDate(b).localeCompare(visaDate(a)) || String(b.validUntil || "").localeCompare(String(a.validUntil || ""));
