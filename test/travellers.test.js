import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRef, computeFlags, normalize, fromOpenFlightsCSV, toOpenFlightsCSV, forPerson } from "../public/lib/core.js";
import { buildApp } from "../server/index.js";

const ref = createRef(JSON.parse(readFileSync(new URL("../public/data/ref.json", import.meta.url), "utf8")));
const F = (id, date, from, to, flight, travellers) => ({ id, ...normalize({ date, from, to, flight, travellers }, ref) });

test("two people's itineraries on the same day don't conflict", () => {
  const fs = [
    F("a", "2023-04-11", "MAD", "BCN", "IB3010", ["me"]),
    F("b", "2023-04-11", "BCN", "JED", "SV228", ["me"]),
    F("c", "2023-04-11", "BOM", "JED", "SV773", ["kruti"]),
    F("d", "2023-04-11", "JED", "BCN", "SV229", ["kruti"]),
  ];
  assert.ok(!computeFlags(fs, "2026-01-01").groups.some(g => g.kind === "conflict"));
  const oneCalendar = fs.map(f => ({ ...f, travellers: ["me"] }));
  assert.ok(computeFlags(oneCalendar, "2026-01-01").groups.some(g => g.kind === "conflict"), "same flights for one person do conflict");
});

test("unassigned flights are grouped into a 'whose flight' question and kept out of everyone's view", () => {
  const fs = [F("x", "2023-03-16", "BOM", "HKT", "G821", []), F("y", "2023-03-19", "HKT", "BOM", "G822", []), F("z", "2024-01-01", "BOM", "DEL", "6E1", undefined)];
  const g = computeFlags(fs, "2026-01-01").groups.filter(g => g.kind === "unassigned");
  assert.equal(g.length, 1);
  assert.equal(g[0].items.length, 2);
  assert.deepEqual(forPerson(fs, "all").map(f => f.id), ["z"]);
  assert.deepEqual(forPerson(fs, "me").map(f => f.id), ["z"], "flights without a list belong to the owner");
});

test("travellers survive a CSV round trip, including unassigned", () => {
  const fs = [F("a", "2024-01-01", "BOM", "DEL", "6E1", ["me", "kruti"]), F("b", "2024-01-02", "DEL", "BOM", "6E2", [])];
  const { flights } = fromOpenFlightsCSV(toOpenFlightsCSV(fs, ref, "2026-01-01"));
  assert.deepEqual(flights.find(f => f.flight === "6E1").travellers, ["me", "kruti"]);
  assert.deepEqual(flights.find(f => f.flight === "6E2").travellers, []);
});

test("people, bulk tagging and per-person stats over the API", async () => {
  const { handler } = buildApp({ WANDER_DB: ":memory:", COOKIE_SECURE: "false", WANDER_PEOPLE: "me:Anmol,kruti:Kruti,ayaansh:Ayaansh" });
  const srv = createServer(handler); await new Promise(r => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = (method, path, body) => fetch(base + path, { method, body: body && JSON.stringify(body) }).then(async r => ({ status: r.status, json: await r.json() }));
  try {
    const { json: { people } } = await call("GET", "/api/people");
    assert.deepEqual(people.map(p => p.name), ["Anmol", "Kruti", "Ayaansh"]);
    const a = (await call("POST", "/api/flights", { date: "2026-04-04", from: "BOM", to: "MAD", flight: "LH767" })).json;
    const b = (await call("POST", "/api/flights", { date: "2023-03-16", from: "BOM", to: "HKT", flight: "G821", travellers: ["kruti"] })).json;
    assert.deepEqual(a.travellers, ["me"]);
    assert.equal((await call("POST", "/api/flights", { date: "2023-03-16", from: "BOM", to: "HKT", travellers: ["nobody"] })).status, 400);
    await call("POST", "/api/flights/travellers", { ids: [a.id], add: ["kruti", "ayaansh"] });
    assert.equal((await call("GET", "/api/stats?person=me")).json.flights, 1);
    assert.equal((await call("GET", "/api/stats?person=kruti")).json.flights, 2);
    assert.equal((await call("GET", "/api/stats?person=ayaansh")).json.flights, 1);
    assert.equal((await call("PUT", "/api/people", { people: [{ id: "me", name: "Anmol" }] })).status, 400, "can't drop people who still have flights");
  } finally { srv.close(); }
});
