import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRef, computeStats, computeFlags, buildTrips, fromOpenFlightsCSV, toOpenFlightsCSV, normalize, validate, toDoc } from "../public/lib/core.js";
import { buildApp } from "../server/index.js";
import { createGemini } from "../server/gemini.js";

const ref = createRef(JSON.parse(readFileSync(new URL("../public/data/ref.json", import.meta.url), "utf8")));
const F = (id, date, from, to, flight, extra = {}) => ({ id, ...normalize({ date, from, to, flight, ...extra }, ref) });

// Synthetic sample, not anyone's real history.
const sample = [
  F("a", "2024-03-01", "BOM", "DEL", "6E2114"),
  F("b", "2024-03-03", "DEL", "BOM", "AI865"),
  F("c", "2024-05-10", "BOM", "LHR", "AI131", { seatType: "window" }),
  F("d", "2024-05-20", "LHR", "BOM", "AI130"),
  F("e", "2024-06-01", "IST", "MCT", "TK774"),
  F("f", "2024-06-01", "IST", "MCT", "WY5774"),
  F("g", "2024-07-01", "BOM", "BLR", "6E5221"),
  F("h", "2024-07-02", "BOM", "BLR", "6E5221"),
];

test("stats count flights, distance, airports and countries", () => {
  const s = computeStats(sample, ref);
  assert.equal(s.n, 8);
  assert.equal(s.home, "BOM");
  assert.ok(s.countries.has("GB") && s.countries.has("IN"));
  assert.equal(s.longest.to === "LHR" || s.longest.from === "LHR", true);
  assert.ok(Math.abs(sample.find(f => f.id === "c").distanceKm - 7190) < 60, "BOM-LHR is about 7,190 km");
});

test("review flags codeshares and rebookings", () => {
  const { groups, flags } = computeFlags(sample, "2026-01-01");
  assert.ok(groups.some(g => g.kind === "codeshare"), "codeshare found");
  assert.ok(flags.has("f"));
  assert.ok(groups.some(g => g.kind === "rebooked" && g.suggest === "g"), "rebooking found");
  const after = computeFlags(sample.map(f => (f.id === "f" ? { ...f, status: "cancelled" } : f)), "2026-01-01");
  assert.ok(!after.groups.some(g => g.kind === "codeshare"), "not-flown flights leave the queue");
});

test("trips start and end at home", () => {
  const trips = buildTrips(sample, ref, "BOM", "2026-01-01");
  const uk = trips.find(t => t.codes.includes("LHR"));
  assert.equal(uk.flights.length, 2);
  assert.equal(uk.name, "United Kingdom");
  assert.equal(uk.days, 11);
});

test("OpenFlights CSV round-trips", () => {
  const csv = toOpenFlightsCSV(sample, ref, "2026-01-01");
  const { flights, error } = fromOpenFlightsCSV(csv);
  assert.equal(error, "");
  assert.equal(flights.length, sample.length);
  assert.equal(flights.find(f => f.flight === "AI131").seatType, "window");
});

test("validation rejects unknown airports and bad durations", () => {
  assert.match(validate({ date: "2024-01-01", from: "XXX", to: "DEL" }, ref), /Unknown departure/);
  assert.match(validate({ date: "2024-01-01", from: "BOM", to: "DEL", duration: "2h" }, ref), /Duration/);
  assert.equal(validate({ date: "2024-01-01", from: "BOM", to: "DEL" }, ref), "");
  assert.equal(toDoc({ date: "2099-01-01", from: "BOM", to: "DEL" }, ref).status, "upcoming");
});

test("Gemini client sends the key in a header and parses JSON", async () => {
  let seen;
  const fake = async (url, init) => { seen = { url, init }; return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '[{"date":"2026-11-14","from":"BOM","to":"LHR","flight":"AI131"}]' }] } }] }) }; };
  const g = createGemini({ apiKey: "k", model: "m", fetchImpl: fake });
  const out = await g.extract({ text: "AI 131 Mumbai to London 14 Nov", today: "2026-09-26" });
  assert.equal(out[0].to, "LHR");
  assert.equal(seen.init.headers["x-goog-api-key"], "k");
  assert.ok(!seen.url.includes("key="), "key never goes in the URL");
});

