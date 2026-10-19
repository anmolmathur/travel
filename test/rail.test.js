import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRef, normalize, toDoc, fromOpenFlightsCSV, toOpenFlightsCSV } from "../public/lib/core.js";
import { parseIrctc, cleanRail, statusKind, legLinks, STATIONS } from "../public/lib/rail.js";
import { buildApp } from "../server/index.js";

const ref = createRef(JSON.parse(readFileSync(new URL("../public/data/ref.json", import.meta.url), "utf8")));

test("every station maps to an airport Wander knows", () => {
  const missing = Object.entries(STATIONS).filter(([, [, a]]) => !ref.ap.get(a)).map(([s]) => s);
  assert.deepEqual(missing, []);
});

test("reads IRCTC booking and chart SMS layouts", () => {
  const a = parseIrctc("PNR:2412345678,TRN:12951,DOJ:15-10-26,3A,BCT-NDLS,DP:17:00,ANMOL MATHUR+2,B4 34,B4 35,B4 36,Fare:4,235,SC Fee:35.4+PG CHGS.", "2026-10-19");
  assert.deepEqual([a.pnr, a.train, a.date, a.time, a.cls, a.fromStn, a.toStn, a.from, a.to, a.party], ["2412345678", "12951", "2026-10-15", "17:00", "3A", "BCT", "NDLS", "BOM", "DEL", 3]);
  assert.deepEqual(a.passengers.map(p => `${p.coach} ${p.berth}`), ["B4 34", "B4 35", "B4 36"]);
  const b = parseIrctc("PNR:4567890123,TRN:22119,DOJ:02-11-2026,CC,CSMT-MAO,DP:05:25,ANMOL+1,C3 45 WS,C3 46 MS,Fare:2,170");
  assert.deepEqual(b.passengers.map(p => p.berthType), ["WS", "MS"]);
  const w = parseIrctc("PNR:8765432109,TRN:12627,DOJ:20-12-26,SL,SBC-NDLS,DP:20:00,KRUTI GARG+1,WL 34,WL 35,Fare:1,600");
  assert.deepEqual(w.passengers.map(p => p.status), ["WL 34", "WL 35"]);
  const c = parseIrctc("PNR-8765432109 Trn:12627 Dt:20-12-26 Frm SBC to NDLS Cls:SL P1-S5,34,P2-RAC 12 Chart Prepared");
  assert.deepEqual([c.fromStn, c.toStn, c.chart, c.passengers[0].coach, c.passengers[1].status], ["SBC", "NDLS", true, "S5", "RAC 12"]);
  assert.deepEqual(parseIrctc("hello"), {});
});

test("ticket details are cleaned, kept only on trains, and survive a CSV round trip", () => {
  const train = toDoc(normalize({ mode: "train", date: "2026-10-15", from: "BOM", to: "DEL", flight: "12951", pnr: "241 234 5678",
    rail: { trainName: "Mumbai Rajdhani", cls: "3a", status: "cnf", chart: "true", passengers: [{ who: "me", coach: "b4", berth: "34", berthType: "lb" }], junk: 1 } }, ref), ref, {}, "2026-10-19");
  assert.equal(train.pnr, "2412345678");
  assert.deepEqual(train.rail, { trainName: "Mumbai Rajdhani", cls: "3A", status: "CNF", chart: true, passengers: [{ who: "me", coach: "B4", berth: "34", berthType: "LB" }] });
  const flight = toDoc(normalize({ date: "2026-10-10", from: "BOM", to: "BLR", flight: "IX5986", pnr: "bydp3k", rail: { cls: "3A" } }, ref), ref, {}, "2026-10-19");
  assert.equal(flight.pnr, "BYDP3K"); assert.equal(flight.rail, undefined);
  const back = fromOpenFlightsCSV(toOpenFlightsCSV([{ id: "x", ...train }], ref, "2026-10-19")).flights[0];
  assert.equal(back.pnr, "2412345678"); assert.equal(back.rail.passengers[0].coach, "B4");
  assert.equal(cleanRail({}), undefined);
  assert.deepEqual(["CNF", "RAC 3", "WL 9", "", "CAN/MOD"].map(statusKind), ["ok", "rac", "wl", "", "wl"]);
});

test("quick links need no API: official PNR page, SMS to 139, live status", () => {
  const links = legLinks({ mode: "train", flight: "12951", pnr: "2412345678" });
  assert.ok(links.some(l => l.official && /indianrail\.gov\.in/.test(l.href)));
  assert.ok(links.some(l => l.href === "sms:139?&body=PNR%202412345678"));
  assert.ok(links.some(l => /12951/.test(l.href) && /running/.test(l.href)));
});

test("ticket updates over the API: only trains, cleaned, time-stamped", async () => {
  const { handler } = buildApp({ WANDER_DB: ":memory:", COOKIE_SECURE: "false" });
  const srv = createServer(handler); await new Promise(r => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = (method, path, body) => fetch(base + path, { method, body: body && JSON.stringify(body) }).then(async r => ({ status: r.status, json: await r.json() }));
  try {
    const t = (await call("POST", "/api/flights", { mode: "train", date: "2026-10-15", from: "BOM", to: "DEL", flight: "12951", pnr: "2412345678", rail: { status: "WL 12" } })).json;
    const u = (await call("PATCH", `/api/flights/${t.id}`, { rail: { ...t.rail, status: "cnf", chart: true, platform: "4", passengers: [{ who: "me", coach: "B4", berth: "34" }] } })).json;
    assert.deepEqual([u.rail.status, u.rail.chart, u.rail.platform, u.rail.passengers[0].coach], ["CNF", true, "4", "B4"]);
    assert.ok(u.rail.updatedAt);
    const f = (await call("POST", "/api/flights", { date: "2026-10-10", from: "BOM", to: "BLR", flight: "IX5986" })).json;
    assert.equal((await call("PATCH", `/api/flights/${f.id}`, { rail: { status: "CNF" } })).status, 400);
    assert.equal((await call("PATCH", `/api/flights/${f.id}`, { pnr: "bydp3k" })).json.pnr, "BYDP3K");
  } finally { srv.close(); }
});
