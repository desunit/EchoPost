import { runMigrations } from "../db/migrate.js";
import { getDb } from "../db/index.js";
import { backupDatabase, verifyLatestBackup } from "../scripts-lib/backup.js";

runMigrations(getDb());
const file = backupDatabase();
console.log(`Backup written: ${file}`);
const check = verifyLatestBackup();
console.log(check.ok ? `Verified: ${check.details}` : `VERIFICATION FAILED: ${check.details}`);
process.exit(check.ok ? 0 : 1);
