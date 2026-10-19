import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createSearch } from "../server/search.js";
import { buildApp } from "../server/index.js";
import { legLinks } from "../public/lib/rail.js";

const json = body => ({ ok: true, status: 200, json: async () => body });

test("SearXNG client: JSON request, deduped and trimmed results, clear errors", async () => {
  let seen;
  const s = createSearch({ url: "http://searxng:8080/", fetchImpl: async u => { seen = u; return json({ answers: [{ answer: "On time" }], results: [
    { title: "12951 Live Status", url: "https://example.org/12951", content: "Running  25 min late,\\n last at RTM", publishedDate: "2026-10-19T07:00:00" },
    { title: "dup", url: "https://example.org/12951" }, { title: "bad", url: "javascript:alert(1)" }, { title: "NTES", url: "https://enquiry.indianrail.gov.in/x" }] }); } });
  const r = await s.search("12951 train live running status");
  assert.match(seen, /^http:\/\/searxng:8080\/search\?q=12951\+train/); assert.match(seen, /format=json/);
  assert.equal(r.results.length, 2);
  assert.deepEqual([r.results[0].site, r.results[0].snippet, r.results[1].site], ["example.org", "Running 25 min late,\\n last at RTM".replace(/\s+/g, " "), "enquiry.indianrail.gov.in"]);
  assert.deepEqual(r.answers, ["On time"]);
  const forbidden = createSearch({ url: "http://x", fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}) }) });
  await assert.rejects(forbidden.search("q"), /search\.formats/);
  const html = createSearch({ url: "http://x", fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error("not json"); } }) });
  await assert.rejects(html.search("q"), /JSON/);
  assert.equal(createSearch({ url: "" }), null);
  assert.equal(createSearch({ url: "ftp://x" }), null);
});

test("search links carry their words, never the PNR", () => {
  const t = legLinks({ mode: "train", flight: "12951", pnr: "2412345678", rail: { fromStn: "BCT" } });
  const qs = t.filter(l => l.q).map(l => l.q);
  assert.deepEqual(t.filter(l => l.q).map(l => l.label), ["Live running status", "Platform", "Coach position", "Timetable"]);
  assert.ok(qs.every(q => !q.includes("2412345678")));
  assert.ok(legLinks({ mode: "air", flight: "AI131", date: "2026-11-14" }).every(l => l.q && /AI 131/.test(l.q)));
});

test("search over the API: owner-only settings, feature flag, results", async () => {
  const searx = createServer((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ results: [{ title: "Hit", url: "https://example.org/a", content: "snippet" }], answers: [] })); });
  await new Promise(r => searx.listen(0, r));
  const searxUrl = `http://127.0.0.1:${searx.address().port}`;
  const token = "s".repeat(24);
  const { handler } = buildApp({ WANDER_DB: ":memory:", COOKIE_SECURE: "false", WANDER_PASSWORD: "pw", WANDER_API_TOKEN: token });
  const srv = createServer(handler); await new Promise(r => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const cookie = (await fetch(`${base}/api/login`, { method: "POST", body: JSON.stringify({ password: "pw" }) })).headers.get("set-cookie").split(";")[0];
    const call = (method, path, body, headers = { cookie }) => fetch(base + path, { method, headers, body: body && JSON.stringify(body) }).then(async r => ({ status: r.status, json: await r.json() }));
    assert.equal((await call("GET", "/api/me")).json.features.search, false);
    assert.equal((await call("GET", "/api/search?q=x")).status, 503, "off until configured");
    assert.equal((await call("PUT", "/api/search/settings", { url: searxUrl }, { authorization: `Bearer ${token}` })).status, 401, "agents can't change it");
    assert.equal((await call("PUT", "/api/search/settings", { url: "file:///etc/passwd" })).status, 400);
    assert.equal((await call("POST", "/api/search/test", { url: searxUrl })).json.results[0].title, "Hit");
    assert.equal((await call("PUT", "/api/search/settings", { url: searxUrl })).json.source, "settings");
    assert.equal((await call("GET", "/api/me")).json.features.search, true);
    const r = (await call("GET", "/api/search?q=12951%20running%20status")).json;
    assert.equal(r.results[0].site, "example.org");
    assert.equal((await call("POST", "/api/ai/digest", { question: "q", results: r.results })).status, 503, "the summary needs an AI key");
  } finally { srv.close(); searx.close(); }
});

test("the AI summary reads only the snippets it is given", async () => {
  const { createAI } = await import("../server/ai.js");
  let prompt;
  const ai = createAI({ provider: "gemini", apiKey: "k", model: "m", fetchImpl: async (u, init) => { prompt = JSON.parse(init.body); return json({ candidates: [{ content: { parts: [{ text: "Running 25 min late near Ratlam [example.org]." }] } }] }); } });
  const out = await ai.digest({ question: "Live running status · Train 12951", results: [{ site: "example.org", title: "12951", snippet: "Running 25 min late, last at RTM" }], now: "2026-10-19T07:00:00Z" });
  assert.match(out, /25 min late/);
  assert.match(prompt.contents[0].parts[0].text, /\[example\.org\] 12951\nRunning 25 min late/);
  assert.match(prompt.systemInstruction.parts[0].text, /only what the snippets say/);
});
