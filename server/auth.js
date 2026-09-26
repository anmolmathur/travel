import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";

const COOKIE = "wander_session";
const TTL_MS = 30 * 24 * 3600 * 1000;

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Single-owner auth. The owner signs in with WANDER_PASSWORD and gets a signed cookie.
 * Agents (Claude, scripts, the MCP endpoint) use WANDER_API_TOKEN as a bearer token.
 */
export function createAuth({ password, apiToken, secret, publicRead, secureCookie }) {
  const key = secret || randomBytes(32).toString("hex");
  const attempts = new Map(); // ip -> {n, until}

  const sign = payload => createHmac("sha256", key).update(payload).digest("base64url");
  const issue = () => { const p = `owner.${Date.now() + TTL_MS}`; return `${p}.${sign(p)}`; };
  const verify = tok => {
    const parts = String(tok || "").split(".");
    if (parts.length !== 3) return false;
    const p = `${parts[0]}.${parts[1]}`;
    return safeEqual(sign(p), parts[2]) && Number(parts[1]) > Date.now();
  };
  const cookieOf = req => {
    const m = (req.headers.cookie || "").split(/;\s*/).find(c => c.startsWith(COOKIE + "="));
    return m ? decodeURIComponent(m.slice(COOKIE.length + 1)) : "";
  };
  const bearerOf = req => {
    const h = req.headers.authorization || "";
    return h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  };

  return {
    enabled: Boolean(password),
    /** "owner" | "agent" | "public" | null */
    who(req, pathToken) {
      if (!password) return "owner"; // no password configured: local/dev use
      if (verify(cookieOf(req))) return "owner";
      const t = bearerOf(req) || pathToken;
      if (apiToken && t && safeEqual(t, apiToken)) return "agent";
      return publicRead ? "public" : null;
    },
    tryLogin(req, pw) {
      const ip = req.socket.remoteAddress || "?";
      const a = attempts.get(ip) || { n: 0, until: 0 };
      if (a.until > Date.now()) return { ok: false, retryAfter: Math.ceil((a.until - Date.now()) / 1000) };
      if (password && safeEqual(pw || "", password)) { attempts.delete(ip); return { ok: true, cookie: this.cookie(issue()) }; }
      a.n++; if (a.n >= 5) { a.until = Date.now() + 60_000 * Math.min(30, 2 ** (a.n - 5)); }
      attempts.set(ip, a);
      return { ok: false };
    },
    cookie(value, maxAge = TTL_MS / 1000) {
      return `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureCookie ? "; Secure" : ""}`;
    },
    clearCookie() { return this.cookie("", 0); },
  };
}
