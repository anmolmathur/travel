// Thin Gemini REST client plus the prompts behind Wander's AI features.
// The key never leaves the server.

const API = "https://generativelanguage.googleapis.com/v1beta";
const TIMEOUT_MS = 85_000; // stay under Cloudflare's 100-second limit

const fail = (message, status = 502) => Object.assign(new Error(message), { status });
/** Models sometimes wrap a requested array in an object ({"flights": [...]}); unwrap it. */
export const asArray = out => Array.isArray(out) ? out : out && typeof out === "object" ? (Object.values(out).find(Array.isArray) || []) : [];

/** Picks the newest stable Gemini model of a family ("flash" or "pro") from a ListModels response. */
export function pickModel(names, family) {
  const version = n => parseFloat((n.match(/^gemini-(\d+(?:\.\d+)?)/) || [])[1] || 0);
  const ok = names.filter(n => n.startsWith("gemini-") && n.includes(`-${family}`)
    && !/(lite|tts|image|audio|live|embedding|vision|thinking|computer|robotics|8b)/.test(n));
  ok.sort((a, b) => version(b) - version(a) || Number(/preview|exp/.test(a)) - Number(/preview|exp/.test(b)) || a.length - b.length);
  return ok[0] || null;
}

export function createGemini({ apiKey, model, smartModel, fetchImpl = fetch }) {
  if (!apiKey) return null;
  const chosen = { fast: model, smart: smartModel || model };
  const headers = { "content-type": "application/json", "x-goog-api-key": apiKey };

  async function request(url, init) {
    try { return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) }); }
    catch (e) {
      if (e?.name === "TimeoutError" || e?.name === "AbortError") throw fail("Gemini took too long to answer. Try again, or set GEMINI_MODEL_SMART to a faster model.", 504);
      throw fail(`Couldn't reach Gemini (${e?.cause?.code || e?.message || "network error"}).`);
    }
  }

  async function listModels() {
    const res = await request(`${API}/models?pageSize=1000`, { headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw fail(`Gemini rejected the API key: ${data?.error?.message || `HTTP ${res.status}`}`);
    return (data.models || []).filter(m => (m.supportedGenerationMethods || []).includes("generateContent")).map(m => m.name.replace(/^models\//, ""));
  }

  async function post(m, body) {
    const res = await request(`${API}/models/${encodeURIComponent(m)}:generateContent`, { method: "POST", headers, body: JSON.stringify(body) });
    return { res, data: await res.json().catch(() => ({})) };
  }

  async function generate({ parts, json = true, useSmart = false, temperature = 0.3, system }) {
    const slot = useSmart ? "smart" : "fast";
    const body = {
      contents: [{ role: "user", parts }],
      generationConfig: { temperature, ...(json ? { responseMimeType: "application/json" } : {}) },
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    };
    let { res, data } = await post(chosen[slot], body);
    const msg = data?.error?.message || "";
    // The configured model may have been renamed or retired: find the current one and retry once.
    if (res.status === 404 || (res.status === 400 && /not (found|supported)|unknown model|is not available/i.test(msg))) {
      const names = await listModels();
      const alt = pickModel(names, useSmart ? "pro" : "flash") || pickModel(names, "flash");
      if (alt && alt !== chosen[slot]) {
        console.warn(`Gemini model "${chosen[slot]}" is unavailable (${msg || res.status}); using "${alt}". Set GEMINI_MODEL${useSmart ? "_SMART" : ""}=${alt} to silence this.`);
        chosen[slot] = alt;
        ({ res, data } = await post(alt, body));
      }
    }
    // Pro models have no free-tier quota ("limit: 0"): use the fast model for smart tasks instead.
    if (res.status === 429 && useSmart && chosen.smart !== chosen.fast && /limit: 0\b/.test(data?.error?.message || "")) {
      console.warn(`Gemini model "${chosen.smart}" has no quota on this key (billing not enabled); using "${chosen.fast}" for questions and recaps.`);
      chosen.smart = chosen.fast;
      ({ res, data } = await post(chosen.fast, body));
    }
    if (!res.ok) {
      const m = data?.error?.message || `HTTP ${res.status}`;
      if (res.status === 429) throw fail(`Gemini rate limit or quota reached: ${m}`, 429);
      if ((res.status === 400 && /api key/i.test(m)) || res.status === 403) throw fail(`Gemini rejected the API key: ${m}`);
      throw fail(`Gemini error (${chosen[slot]}): ${m}`);
    }
    const cand = data.candidates?.[0];
    const text = (cand?.content?.parts || []).filter(p => !p.thought).map(p => p.text || "").join("").trim();
    if (!text) {
      const why = data.promptFeedback?.blockReason || cand?.finishReason || "no content";
      throw fail(`Gemini returned no answer (${why}). Try rephrasing, or a smaller image.`);
    }
    if (!json) return text;
    return parseJSON(text);
  }

  function parseJSON(text) {
    const clean = text.replace(/^```(?:json)?\s*|\s*```$/g, "");
    try { return JSON.parse(clean); } catch { /* fall through */ }
    const a = clean.search(/[\[{]/), b = Math.max(clean.lastIndexOf("]"), clean.lastIndexOf("}"));
    if (a >= 0 && b > a) { try { return JSON.parse(clean.slice(a, b + 1)); } catch { /* fall through */ } }
    throw fail("Gemini's answer wasn't in the expected format. Try again.");
  }

  async function status() {
    const out = { configured: true, model: chosen.fast, smartModel: chosen.smart };
    try {
      out.available = (await listModels()).filter(n => n.startsWith("gemini-"));
      const reply = await generate({ parts: [{ text: 'Reply with the JSON {"ok":true}' }], temperature: 0 });
      out.fast = reply?.ok === true ? "ok" : `unexpected reply: ${JSON.stringify(reply).slice(0, 80)}`;
      const t0 = Date.now();
      const r2 = await generate({ parts: [{ text: "Say OK." }], json: false, useSmart: true, temperature: 0 });
      out.smart = `ok (${Date.now() - t0} ms): ${r2.slice(0, 40)}`;
    } catch (e) { out.error = e.message; }
    out.model = chosen.fast; out.smartModel = chosen.smart;
    return out;
  }

  return {
    get model() { return chosen.fast; },
    status,
    /** Pull flight segments out of booking text and/or a ticket image. */
    async extract({ text, image, today }) {
      const parts = [{ text: `You extract flight segments from travel bookings, e-tickets, itineraries and boarding passes.
Today is ${today}.
Return a JSON array. Each item:
{"date":"YYYY-MM-DD","time":"HH:MM local departure or empty","from":"IATA airport code","to":"IATA airport code",
 "flight":"airline IATA code + number, no space, e.g. 6E5297","seat":"e.g. 27C or empty","seatType":"window|middle|aisle or empty",
 "cabin":"economy|premium|business|first","aircraft":"IATA aircraft type code like 32N or 77W if stated, else empty",
 "duration":"H:MM if stated, else empty","note":"booking reference / PNR if present, else empty"}
Rules: one item per flight segment, including connections and return legs. Convert city names to that city's main airport code.
If a year is missing, use the next occurrence on or after today for bookings, else the most recent past date.
Never invent flights. If there are none, return [].
${text ? `\nBOOKING TEXT:\n"""\n${String(text).slice(0, 20000)}\n"""` : ""}` }];
      if (image) parts.push({ inlineData: { mimeType: image.mimeType, data: image.data } });
      return asArray(await generate({ parts, temperature: 0.1 }));
    },

    /** Answer a free-form question about the logbook. */
    async ask({ question, table, summary, today }) {
      const text = await generate({
        json: false, useSmart: true, temperature: 0.3,
        system: "You are Wander, a friendly analyst for one person's flight logbook. Answer only from the data given. Be concise: 1-4 short paragraphs or a short list. Use km. If the data can't answer, say so. Cancelled flights were not flown and must be excluded unless asked about.",
        parts: [{ text: `Today is ${today}.\nSUMMARY:\n${summary}\n\nFLIGHTS (date | flight | from | to | airline | distance | duration | aircraft | seat | cabin | status):\n${table}\n\nQUESTION: ${String(question).slice(0, 1000)}` }],
      });
      return text.trim();
    },

    /** A short, warm year-in-review. */
    async story({ year, table, summary }) {
      return generate({
        useSmart: true, temperature: 0.7,
        system: "You write short, vivid, factual travel recaps. No clichés like 'jet-setter' or 'wanderlust'. Never invent places or events not in the data.",
        parts: [{ text: `Write a year-in-review for ${year} from this flight log.
Return JSON: {"title":"4-7 word title","story":"90-140 words, second person, specific to the routes and places","highlights":["3-5 short factual highlights, each under 12 words"]}
SUMMARY:\n${summary}\n\nFLIGHTS:\n${table}` }],
      });
    },

    /** Evocative names for trips. Input: [{id, when, places, days, flights}] */
    async nameTrips(trips) {
      const out = await generate({
        temperature: 0.6,
        parts: [{ text: `Give each trip a short evocative name (2-5 words, no dates, no emoji) and a one-line summary (max 16 words), based only on the places.
Return JSON: [{"id":"...","name":"...","summary":"..."}] in the same order.
TRIPS:\n${JSON.stringify(trips)}` }],
      });
      return asArray(out);
    },

    /** Suggest new destinations reachable from home. */
    async whereNext({ home, visited, topRoutes, today }) {
      const out = await generate({
        useSmart: true, temperature: 0.8,
        parts: [{ text: `Home airport: ${home}. Today: ${today}.
Countries already visited: ${visited.join(", ")}.
Most-flown routes: ${topRoutes.join(", ")}.
Suggest 6 destinations this traveller hasn't been to, mixing easy short-haul and one or two ambitious long-haul picks.
Prefer places with direct or one-stop flights from home. Return JSON:
[{"iata":"airport code","city":"...","country":"...","why":"max 20 words, specific","bestMonths":"e.g. Oct–Mar","flightTime":"approx, e.g. 3h direct"}]` }],
      });
      return asArray(out);
    },
  };
}
