import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRef, computeStats, computeFlags, buildTrips, normalize, validate, toDoc, fromOpenFlightsCSV, toOpenFlightsCSV, cleanMode, legName, hav } from "../public/lib/core.js";
import { buildApp } from "../server/index.js";

const ref = createRef(JSON.parse(readFileSync(new URL("../public/data/ref.json", import.meta.url), "utf8")));
const F = (id, date, from, to, flight, extra = {}) => ({ id, ...toDoc(normalize({ date, from, to, flight, ...extra }, ref), ref, {}, "2026-09-26") });

// Spring 2026 in Europe: fly in, train between cities, fly home.
const europe = [
  F("a", "2026-04-04", "BOM", "MUC", "LH765"),
  F("b", "2026-04-04", "MUC", "MAD", "LH1800"),
  F("c", "2026-04-10", "MAD", "SVQ", "", { mode: "train", operator: "Renfe" }),
  F("d", "2026-04-13", "SVQ", "MXP", "W46310"),
  F("e", "2026-04-15", "LIN", "FCO", "FR9544", { mode: "train", operator: "Trenitalia", distanceKm: 572 }),
  F("f", "2026-04-17", "FCO", "AUH", "EY84"),
  F("g", "2026-04-18", "AUH", "BOM", "EY202"),
];

test("modes: loose input is normalised, and junk is rejected", () => {
  assert.equal(cleanMode("Rail"), "train");
  assert.equal(cleanMode(""), "air");
  assert.equal(cleanMode("drive"), "car");
  assert.equal(cleanMode("hovercraft"), null);
  assert.match(validate(normalize({ date: "2026-04-15", from: "LIN", to: "FCO", mode: "hovercraft" }, ref), ref), /Mode must be/);
  assert.match(validate(normalize({ date: "2026-04-15", from: "FCO", to: "FCO", mode: "car" }, ref), ref), /same place/);
});

test("ground legs keep no airline, estimate road distance, and use a given one", () => {
  const c = europe.find(f => f.id === "c"), e = europe.find(f => f.id === "e");
  assert.equal(c.mode, "train"); assert.equal(c.airline, ""); assert.equal(c.operator, "Renfe");
  const straight = hav(ref.ap.get("MAD"), ref.ap.get("SVQ"));
  assert.ok(Math.abs(c.distanceKm - straight * 1.2) < 2, "straight line plus 20%");
  assert.equal(e.distanceKm, 572, "a distance you enter wins");
  assert.equal(legName(e), "Train FR9544");
  assert.equal(europe.find(f => f.id === "f").mode, "air");
});

test("flight statistics skip ground legs, but countries and ground totals include them", () => {
  const s = computeStats(europe, ref);
  assert.equal(s.n, 5, "five flights");
  assert.equal(s.ground.n, 2);
  assert.equal(s.ground.by.train.n, 2);
  assert.ok(!s.airports.has("LIN"), "a train from Milan isn't an airport visit");
  assert.ok(s.countries.has("IT") && s.countries.has("ES"));
  const onlyTrain = computeStats([F("t", "2026-04-15", "GVA", "ZRH", "", { mode: "train" })], ref);
  assert.equal(onlyTrain.n, 0);
  assert.ok(onlyTrain.countries.has("CH"), "a country reached overland still counts");
});

test("a train between flights joins the trip, and isn't flagged as a rebooking", () => {
  const trips = buildTrips(europe, ref, "BOM", "2026-09-26");
  assert.equal(trips.length, 1);
  assert.equal(trips[0].flights.length, 7);
  const commute = [F("x", "2026-05-01", "BOM", "PNQ", "", { mode: "car" }), F("y", "2026-05-03", "BOM", "PNQ", "", { mode: "car" })];
  assert.ok(!computeFlags(commute, "2026-09-26").groups.some(g => g.kind === "rebooked"));
});

test("mode, operator and road distance survive a CSV round trip; OpenFlights files stay flights", () => {
  const { flights, error } = fromOpenFlightsCSV(toOpenFlightsCSV(europe, ref, "2026-09-26"));
  assert.equal(error, "");
  const e = flights.find(f => f.flight === "FR9544");
  assert.equal(e.mode, "train"); assert.equal(e.operator, "Trenitalia");
  assert.ok(Math.abs(e.distanceKm - 572) <= 1);
  assert.equal(flights.find(f => f.flight === "EY84").mode, "air");
  const plain = fromOpenFlightsCSV("Date,From,To,Flight_Number\n2016-08-01,BOM,DEL,AI865\n").flights[0];
  assert.equal(plain.mode, "air");
});

test("the API and MCP accept ground legs", async () => {
  const token = "m".repeat(24);
  const { handler } = buildApp({ WANDER_DB: ":memory:", COOKIE_SECURE: "false", WANDER_API_TOKEN: token });
  const srv = createServer(handler); await new Promise(r => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const add = await (await fetch(`${base}/api/flights`, { method: "POST", body: JSON.stringify({ mode: "car", date: "2026-10-12", from: "BLR", to: "MYQ", operator: "Self-drive" }) })).json();
    assert.equal(add.mode, "car"); assert.equal(add.airline, "");
    const rpc = body => fetch(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) }).then(r => r.json());
    const r = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "add_flight", arguments: { mode: "train", date: "2026-04-15", from: "LIN", to: "FCO", operator: "Trenitalia" } } });
    const doc = JSON.parse(r.result.content[0].text);
    assert.equal(doc.mode, "train");
    const moved = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "update_flight", arguments: { id: doc.id, from: "MXP" } } });
    const after = JSON.parse(moved.result.content[0].text);
    assert.equal(after.distanceKm, Math.round(hav(ref.ap.get("MXP"), ref.ap.get("FCO")) * 1.2), "distance follows the new start");
    const listed = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_flights", arguments: { mode: "train" } } });
    assert.equal(JSON.parse(listed.result.content[0].text).length, 1);
    const csv = await (await fetch(`${base}/api/import`, { method: "POST", body: "Date,From,To,Flight_Number,Airline,Mode\n2026-04-15,MXP,FCO,,Trenitalia,train\n2026-04-15,MXP,FCO,,Trenitalia,car\n" })).json();
    assert.deepEqual([csv.added, csv.skipped], [1, 1], "same-day train already logged via MCP is a duplicate; a car on the same road isn't");
  } finally { srv.close(); }
});
