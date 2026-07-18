import Database from "better-sqlite3";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const databasePath = resolve(process.env.SQLITE_PATH || "./data/gongkaorilian.sqlite");
const migrationsPath = resolve("./drizzle");

await mkdir(dirname(databasePath), { recursive: true });
const database = new Database(databasePath);
database.pragma("journal_mode = WAL");
database.pragma("foreign_keys = ON");
database.pragma("busy_timeout = 5000");
database.exec(`CREATE TABLE IF NOT EXISTS __local_migrations (
  name TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`);

const applied = new Set(
  database.prepare("SELECT name FROM __local_migrations ORDER BY name").all().map((row) => row.name),
);
const files = (await readdir(migrationsPath))
  .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/i.test(name))
  .sort((left, right) => left.localeCompare(right));
const record = database.prepare("INSERT INTO __local_migrations (name) VALUES (?)");

for (const file of files) {
  if (applied.has(file)) continue;
  const sql = (await readFile(resolve(migrationsPath, file), "utf8"))
    .replaceAll("--> statement-breakpoint", "\n");
  database.transaction(() => {
    database.exec(sql);
    record.run(file);
  })();
  process.stdout.write(`Applied ${file}\n`);
}

database.close();
process.stdout.write(`Database ready: ${databasePath}\n`);
