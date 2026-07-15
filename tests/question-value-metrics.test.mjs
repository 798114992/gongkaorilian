import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  QUESTION_VALUE_METRICS_SQL,
  questionValueMetricBindsForBank,
  questionValueMetricBindsForReview,
} from "../app/api/app/question-value-metrics-sql.mjs";

function createMetricDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE questions (
      id INTEGER PRIMARY KEY,
      question_code TEXT NOT NULL,
      subject TEXT NOT NULL DEFAULT '行测',
      source_exam_type TEXT NOT NULL,
      source_region TEXT NOT NULL,
      module TEXT NOT NULL,
      sub_type TEXT NOT NULL DEFAULT '',
      source_batch TEXT NOT NULL,
      source_year INTEGER NOT NULL,
      truth_verified INTEGER NOT NULL DEFAULT 0,
      review_status TEXT NOT NULL DEFAULT 'pending_review',
      status TEXT NOT NULL DEFAULT 'active',
      version INTEGER NOT NULL DEFAULT 1,
      frequency TEXT NOT NULL DEFAULT '',
      frequency_occurrences INTEGER NOT NULL DEFAULT 0,
      frequency_papers INTEGER NOT NULL DEFAULT 0,
      frequency_years_json TEXT NOT NULL DEFAULT '[]',
      frequency_updated_at TEXT,
      importance_stars INTEGER NOT NULL DEFAULT 0,
      importance_rule_version TEXT NOT NULL DEFAULT '',
      importance_reason TEXT NOT NULL DEFAULT '',
      importance_override_reason TEXT NOT NULL DEFAULT '',
      updated_at TEXT
    );
    CREATE TABLE question_bank_items (
      bank_id INTEGER NOT NULL,
      question_id INTEGER NOT NULL,
      PRIMARY KEY (bank_id, question_id)
    );
  `);
  return db;
}

test("set-based value metric recompute handles 100+ questions in one point and 50+ points", () => {
  const db = createMetricDatabase();
  const year = new Date().getFullYear();
  const insertQuestion = db.prepare(`INSERT INTO questions
    (id, question_code, source_exam_type, source_region, module, sub_type, source_batch, source_year,
      truth_verified, review_status, status, version, importance_stars, importance_rule_version,
      importance_reason, importance_override_reason)
    VALUES (?, ?, '省考', '广东', '判断推理', ?, ?, ?, 1, 'approved', 'active', 1, ?, ?, ?, ?)`);
  const addToBank = db.prepare("INSERT INTO question_bank_items (bank_id, question_id) VALUES (1, ?)");

  let id = 1;
  // One knowledge point has 125 real-question rows over five distinct papers.
  for (let index = 0; index < 125; index += 1) {
    const paper = index % 5;
    const manual = index === 0;
    insertQuestion.run(id, `dense-${id}`, "图形推理", `GD-${year - paper}`, year - paper,
      manual ? 2 : 0, manual ? "manual-v1" : "", manual ? "人工复核" : "", manual ? "保留人工覆盖" : "");
    addToBank.run(id);
    id += 1;
  }
  // Fifty-nine more knowledge points share an existing paper, taking the
  // total to sixty groups without increasing the five-paper denominator.
  for (let group = 1; group < 60; group += 1) {
    insertQuestion.run(id, `sparse-${group}`, `知识点-${group}`, `GD-${year}`, year,
      0, "", "", "");
    addToBank.run(id);
    id += 1;
  }

  const binds = questionValueMetricBindsForBank(1, year - 4, year - 2);
  assert.equal(binds.length, 7, "query bind count must stay fixed regardless of data volume");
  assert.doesNotMatch(QUESTION_VALUE_METRICS_SQL, /id IN \(\s*\?(?:\s*,\s*\?)+/i);
  db.prepare(QUESTION_VALUE_METRICS_SQL).run(...binds);

  const dense = db.prepare("SELECT * FROM questions WHERE question_code = 'dense-2'").get();
  assert.equal(dense.frequency, "高频");
  assert.equal(dense.frequency_occurrences, 5);
  assert.equal(dense.frequency_papers, 5);
  assert.deepEqual(JSON.parse(dense.frequency_years_json), [year, year - 1, year - 2, year - 3, year - 4]);
  assert.equal(dense.importance_stars, 5);
  assert.equal(dense.importance_rule_version, "importance-v1");
  assert.match(dense.importance_reason, /5\/5/);

  const sparse = db.prepare("SELECT * FROM questions WHERE question_code = 'sparse-59'").get();
  assert.equal(sparse.frequency, "低频");
  assert.equal(sparse.frequency_occurrences, 1);
  assert.equal(sparse.frequency_papers, 5);
  assert.equal(sparse.importance_stars, 1);

  const manual = db.prepare("SELECT * FROM questions WHERE question_code = 'dense-1'").get();
  assert.equal(manual.importance_stars, 2);
  assert.equal(manual.importance_rule_version, "manual-v1");
  assert.equal(manual.importance_reason, "人工复核");
  assert.equal(manual.importance_override_reason, "保留人工覆盖");

  const summary = db.prepare(`SELECT COUNT(DISTINCT sub_type) AS point_count,
    COUNT(*) AS updated_count FROM questions WHERE frequency_updated_at IS NOT NULL`).get();
  assert.equal(summary.point_count, 60);
  assert.equal(summary.updated_count, 184);
  db.close();
});

test("review-mode recompute is gated by the committed approved version", () => {
  const db = createMetricDatabase();
  const year = new Date().getFullYear();
  db.exec(`INSERT INTO questions
    (id, question_code, source_exam_type, source_region, module, sub_type, source_batch, source_year,
      truth_verified, review_status, status, version)
    VALUES (1, 'reviewed', '省考', '广东', '言语理解', '成语', 'GD-${year}', ${year}, 0, 'pending_review', 'active', 1);
    INSERT INTO question_bank_items (bank_id, question_id) VALUES (9, 1);`);

  db.prepare(QUESTION_VALUE_METRICS_SQL)
    .run(...questionValueMetricBindsForReview(1, 2, year - 4, year - 2));
  assert.equal(db.prepare("SELECT frequency FROM questions WHERE id = 1").get().frequency, "");

  db.exec("UPDATE questions SET truth_verified=1, review_status='approved', version=2 WHERE id=1");
  db.prepare(QUESTION_VALUE_METRICS_SQL)
    .run(...questionValueMetricBindsForReview(1, 2, year - 4, year - 2));
  assert.equal(db.prepare("SELECT frequency FROM questions WHERE id = 1").get().frequency, "高频");
  db.close();
});

test("question review schedules metric recompute inside the same atomic D1 batch", () => {
  const route = readFileSync(new URL("../app/api/app/route.ts", import.meta.url), "utf8");
  const review = route.slice(route.indexOf("async function adminReviewQuestion"), route.indexOf("async function sha256Text"));
  const enqueueAt = review.indexOf("statements.push(db.prepare(QUESTION_VALUE_METRICS_SQL)");
  const commitAt = review.indexOf("const results = await db.batch(statements)");
  assert.ok(enqueueAt > 0 && enqueueAt < commitAt, "metric statement must be part of the review batch");
  assert.doesNotMatch(review.slice(commitAt), /recomputeQuestionValueMetrics|QUESTION_VALUE_METRICS_SQL/,
    "a successful review must not be followed by a fallible synchronous recompute");
});

test("value metrics isolate 行测 and 申论 paper denominators in the same exam scope", () => {
  const db = createMetricDatabase();
  const year = new Date().getFullYear();
  const insert = db.prepare(`INSERT INTO questions
    (id, question_code, subject, source_exam_type, source_region, module, sub_type,
      source_batch, source_year, truth_verified, review_status, status)
    VALUES (?, ?, ?, 'provincial', '广东', ?, ?, ?, ?, 1, 'approved', 'active')`);
  for (let index = 0; index < 5; index += 1) {
    insert.run(index + 1, `apt-${index}`, "行测", "判断推理", "图形推理", `GD-${year - index}-XC`, year - index);
    insert.run(index + 101, `essay-${index}`, "申论", "申论", `主题-${index}`, `GD-${year - index}-SL`, year - index);
  }
  db.prepare("INSERT INTO question_bank_items (bank_id, question_id) VALUES (1, 1)").run();
  db.prepare(QUESTION_VALUE_METRICS_SQL).run(...questionValueMetricBindsForBank(1, year - 4, year - 2));
  const aptitude = db.prepare("SELECT frequency_occurrences, frequency_papers, importance_reason FROM questions WHERE id=1").get();
  assert.equal(aptitude.frequency_occurrences, 5);
  assert.equal(aptitude.frequency_papers, 5);
  assert.match(aptitude.importance_reason, /5\/5/);
  const essay = db.prepare("SELECT frequency_updated_at FROM questions WHERE id=101").get();
  assert.equal(essay.frequency_updated_at, null, "an unrelated subject must not enter the selected bank scope");
  db.close();
});
