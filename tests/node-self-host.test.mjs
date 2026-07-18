import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the self-host target has durable SQLite, media storage and repeatable migrations", async () => {
  const [vite, runtime, migration, installer] = await Promise.all([
    readFile(new URL("../vite.config.ts", import.meta.url), "utf8"),
    readFile(new URL("../runtime/sqlite-runtime.ts", import.meta.url), "utf8"),
    readFile(new URL("../scripts/migrate-node.mjs", import.meta.url), "utf8"),
    readFile(new URL("../deploy/install-aliyun.sh", import.meta.url), "utf8"),
  ]);

  assert.match(vite, /DEPLOY_TARGET === "node"/);
  assert.match(vite, /external: \["better-sqlite3"\]/);
  assert.match(runtime, /journal_mode = WAL/);
  assert.match(runtime, /busy_timeout = 5000/);
  assert.match(runtime, /Invalid media object key/);
  assert.match(migration, /__local_migrations/);
  assert.match(installer, /systemctl enable --now gongkaorilian/);
  assert.match(installer, /gongkaorilian-backup\.timer/);
  assert.match(installer, /proxy_pass http:\/\/127\.0\.0\.1:3000/);
});
