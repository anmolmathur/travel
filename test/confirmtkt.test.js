import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseConfirmTkt, createConfirmTkt } from "../server/confirmtkt.js";
import { createService } from "../server/service.js";
import { openDb } from "../server/db.js";
import { createRef } from "../public/lib/core.js";
import { legLinks, cleanRail } from "../public/lib/rail.js";

const ref = createRef(JSON.parse(readFileSync(new URL("../public/data/ref.json", import.meta.url), "utf8")));
// Made-up pages in the shapes such sites use. The real page wasn't reachable from the build machine; on the server,
// `node server/cli.js confirmtkt <PNR>` shows what Wander reads from it.
const NEXT = `<html><body><div id="app">Loading…</div><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { pnrData: {
  Pnr: "1234567890", TrainNo: "12951", BookingStatus: "WL 34", CurrentStatus: "WL 12", ChartPrepared: false, ConfirmTktStatus: "Probable", Prediction: "Likely to confirm", PredictionPercentage: "86" } } } })}</script></body></html>`;
const TEXT = `<html><body><div class="pnr-card"><h2>PNR 1234567890</h2><div class="row"><span>Booking Status</span><span>WL 34</span></div>
  <div class="prediction"><p class="label">Confirmation Chances</p><p class="value">72 %</p></div><div>Chart Status: Not Prepared</div></div></body></html>`;
const WORD = `<html><body><div>PNR 1234567890</div><div>Chances of confirmation: High</div></body></html>`;
const FRACTION = `<script type="application/json">{"pnr":{"confirmationProbability":0.43,"currentStatus":"RAC 5"}}</script>`;
const CAPTCHA = `<html><body><h1>Are you a robot?</h1><div class="cf-chl">Please complete the captcha</div></body></html>`;

test("reads the chance from embedded JSON, visible text, a word, or a fraction", () => {
  assert.deepEqual(Object.fromEntries(Object.entries(parseConfirmTkt(NEXT)).filter(([k]) => ["chance", "label", "bookingStatus", "currentStatus", "chart", "method"].includes(k))),
    { chance: 86, label: "Likely to confirm", bookingStatus: "WL 34", currentStatus: "WL 12", chart: false, method: "json:PredictionPercentage" });
  const t = parseConfirmTkt(TEXT);
  assert.deepEqual([t.chance, t.method, t.chart, t.bookingStatus, t.label], [72, "text", false, "WL 34", ""], "the heading alone isn't repeated as a label");
  assert.equal(parseConfirmTkt("<div>Confirmation chance: 64% (likely to confirm)</div>").label, "Confirmation chance: (likely to confirm)");
  assert.equal(parseConfirmTkt("<div>Current Status: RAC 5</div><div>Chances 55%</div>").currentStatus, "RAC 5");
  const w = parseConfirmTkt(WORD);
  assert.deepEqual([w.chance, w.label, w.method], [null, "High chance", "text:word"]);
  const f = parseConfirmTkt(FRACTION);
  assert.deepEqual([f.chance, f.currentStatus], [43, "RAC 5"]);
  assert.equal(parseConfirmTkt(CAPTCHA).blocked, true);
  assert.equal(parseConfirmTkt("<html>nothing here</html>").method, "none");
});

