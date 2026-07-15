import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

function section(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `missing ${start}`);
  return source.slice(from, to);
}

function preparedAfter(source, marker) {
  const prefix = `db.prepare(\`${marker}`;
  const start = source.indexOf(prefix);
  assert.notEqual(start, -1, `missing SQL ${marker}`);
  const sqlStart = start + "db.prepare(`".length;
  const end = source.indexOf("`)", sqlStart);
  assert.notEqual(end, -1, `unterminated SQL ${marker}`);
  return source.slice(sqlStart, end);
}

test("expired question-import cancellation is durably reaped and no longer blocks its bank", async () => {
  const route = await readFile(new URL("../app/api/app/route.ts", import.meta.url), "utf8");
  const reaper = section(route, "async function reapImportCancellation", "async function dispatchDueImportWork");
  const dispatcher = section(route, "async function dispatchDueImportWork", "async function processQuestionImport");
  const dueSql = preparedAfter(dispatcher, "SELECT kind, id, total_chunks, due_at FROM");
  const cancelChunksSql = preparedAfter(reaper, "UPDATE question_import_chunks SET status = 'cancelled'");
  const cancelJobSql = preparedAfter(reaper, "UPDATE question_imports SET status = 'cancelled'");
  assert.match(dispatcher, /job\.kind === "question_cancel"/);
  assert.match(dispatcher, /job\.kind === "content_cancel"/);
  assert.match(dispatcher, /reapImportCancellationInternal/);
  assert.doesNotMatch(dispatcher, /UPDATE question_import_chunks SET status = 'cancelled'/,
    "ordinary requests must only spend the due scan and dispatch cleanup to a fresh Worker");
  assert.match(reaper, /refreshContentImportProgress\(importId\)/);
  assert.match(route, /internalAction === "reapImportCancellationInternal"/);

  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE question_imports (
      id INTEGER PRIMARY KEY, total_chunks INTEGER NOT NULL DEFAULT 1, cancel_requested INTEGER NOT NULL,
      status TEXT NOT NULL, lease_token TEXT, lease_until TEXT, updated_at TEXT, created_at TEXT,
      completed_at TEXT
    );
    CREATE TABLE question_import_chunks (
      import_id INTEGER NOT NULL, status TEXT NOT NULL, rows_json TEXT NOT NULL, updated_at TEXT
    );
    CREATE TABLE content_imports (
      id INTEGER PRIMARY KEY, total_chunks INTEGER, cancel_requested INTEGER, status TEXT,
      next_retry_at TEXT, sealed_at TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE content_import_chunks (
      import_id INTEGER, status TEXT, lease_until TEXT
    );
    INSERT INTO question_imports VALUES
      (7,1,1,'cancelling','dead-lease',datetime('now','-1 minute'),CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,NULL);
    INSERT INTO question_import_chunks VALUES (7,'processing','[{"questionCode":"Q-1"}]',CURRENT_TIMESTAMP);
  `);
  const due = db.prepare(dueSql).get();
  assert.equal(due.kind, "question_cancel");
  assert.equal(due.id, 7);
  db.exec("BEGIN");
  try {
    db.prepare(cancelChunksSql).run(7, 7);
    db.prepare(cancelJobSql).run(7);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  assert.deepEqual({ ...db.prepare("SELECT status,lease_token,lease_until FROM question_imports WHERE id=7").get() },
    { status: "cancelled", lease_token: null, lease_until: null });
  assert.deepEqual({ ...db.prepare("SELECT status,rows_json FROM question_import_chunks WHERE import_id=7").get() },
    { status: "cancelled", rows_json: "[]" });
  db.close();
});
