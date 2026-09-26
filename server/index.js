import { createServer } from "node:http";
import { readFileSync, existsSync, statSync, createReadStream } from "node:fs";
import { join, extname, normalize as normPath, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createGzip } from "node:zlib";
import { createRef } from "../public/lib/core.js";
import { openDb } from "./db.js";
import { createAuth } from "./auth.js";
import { createGemini } from "./gemini.js";
import { createAeroDataBox } from "./lookup.js";
import { createService, InputError } from "./service.js";
import { handleMcp } from "./mcp.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = join(ROOT, "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json", ".txt": "text/plain; charset=utf-8" };
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", "font-src https://fonts.gstatic.com",
  "img-src 'self' data: blob: https://pics.avs.io https://flagcdn.com", "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'",
].join("; ");

export function buildApp(env = process.env) {
  const ref = createRef(JSON.parse(readFileSync(join(PUBLIC, "data", "ref.json"), "utf8")));
  const db = openDb(env.WANDER_DB || join(ROOT, "data", "wander.db"));
  const gemini = createGemini({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL || "gemini-2.5-flash", smartModel: env.GEMINI_MODEL_SMART || env.GEMINI_MODEL || "gemini-2.5-flash" });
  const lookupProvider = createAeroDataBox({ apiKey: env.AERODATABOX_API_KEY });
  const service = createService({ db, ref, gemini, lookupProvider });
  const auth = createAuth({
    password: env.WANDER_PASSWORD, apiToken: env.WANDER_API_TOKEN, secret: env.SESSION_SECRET,
    publicRead: env.PUBLIC_READ === "true", secureCookie: env.COOKIE_SECURE !== "false",
  });

  const send = (res, status, body, headers = {}) => {
    const isStr = typeof body === "string";
    res.writeHead(status, { "content-type": isStr ? "text/plain; charset=utf-8" : "application/json", "cache-control": "no-store", ...headers });
    res.end(isStr ? body : JSON.stringify(body));
  };
  const readBody = (req, limit) => new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => { size += c.length; if (size > limit) { reject(new InputError("That upload is too large.", 413)); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
  const readJSON = async (req, limit = 256 * 1024) => {
    const t = await readBody(req, limit);
    try { return t ? JSON.parse(t) : {}; } catch { throw new InputError("The request body isn't valid JSON."); }
  };

  function serveStatic(req, res, path) {
    let p = decodeURIComponent(path);
    if (p === "/" || !extname(p)) p = "/index.html";
    const file = normPath(join(PUBLIC, p));
    if (!file.startsWith(PUBLIC) || !existsSync(file) || !statSync(file).isFile()) return send(res, 404, "Not found");
    const ext = extname(file);
    const headers = {
      "content-type": TYPES[ext] || "application/octet-stream",
      "cache-control": ext === ".html" ? "no-cache" : p.startsWith("/vendor/") || p.startsWith("/data/") ? "public, max-age=604800" : "public, max-age=300",
      "content-security-policy": CSP, "x-content-type-options": "nosniff", "referrer-policy": "strict-origin-when-cross-origin",
    };
    const gz = /\bgzip\b/.test(req.headers["accept-encoding"] || "") && [".js", ".css", ".json", ".html", ".svg"].includes(ext);
    if (gz) headers["content-encoding"] = "gzip";
    res.writeHead(200, headers);
    const stream = createReadStream(file);
    (gz ? stream.pipe(createGzip()) : stream).pipe(res);
  }

  async function api(req, res, url) {
    const path = url.pathname, method = req.method;
    const who = auth.who(req);
    const canRead = Boolean(who), canWrite = who === "owner" || who === "agent";
    const needRead = () => { if (!canRead) throw new InputError("Sign in to see this logbook.", 401); };
    const needWrite = () => { if (!canWrite) throw new InputError(who ? "This view is read-only. Sign in to make changes." : "Sign in first.", 401); };

    if (path === "/api/me") return send(res, 200, { who, canRead, canWrite, authEnabled: auth.enabled, features: service.features });
    if (path === "/api/login" && method === "POST") {
      const { password } = await readJSON(req, 4096);
      const r = auth.tryLogin(req, password);
      if (r.retryAfter) return send(res, 429, { error: `Too many attempts. Try again in ${r.retryAfter} seconds.` });
      if (!r.ok) return send(res, 401, { error: "That password isn't right." });
      return send(res, 200, { ok: true }, { "set-cookie": r.cookie });
    }
    if (path === "/api/logout" && method === "POST") return send(res, 200, { ok: true }, { "set-cookie": auth.clearCookie() });

    const m = path.match(/^\/api\/flights\/([A-Za-z0-9_\-.~:@+]{1,200})$/);
    if (path === "/api/flights" && method === "GET") { needRead(); return send(res, 200, { flights: service.all() }); }
    if (path === "/api/flights" && method === "POST") { needWrite(); return send(res, 201, service.create(await readJSON(req), who === "agent" ? "agent" : "manual")); }
    if (m && method === "PUT") { needWrite(); return send(res, 200, service.replace(m[1], await readJSON(req))); }
    if (m && method === "PATCH") { needWrite(); return send(res, 200, service.patch(m[1], await readJSON(req))); }
    if (m && method === "DELETE") { needWrite(); return send(res, 200, service.remove(m[1])); }
    if (path === "/api/import" && method === "POST") { needWrite(); return send(res, 200, service.importCSV(await readBody(req, 5 * 1024 * 1024))); }
    if (path === "/api/export.csv") {
      needRead();
      return send(res, 200, service.exportCSV(), { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="wander-flights-${new Date().toISOString().slice(0, 10)}.csv"` });
    }
    if (path === "/api/stats") { needRead(); return send(res, 200, service.stats(url.searchParams.get("year") || undefined)); }
    if (path === "/api/trips") { needRead(); return send(res, 200, service.trips()); }
    if (path === "/api/review") { needRead(); return send(res, 200, service.reviewQueue()); }
    if (path === "/api/lookup") { needWrite(); return send(res, 200, { results: await service.lookup(url.searchParams.get("flight"), url.searchParams.get("date")) }); }

    if (path === "/api/ai/extract" && method === "POST") { needWrite(); return send(res, 200, { flights: await service.aiExtract(await readJSON(req, 12 * 1024 * 1024)) }); }
    if (path === "/api/ai/ask" && method === "POST") { needRead(); if (who === "public") throw new InputError("Sign in to ask questions.", 401); return send(res, 200, { answer: await service.aiAsk((await readJSON(req)).question) }); }
    if (path === "/api/ai/story" && method === "POST") { needRead(); if (who === "public") throw new InputError("Sign in to write a recap.", 401); return send(res, 200, await service.aiStory((await readJSON(req)).year)); }
    if (path === "/api/ai/trips" && method === "POST") { needWrite(); return send(res, 200, await service.aiNameTrips()); }
    if (path === "/api/ai/next" && method === "POST") { needRead(); if (who === "public") throw new InputError("Sign in for suggestions.", 401); return send(res, 200, { ideas: await service.aiWhereNext() }); }
    return send(res, 404, { error: "Unknown endpoint." });
  }

  async function mcp(req, res, pathToken) {
    const who = auth.who(req, pathToken);
    if (who !== "owner" && who !== "agent") return send(res, 401, { error: "Send WANDER_API_TOKEN as a bearer token." }, { "www-authenticate": "Bearer" });
    if (req.method === "GET") return send(res, 405, { error: "This MCP server answers POST requests only." }, { allow: "POST" });
    if (req.method === "DELETE") return send(res, 200, { ok: true });
    if (req.method !== "POST") return send(res, 405, { error: "Use POST." });
    const body = await readJSON(req, 1024 * 1024);
    const batch = Array.isArray(body) ? body : [body];
    const out = [];
    for (const msg of batch) { const r = await handleMcp(msg, { service, canWrite: true }); if (r) out.push(r); }
    if (!out.length) { res.writeHead(202); return res.end(); }
    return send(res, 200, Array.isArray(body) ? out : out[0]);
  }

  const handler = async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      if (url.pathname === "/healthz") return send(res, 200, { ok: true });
      if (url.pathname.startsWith("/api/")) return await api(req, res, url);
      const mm = url.pathname.match(/^\/mcp(?:\/([A-Za-z0-9_\-]{16,200}))?\/?$/);
      if (mm) return await mcp(req, res, mm[1]);
      if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed");
      return serveStatic(req, res, url.pathname);
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500 && !(e instanceof InputError)) console.error(e);
      if (!res.headersSent) send(res, status, { error: status >= 500 && !(e instanceof InputError) && status !== 502 ? "Something went wrong on the server." : e.message });
    }
  };
  return { handler, service, db };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  const { handler } = buildApp();
  if (!process.env.WANDER_PASSWORD) console.warn("WANDER_PASSWORD is not set: anyone who can reach this server can edit the logbook.");
  createServer(handler).listen(port, () => console.log(`Wander listening on :${port}`));
}