test("the client sends only the PNR, and explains failures", async () => {
  let seen;
  const ok = createConfirmTkt({ fetchImpl: async (url, init) => { seen = { url, ua: init.headers["user-agent"] }; return { ok: true, status: 200, text: async () => TEXT }; } });
  const r = await ok.lookup("1234567890");
  assert.equal(seen.url, "https://www.confirmtkt.com/pnr-status/1234567890"); assert.match(seen.ua, /Mozilla/);
  assert.equal(r.chance, 72); assert.ok(r.checkedAt);
  await assert.rejects(createConfirmTkt({ fetchImpl: async () => ({ ok: false, status: 503, text: async () => "" }) }).lookup("1"), e => /HTTP 503/.test(e.message) && e.status === 503);
  await assert.rejects(createConfirmTkt({ fetchImpl: async () => ({ ok: false, status: 403, text: async () => "" }) }).lookup("1"), e => /refused/.test(e.message) && e.status === 503, "never 502: Cloudflare would hide the message");
  await assert.rejects(createConfirmTkt({ fetchImpl: async () => ({ ok: true, status: 200, text: async () => CAPTCHA }) }).lookup("1"), /captcha/);
  await assert.rejects(createConfirmTkt({ fetchImpl: async () => { throw Object.assign(new Error("x"), { cause: { code: "ENOTFOUND" } }); } }).lookup("1"), /ENOTFOUND/);
});

test("the ticket keeps ConfirmTkt's reading apart from the owner's own status, and isn't re-asked within 2 minutes", async () => {
  const db = openDb(":memory:");
  let calls = 0;
  const provider = { lookup: async pnr => { calls++; return { ...parseConfirmTkt(NEXT), checkedAt: new Date().toISOString(), pnr }; } };
  const svc = createService({ db, ref, chanceProvider: provider });
  const t = svc.create({ mode: "train", date: "2026-12-20", from: "BOM", to: "DEL", flight: "12951", pnr: "1234567890", rail: { status: "WL 34", cls: "3A" } });
  const a = await svc.trainChance(t.id);
  assert.deepEqual([a.reading.chance, a.reading.currentStatus, a.reading.source, a.cached], [86, "WL 12", "ConfirmTkt", false]);
  assert.equal(a.flight.rail.status, "WL 34", "the owner's status is untouched");
  assert.equal(a.flight.rail.prediction.chart, "not prepared");
  assert.equal((await svc.trainChance(t.id)).cached, true); assert.equal(calls, 1);
  await svc.trainChance(t.id, { force: true }); assert.equal(calls, 2);
  // a later quick update from the Journeys screen keeps the reading
  const p = svc.patch(t.id, { rail: { ...db.get(t.id).rail, status: "RAC 3" } });
  assert.equal(p.rail.prediction.chance, 86);
  const flight = svc.create({ date: "2026-12-20", from: "BOM", to: "DEL", flight: "AI101" });
  await assert.rejects(svc.trainChance(flight.id), /train tickets/);
  const noPnr = svc.create({ mode: "train", date: "2026-12-21", from: "BOM", to: "DEL", flight: "12951" });
  await assert.rejects(svc.trainChance(noPnr.id), /10-digit PNR/);
  const empty = createService({ db, ref, chanceProvider: { lookup: async () => ({ ...parseConfirmTkt("<html></html>"), checkedAt: new Date().toISOString() }) } });
  await assert.rejects(empty.trainChance(t.id, { force: true }), /didn't show a confirmation chance/);
  assert.equal(cleanRail({ prediction: { chance: 140, at: "x" } }).prediction.chance, undefined, "out-of-range chance dropped");
});

test("train tickets link to ConfirmTkt with the PNR", () => {
  const l = legLinks({ mode: "train", flight: "12951", pnr: "1234567890" }).find(x => x.label === "ConfirmTkt");
  assert.equal(l.href, "https://www.confirmtkt.com/pnr-status/1234567890");
});

test("no error Wander raises uses 502: Cloudflare swaps a 502 for its own page and the reason is lost", async () => {
  const { readdirSync } = await import("node:fs");
  const dir = new URL("../server/", import.meta.url);
  const hits = readdirSync(dir).filter(f => f.endsWith(".js")).flatMap(f => readFileSync(new URL(f, dir), "utf8").split("\n")
    .map((l, i) => [f, i + 1, l]).filter(([, , l]) => /(status:\s*502|,\s*502\)|status\s*=\s*502|\?\s*\d+\s*:\s*502)/.test(l)));
  assert.deepEqual(hits, []);
});
