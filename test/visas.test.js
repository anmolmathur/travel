import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRef } from "../public/lib/core.js";
import { cleanVisa, visaStatus, parseVisaMrz, mrzCheck, visaFor, maskNo, staysIn } from "../public/lib/visa.js";
import { buildApp } from "../server/index.js";
import { createService } from "../server/service.js";
import { openDb } from "../server/db.js";

const ref = createRef(JSON.parse(readFileSync(new URL("../public/data/ref.json", import.meta.url), "utf8")));
const ccOf = c => ref.ap.get(c)?.cc;
const leg = (id, date, from, to, extra = {}) => ({ id, date, from, to, ...extra });

test("MRZ: ICAO 9303 visa specimen reads with every check digit passing", () => {
  const m = parseVisaMrz("VNUTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<\nL8988901C4XXX4009078F96121096ZE184226B<<<<<<");
  assert.deepEqual([m.issuer, m.surname, m.given, m.number, m.dob, m.sex, m.validUntil], ["UTO", "ERIKSSON", "ANNA MARIA", "L8988901C", "1940-09-07", "F", "2096-12-10"]);
  assert.ok(m.numberOk && m.dobOk && m.validUntilOk);
  const bad = parseVisaMrz("VNUTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<\nL8988901C4XXX4009078F96121196ZE184226B<<<<<<"); // one digit misread
  assert.equal(bad.validUntilOk, false);
  assert.equal(mrzCheck("L8988901C"), "4");
  assert.equal(parseVisaMrz("P<INDMATHUR<<ANMOL"), null);
});

test("cleanVisa: tidies input and refuses what can't be tracked", () => {
  const known = new Set(Object.keys(ref.countries)), people = new Set(["me", "kruti"]);
  const { visa } = cleanVisa({ country: "gb", entries: "MULT", validUntil: "2028-03-01", issued: "2026-03-02", maxStay: "180", number: " ab 123 ", person: "kruti" }, { known, people });
  assert.deepEqual([visa.country, visa.entries, visa.validFrom, visa.maxStay, visa.number, visa.person], ["GB", "multiple", "2026-03-02", 180, "AB 123", "kruti"]);
  assert.equal(cleanVisa({ country: "schengen", entries: "2", validUntil: "2027-01-01" }, { known }).visa.entries, "double");
  assert.match(cleanVisa({ country: "ZZ", validUntil: "2027-01-01" }, { known }).error, /Unknown country/);
  assert.match(cleanVisa({ country: "US" }, { known }).error, /expires/);
  assert.match(cleanVisa({ country: "US", validFrom: "2027-02-01", validUntil: "2027-01-01" }, { known }).error, /start after/);
  assert.match(cleanVisa({ country: "US", validUntil: "2027-01-01", person: "bob" }, { known, people }).error, /Unknown person/);
});

test("stays: entries from outside count, legs inside the country don't", () => {
  const legs = [
    leg("a", "2026-01-10", "BOM", "LHR"), leg("b", "2026-01-12", "LHR", "EDI"), leg("c", "2026-01-20", "EDI", "BOM"),
    leg("d", "2026-05-01", "BOM", "LHR"), leg("e", "2026-05-03", "LHR", "CDG", { status: "cancelled" }), leg("f", "2026-05-09", "LHR", "BOM"),
  ];
  const s = staysIn(["GB"], legs, ccOf);
  assert.deepEqual(s.map(x => [x.in, x.out]), [["2026-01-10", "2026-01-20"], ["2026-05-01", "2026-05-09"]]);
});

