import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { inspectQuestionBankIdentityChange } from "../app/api/app/question-bank-policy.mjs";

const routeFile = new URL("../app/api/app/route.ts", import.meta.url);
const managerFile = new URL("../app/admin/QuestionBankManager.tsx", import.meta.url);

const [route, manager] = await Promise.all([
  readFile(routeFile, "utf8"),
  readFile(managerFile, "utf8"),
]);

function section(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0, `missing section start: ${start}`);
  assert.ok(to > from, `missing section end: ${end}`);
  return source.slice(from, to);
}

test("every QuestionBankManager admin action has a permission and dispatcher registration", () => {
  const actions = [...new Set([...manager.matchAll(/action:\s*"(admin[A-Za-z0-9]+)"/g)].map((match) => match[1]))];
  assert.ok(actions.length >= 15, "expected the complete bank/import/question action surface");
  for (const action of actions) {
    assert.match(route, new RegExp(`\\b${action}: \\[`), `${action} must declare an admin permission`);
    assert.match(route, new RegExp(`action === "${action}"`), `${action} must be dispatched by the API`);
  }
});

test("single-question actions enforce read/write permission, optimistic versions and snapshots", () => {
  const search = section(route, "async function adminSearchQuestions(", "function sameNumberList");
  const upsert = section(route, "async function adminUpsertQuestion(", "async function adminSetQuestionStatus(");
  const status = section(route, "async function adminSetQuestionStatus(", "async function adminStartContentImport(");

  assert.match(search, /canAdmin\(payload, "question\.read"\)/);
  assert.match(upsert, /canAdmin\(payload, "question\.write"\)/);
  assert.match(status, /canAdmin\(payload, "question\.write"\)/);
  assert.match(upsert, /expectedVersion/);
  assert.match(upsert, /WHERE id = \? AND version = \?/);
  assert.match(upsert, /version = version \+ 1/);
  assert.match(upsert, /truth_verified = 0/);
  assert.match(upsert, /review_status = 'pending_review'/);
  assert.match(upsert, /INSERT OR IGNORE INTO question_versions/);
  assert.ok([...upsert.matchAll(/INSERT OR IGNORE INTO question_versions/g)].length >= 2);
  assert.match(status, /WHERE id = \? AND version = \?/);
  assert.match(status, /change_type, from_version, admin_user_id, review_status/);
  assert.match(status, /'status'/);
});

