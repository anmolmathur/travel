import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Flights are stored as JSON documents; a small key/value table caches AI output. */
export function openDb(file) {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS flights (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);
  const q = {
    all: db.prepare("SELECT id, data FROM flights"),
    get: db.prepare("SELECT id, data FROM flights WHERE id = ?"),
    put: db.prepare(`INSERT INTO flights (id, data) VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`),
    del: db.prepare("DELETE FROM flights WHERE id = ?"),
    kvGet: db.prepare("SELECT value FROM kv WHERE key = ?"),
    kvPut: db.prepare(`INSERT INTO kv (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`),
  };
  const row = r => (r ? { id: r.id, ...JSON.parse(r.data) } : null);
  let version = Date.now();
  return {
    version: () => version,
    list: () => q.all.all().map(row),
    get: id => row(q.get.get(id)),
    put(id, doc) { const { id: _drop, ...rest } = doc; q.put.run(id, JSON.stringify(rest)); version = Date.now(); return { id, ...rest }; },
    del(id) { const r = q.del.run(id); version = Date.now(); return r.changes > 0; },
    putMany(entries) {
      db.exec("BEGIN");
      try { for (const [id, doc] of entries) { const { id: _d, ...rest } = doc; q.put.run(id, JSON.stringify(rest)); } db.exec("COMMIT"); }
      catch (e) { db.exec("ROLLBACK"); throw e; }
      version = Date.now();
    },
    kvGet: k => { const r = q.kvGet.get(k); return r ? JSON.parse(r.value) : null; },
    kvPut: (k, v) => q.kvPut.run(k, JSON.stringify(v)),
    close: () => db.close(),
  };
}
