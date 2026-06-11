import { createInterface } from "node:readline/promises";
import { getDb } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { AuthService } from "../modules/auth/service.js";

const db = getDb();
runMigrations(db);

const rl = createInterface({ input: process.stdin, output: process.stdout });
const password = await rl.question("New admin password: ");
rl.close();

if (password.trim().length < 8) {
  console.error("Password must be at least 8 characters.");
  process.exit(1);
}

new AuthService(db).setAdminPassword(password.trim());
console.log("Admin password set. Log in at /admin/login");
