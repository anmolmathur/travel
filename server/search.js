// Web search through a self-hosted SearXNG instance (JSON API), so the app's quick links can show results in place
// instead of sending the traveller to Google. Only the search words leave the server: never a PNR or a name.
const fail = (message, status = 502) => Object.assign(new Error(message), { status });

export function createSearch({ url, fetchImpl = fetch, timeoutMs = 9000 }) {
  const base = String(url || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\/\S+$/i.test(base)) return null;
  return {
    url: base,
    /** Top results for a query: [{ title, url, site, snippet, published }], plus any direct answers SearXNG found. */
    async search(q, { language = "en-IN", max = 8 } = {}) {
      const query = String(q || "").trim().slice(0, 200);
      if (!query) throw fail("Nothing to search for.", 400);
      const u = `${base}/search?${new URLSearchParams({ q: query, format: "json", language, safesearch: "1" })}`;
      let res;
      try { res = await fetchImpl(u, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) }); }
      catch (e) {
        if (e?.name === "TimeoutError" || e?.name === "AbortError") throw fail("Search took too long. Try again.", 504);
        throw fail(`Couldn't reach SearXNG at ${base} (${e?.cause?.code || e?.message || "network error"}). Is Wander on the same Docker network?`);
      }
      if (res.status === 403) throw fail("SearXNG refused a JSON search. Add json to search.formats in its settings.yml.");
      if (!res.ok) throw fail(`SearXNG answered HTTP ${res.status}.`);
      const data = await res.json().catch(() => null);
      if (!data || !Array.isArray(data.results)) throw fail("SearXNG's answer wasn't JSON. Add json to search.formats in its settings.yml.");
      const seen = new Set(), results = [];
      for (const r of data.results) {
        if (!r?.url || seen.has(r.url) || !/^https?:\/\//.test(r.url)) continue;
        seen.add(r.url);
        let site = ""; try { site = new URL(r.url).hostname.replace(/^www\./, ""); } catch { /* keep blank */ }
        results.push({ title: String(r.title || site).slice(0, 200), url: r.url, site, snippet: String(r.content || "").replace(/\s+/g, " ").trim().slice(0, 400), ...(r.publishedDate ? { published: String(r.publishedDate).slice(0, 25) } : {}) });
        if (results.length >= max) break;
      }
      const answers = (Array.isArray(data.answers) ? data.answers : []).map(a => String(a?.answer ?? a ?? "").trim()).filter(Boolean).slice(0, 3);
      return { query, results, answers };
    },
  };
}
