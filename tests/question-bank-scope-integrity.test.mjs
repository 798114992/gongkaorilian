import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  QUESTION_BANK_CAN_PUBLISH_SQL,
  questionMatchesQuestionBankScope,
} from "../app/api/app/question-bank-policy.mjs";

function scopeDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE question_banks (
      id INTEGER PRIMARY KEY, exam_type TEXT NOT NULL, province TEXT NOT NULL,
      subject TEXT NOT NULL, status TEXT NOT NULL
    );
    CREATE TABLE questions (
      id INTEGER PRIMARY KEY, status TEXT NOT NULL, truth_verified INTEGER NOT NULL,
      review_status TEXT NOT NULL, source TEXT NOT NULL, source_region TEXT NOT NULL,
      source_year INTEGER, source_batch TEXT NOT NULL, explanation TEXT NOT NULL,
      subject TEXT NOT NULL, source_exam_type TEXT NOT NULL, options_json TEXT NOT NULL,
      answer TEXT NOT NULL
    );
    CREATE TABLE question_bank_items (bank_id INTEGER NOT NULL, question_id INTEGER NOT NULL);
    CREATE TABLE question_imports (bank_id INTEGER NOT NULL, status TEXT NOT NULL);
    INSERT INTO question_banks VALUES (1,'provincial','广东省','行测','draft');
    INSERT INTO questions VALUES
      (1,'active',1,'approved','广东-2024','广东',2024,'GD-2024-XC-A','完整解析','行测','provincial','["甲","乙","丙","丁"]','B');
    INSERT INTO question_bank_items VALUES (1,1);
  `);
  return db;
}

function canPublish(db) {
  return Number(db.prepare(`SELECT ${QUESTION_BANK_CAN_PUBLISH_SQL} AS allowed FROM question_banks qb WHERE qb.id=1`).get().allowed);
}

test("question-bank scope normalizes province names and supports intentional multi-exam collections", () => {
  assert.equal(questionMatchesQuestionBankScope(
    { examType: "provincial", province: "广东省", subject: "行测" },
    { sourceExamType: "provincial", region: "广东", subject: "行测" },
  ), true);
  assert.equal(questionMatchesQuestionBankScope(
    { examType: "provincial", province: "广东", subject: "行测" },
    { sourceExamType: "provincial", region: "浙江", subject: "行测" },
  ), false);
  assert.equal(questionMatchesQuestionBankScope(
    { examType: "special", province: "多省", subject: "综合" },
    { sourceExamType: "provincial", region: "山东", subject: "申论" },
  ), true);
});

test("the single publish predicate rejects malformed, cross-region and importing banks without throwing", () => {
  const db = scopeDatabase();
  assert.equal(canPublish(db), 1);
  db.exec("UPDATE questions SET options_json='not-json' WHERE id=1");
  assert.equal(canPublish(db), 0, "malformed option JSON must fail closed instead of crashing publication");
  db.exec("UPDATE questions SET options_json='[\"甲\",\"乙\"]', source_region='浙江' WHERE id=1");
  assert.equal(canPublish(db), 0, "a Guangdong bank cannot publish a Zhejiang question");
  db.exec("UPDATE questions SET source_region='广东'; INSERT INTO question_imports VALUES (1,'processing')");
  assert.equal(canPublish(db), 0, "publishing and an active import must be mutually exclusive");
  db.close();
});

test("learner load, review, import and publish paths all reference the centralized bank-scope policy", async () => {
  const [route, policy] = await Promise.all([
    readFile(new URL("../app/api/app/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/app/question-bank-policy.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(policy, /QUESTION_BANK_SCOPE_MATCH_SQL/);
  assert.match(route, /QUESTION_BANK_PUBLISHABLE_ITEM_SQL/);
  assert.match(route, /QUESTION_BANK_CAN_PUBLISH_SQL/);
  assert.match(route, /questionMatchesQuestionBankScope/);
  assert.match(route, /WHERE qb\.id = \? AND \$\{QUESTION_BANK_CAN_PUBLISH_SQL\}/);
});
