import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const defaultMigrationDir = path.resolve(moduleDir, "../db/migrations");

export function openDatabase(filename = ":memory:", migrationDir = defaultMigrationDir) {
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  if (filename !== ":memory:") db.exec("PRAGMA journal_mode=WAL;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations(version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  for (const file of readdirSync(migrationDir).filter((name) => name.endsWith(".sql")).sort()) {
    const version = file.slice(0, -4);
    const exists = db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(version);
    if (exists) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(readFileSync(path.join(migrationDir, file), "utf8"));
      db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)")
        .run(version, new Date().toISOString());
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      db.close();
      throw error;
    }
  }
  return db;
}

export function transaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function one(db, sql, ...params) {
  return db.prepare(sql).get(...params) ?? null;
}

export function all(db, sql, ...params) {
  return db.prepare(sql).all(...params);
}
