import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const routeFile = new URL("../app/api/app/route.ts", import.meta.url);
const runtimeFile = new URL("../db/runtime.ts", import.meta.url);

function functionBody(source, name) {
  const start = source.indexOf(`async function ${name}`);
  assert.notEqual(start, -1, `missing function ${name}`);
  const opening = source.indexOf("{", start);
  let depth = 0;
  for (let index = opening; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(opening + 1, index);
  }
  throw new Error(`unterminated function ${name}`);
}

function preparedSql(source, marker) {
  const prefix = `db.prepare(\`${marker}`;
  const start = source.indexOf(prefix);
  assert.notEqual(start, -1, `missing SQL ${marker}`);
  const sqlStart = start + "db.prepare(`".length;
  const end = source.indexOf("`)", sqlStart);
  assert.notEqual(end, -1, `unterminated SQL ${marker}`);
  return source.slice(sqlStart, end);
}

function createTableSql(runtime, table) {
  const marker = `CREATE TABLE IF NOT EXISTS ${table} (`;
  const start = runtime.indexOf(marker);
  assert.notEqual(start, -1, `missing ${table} runtime table`);
  const end = runtime.indexOf("`)", start);
  assert.notEqual(end, -1, `unterminated ${table} runtime table`);
  return runtime.slice(start, end);
}

test("a 200-code admin batch uses one atomic JSON insert and remains collision-safe", async () => {
  const [route, runtime] = await Promise.all([readFile(routeFile, "utf8"), readFile(runtimeFile, "utf8")]);
  const createCodes = functionBody(route, "adminCreateCodes");
  assert.match(createCodes, /count > 200/);
  assert.match(createCodes, /while \(plainCodes\.length < count\)/);
  assert.match(createCodes, /Promise\.all\(plainCodes\.map/);
  assert.match(createCodes, /const maxInsertAttempts = 3/);
  assert.match(createCodes, /FROM json_each\(\?\) AS generated/);
  assert.doesNotMatch(createCodes, /INSERT OR IGNORE INTO redemption_codes/);

  const insertSql = preparedSql(createCodes, "INSERT INTO redemption_codes");
  assert.equal((insertSql.match(/\?/g) ?? []).length, 8, "the statement must use a bounded parameter count");

  const db = new DatabaseSync(":memory:");
  db.exec(createTableSql(runtime, "redemption_codes"));
  const generated = Array.from({ length: 200 }, (_, index) => ({
    codeHash: index.toString(16).padStart(64, "0"),
    codePreview: `TEST-****-${String(index).padStart(4, "0")}`,
  }));
  db.prepare(insertSql).run("capacity-test", "duration", 365, "manual", "admin", 1, null, JSON.stringify(generated));

  const summary = db.prepare(`SELECT COUNT(*) AS count, COUNT(DISTINCT code_hash) AS unique_count,
    MIN(batch_name) AS batch_name, MIN(grant_type) AS grant_type, MIN(duration_days) AS duration_days,
    MIN(channel) AS channel, MIN(created_by) AS created_by, MIN(max_uses) AS max_uses FROM redemption_codes`).get();
  assert.deepEqual({ ...summary }, {
    count: 200,
    unique_count: 200,
    batch_name: "capacity-test",
    grant_type: "duration",
    duration_days: 365,
    channel: "manual",
    created_by: "admin",
    max_uses: 1,
  });

  const conflicting = Array.from({ length: 200 }, (_, index) => ({
    codeHash: index === 100 ? generated[0].codeHash : `next-${index}`,
    codePreview: `NEXT-****-${String(index).padStart(4, "0")}`,
  }));
  assert.throws(() => db.prepare(insertSql)
    .run("collision-test", "duration", 30, "manual", "admin", 1, null, JSON.stringify(conflicting)),
  /UNIQUE constraint failed: redemption_codes\.code_hash/);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM redemption_codes").get().count, 200,
    "a conflict must roll back every row in the attempted export");
});
