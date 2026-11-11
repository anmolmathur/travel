// Upstream failures answer 503, never 502: Cloudflare replaces a 502 with its own error page, hiding the reason.
// Confirmation chance for an Indian Railways PNR, read from ConfirmTkt's public PNR page
// (https://www.confirmtkt.com/pnr-status/<PNR>). Only the PNR is sent; the server fetches on demand, when the owner
// taps the button. The page has no documented API, so the reader is deliberately tolerant: it looks for the
// prediction in any JSON embedded in the page first, then in the page's visible text.

const BASE = "https://www.confirmtkt.com";
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

const decode = s => s.replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
/** The page's readable text, one line per block, without scripts and styles. */
export const pageText = html => decode(String(html)
  .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
  .replace(/<(br|\/p|\/div|\/li|\/tr|\/h\d|\/td|\/span)\b[^>]*>/gi, "\n")
  .replace(/<[^>]+>/g, " "))
  .split("\n").map(l => l.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");

/** Every JSON object embedded in the page (Next.js data, JSON-LD, window.__STATE__ = {...}). */
export function embeddedJson(html) {
  const out = [];
  const s = String(html);
  for (const m of s.matchAll(/<script\b[^>]*type=["']application\/(?:ld\+)?json["'][^>]*>([\s\S]*?)<\/script>/gi)) { try { out.push(JSON.parse(m[1])); } catch { /* not JSON */ } }
  for (const m of s.matchAll(/<script\b[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/gi)) { try { out.push(JSON.parse(m[1])); } catch { /* not JSON */ } }
  for (const m of s.matchAll(/(?:window\.)?__[A-Z_]+__\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/g)) { try { out.push(JSON.parse(m[1])); } catch { /* not JSON */ } }
  return out;
}

const pct = v => { const m = String(v ?? "").match(/(\d{1,3}(?:\.\d+)?)\s*%?/); const n = m ? Math.round(Number(m[1])) : NaN; return n >= 0 && n <= 100 ? n : null; };
const CHANCE_KEY = /(confirm|cnf).*(prob|chance|percent|pct)|^(prob|probability|prediction|predictionpercentage|chance|chances|confirmationchance)s?$/i;
const STATUS_KEYS = { booking: /^(booking_?status|bookingstatus)$/i, current: /^(current_?status|currentstatus)$/i, chart: /^(chart_?status|chartstatus|chartprepared|ischartprepared)$/i };

/** Walk embedded JSON for a confirmation probability and the statuses next to it. */
function fromJson(objs) {
  const found = {};
  const walk = (o, depth) => {
    if (!o || typeof o !== "object" || depth > 12) return;
    for (const [k, v] of Object.entries(o)) {
      if (v && typeof v === "object") { walk(v, depth + 1); continue; }
      // a probability may be stored as 0.85 rather than 85
      const val = typeof v === "number" && v > 0 && v < 1 ? v * 100 : v;
      if (found.chance == null && CHANCE_KEY.test(k) && pct(val) != null) { found.chance = pct(val); found.key = k; }
      // the prediction's wording wins over a shorter "confirm…status" field
      const words = typeof v === "string" && /[a-z]/i.test(v) && v.length < 80;
      if (found.label == null && words && /prediction(text|label)?$/i.test(k)) found.label = v.trim();
      if (found.altLabel == null && words && /prediction ?status$|confirm.*(text|status|label)$/i.test(k)) found.altLabel = v.trim();
      for (const [name, re] of Object.entries(STATUS_KEYS)) if (found[name] == null && re.test(k) && v !== "" && v != null) found[name] = typeof v === "boolean" ? v : String(v).trim();
    }
  };
  for (const o of objs) walk(o, 0);
  if (found.label == null && found.altLabel) found.label = found.altLabel;
  return found;
}

/** Find the chance in the readable text: a percentage next to "chance", "probability" or "confirm". */
function fromText(text) {
  const lines = text.split("\n");
  const near = /chance|probab|prediction|confirm/i;
  for (let i = 0; i < lines.length; i++) {
    if (!near.test(lines[i])) continue;
    // the number is usually on the same line, or the one just before or after the label
    for (const j of [i, i + 1, i - 1, i + 2]) {
      const l = lines[j]; if (!l) continue;
      const m = l.match(/(\d{1,3})\s*%/);
      // keep the line as a label only when it says more than the heading ("Confirmation Chances")
      const rest = lines[i].replace(/\d{1,3}\s*%/, "").replace(/\b(confirmation|confirm|chances?|probability|prediction|of|is)\b|[:\-–]/gi, "").trim();
      if (m && Number(m[1]) <= 100) return { chance: Number(m[1]), label: rest ? lines[i].replace(/\s*\d{1,3}\s*%\s*/, " ").trim().slice(0, 80) : "", line: i };
    }
  }
  // Some layouts say "High / Medium / Low chances" without a number.
  const word = text.match(/\b(very high|high|medium|moderate|low|very low)\s+(?:chances?|probability)\b/i) || text.match(/\b(?:chances?|probability)\s*(?:of confirmation)?\s*[:\-]?\s*(very high|high|medium|moderate|low|very low)\b/i);
  return word ? { chance: null, label: `${word[1][0].toUpperCase()}${word[1].slice(1).toLowerCase()} chance` } : {};
}

/** Read the confirmation chance (0-100, or null), a short label and the statuses from a ConfirmTkt PNR page. */
export function parseConfirmTkt(html) {
  const text = pageText(html);
  const j = fromJson(embeddedJson(html));
  const t = j.chance == null ? fromText(text) : {};
  const chance = j.chance ?? t.chance ?? null;
  const label = j.label || t.label || "";
  // "Booking Status: WL 34", or the label on one line and the value on the next
  const statusFrom = re => { const ls = text.split("\n"); const i = ls.findIndex(l => re.test(l)); if (i < 0) return ""; const same = ls[i].replace(re, "").replace(/^[\s:\-]+/, "").trim(); return (same || ls[i + 1] || "").slice(0, 40); };
  const tBooking = j.booking ? "" : statusFrom(/^\s*booking status\b/i), tCurrent = j.current ? "" : statusFrom(/^\s*current status\b/i);
  const chartText = text.match(/chart\s*(?:status)?\s*[:\-]?\s*(not prepared|prepared)/i)?.[1];
  const chart = typeof j.chart === "boolean" ? j.chart : /prepared/i.test(String(j.chart ?? chartText ?? "")) ? !/not/i.test(String(j.chart ?? chartText)) : null;
  return {
    chance, label: label.replace(/\s+/g, " ").trim(),
    bookingStatus: j.booking || tBooking, currentStatus: j.current || tCurrent, chart,
    method: j.chance != null ? `json:${j.key}` : t.chance != null ? "text" : t.label ? "text:word" : "none",
    blocked: /captcha|are you a robot|access denied|cf-chl|challenge-platform/i.test(String(html)) && chance == null,
  };
}

/** A small client: lookup(pnr) fetches the page and parses it, with a timeout and readable errors. */
export function createConfirmTkt({ fetchImpl = fetch, timeoutMs = 15000, base = BASE } = {}) {
  const PAGE = pnr => `${String(base || BASE).replace(/\/+$/, "")}/pnr-status/${pnr}`;
  return {
    pageUrl: PAGE,
    async lookup(pnr) {
      let res;
      try { res = await fetchImpl(PAGE(pnr), { headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml", "accept-language": "en-IN,en;q=0.8" }, signal: AbortSignal.timeout(timeoutMs) }); }
      catch (e) { throw Object.assign(new Error(e?.name === "TimeoutError" ? "ConfirmTkt took too long to answer. Try again in a minute." : `Couldn't reach ConfirmTkt (${e?.cause?.code || e?.message || "network error"}).`), { status: 503 }); }
      if (!res.ok) {
        const why = res.status === 403 || res.status === 429 ? "it refused the request (it may block servers from reading its pages)" : `HTTP ${res.status}`;
        throw Object.assign(new Error(`ConfirmTkt didn't answer: ${why}. Open the page instead.`), { status: 503, upstream: res.status });
      }
      const html = await res.text();
      const r = parseConfirmTkt(html);
      if (r.blocked) throw Object.assign(new Error("ConfirmTkt asked for a human check (captcha), so Wander can't read it. Open the page instead."), { status: 503 });
      return { ...r, url: PAGE(pnr), checkedAt: new Date().toISOString(), size: html.length };
    },
  };
}