test("status: days left, entries used, stay limit and expiry states", () => {
  const v = { country: "GB", entries: "double", validFrom: "2026-01-01", validUntil: "2026-12-31", maxStay: 10 };
  const legs = [leg("a", "2026-01-10", "BOM", "LHR"), leg("b", "2026-01-25", "LHR", "BOM"), leg("c", "2026-12-20", "BOM", "LHR"), leg("d", "2027-01-05", "LHR", "BOM")];
  const s = visaStatus(v, { legs, ccOf, today: "2026-11-07" });
  assert.equal(s.state, "expiring"); assert.equal(s.daysLeft, 54);
  assert.deepEqual([s.used, s.planned, s.allowed, s.left], [1, 1, 2, 1]);
  assert.ok(s.stays[0].over, "16 days is over the 10-day limit");
  assert.ok(s.warnings.some(w => /over the 10-day limit/.test(w.text)));
  assert.equal(visaStatus(v, { legs: [], ccOf, today: "2027-01-01" }).state, "expired");
  assert.equal(visaStatus({ ...v, validFrom: "2026-12-01" }, { legs: [], ccOf, today: "2026-11-07" }).state, "upcoming");
  assert.equal(visaStatus({ ...v, validUntil: "2027-12-31" }, { legs: [], ccOf, today: "2026-11-07" }).state, "valid");
  // a single-entry visa with a second trip planned
  const single = visaStatus({ ...v, entries: "single", maxStay: 0 }, { legs, ccOf, today: "2026-11-07" });
  assert.ok(single.warnings.some(w => /allows 1/.test(w.text)));
  // passport running out before the visa does
  assert.ok(visaStatus({ ...v, passportExpiry: "2026-06-01" }, { legs: [], ccOf, today: "2026-03-01" }).warnings.some(w => /passport expires/i.test(w.text)));
});

test("Schengen: one visa for the area, moves between members aren't entries, 90/180 counted", () => {
  const v = { country: "SCHENGEN", entries: "multiple", validFrom: "2026-01-01", validUntil: "2027-06-30", maxStay: 90 };
  const legs = [leg("a", "2026-09-01", "BOM", "CDG"), leg("b", "2026-09-05", "CDG", "FCO"), leg("c", "2026-09-10", "FCO", "ZRH"), leg("d", "2026-09-14", "ZRH", "BOM")];
  const s = visaStatus(v, { legs, ccOf, today: "2026-11-07" });
  assert.deepEqual([s.used, s.stays[0].days, s.days180], [1, 14, 14]);
});

test("visaFor: covers a date, or says one exists but has lapsed", () => {
  const visas = [{ person: "me", country: "US", validFrom: "2020-01-01", validUntil: "2025-01-01" }, { person: "me", country: "SCHENGEN", validFrom: "2026-01-01", validUntil: "2027-01-01" }];
  assert.equal(visaFor(visas, "me", "FR", "2026-06-01").visa.country, "SCHENGEN");
  const us = visaFor(visas, "me", "US", "2026-06-01");
  assert.deepEqual([us.has, us.visa, us.latest.validUntil], [true, null, "2025-01-01"]);
  assert.equal(visaFor(visas, "kruti", "US", "2026-06-01").has, false);
  assert.equal(maskNo("AB1234567"), "•••••4567");
});

