// Thin Gemini REST client plus the prompts behind Wander's AI features.
// The key never leaves the server.

const API = "https://generativelanguage.googleapis.com/v1beta/models";

export function createGemini({ apiKey, model, smartModel, fetchImpl = fetch }) {
  if (!apiKey) return null;

  async function generate({ parts, json = true, useSmart = false, temperature = 0.3, system }) {
    const m = useSmart ? smartModel || model : model;
    const body = {
      contents: [{ role: "user", parts }],
      generationConfig: { temperature, ...(json ? { responseMimeType: "application/json" } : {}) },
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    };
    const res = await fetchImpl(`${API}/${encodeURIComponent(m)}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data?.error?.message || `Gemini returned HTTP ${res.status}`);
      err.status = res.status === 429 ? 429 : 502;
      throw err;
    }
    const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("");
    if (!json) return text;
    try { return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, "")); }
    catch { const e = new Error("Gemini returned something that wasn't JSON."); e.status = 502; throw e; }
  }

  return {
    model,
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
      const out = await generate({ parts, temperature: 0.1 });
      return Array.isArray(out) ? out : Array.isArray(out?.flights) ? out.flights : [];
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
      return Array.isArray(out) ? out : [];
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
      return Array.isArray(out) ? out : [];
    },
  };
}
