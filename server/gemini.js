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

/** Flash-Lite models, newest first: a last resort with its own (larger) free-tier quota, and it reads images too. */
const liteModels = names => names.filter(n => /^gemini-\d+(\.\d+)?-flash-lite/.test(n) && !/(preview|exp|tts|image|audio|live)/.test(n))
  .sort((a, b) => parseFloat(b.slice(7)) - parseFloat(a.slice(7)) || a.length - b.length);
/** A 429 for a used-up daily allowance (free tier: "requests per day"), as opposed to a per-minute burst. */
export const isDailyQuota = msg => /per ?day|PerDay|_per_day/i.test(msg);
/** "Please retry in 20h46m17.5s" -> milliseconds (default: an hour). */
export function retryAfterMs(msg) {
  const m = String(msg).match(/retry in\s*(?:(\d+)h)?\s*(?:(\d+)m(?!s))?\s*(?:([\d.]+)s)?/i);
  const ms = m ? ((+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (parseFloat(m[3]) || 0)) * 1000 : 0;
  return ms > 0 ? ms : 3600_000;
}
const inHours = ms => (ms >= 3600_000 ? `about ${Math.round(ms / 3600_000)} h` : `about ${Math.max(1, Math.round(ms / 60_000))} min`);

export function createGemini({ apiKey, model, smartModel, fetchImpl = fetch }) {
  if (!apiKey) return null;
  const chosen = { fast: model, smart: smartModel || model };
  // Free-tier daily allowances are per model. A model that has used its allowance is skipped until it resets,
  // and the model that stood in for it is used directly, so no request is wasted on a known "no".
  const spent = new Map(), standIn = new Map();
  const isSpent = m => (spent.get(m) || 0) > Date.now();
  const live = m => (isSpent(m) && standIn.has(m) && !isSpent(standIn.get(m)) ? standIn.get(m) : m);
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

  async function generate({ parts, json = true, useSmart = false, temperature = 0.3, system, budgetMs = BUDGET_MS, quick = false }) {
    const slot = useSmart ? "smart" : "fast";
    const body = {
      contents: [{ role: "user", parts }],
      // quick: copying text off an image needs little reasoning, and thinking is most of the wait on Flash models.
      generationConfig: { temperature, ...(json ? { responseMimeType: "application/json" } : {}), ...(quick ? { thinkingConfig: { thinkingBudget: 512 } } : {}) },
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    };
    const deadline = Date.now() + budgetMs;
    let used = live(chosen[slot]);
    let { res, data } = await post(used, body, deadline);
    // A model that doesn't take a thinking budget says so with a 400: ask again without one.
    if (quick && res.status === 400 && /thinking/i.test(data?.error?.message || "")) {
      delete body.generationConfig.thinkingConfig;
      ({ res, data } = await post(used, body, deadline));
    }
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
    // A used-up daily allowance (free tier): try other Flash models, then Flash-Lite, each with its own allowance.
    if (res.status === 429 && isDailyQuota(data?.error?.message || "")) {
      const first = chosen[slot];
      spent.set(used, Date.now() + retryAfterMs(data?.error?.message || ""));
      const names = await listModels(deadline).catch(() => []);
      const alts = [...rankModels(names, "flash"), ...liteModels(names)].filter((n, i, a) => a.indexOf(n) === i && !isSpent(n) && n !== used).slice(0, 3);
      for (const alt of alts) {
        const r = await post(alt, body, deadline);
        ({ res, data } = r); used = alt;
        if (res.ok) { standIn.set(first, alt); console.warn(`Gemini model "${first}" has used its daily free quota; using "${alt}" until it resets.`); break; }
        if (res.status === 429 && isDailyQuota(data?.error?.message || "")) { spent.set(alt, Date.now() + retryAfterMs(data?.error?.message || "")); continue; }
        break;
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
      if (res.status === 429 && isDailyQuota(m)) {
        const wait = Math.min(...[...spent.values()].filter(t => t > Date.now()).map(t => t - Date.now()), retryAfterMs(m));
        throw fail(`Your Gemini key's free daily allowance is used up (tried ${[...spent.keys()].filter(isSpent).join(", ") || used}). It resets in ${inHours(wait)}. To keep going now: turn on billing for the key's Google project (aistudio.google.com → Get API key → set up billing), or switch to another provider in ⚙ AI. You can also type the details in by hand.`, 429);
      }
      if (res.status === 429) throw fail(`Gemini rate limit reached: ${m.split(/\n|\* /)[0].slice(0, 160)} Wait a minute and try again.`, 429);
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
