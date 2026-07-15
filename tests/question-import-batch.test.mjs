import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const routeFile = new URL("../app/api/app/route.ts", import.meta.url);
const runtimeFile = new URL("../db/runtime.ts", import.meta.url);
const managerFile = new URL("../app/admin/QuestionBankManager.tsx", import.meta.url);

function createTableSql(runtime, table) {
  const marker = `CREATE TABLE IF NOT EXISTS ${table} (`;
  const start = runtime.indexOf(marker);
  assert.notEqual(start, -1, `missing ${table} runtime table`);
  const end = runtime.indexOf("`)", start);
  assert.notEqual(end, -1, `unterminated ${table} runtime table`);
  return runtime.slice(start, end);
}

function acceptedBatchSql(route, marker) {
  const anchor = route.indexOf("const acceptedJson = JSON.stringify(accepted.map");
  assert.notEqual(anchor, -1, "missing accepted import payload");
  const prefix = `db.prepare(\`${marker}`;
  const start = route.indexOf(prefix, anchor);
  assert.notEqual(start, -1, `missing import statement: ${marker}`);
  const sqlStart = start + "db.prepare(`".length;
  const end = route.indexOf("`)", sqlStart);
  assert.notEqual(end, -1, `unterminated import statement: ${marker}`);
  return route.slice(sqlStart, end)
    .replaceAll("${QUESTION_IMPORT_WRITE_GUARD_SQL}", templateConstant(route, "QUESTION_IMPORT_WRITE_GUARD_SQL"))
    .replaceAll("${QUESTION_IMPORT_POST_STATE_SQL}", templateConstant(route, "QUESTION_IMPORT_POST_STATE_SQL"));
}

function templateConstant(route, name) {
  const prefix = `const ${name} = \``;
  const start = route.indexOf(prefix);
  assert.notEqual(start, -1, `missing ${name}`);
  const sqlStart = start + prefix.length;
  const end = route.indexOf("`;", sqlStart);
  assert.notEqual(end, -1, `unterminated ${name}`);
  return route.slice(sqlStart, end);
}

function importedQuestion(questionCode, stem) {
  return {
    questionCode,
    subject: "行测",
    module: "判断推理",
    subType: "图形推理",
    stem,
    options: ["甲", "乙", "丙", "丁"],
    answer: "B",
    explanation: "排除后选择乙。",
    technique: "先看位置，再看数量。",
    material: "",
    prompt: "",
    wordLimit: null,
    scoringPoints: [],
    difficulty: "中等",
    source: "广东省考真题",
    sourceExamType: "provincial",
    sourceBatch: "GD-2024-A",
    region: "广东",
    examYear: 2024,
    truthVerified: false,
    reviewStatus: "pending_review",
    frequency: "高频",
    frequencyOccurrences: 3,
    frequencyPapers: 4,
    frequencyYears: [2024, 2023, 2022],
    frequencyUpdatedAt: "2026-07-15T00:00:00.000Z",
    importanceStars: 4,
    importanceRuleVersion: "importance-v1",
    importanceReason: "近三年持续出现",
    importanceOverrideReason: "",
    scoreRate: 60,
    scoreRateCorrect: 60,
    scoreRateAttempts: 100,
    scoreRateScope: "外部首答样本",
    scoreRateSource: "https://example.com/stats",
    scoreRateUpdatedAt: "2026-07-15T00:00:00.000Z",
    suggestedSeconds: 60,
    imageUrl: "",
    resourceUrl: "",
    status: "active",
  };
}