test("question rollback is optimistic and keeps dependent mutations in one guarded batch", () => {
  const rollback = section(route, "async function adminRollbackQuestionVersion(", "function adminPublicShape");

  assert.match(manager, /adminRollbackQuestionVersion", questionId, version, expectedVersion/);
  assert.match(rollback, /payload\.expectedVersion/);
  assert.match(rollback, /Number\(live\.version\) !== expectedVersion/);
  assert.match(rollback, /code: "QUESTION_VERSION_CONFLICT"/);
  assert.match(rollback, /WHERE id = \? AND version = \?/);
  assert.match(rollback, /INSERT INTO question_versions[\s\S]*changes\(\) = 1/);
  assert.match(rollback, /UPDATE practice_sessions[\s\S]*WHERE changes\(\) = 1/);
  assert.match(rollback, /const results = await db\.batch\(\[/);
  assert.match(rollback, /if \(!results\[0\]\?\.meta\.changes\)/);
});

test("stale rollback cannot write history or abandon a practice session", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE questions (id INTEGER PRIMARY KEY, question_code TEXT NOT NULL, version INTEGER NOT NULL, stem TEXT NOT NULL);
    CREATE TABLE question_versions (question_id INTEGER NOT NULL, version INTEGER NOT NULL, snapshot_json TEXT NOT NULL,
      change_type TEXT NOT NULL, UNIQUE(question_id, version));
    CREATE TABLE practice_sessions (id TEXT PRIMARY KEY, status TEXT NOT NULL, question_codes_json TEXT NOT NULL);
    INSERT INTO questions VALUES (1, 'Q-1', 1, 'current');
    INSERT INTO practice_sessions VALUES ('first', 'active', '["Q-1"]');
  `);

  const rollback = (expectedVersion, snapshot) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const updated = db.prepare("UPDATE questions SET stem = ?, version = version + 1 WHERE id = 1 AND version = ?")
        .run(snapshot, expectedVersion);
      db.prepare(`INSERT INTO question_versions (question_id, version, snapshot_json, change_type)
        SELECT id, version, ?, 'rollback' FROM questions WHERE id = 1 AND version = ? AND changes() = 1`)
        .run(snapshot, expectedVersion + 1);
      db.prepare(`UPDATE practice_sessions SET status = 'abandoned'
        WHERE changes() = 1 AND status = 'active'
          AND EXISTS (SELECT 1 FROM json_each(question_codes_json) WHERE value = 'Q-1')`).run();
      db.exec("COMMIT");
      return Number(updated.changes);
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };

  assert.equal(rollback(1, "restored"), 1);
  assert.equal(db.prepare("SELECT version FROM questions WHERE id = 1").get().version, 2);
  assert.equal(db.prepare("SELECT status FROM practice_sessions WHERE id = 'first'").get().status, "abandoned");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM question_versions").get().count, 1);

  db.exec("INSERT INTO practice_sessions VALUES ('stale', 'active', '[\"Q-1\"]')");
  assert.equal(rollback(1, "stale overwrite"), 0);
  assert.equal(db.prepare("SELECT stem FROM questions WHERE id = 1").get().stem, "restored");
  assert.equal(db.prepare("SELECT status FROM practice_sessions WHERE id = 'stale'").get().status, "active");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM question_versions").get().count, 1);
});

test("question identifiers and bank codes are immutable while disabled questions stay out of new groups", () => {
  const bank = section(route, "async function adminUpsertQuestionBank(", "async function adminSetQuestionBankStatus(");
  const upsert = section(route, "async function adminUpsertQuestion(", "async function adminSetQuestionStatus(");
  const candidates = section(route, "async function dbQuestionCandidates(", "async function getPracticeBatch(");

  assert.match(bank, /题库编码创建后永久不可修改/);
  assert.match(bank, /QUESTION_BANK_IDENTITY_LOCKED/);
  assert.match(bank, /question_imports/);
  assert.match(bank, /user_question_banks/);
  assert.match(bank, /practice_sessions ps WHERE ps\.status = 'active'/);
  assert.doesNotMatch(bank, /UPDATE question_banks SET bank_code/);
  assert.match(upsert, /题目编号创建后不可修改/);
  assert.doesNotMatch(upsert, /UPDATE questions SET question_code/);
  assert.match(candidates, /WHERE q\.status = 'active'/);
});

test("API bank identity policy only permits scope changes on a dependency-free draft", () => {
  const emptyDraft = {
    bankCode: "GD-XC-2027", examType: "provincial", province: "广东", examYear: 2027,
    subject: "行测", status: "draft", questionCount: 0, importCount: 0, selectionCount: 0, activeSessionCount: 0,
  };
  const changedScope = { bankCode: "GD-XC-2027", examType: "provincial", province: "浙江", examYear: 2028, subject: "申论" };
  assert.equal(inspectQuestionBankIdentityChange(emptyDraft, changedScope).locked, false);

  const dependencyCases = [
    ["published", { status: "published" }],
    ["question", { questionCount: 1 }],
    ["import", { importCount: 1 }],
    ["selection", { selectionCount: 1 }],
    ["session", { activeSessionCount: 1 }],
  ];
  for (const [label, dependency] of dependencyCases) {
    const result = inspectQuestionBankIdentityChange({ ...emptyDraft, ...dependency }, changedScope);
    assert.equal(result.locked, true, `${label} must lock scope identity`);
    assert.deepEqual(result.lockedFields, ["省份", "科目", "适用年份"]);
    assert.ok(result.lockReasons.length > 0);
  }

  const renamed = inspectQuestionBankIdentityChange(emptyDraft, { ...emptyDraft, bankCode: "GD-XC-2028" });
  assert.equal(renamed.locked, true);
  assert.deepEqual(renamed.lockedFields, ["题库编码"]);
});

test("single-question UI is enabled and cannot hand-edit frequency or platform score rate", () => {
  assert.match(manager, /ENABLE_SINGLE_QUESTION_ADMIN = true/);
  assert.match(manager, /expectedVersion: editingQuestion\.version/);
  assert.match(manager, /expectedVersion: question\.version/);
  assert.match(manager, /考频（系统）<input[^>]+disabled/);
  assert.match(manager, /拿分率（系统）<input[^>]+disabled/);
  assert.match(manager, /importanceOverrideReason/);
  assert.match(manager, /人工调整重要星级时，请填写至少5个字的覆盖理由/);
  assert.match(manager, /disabled=\{Boolean\(editingBankId\)\}/);
  assert.match(manager, /editingBankIdentityLocked/);
  assert.match(manager, /范围变化请复制为新题库/);
});
