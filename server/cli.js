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
} else if (cmd === "export") {
  process.stdout.write(service.exportCSV());
} else {
  console.log("Usage: node server/cli.js import <file.csv> | export | ai-check | token");
  process.exit(1);
}