async function withServer(env, fn) {
  const { handler } = buildApp({ WANDER_DB: ":memory:", COOKIE_SECURE: "false", ...env });
  const srv = createServer(handler); await new Promise(r => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try { await fn(base); } finally { srv.close(); }
}

test("API needs a login when a password is set", async () => {
  await withServer({ WANDER_PASSWORD: "pw", WANDER_API_TOKEN: "t".repeat(20) }, async base => {
    assert.equal((await fetch(`${base}/api/flights`)).status, 401);
    assert.equal((await fetch(`${base}/api/login`, { method: "POST", body: JSON.stringify({ password: "no" }) })).status, 401);
    const ok = await fetch(`${base}/api/login`, { method: "POST", body: JSON.stringify({ password: "pw" }) });
    const cookie = ok.headers.get("set-cookie").split(";")[0];
    const r = await fetch(`${base}/api/flights`, { method: "POST", headers: { cookie }, body: JSON.stringify({ date: "2024-01-02", from: "BOM", to: "GOI", flight: "6E 711" }) });
    assert.equal(r.status, 201);
    const bad = await fetch(`${base}/api/flights`, { method: "POST", headers: { cookie }, body: JSON.stringify({ date: "2024-01-02", from: "BOM", to: "ZZZ" }) });
    assert.equal(bad.status, 400);
    const list = await (await fetch(`${base}/api/flights`, { headers: { authorization: `Bearer ${"t".repeat(20)}` } })).json();
    assert.equal(list.flights.length, 1);
  });
});

test("MCP endpoint lists tools and adds flights", async () => {
  const token = "x".repeat(24);
  await withServer({ WANDER_PASSWORD: "pw", WANDER_API_TOKEN: token }, async base => {
    const rpc = (body, auth = true) => fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    assert.equal((await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, false)).status, 401);
    const init = await (await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })).json();
    assert.equal(init.result.serverInfo.name, "wander");
    assert.equal((await rpc({ jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
    const tools = await (await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json();
    assert.ok(tools.result.tools.some(t => t.name === "mark_not_flown"));
    const add = await (await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "add_flight", arguments: { date: "2024-02-02", from: "DEL", to: "BOM", flight: "UK995" } } })).json();
    const id = JSON.parse(add.result.content[0].text).id;
    const cx = await (await rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "mark_not_flown", arguments: { id } } })).json();
    assert.equal(JSON.parse(cx.result.content[0].text).status, "cancelled");
    const bad = await (await rpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "add_flight", arguments: { date: "2024-02-02", from: "DEL", to: "QQQ" } } })).json();
    assert.equal(bad.result.isError, true);
    // path-token form, for clients that can't send headers
    const viaPath = await fetch(`${base}/mcp/${token}`, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 6, method: "ping" }) });
    assert.equal(viaPath.status, 200);
  });
});

test("AI endpoints explain when no key is configured", async () => {
  await withServer({}, async base => {
    const r = await fetch(`${base}/api/ai/ask`, { method: "POST", body: JSON.stringify({ question: "hi" }) });
    assert.equal(r.status, 503);
    assert.match((await r.json()).error, /GEMINI_API_KEY/);
  });
});

test("Gemini client switches to a current model when the configured one is gone", async () => {
  const calls = [];
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
  const fake = async url => {
    calls.push(url);
    if (url.includes("/models?")) return reply(200, { models: [
      { name: "models/gemini-3.0-flash", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-3.0-flash-lite", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-3.0-pro-preview", supportedGenerationMethods: ["generateContent"] },
      { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
    ] });
    if (url.includes("gemini-2.5-flash")) return reply(404, { error: { message: "models/gemini-2.5-flash is not found for API version v1beta" } });
    return reply(200, { candidates: [{ content: { parts: [{ text: '{"flights":[{"date":"2026-01-01","from":"BOM","to":"DEL"}]}' }] } }] });
  };
  const g = createGemini({ apiKey: "k", model: "gemini-2.5-flash", fetchImpl: fake });
  const out = await g.extract({ text: "x", today: "2026-01-01" });
  assert.equal(out.length, 1, "wrapped array is unwrapped");
  assert.equal(g.model, "gemini-3.0-flash");
  assert.ok(calls.at(-1).includes("gemini-3.0-flash:generateContent"));
});

test("Gemini client explains blocked answers and bad keys", async () => {
  const blocked = createGemini({ apiKey: "k", model: "m", fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ promptFeedback: { blockReason: "SAFETY" } }) }) });
  await assert.rejects(blocked.ask({ question: "q", table: "", summary: "", today: "2026-01-01" }), /no answer \(SAFETY\)/);
  const badKey = createGemini({ apiKey: "k", model: "m", fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: { message: "API key not valid. Please pass a valid API key." } }) }) });
  await assert.rejects(badKey.ask({ question: "q", table: "", summary: "", today: "2026-01-01" }), /rejected the API key/);
});
