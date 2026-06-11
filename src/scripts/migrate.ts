import { getDb } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";

const ran = runMigrations(getDb());
console.log(ran.length > 0 ? `Applied migrations:\n${ran.join("\n")}` : "Database is up to date.");
