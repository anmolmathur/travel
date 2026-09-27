import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { buildApp } from "../server/index.js";
import { createAI } from "../server/ai.js";

const ok = body => ({ ok: true, status: 200, json: async () => body });
const err = (status, message) => ({ ok: false, status, json: async () => ({ error: { message } }) });

test("OpenAI-compatible: sends the key as a bearer token, retries without an unsupported temperature, parses JSON", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body); calls.push({ url, body, auth: init.headers.authorization });
    if ("temperature" in body) return err(400, "Unsupported value: 'temperature' does not support 0.1 with this model.");
    return ok({ choices: [{ message: { content: '{"flights":[{"date":"2026-10-10","from":"BOM","to":"BLR","flight":"IX5986"}]}' } }] });
  };
  const ai = createAI({ provider: "openai", apiKey: "sk-test", model: "gpt-x", fetchImpl });
  const rows = await ai.extract({ text: "IX 5986 BOM-BLR 10 Oct", today: "2026-09-27" });
  assert.equal(rows[0].to, "BLR");
  assert.equal(calls[0].url, "https://api.openai.com/v1/chat/completions");
  assert.equal(calls[0].auth, "Bearer sk-test");
  assert.equal(calls.length, 2); assert.ok(!("temperature" in calls[1].body));
  assert.equal(calls[0].body.response_format.type, "json_object");
  assert.equal(createAI({ provider: "openai", model: "gpt-x" }), null, "api.openai.com needs a key");
  assert.ok(createAI({ provider: "openai", model: "llama3", baseUrl: "http://localhost:11434/v1" }), "a local server may not");
});

test("Anthropic: x-api-key and version headers, image before text, no temperature, text blocks only", async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init, body: JSON.parse(init.body) }; return ok({ stop_reason: "end_turn", content: [{ type: "thinking", thinking: "" }, { type: "text", text: "You flew 12 times." }] }); };
  const ai = createAI({ provider: "anthropic", apiKey: "sk-ant-test", model: "claude-haiku-4-5", fetchImpl });
  assert.equal(await ai.ask({ question: "q", table: "", summary: "", today: "2026-09-27" }), "You flew 12 times.");
  assert.equal(seen.url, "https://api.anthropic.com/v1/messages");
  assert.equal(seen.init.headers["x-api-key"], "sk-ant-test");
  assert.equal(seen.init.headers["anthropic-version"], "2023-06-01");
  assert.ok(!("temperature" in seen.body));
  await ai.extract({ text: "x", image: { mimeType: "image/png", data: "AAAA" }, today: "2026-09-27" }).catch(() => {});
  assert.equal(seen.body.messages[0].content[0].type, "image");
  assert.match(seen.body.system, /JSON only/);
  const refuses = createAI({ provider: "anthropic", apiKey: "k", model: "claude-opus-5", fetchImpl: async (u, init) => { seen = { init, body: JSON.parse(init.body) }; return ok({ stop_reason: "refusal", content: [] }); } });
  await assert.rejects(refuses.ask({ question: "q", table: "", summary: "", today: "2026-09-27" }), /declined/);
  assert.equal(seen.body.fallbacks, "default", "Opus 5 gets server-side fallbacks");
  assert.equal(seen.init.headers["anthropic-beta"], "server-side-fallback-2026-07-01");
});

async function withServer(env, fn) {
  const { handler } = buildApp({ WANDER_DB: ":memory:", COOKIE_SECURE: "false", ...env });
  const srv = createServer(handler); await new Promise(r => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try { await fn(base); } finally { srv.close(); }
}

test("AI settings: owner only, the key never comes back, blank keeps it, reset returns to .env", async () => {
  const token = "t".repeat(24);
  await withServer({ WANDER_PASSWORD: "pw", WANDER_API_TOKEN: token, GEMINI_API_KEY: "AIza-env-key-1234" }, async base => {
    const login = await fetch(`${base}/api/login`, { method: "POST", body: JSON.stringify({ password: "pw" }) });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const call = (method, path, body, headers = { cookie }) => fetch(base + path, { method, headers, body: body && JSON.stringify(body) }).then(async r => ({ status: r.status, json: await r.json() }));
    assert.equal((await call("GET", "/api/ai/settings", undefined, { authorization: `Bearer ${token}` })).status, 401, "agents can't read AI settings");
    let s = (await call("GET", "/api/ai/settings")).json;
    assert.deepEqual([s.provider, s.source, s.keySet, s.keyFromEnv, s.keyHint], ["gemini", "env", true, true, "…1234"]);
    assert.ok(!JSON.stringify(s).includes("AIza-env-key"), "the .env key never reaches the browser");

    s = (await call("PUT", "/api/ai/settings", { provider: "anthropic", apiKey: "sk-ant-secret-9876", model: "claude-opus-5" })).json;
    assert.deepEqual([s.provider, s.source, s.keyHint, s.keyFromEnv], ["anthropic", "settings", "…9876", false]);
    assert.ok(!JSON.stringify(s).includes("secret"));
    s = (await call("PUT", "/api/ai/settings", { provider: "anthropic", apiKey: "", model: "claude-sonnet-5" })).json;
    assert.deepEqual([s.keyHint, s.model], ["…9876", "claude-sonnet-5"], "a blank key keeps the saved one");
    assert.equal((await call("GET", "/api/me")).json.features.ai, true);

    s = (await call("PUT", "/api/ai/settings", { provider: "gemini", model: "gemini-3.7-flash" })).json;
    assert.deepEqual([s.provider, s.keyFromEnv, s.model], ["gemini", true, "gemini-3.7-flash"], "switching back to Gemini borrows the .env key");
    assert.equal((await call("PUT", "/api/ai/settings", { provider: "openai" })).status, 400, "OpenAI needs a model");
    assert.equal((await call("PUT", "/api/ai/settings", { provider: "nope" })).status, 400);
    assert.equal((await call("PUT", "/api/ai/settings", { provider: "openai", model: "m", baseUrl: "file:///etc" })).status, 400);
    s = (await call("PUT", "/api/ai/settings", { reset: true })).json;
    assert.deepEqual([s.source, s.model], ["env", "gemini-flash-latest"]);
  });
});

test("AI features switch on from settings without any server key", async () => {
  await withServer({}, async base => {
    const me = async () => (await (await fetch(`${base}/api/me`)).json()).features.ai;
    assert.equal(await me(), false);
    const r = await fetch(`${base}/api/ai/ask`, { method: "POST", body: JSON.stringify({ question: "hi" }) });
    assert.match((await r.json()).error, /AI settings/);
    await fetch(`${base}/api/ai/settings`, { method: "PUT", body: JSON.stringify({ provider: "openai", apiKey: "sk-x", model: "gpt-x" }) });
    assert.equal(await me(), true);
    await fetch(`${base}/api/ai/settings`, { method: "PUT", body: JSON.stringify({ provider: "openai", model: "gpt-x", clearKey: true }) });
    assert.equal(await me(), false, "clearing the key turns AI off again");
  });
});
