import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config/index.js";

export type DB = Database.Database;

let instance: DB | null = null;

export function getDb(): DB {
  if (instance) return instance;
  fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
  instance = new Database(config.databasePath);
  instance.pragma("journal_mode = WAL");
  instance.pragma("foreign_keys = ON");
  instance.pragma("busy_timeout = 5000");
  instance.pragma("synchronous = NORMAL");
  return instance;
}

export function closeDb(): void {
  instance?.close();
  instance = null;
}

/** For tests: in-memory database with the same pragmas. */
export function createTestDb(): DB {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  return db;
}