test("AI read: the MRZ's check digits overrule a misread printed expiry", async () => {
  const db = openDb(":memory:");
  const fake = { visa: async () => ({ country: "GB", validUntil: "2096-10-12", number: "", mrz: "VNUTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<\nL8988901C4XXX4009078F96121096ZE184226B<<<<<<" }) };
  const svc = createService({ db, ref, makeAI: () => fake, aiEnv: { apiKey: "k" } });
  const r = await svc.aiVisa({ image: "data:image/jpeg;base64,AAAA" });
  assert.equal(r.visa.validUntil, "2096-12-10");
  assert.equal(r.visa.number, "L8988901C");
  assert.ok(r.mrz.ok); assert.match(r.checks[0], /machine-readable/);
  const notVisa = createService({ db, ref, makeAI: () => ({ visa: async () => ({ error: "a boarding pass" }) }), aiEnv: { apiKey: "k" } });
  await assert.rejects(notVisa.aiVisa({ image: "data:image/jpeg;base64,AAAA" }), /doesn't look like a visa/);
});

test("visas over the API: owner only, photo kept apart, people with visas can't be removed", async () => {
  const token = "t".repeat(24);
  const { handler } = buildApp({ WANDER_DB: ":memory:", COOKIE_SECURE: "false", WANDER_PASSWORD: "pw", WANDER_API_TOKEN: token, PUBLIC_READ: "true", WANDER_PEOPLE: "me:Anmol,kruti:Kruti" });
  const srv = createServer(handler); await new Promise(r => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const cookie = (await fetch(`${base}/api/login`, { method: "POST", body: JSON.stringify({ password: "pw" }) })).headers.get("set-cookie").split(";")[0];
    const as = (h, path, opts = {}) => fetch(base + path, { ...opts, headers: { ...h, ...(opts.headers || {}) } });
    const owner = { cookie }, agent = { authorization: `Bearer ${token}` };
    assert.equal((await as({}, "/api/visas")).status, 401, "public viewers can't see visas");
    assert.equal((await as(agent, "/api/visas")).status, 401, "agents can't see visas");
    assert.equal((await (await as(owner, "/api/me")).json()).features.visas, true);
    assert.equal((await (await as({}, "/api/me")).json()).features.visas, false);
    // 1x1 JPEG-ish payload; the server only checks the data URL shape and size
    const photo = "data:image/jpeg;base64," + Buffer.from("fake-jpeg-bytes").toString("base64");
    const made = await as(owner, "/api/visas", { method: "POST", body: JSON.stringify({ person: "kruti", country: "gb", entries: "multiple", validUntil: "2028-03-01", passportNo: "z1234567", photo }) });
    assert.equal(made.status, 201);
    const v = await made.json();
    assert.match(v.id, /^v_[a-f0-9]{12}$/); assert.equal(v.hasPhoto, true); assert.equal(v.passportNo, "Z1234567"); assert.ok(v.status.state);
    const list = await (await as(owner, "/api/visas")).json();
    assert.equal(list.visas.length, 1); assert.ok(!("photo" in list.visas[0]));
    const ph = await as(owner, `/api/visas/${v.id}/photo`);
    assert.equal(ph.headers.get("content-type"), "image/jpeg"); assert.equal(await ph.text(), "fake-jpeg-bytes");
    assert.equal((await as(agent, `/api/visas/${v.id}/photo`)).status, 401);
    // removing a person who still has a visa is refused
    const pp = await as(owner, "/api/people", { method: "PUT", body: JSON.stringify({ people: [{ id: "me", name: "Anmol" }] }) });
    assert.equal(pp.status, 400); assert.match((await pp.json()).error, /visas/);
    const upd = await (await as(owner, `/api/visas/${v.id}`, { method: "PUT", body: JSON.stringify({ maxStay: 180, photo: null }) })).json();
    assert.deepEqual([upd.maxStay, upd.hasPhoto, upd.country], [180, false, "GB"]);
    assert.equal((await as(owner, `/api/visas/${v.id}/photo`)).status, 404);
    assert.equal((await as(owner, "/api/visas", { method: "POST", body: JSON.stringify({ country: "GB", validUntil: "2028-03-01", photo: "data:text/html;base64,PGI+" }) })).status, 400);
    assert.equal((await as(owner, `/api/visas/${v.id}`, { method: "DELETE" })).status, 200);
    assert.equal((await (await as(owner, "/api/visas")).json()).visas.length, 0);
  } finally { srv.close(); }
});

test("the server says which version it runs, at /healthz and /api/me", async () => {
  const run = async env => {
    const { handler } = buildApp({ WANDER_DB: ":memory:", ...env });
    const srv = createServer(handler); await new Promise(r => srv.listen(0, r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    try { return [(await (await fetch(`${base}/healthz`)).json()).version, (await (await fetch(`${base}/api/me`)).json()).version]; } finally { srv.close(); }
  };
  assert.deepEqual(await run({ WANDER_VERSION: "496ca8ff45b224f0c92464e0eef08bdb70380010" }), ["496ca8f", "496ca8f"]);
  const [h] = await run({});
  assert.match(h, /^files-[0-9a-f]{7}$/);
});

test("tidyRead: messy AI output becomes form values, gaps filled from the MRZ and earlier visas", async () => {
  const { tidyRead, toISODate, toCountry } = await import("../public/lib/visa.js");
  const names = ref.countries;
  assert.deepEqual(["12 MAR 2026", "12-03-2026", "12/03/26", "2026-03-12", "12MAR2026", "12.03.2026", "MAR 12, 2026"].map(toISODate), Array(7).fill("2026-03-12"));
  assert.equal(toISODate("12 AVR 2026"), "2026-04-12"); // French: avril
  assert.equal(toISODate("31 FEB 2026"), ""); assert.equal(toISODate("soon"), "");
  assert.deepEqual(["JPN", "Japan", "jp", "UK", "U.S.A.", "D", "Etats Schengen", "Narnia"].map(c => toCountry(c, names)), ["JP", "JP", "JP", "GB", "US", "DE", "SCHENGEN", ""]);
  const people = [{ id: "me", name: "Anmol" }, { id: "kruti", name: "Kruti" }];
  const earlier = [{ person: "kruti", passportNo: "Z7654321", passportExpiry: "2031-05-01" }];
  const { visa, filled } = tidyRead({ country: "France", category: "C", entries: "MULT", maxStay: "90 DAYS", issued: "02 JAN 2026", validUntil: "01-01-2027", name: "", passportNo: "z 765 4321", number: "" },
    { names, people, visas: earlier, mrz: { surname: "GARG", given: "KRUTI", number: "FRA123456", numberOk: true, validUntil: "2027-01-01", validUntilOk: true, issuer: "FRA" } });
  assert.deepEqual(visa, { country: "SCHENGEN", issued: "2026-01-02", validFrom: "2026-01-02", validUntil: "2027-01-01", maxStay: 90, entries: "multiple", category: "C",
    number: "FRA123456", passportNo: "Z7654321", name: "KRUTI GARG", person: "kruti", passportExpiry: "2031-05-01" });
  assert.ok(filled.includes("person") && filled.includes("passportExpiry"));
  // no country printed: the MRZ issuer (alpha-3) still gives it
  assert.equal(tidyRead({}, { names, mrz: { issuer: "JPN" } }).visa.country, "JP");
  // a name shared by nobody, or by two people, picks no one
  assert.equal(tidyRead({ name: "JOHN DOE" }, { people }).visa.person, undefined);
});

test("visa reads run as a job the app polls, so slow AI answers never hit a proxy timeout", async () => {
  const db = openDb(":memory:");
  let release;
  const slow = { provider: "fake", model: "m", visa: () => new Promise(r => { release = () => r({ country: "JPN", validUntil: "29 JAN 2027", maxStay: "15 days" }); }) };
  const svc = createService({ db, ref, makeAI: () => slow, aiEnv: { apiKey: "k" } });
  const { job } = svc.startVisaRead({ image: "data:image/jpeg;base64,AAAA" });
  assert.match(job, /^[a-f0-9]{18}$/);
  assert.equal(svc.visaReadJob(job).state, "working");
  release(); await new Promise(r => setImmediate(r));
  const done = svc.visaReadJob(job);
  assert.deepEqual([done.state, done.visa.country, done.visa.validUntil, done.visa.maxStay], ["done", "JP", "2027-01-29", 15]);
  // a failure comes back as a readable message on the next poll
  const failing = createService({ db, ref, makeAI: () => ({ provider: "fake", model: "m", visa: async () => { throw Object.assign(new Error("Gemini is overloaded right now."), { status: 503 }); } }), aiEnv: { apiKey: "k" } });
  const f = failing.startVisaRead({ image: "data:image/jpeg;base64,AAAA" }).job;
  await new Promise(r => setImmediate(r));
  assert.deepEqual([failing.visaReadJob(f).state, failing.visaReadJob(f).error, failing.visaReadJob(f).status], ["failed", "Gemini is overloaded right now.", 503]);
  assert.throws(() => svc.visaReadJob("0".repeat(18)), /expired/);
  assert.throws(() => createService({ db, ref, aiEnv: {} }).startVisaRead({ image: "data:image/jpeg;base64,AAAA" }), /AI features are off/);
});

test("Gemini quick reads ask for a small thinking budget, and drop it if the model refuses", async () => {
  const { createGemini } = await import("../server/gemini.js");
  const bodies = [];
  const fetchImpl = async (url, init) => {
    const b = JSON.parse(init.body); bodies.push(b);
    if (b.generationConfig.thinkingConfig) return { ok: false, status: 400, json: async () => ({ error: { message: "Thinking budget is not supported by this model." } }) };
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"country":"JP"}' }] } }] }) };
  };
  const g = createGemini({ apiKey: "k", model: "gemini-x-flash", fetchImpl });
  const out = await g.visa({ image: { mimeType: "image/jpeg", data: "AAAA" }, today: "2026-11-10" });
  assert.deepEqual(out, { country: "JP" });
  assert.deepEqual(bodies.map(b => Boolean(b.generationConfig.thinkingConfig)), [true, false]);
  assert.equal(bodies[0].generationConfig.thinkingConfig.thinkingBudget, 512);
});

test("visas are listed newest first, and export to an .xlsx the owner alone can download", async () => {
  const { byRecent } = await import("../public/lib/visa.js");
  const list = [{ id: "a", issued: "2019-05-01", validUntil: "2029-04-30" }, { id: "b", validFrom: "2026-08-20", validUntil: "2026-12-31" }, { id: "c", issued: "2024-01-01", validUntil: "2025-01-01" }];
  assert.deepEqual([...list].sort(byRecent).map(v => v.id), ["b", "c", "a"]);
  const { handler } = buildApp({ WANDER_DB: ":memory:", COOKIE_SECURE: "false", WANDER_PASSWORD: "pw", WANDER_API_TOKEN: "t".repeat(24), PUBLIC_READ: "true", WANDER_PEOPLE: "me:Anmol,kruti:Kruti" });
  const srv = createServer(handler); await new Promise(r => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const cookie = (await fetch(`${base}/api/login`, { method: "POST", body: JSON.stringify({ password: "pw" }) })).headers.get("set-cookie").split(";")[0];
    const post = b => fetch(`${base}/api/visas`, { method: "POST", headers: { cookie }, body: JSON.stringify(b) });
    await post({ person: "me", country: "US", issued: "2019-05-01", validUntil: "2029-04-30", number: "0123<&>", passportNo: "Z1234567" });
    await post({ person: "kruti", country: "SCHENGEN", entries: "multiple", issued: "2026-08-20", validUntil: "2026-12-31", maxStay: 90 });
    assert.deepEqual((await (await fetch(`${base}/api/visas`, { headers: { cookie } })).json()).visas.map(v => v.country), ["SCHENGEN", "US"]);
    assert.equal((await fetch(`${base}/api/visas/export.xlsx`)).status, 401);
    assert.equal((await fetch(`${base}/api/visas/export.xlsx`, { headers: { authorization: `Bearer ${"t".repeat(24)}` } })).status, 401);
    const res = await fetch(`${base}/api/visas/export.xlsx`, { headers: { cookie } });
    assert.equal(res.headers.get("content-type"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    assert.match(res.headers.get("content-disposition"), /attachment; filename="wander-visas-\d{4}-\d{2}-\d{2}\.xlsx"/);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(buf.readUInt32LE(0), 0x04034b50, "a zip file");
    // unpack the sheet and check rows, order, escaping, dates and text kept as text
    const { inflateRawSync } = await import("node:zlib");
    const parts = {}; let o = 0;
    while (buf.readUInt32LE(o) === 0x04034b50) {
      const size = buf.readUInt32LE(o + 18), nameLen = buf.readUInt16LE(o + 26), extra = buf.readUInt16LE(o + 28);
      const name = buf.subarray(o + 30, o + 30 + nameLen).toString(); const start = o + 30 + nameLen + extra;
      parts[name] = inflateRawSync(buf.subarray(start, start + size)).toString(); o = start + size;
    }
    assert.deepEqual(Object.keys(parts).sort(), ["[Content_Types].xml", "_rels/.rels", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml"]);
    const sheet = parts["xl/worksheets/sheet1.xml"];
    assert.ok(sheet.indexOf("Kruti") < sheet.indexOf("Anmol"), "newest first");
    assert.match(sheet, /Schengen area/); assert.match(sheet, /0123&lt;&amp;&gt;/); assert.match(sheet, /Z1234567/);
    assert.match(sheet, /<c r="G2" s="2"><v>46254<\/v><\/c>/, "2026-08-20 as an Excel date");
  } finally { srv.close(); }
});

test("Read photo again: a job can read a visa's saved photo without a new upload", async () => {
  const db = openDb(":memory:");
  let seen = null;
  const svc = createService({ db, ref, makeAI: () => ({ provider: "fake", model: "m", visa: async ({ image }) => { seen = image; return { country: "GBR", validUntil: "01 MAR 2028" }; } }), aiEnv: { apiKey: "k" } });
  const v = svc.createVisa({ country: "GB", validUntil: "2027-01-01", photo: "data:image/jpeg;base64," + Buffer.from("saved-jpeg").toString("base64") });
  const { job } = svc.startVisaRead({ visaId: v.id });
  await new Promise(r => setImmediate(r));
  assert.deepEqual([seen.mimeType, Buffer.from(seen.data, "base64").toString()], ["image/jpeg", "saved-jpeg"]);
  assert.equal(svc.visaReadJob(job).visa.validUntil, "2028-03-01");
  const bare = svc.createVisa({ country: "US", validUntil: "2027-01-01" });
  assert.throws(() => svc.startVisaRead({ visaId: bare.id }), /no saved photo/);
});
