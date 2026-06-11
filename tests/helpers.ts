import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../src/db/migrate.js";
import type { DB } from "../src/db/index.js";

const migrationsDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/db/migrations",
);

export function testDb(): DB {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db, migrationsDir);
  return db;
}
