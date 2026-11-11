// Command-line helpers. Usage:
//   node server/cli.js import path/to/openflights.csv
//   node server/cli.js export > backup.csv
//   node server/cli.js token          (prints a fresh random token for WANDER_API_TOKEN)
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { buildApp } from "./index.js";

const [cmd, arg] = process.argv.slice(2);
if (cmd === "token") { console.log(randomBytes(32).toString("base64url")); process.exit(0); }
const { service } = buildApp();
if (cmd === "import" && arg) {
  const r = service.importCSV(readFileSync(arg, "utf8"));
  console.log(`Added ${r.added}, skipped ${r.skipped} duplicates, ${r.failed} couldn't be read.`);
  for (const e of r.errors) console.log(`  row ${e.row}: ${e.error}`);
} else if (cmd === "ai-check") {
  const s = await service.aiStatus();
  console.log(JSON.stringify(s, null, 2));
  process.exit(s.error ? 1 : 0);
} else if (cmd === "confirmtkt" && arg) {
  // What Wander reads from ConfirmTkt's page for a PNR, plus the page's layout (no names) to fix the reader if needed.
  const { createConfirmTkt, embeddedJson, pageText } = await import("./confirmtkt.js");
  const url = `https://www.confirmtkt.com/pnr-status/${arg.replace(/\D/g, "")}`;
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1", accept: "text/html,application/xhtml+xml", "accept-language": "en-IN,en;q=0.8" } });
  const html = await res.text();
  console.log(`ConfirmTkt answered HTTP ${res.status} (${res.headers.get("content-type") || "no type"}, server: ${res.headers.get("server") || "?"}, ${html.length} bytes).`);
  if (!res.ok) console.log("First 300 characters:", html.replace(/\s+/g, " ").slice(0, 300));
  const r = await createConfirmTkt({ fetchImpl: async () => ({ ok: true, status: 200, text: async () => html }) }).lookup(arg.replace(/\D/g, ""));
  console.log("Wander read:", JSON.stringify({ chance: r.chance, label: r.label, bookingStatus: r.bookingStatus, currentStatus: r.currentStatus, chart: r.chart, method: r.method, blocked: r.blocked }));
  const keys = new Set(); const walk = (o, p) => { if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) { const q = p ? `${p}.${k}` : k; if (v && typeof v === "object") walk(v, Array.isArray(o) ? p : q); else keys.add(q.replace(/\.\d+(?=\.|$)/g, "[]")); } };
  embeddedJson(html).forEach(o => walk(o, ""));
  console.log(`Page: ${html.length} bytes; embedded JSON keys (${keys.size}):`, [...keys].filter(k => /prob|chance|predict|confirm|status|chart|pnr|train/i.test(k)).slice(0, 60).join(", ") || "(none)");
  console.log("Text lines mentioning chance/confirm/status (names hidden):");
  for (const l of pageText(html).split("\n").filter(l => /chance|probab|predict|confirm|status|chart|%/i.test(l)).slice(0, 25)) console.log("  ", l.replace(/\b(MR|MRS|MS|MISS)\.?\s+[A-Z ]+/gi, "<name>").slice(0, 140));
} else if (cmd === "export") {
  process.stdout.write(service.exportCSV());
} else {
  console.log("Usage: node server/cli.js import <file.csv> | export | ai-check | token | confirmtkt <PNR>");
  process.exit(1);
}