test("question import writes, reuses, versions and retries one JSON batch idempotently", async () => {
  const [route, runtime] = await Promise.all([
    readFile(routeFile, "utf8"),
    readFile(runtimeFile, "utf8"),
  ]);
  const db = new DatabaseSync(":memory:");
  for (const table of ["questions", "question_bank_items", "question_import_row_results", "question_versions"]) {
    db.exec(createTableSql(runtime, table));
  }
  db.exec(`
    CREATE UNIQUE INDEX question_bank_items_bank_question_uq ON question_bank_items(bank_id, question_id);
    CREATE UNIQUE INDEX question_import_row_results_import_row_uq ON question_import_row_results(import_id, row_number);
    CREATE UNIQUE INDEX question_versions_question_version_uq ON question_versions(question_id, version);
    CREATE UNIQUE INDEX question_versions_import_row_uq ON question_versions(import_id, source_row);
    CREATE TABLE question_banks (id INTEGER PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE question_imports (
      id INTEGER PRIMARY KEY, bank_id INTEGER NOT NULL, status TEXT NOT NULL,
      cancel_requested INTEGER NOT NULL DEFAULT 0, lease_token TEXT
    );
    CREATE TABLE question_import_chunks (
      id INTEGER PRIMARY KEY, import_id INTEGER NOT NULL, status TEXT NOT NULL
    );
    INSERT INTO question_banks VALUES (2,'draft');
    INSERT INTO question_imports VALUES (77,2,'processing',0,'lease-77');
    INSERT INTO question_import_chunks VALUES (5,77,'processing');
    INSERT INTO questions (question_code, subject, module, stem, source_region, source_year, version,
      truth_verified, review_status, source, source_exam_type, source_batch,
      sub_type, options_json, answer)
      VALUES ('UPD-001', '行测', '旧模块', '旧题干', '广东', 2023, 2, 1, 'approved', '旧来源', 'provincial', 'OLD', '', '[]', ''),
             ('REUSE-001', '行测', '判断推理', '保持不变', '广东', 2024, 5, 1, 'approved', '广东省考真题', 'provincial', 'GD-2024-A', '图形推理', '["甲","乙","丙","丁"]', 'B');
    INSERT INTO question_bank_items (bank_id, question_id, sort_order)
      SELECT 9, id, 0 FROM questions WHERE question_code = 'REUSE-001';
  `);

  const payload = JSON.stringify([
    { row: 2, mode: "write", expectedVersion: 0, question: importedQuestion("NEW-001", "新增题干") },
    { row: 3, mode: "write", expectedVersion: 2, question: importedQuestion("UPD-001", "更新题干") },
    { row: 4, mode: "reuse", expectedVersion: 5, question: importedQuestion("REUSE-001", "保持不变") },
  ]);
  assert.ok(Buffer.byteLength(payload) < 768 * 1024);

  const questionsSql = acceptedBatchSql(route, "INSERT INTO questions");
  const versionsSql = acceptedBatchSql(route, "INSERT OR IGNORE INTO question_versions");
  const banksSql = acceptedBatchSql(route, "INSERT OR IGNORE INTO question_bank_items");
  const resultsSql = acceptedBatchSql(route, "INSERT OR IGNORE INTO question_import_row_results");
  for (const sql of [questionsSql, versionsSql, banksSql, resultsSql]) {
    assert.ok((sql.match(/\?/g) ?? []).length <= 100, "D1 statement exceeds 100 bound parameters");
  }

  const runBatch = () => {
    db.exec("BEGIN");
    try {
      db.prepare(questionsSql).run(payload, 77, 5, 77, "lease-77",
        "replace_external_metrics", "replace_external_metrics", "replace_external_metrics",
        "replace_external_metrics", "replace_external_metrics", "replace_external_metrics");
      db.prepare(versionsSql).run(77, 12, payload, 77, 5, 77, "lease-77");
      db.prepare(banksSql).run(2, payload, 5, 77, "lease-77");
      db.prepare(resultsSql).run(77, 0, payload, 5, 77, "lease-77");
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };

  runBatch();
  const importedRows = db.prepare(`SELECT question_code, version, truth_verified, review_status FROM questions
    ORDER BY question_code`).all().map((row) => ({ ...row }));
  assert.deepEqual(importedRows, [
    { question_code: "NEW-001", version: 1, truth_verified: 0, review_status: "pending_review" },
    { question_code: "REUSE-001", version: 5, truth_verified: 1, review_status: "approved" },
    { question_code: "UPD-001", version: 3, truth_verified: 0, review_status: "pending_review" },
  ]);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM question_versions").get().count, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM question_bank_items WHERE bank_id = 2").get().count, 3);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM question_import_row_results WHERE import_id = 77").get().count, 3);

  // A repeated invocation sees durable row results and cannot increment versions again.
  runBatch();
  assert.equal(db.prepare("SELECT version FROM questions WHERE question_code = 'UPD-001'").get().version, 3);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM question_versions").get().count, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM question_import_row_results WHERE import_id = 77").get().count, 3);
});

test("question import stays inside D1 Free query, chunk and continuation budgets", async () => {
  const [route, manager] = await Promise.all([readFile(routeFile, "utf8"), readFile(managerFile, "utf8")]);
  assert.match(route, /QUESTION_IMPORT_CHUNK_ROWS = 80/);
  assert.match(route, /QUESTION_IMPORT_MAX_FILE_ROWS = 800/);
  assert.match(route, /QUESTION_IMPORT_MAX_CHUNKS_PER_FILE = 10/);
  assert.match(route, /QUESTION_IMPORT_UPLOAD_BYTES = 480 \* 1024/);
  assert.match(route, /QUESTION_IMPORT_MAX_BINDING_BYTES = 768 \* 1024/);
  assert.match(route, /QUESTION_IMPORT_D1_QUERY_LIMIT = 50/);
  assert.match(route, /QUESTION_IMPORT_D1_QUERY_RESERVE = 24/);
  assert.match(route, /QUESTION_IMPORT_CHUNK_QUERY_BUDGET = 15/);
  assert.match(route, /attemptedChunks < QUESTION_IMPORT_MAX_CHUNKS_PER_INVOCATION/);
  assert.match(route, /FROM json_each\(\?\) AS incoming/);
  const finishHandler = route.slice(
    route.indexOf("async function adminFinishQuestionImport"),
    route.indexOf("async function adminGetQuestionImport"),
  );
  const retryHandler = route.slice(
    route.indexOf("async function adminRetryQuestionImport"),
    route.indexOf("function csvCell"),
  );
  assert.match(finishHandler, /requestQuestionImportContinuation/);
  assert.doesNotMatch(finishHandler, /\(\) => processQuestionImport/);
  assert.match(retryHandler, /requestQuestionImportContinuation/);
  assert.doesNotMatch(retryHandler, /\(\) => processQuestionImport/);
  const post = route.slice(route.indexOf("export async function POST"));
  assert.ok(post.indexOf("request.headers.has(INTERNAL_IMPORT_HEADER)") < post.indexOf("await ensureSchema()"),
    "internal continuation must not spend its D1 budget on cold schema bootstrap");
  assert.doesNotMatch(route, /accepted\.slice\(/);
  assert.doesNotMatch(route, /for \(let offset = 0; offset < accepted\.length/);
  assert.match(manager, /IMPORT_MAX_FILE_ROWS = 800/);
  assert.match(manager, /IMPORT_MAX_CHUNKS_PER_FILE = 10/);
  assert.match(manager, /超出请按年份或地区拆分/);
});
