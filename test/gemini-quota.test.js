import { test } from "node:test";
import assert from "node:assert/strict";
import { createGemini, isDailyQuota, retryAfterMs } from "../server/gemini.js";

// The error Google returned on the owner's key (free tier, 20 requests a day).
const DAILY = "You exceeded your current quota, please check your plan and billing details. * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: gemini-3.8-flash, description: Generate content requests per day limit exceeded on Free Tier. Please retry in 20h46m17.506543518s.";
const MINUTE = "Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 10, description: Generate content requests per minute. Please retry in 37s.";

function fakeGoogle(answers) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    if (url.includes("/models?")) return { ok: true, status: 200, json: async () => ({ models: ["gemini-3.8-flash", "gemini-3.5-flash", "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-3.8-pro"].map(n => ({ name: `models/${n}`, supportedGenerationMethods: ["generateContent"] })) }) };
    const model = decodeURIComponent(url.match(/models\/([^:]+):/)[1]); calls.push(model);
    const a = answers[model] || "ok";
    if (a === "ok") return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: `{"by":"${model}"}` }] } }] }) };
    return { ok: false, status: 429, json: async () => ({ error: { message: a } }) };
  };
  return { calls, fetchImpl };
}

test("reads the reset time and tells a daily allowance from a per-minute burst", () => {
  assert.ok(isDailyQuota(DAILY)); assert.ok(!isDailyQuota(MINUTE));
  assert.equal(Math.round(retryAfterMs(DAILY) / 60000), 1246);
  assert.equal(retryAfterMs(MINUTE), 37000);
});

test("a used-up daily allowance moves to the next Flash model, and stays there until it resets", async () => {
  const g = fakeGoogle({ "gemini-3.8-flash": DAILY });
  const ai = createGemini({ apiKey: "k", model: "gemini-3.8-flash", fetchImpl: g.fetchImpl });
  const gen = () => ai.visa({ image: { mimeType: "image/jpeg", data: "AAAA" }, today: "2026-11-10" });
  assert.deepEqual(await gen(), { by: "gemini-3.5-flash" });
  assert.deepEqual(await gen(), { by: "gemini-3.5-flash" });
  assert.deepEqual(g.calls, ["gemini-3.8-flash", "gemini-3.5-flash", "gemini-3.5-flash"], "the spent model isn't asked again");
});

test("when every model's allowance is gone, the message says when it resets and what to do", async () => {
  const all = Object.fromEntries(["gemini-3.8-flash", "gemini-3.5-flash", "gemini-2.5-flash", "gemini-2.5-flash-lite"].map(n => [n, DAILY]));
  const g = fakeGoogle(all);
  const ai = createGemini({ apiKey: "k", model: "gemini-3.8-flash", fetchImpl: g.fetchImpl });
  await assert.rejects(ai.visa({ image: { mimeType: "image/jpeg", data: "AAAA" }, today: "2026-11-10" }), e => {
    assert.equal(e.status, 429);
    assert.match(e.message, /free daily allowance is used up/); assert.match(e.message, /resets in about 21 h/); assert.match(e.message, /billing|another provider/);
    return true;
  });
  assert.equal(g.calls.length, 4, "the configured model plus at most three others");
});

test("a per-minute burst is not treated as a used-up day", async () => {
  const g = fakeGoogle({ "gemini-3.8-flash": MINUTE });
  const ai = createGemini({ apiKey: "k", model: "gemini-3.8-flash", fetchImpl: g.fetchImpl });
  await assert.rejects(ai.visa({ image: { mimeType: "image/jpeg", data: "AAAA" }, today: "2026-11-10" }), /rate limit reached.*Wait a minute/s);
  assert.deepEqual(g.calls, ["gemini-3.8-flash"]);
});
