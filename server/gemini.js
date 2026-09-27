// Thin Gemini REST client. The prompts behind Wander's AI features live in ai-common.js.
import { BUDGET_MS, fail, sleep, requestWithin, parseJSON, withPrompts } from "./ai-common.js";
export { asArray } from "./ai-common.js";

const API = "https://generativelanguage.googleapis.com/v1beta";
/** Google answers 503/500 ("high demand", "overloaded") when a model is busy; that passes, so retry or switch model. */
const isBusy = (status, msg) => status === 503 || status === 500 || /high demand|overloaded|temporarily unavailable/i.test(msg);

/** Text models of a family ("flash" or "pro") from a ListModels response, newest stable first. */
export function rankModels(names, family) {
  const version = n => parseFloat((n.match(/^gemini-(\d+(?:\.\d+)?)/) || [])[1] || 0);
  const ok = names.filter(n => n.startsWith("gemini-") && n.includes(`-${family}`)
    && !/(lite|tts|image|audio|live|embedding|vision|thinking|computer|robotics|omni|transcribe|8b)/.test(n));
  return ok.sort((a, b) => version(b) - version(a) || Number(/preview|exp/.test(a)) - Number(/preview|exp/.test(b)) || a.length - b.length);
}
/** Picks the newest stable Gemini model of a family. */
export const pickModel = (names, family) => rankModels(names, family)[0] || null;

export function createGemini({ apiKey, model, smartModel, fetchImpl = fetch }) {
  if (!apiKey) return null;
  const chosen = { fast: model, smart: smartModel || model };
  const headers = { "content-type": "application/json", "x-goog-api-key": apiKey };

  const request = (url, init, deadline) => requestWithin(fetchImpl, "Gemini", url, init, deadline);

  async function listModels(deadline) {
    const res = await request(`${API}/models?pageSize=1000`, { headers }, deadline);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw fail(`Gemini rejected the API key: ${data?.error?.message || `HTTP ${res.status}`}`, 502);
    return (data.models || []).filter(m => (m.supportedGenerationMethods || []).includes("generateContent")).map(m => m.name.replace(/^models\//, ""));
  }

  async function post(m, body, deadline) {
    const res = await request(`${API}/models/${encodeURIComponent(m)}:generateContent`, { method: "POST", headers, body: JSON.stringify(body) }, deadline);
    return { res, data: await res.json().catch(() => ({})) };
  }

  async function generate({ parts, json = true, useSmart = false, temperature = 0.3, system }) {
    const slot = useSmart ? "smart" : "fast";
    const body = {
      contents: [{ role: "user", parts }],
      generationConfig: { temperature, ...(json ? { responseMimeType: "application/json" } : {}) },
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    };
    const deadline = Date.now() + BUDGET_MS;
    let used = chosen[slot];
    let { res, data } = await post(used, body, deadline);
    const msg = data?.error?.message || "";
    // The configured model may have been renamed or retired: find the current one and retry once.
    if (res.status === 404 || (res.status === 400 && /not (found|supported)|unknown model|is not available/i.test(msg))) {
      const names = await listModels(deadline);
      const alt = pickModel(names, useSmart ? "pro" : "flash") || pickModel(names, "flash");
      if (alt && alt !== chosen[slot]) {
        console.warn(`Gemini model "${chosen[slot]}" is unavailable (${msg || res.status}); using "${alt}". Set GEMINI_MODEL${useSmart ? "_SMART" : ""}=${alt} to silence this.`);
        chosen[slot] = used = alt;
        ({ res, data } = await post(alt, body, deadline));
      }
    }
    // A busy model: one short retry, then the next Flash models that are up. The configured model stays the default.
    if (!res.ok && isBusy(res.status, data?.error?.message || "")) {
      await sleep(1500);
      ({ res, data } = await post(used, body, deadline));
      if (!res.ok && isBusy(res.status, data?.error?.message || "")) {
        const alts = rankModels(await listModels(deadline), "flash").filter(n => n !== used).slice(0, 3);
        for (const alt of alts) {
          const r = await post(alt, body, deadline);
          if (r.res.ok) console.warn(`Gemini model "${used}" is busy; answered with "${alt}".`);
          ({ res, data } = r); used = alt;
          if (res.ok || !isBusy(res.status, data?.error?.message || "")) break;
        }
      }
    }
    // Pro models have no free-tier quota ("limit: 0"): use the fast model for smart tasks instead.
    if (res.status === 429 && useSmart && chosen.smart !== chosen.fast && /limit: 0\b/.test(data?.error?.message || "")) {
      console.warn(`Gemini model "${chosen.smart}" has no quota on this key (billing not enabled); using "${chosen.fast}" for questions and recaps.`);
      chosen.smart = used = chosen.fast;
      ({ res, data } = await post(chosen.fast, body, deadline));
    }
    if (!res.ok) {
      const m = data?.error?.message || `HTTP ${res.status}`;
      if (res.status === 429) throw fail(`Gemini rate limit or quota reached: ${m}`, 429);
      if ((res.status === 400 && /api key/i.test(m)) || res.status === 403) throw fail(`Gemini rejected the API key: ${m}`, 502);
      if (isBusy(res.status, m)) throw fail(`Gemini is overloaded right now (tried ${used} and other Flash models). Try again in a minute.`);
      throw fail(`Gemini error (${used}): ${m}`);
    }
    const cand = data.candidates?.[0];
    const text = (cand?.content?.parts || []).filter(p => !p.thought).map(p => p.text || "").join("").trim();
    if (!text) {
      const why = data.promptFeedback?.blockReason || cand?.finishReason || "no content";
      throw fail(`Gemini returned no answer (${why}). Try rephrasing, or a smaller image.`);
    }
    if (!json) return text;
    return parseJSON(text, "Gemini");
  }

  return withPrompts({
    provider: "gemini", label: "Gemini",
    get model() { return chosen.fast; },
    get smartModel() { return chosen.smart; },
    generate, listModels: () => listModels(),
  });
}
