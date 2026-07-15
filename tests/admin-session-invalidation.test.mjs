import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const routeFile = new URL("../app/api/app/route.ts", import.meta.url);
const clientFile = new URL("../app/DailyPracticeApp.tsx", import.meta.url);

function functionBody(source, name) {
  const start = source.indexOf(`function ${name}(`) >= 0
    ? source.indexOf(`function ${name}(`)
    : source.indexOf(`async function ${name}(`);
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

function preparedSql(source, functionName) {
  const body = functionBody(source, functionName);
  const match = body.match(/db\.prepare\(`([\s\S]*?)`\)/);
  assert.ok(match, `missing prepared SQL in ${functionName}`);
  return match[1];
}

test("admin bank and question changes invalidate only active sessions that reference changed content", async () => {
  const route = await readFile(routeFile, "utf8");
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE practice_sessions (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      bank_codes_json TEXT NOT NULL,
      question_codes_json TEXT NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE questions (
      id INTEGER PRIMARY KEY,
      question_code TEXT NOT NULL,
      version INTEGER NOT NULL,
      review_status TEXT NOT NULL,
      status TEXT NOT NULL
    );
    INSERT INTO questions VALUES (2,'Q-2',3,'pending_review','active');
    INSERT INTO practice_sessions (id,status,bank_codes_json,question_codes_json) VALUES
      ('bank-hit','active','["gd-2027","gk-2027"]','["Q-1"]'),
      ('question-hit','active','["gk-2027"]','["Q-2","Q-3"]'),
      ('unrelated','active','["gk-2027"]','["Q-4"]'),
      ('finished','completed','["gd-2027"]','["Q-2"]');
  `);

  db.prepare(preparedSql(route, "abandonActiveSessionsByBankCode")).run("gd-2027");
  assert.equal(db.prepare("SELECT status FROM practice_sessions WHERE id='bank-hit'").get().status, "abandoned");
  assert.equal(db.prepare("SELECT status FROM practice_sessions WHERE id='question-hit'").get().status, "active");
  assert.equal(db.prepare("SELECT status FROM practice_sessions WHERE id='finished'").get().status, "completed");

  const guardedQuestionSql = preparedSql(route, "abandonActiveSessionsByQuestionCode")
    .replace("${guard.sql}", "EXISTS (SELECT 1 FROM questions changed WHERE changed.id = ? AND changed.version = ? AND changed.review_status = ?)");
  db.prepare(guardedQuestionSql).run("Q-2", 2, 3, "pending_review");
  assert.equal(db.prepare("SELECT status FROM practice_sessions WHERE id='question-hit'").get().status, "abandoned");
  assert.equal(db.prepare("SELECT status FROM practice_sessions WHERE id='unrelated'").get().status, "active");
  assert.equal(db.prepare("SELECT status FROM practice_sessions WHERE id='finished'").get().status, "completed");

  db.exec("UPDATE practice_sessions SET status='active' WHERE id='question-hit'; UPDATE questions SET version=4 WHERE id=2");
  db.prepare(guardedQuestionSql).run("Q-2", 2, 3, "pending_review");
  assert.equal(db.prepare("SELECT status FROM practice_sessions WHERE id='question-hit'").get().status, "active",
    "a stale admin request must not invalidate a newer session");
});

test("every admin path that can remove a served question abandons old sessions and client recovers", async () => {
  const [route, client] = await Promise.all([readFile(routeFile, "utf8"), readFile(clientFile, "utf8")]);

  for (const name of ["adminUpsertQuestionBank", "adminSetQuestionBankStatus"]) {
    assert.match(functionBody(route, name), /abandonActiveSessionsByBankCode/);
  }
  for (const name of ["adminUpsertQuestion", "adminSetQuestionStatus"]) {
    assert.match(functionBody(route, name), /abandonActiveSessionsByQuestionCode/);
  }
  const rollback = functionBody(route, "adminRollbackQuestionVersion");
  assert.match(rollback, /UPDATE practice_sessions SET status = 'abandoned'/);
  assert.match(rollback, /json_each\(practice_sessions\.question_codes_json\)/);
  assert.match(rollback, /WHERE changes\(\) = 1/);
  const review = functionBody(route, "adminReviewQuestion");
  assert.match(review, /UPDATE practice_sessions SET status = 'abandoned'/);
  assert.match(review, /json_each\(practice_sessions\.question_codes_json\)/);
  assert.match(review, /review_status = 'rejected'/);
  assert.match(review, /await db\.batch\(statements\)/);
  const importChunk = functionBody(route, "processQuestionImportChunk");
  assert.match(importChunk, /UPDATE practice_sessions SET status = 'abandoned'/);
  assert.match(importChunk, /json_each\(practice_sessions\.question_codes_json\)/);
  assert.match(importChunk, /\$\.mode'\) = 'write'/);

  const submit = functionBody(route, "submitPracticeAnswer");
  assert.match(submit, /code: "PRACTICE_SESSION_INVALIDATED"/);
  assert.match(submit, /UPDATE practice_sessions SET status = 'abandoned'/);
  assert.match(client, /\["PRACTICE_SESSION_INVALIDATED", "PRACTICE_SESSION_ENTITLEMENT_CHANGED"\]\.includes\(apiErrorCode\(error\)\)/);
  assert.match(client, /pendingPracticeAttemptsRef\.current = remainingAttempts/);
  assert.match(client, /activePractice: null/);
  assert.match(client, /旧练习已结束；已完成记录仍保留/);
});
