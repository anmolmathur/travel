// Provider-neutral pieces of Wander's AI features: request plumbing, JSON parsing, and the prompts.
// Each provider (gemini.js, providers.js) supplies a small "core": { provider, label, model, smartModel,
// generate({ parts, json, useSmart, temperature, system }), listModels() }. Parts are Gemini-shaped:
// { text } or { inlineData: { mimeType, data } }; other providers translate them. Keys never leave the server.

export const BUDGET_MS = 85_000; // every attempt for one request together stays under Cloudflare's 100-second limit

// 503, not 502: a 502 reads as "the proxy couldn't reach Wander", and some proxies swap in their own error page.
export const fail = (message, status = 503) => Object.assign(new Error(message), { status });
export const sleep = ms => new Promise(r => setTimeout(r, ms));
/** Models sometimes wrap a requested array in an object ({"flights": [...]}); unwrap it. */
export const asArray = out => Array.isArray(out) ? out : out && typeof out === "object" ? (Object.values(out).find(Array.isArray) || []) : [];

/** fetch with a shared deadline, turning timeouts and network errors into readable messages. */
export async function requestWithin(fetchImpl, label, url, init, deadline = Date.now() + BUDGET_MS) {
  const left = deadline - Date.now();
  if (left < 1000) throw fail(`${label} took too long to answer. Try again in a minute.`, 504);
  try { return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(left) }); }
  catch (e) {
    if (e?.name === "TimeoutError" || e?.name === "AbortError") throw fail(`${label} took too long to answer. Try again, or pick a faster model in AI settings.`, 504);
    throw fail(`Couldn't reach ${label} (${e?.cause?.code || e?.message || "network error"}).`);
  }
}

export function parseJSON(text, label = "The AI") {
  const clean = String(text).trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  try { return JSON.parse(clean); } catch { /* fall through */ }
  const a = clean.search(/[\[{]/), b = Math.max(clean.lastIndexOf("]"), clean.lastIndexOf("}"));
  if (a >= 0 && b > a) { try { return JSON.parse(clean.slice(a, b + 1)); } catch { /* fall through */ } }
  throw fail(`${label}'s answer wasn't in the expected format. Try again.`);
}

/** Wraps a provider core with Wander's features (extract, ask, story, trip names, where next) and a health check. */
export function withPrompts(core) {
  const generate = opts => core.generate(opts);
  async function status() {
    const out = { configured: true, provider: core.provider, model: core.model, smartModel: core.smartModel };
    try {
      out.available = (await core.listModels()).slice(0, 200);
      const reply = await generate({ parts: [{ text: 'Reply with the JSON {"ok":true}' }], temperature: 0 });
      out.fast = reply?.ok === true ? "ok" : `unexpected reply: ${JSON.stringify(reply).slice(0, 80)}`;
      const t0 = Date.now();
      const r2 = await generate({ parts: [{ text: "Say OK." }], json: false, useSmart: true, temperature: 0 });
      out.smart = `ok (${Date.now() - t0} ms): ${String(r2).slice(0, 40)}`;
    } catch (e) { out.error = e.message; }
    out.model = core.model; out.smartModel = core.smartModel;
    return out;
  }
  return {
    get provider() { return core.provider; },
    get model() { return core.model; },
    get smartModel() { return core.smartModel; },
    listModels: () => core.listModels(),
    status,
    /** Pull flight segments out of booking text and/or a ticket image. */
    async extract({ text, image, today }) {
      const parts = [{ text: `You extract travel segments (flights, and any train, car, bus or ferry legs) from travel bookings, e-tickets, itineraries and boarding passes.
Today is ${today}.
Return a JSON array. Each item:
{"mode":"air|train|car|bus|ferry","date":"YYYY-MM-DD","time":"HH:MM local departure or empty","from":"IATA airport code","to":"IATA airport code",
 "operator":"for train/car/bus/ferry legs, the operator (e.g. Trenitalia), else empty",
 "flight":"airline IATA code + number, no space, e.g. 6E5297","seat":"e.g. 27C or empty","seatType":"window|middle|aisle or empty",
 "cabin":"economy|premium|business|first","aircraft":"IATA aircraft type code like 32N or 77W if stated, else empty",
 "duration":"H:MM if stated, else empty","note":"booking reference / PNR if present, else empty"}
Rules: one item per segment, including connections and return legs. Convert city names to that city's main airport code;
for train, car, bus and ferry legs use the main airport code of each end city. For those legs "flight" is the train or service number, or empty.
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
        system: "You are Wander, a friendly analyst for one person's travel logbook. Answer only from the data given. Rows whose flight column starts with TRAIN, CAR, BUS or FERRY are ground journeys, not flights: leave them out of flight counts unless asked, but count the places they reach. Be concise: 1-4 short paragraphs or a short list. Use km. If the data can't answer, say so. Cancelled flights were not flown and must be excluded unless asked about.",
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
