// OpenAI (and OpenAI-compatible servers such as OpenRouter, Groq or Ollama) and Anthropic, as provider cores
// for ai-common.js. Plain fetch, no SDKs: Wander has no npm dependencies.
import { BUDGET_MS, fail, sleep, requestWithin, parseJSON, withPrompts } from "./ai-common.js";

const JSON_ONLY = "Reply with JSON only: no prose, no code fences.";
const retryable = status => status === 500 || status === 502 || status === 503 || status === 529;
const needModel = label => fail(`Choose a model for ${label} in AI settings.`, 400);

/* ---------------- OpenAI and compatible ---------------- */
export function createOpenAI({ apiKey, model, smartModel, baseUrl, fetchImpl = fetch }) {
  if (!apiKey && !baseUrl) return null; // a local server (Ollama) may need no key; api.openai.com always does
  const base = String(baseUrl || "https://api.openai.com/v1").trim().replace(/\/+$/, "");
  const label = /api\.openai\.com/.test(base) ? "OpenAI" : "The AI server";
  const chosen = { fast: model, smart: smartModel || model };
  const headers = { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) };
  const request = (url, init, deadline) => requestWithin(fetchImpl, label, url, init, deadline);

  async function listModels(deadline) {
    const res = await request(`${base}/models`, { headers }, deadline);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw fail(`${label} rejected the API key: ${data?.error?.message || `HTTP ${res.status}`}`, 502);
    return (data.data || []).map(m => m.id).filter(id => !/(embed|whisper|tts|dall-e|moderation|transcribe|realtime|audio|image|search)/i.test(id)).sort();
  }

  const toContent = parts => {
    const out = parts.map(p => p.inlineData ? { type: "image_url", image_url: { url: `data:${p.inlineData.mimeType};base64,${p.inlineData.data}` } } : { type: "text", text: p.text });
    return out.length === 1 && out[0].type === "text" ? out[0].text : out;
  };

  async function generate({ parts, json = true, useSmart = false, temperature = 0.3, system }) {
    const m = chosen[useSmart ? "smart" : "fast"]; if (!m) throw needModel(label);
    const deadline = Date.now() + BUDGET_MS;
    const body = {
      model: m,
      messages: [...(system || json ? [{ role: "system", content: [system, json ? JSON_ONLY : ""].filter(Boolean).join("\n") }] : []), { role: "user", content: toContent(parts) }],
      temperature, ...(json ? { response_format: { type: "json_object" } } : {}),
    };
    const post = async () => { const res = await request(`${base}/chat/completions`, { method: "POST", headers, body: JSON.stringify(body) }, deadline); return { res, data: await res.json().catch(() => ({})) }; };
    let { res, data } = await post();
    // Some models only take their default temperature, and some servers don't do JSON mode: drop what's refused, once each.
    for (let i = 0; i < 2 && res.status === 400; i++) {
      const msg = data?.error?.message || "";
      if (/temperature/i.test(msg) && "temperature" in body) delete body.temperature;
      else if (/response_format|json_object/i.test(msg) && body.response_format) delete body.response_format;
      else break;
      ({ res, data } = await post());
    }
    if (!res.ok && retryable(res.status)) { await sleep(1500); ({ res, data } = await post()); }
    if (!res.ok) {
      const msg = data?.error?.message || `HTTP ${res.status}`;
      if (res.status === 401 || res.status === 403) throw fail(`${label} rejected the API key: ${msg}`, 502);
      if (res.status === 429) throw fail(`${label} rate limit or quota reached: ${msg}`, 429);
      if (res.status === 404) throw fail(`${label} doesn't know the model "${m}". Pick another in AI settings.`, 502);
      throw fail(`${label} error (${m}): ${msg}`);
    }
    const c = data.choices?.[0]?.message?.content;
    const text = (Array.isArray(c) ? c.map(x => x.text || "").join("") : c || "").trim();
    if (!text) throw fail(`${label} returned no answer (${data.choices?.[0]?.finish_reason || "no content"}). Try again.`);
    return json ? parseJSON(text, label) : text;
  }

  return withPrompts({ provider: "openai", label, get model() { return chosen.fast; }, get smartModel() { return chosen.smart; }, generate, listModels: () => listModels() });
}

/* ---------------- Anthropic ---------------- */
const ANTHROPIC = "https://api.anthropic.com/v1";
export function createAnthropic({ apiKey, model, smartModel, fetchImpl = fetch }) {
  if (!apiKey) return null;
  const chosen = { fast: model || "claude-opus-5", smart: smartModel || model || "claude-opus-5" };
  const headers = { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
  const request = (url, init, deadline) => requestWithin(fetchImpl, "Claude", url, init, deadline);

  async function listModels(deadline) {
    const res = await request(`${ANTHROPIC}/models?limit=1000`, { headers }, deadline);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw fail(`Anthropic rejected the API key: ${data?.error?.message || `HTTP ${res.status}`}`, 502);
    return (data.data || []).map(m => m.id);
  }

  // temperature is not sent: current Claude models reject sampling parameters.
  async function generate({ parts, json = true, useSmart = false, system }) {
    const m = chosen[useSmart ? "smart" : "fast"];
    const deadline = Date.now() + BUDGET_MS;
    const content = [
      ...parts.filter(p => p.inlineData).map(p => ({ type: "image", source: { type: "base64", media_type: p.inlineData.mimeType, data: p.inlineData.data } })),
      ...parts.filter(p => !p.inlineData).map(p => ({ type: "text", text: p.text })),
    ];
    const sys = [system, json ? JSON_ONLY : ""].filter(Boolean).join("\n");
    // Opus 5 and Fable models can decline a request on safety grounds; let the API retry those on a fallback model.
    const fallback = /^claude-(opus-5|fable-5)/.test(m);
    const body = { model: m, max_tokens: 16000, ...(sys ? { system: sys } : {}), messages: [{ role: "user", content }], ...(fallback ? { fallbacks: "default" } : {}) };
    const h = fallback ? { ...headers, "anthropic-beta": "server-side-fallback-2026-07-01" } : headers;
    const post = async () => { const res = await request(`${ANTHROPIC}/messages`, { method: "POST", headers: h, body: JSON.stringify(body) }, deadline); return { res, data: await res.json().catch(() => ({})) }; };
    let { res, data } = await post();
    if (!res.ok && retryable(res.status)) { await sleep(1500); ({ res, data } = await post()); }
    if (!res.ok) {
      const msg = data?.error?.message || `HTTP ${res.status}`;
      if (res.status === 401 || res.status === 403) throw fail(`Anthropic rejected the API key: ${msg}`, 502);
      if (res.status === 429) throw fail(`Claude rate limit reached: ${msg}`, 429);
      if (res.status === 404) throw fail(`Anthropic doesn't know the model "${m}". Pick another in AI settings.`, 502);
      if (retryable(res.status)) throw fail(`Claude is overloaded right now. Try again in a minute.`);
      throw fail(`Claude error (${m}): ${msg}`);
    }
    if (data.stop_reason === "refusal") throw fail("Claude declined this request. Try rephrasing it.", 422);
    const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
    if (!text) throw fail(`Claude returned no answer (${data.stop_reason || "no content"}). Try again.`);
    return json ? parseJSON(text, "Claude") : text;
  }

  return withPrompts({ provider: "anthropic", label: "Claude", get model() { return chosen.fast; }, get smartModel() { return chosen.smart; }, generate, listModels: () => listModels() });
}
