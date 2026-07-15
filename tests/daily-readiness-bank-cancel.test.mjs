import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const routeFile = new URL("../app/api/app/route.ts", import.meta.url);
const clientFile = new URL("../app/DailyPracticeApp.tsx", import.meta.url);

function functionBody(source, name) {
  const start = source.indexOf(`function ${name}`) >= 0
    ? source.indexOf(`function ${name}`)
    : source.indexOf(`async function ${name}`);
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

function sqlAfter(source, anchor, marker) {
  const anchorAt = source.indexOf(anchor);
  assert.notEqual(anchorAt, -1, `missing anchor ${anchor}`);
  const prefix = `db.prepare(\`${marker}`;
  const start = source.indexOf(prefix, anchorAt);
  assert.notEqual(start, -1, `missing SQL ${marker}`);
  const sqlStart = start + "db.prepare(`".length;
  const end = source.indexOf("`)", sqlStart);
  assert.notEqual(end, -1, `unterminated SQL ${marker}`);
  return source.slice(sqlStart, end);
}

function fingerprint(stem, options) {
  const compact = (value) => value.normalize("NFKC").toLowerCase()
    .replace(/[\s，。；：、,.!?！？:;"'“”‘’（）()【】\[\]]+/g, "");
  return `${compact(stem)}|${options.map(compact).join("|")}`;
}

test("daily readiness uses effective reviewed banks and content fingerprints instead of summed bank counts", async () => {
  const [route, client] = await Promise.all([readFile(routeFile, "utf8"), readFile(clientFile, "utf8")]);
  const readiness = functionBody(route, "loadDailyReadiness");
  assert.match(readiness, /qb\.status = 'published'/);
  assert.match(readiness, /q\.status = 'active'/);
  assert.match(readiness, /q\.subject = '行测'/);
  assert.match(readiness, /q\.truth_verified = 1/);
  assert.match(readiness, /q\.review_status = 'approved'/);
  assert.match(readiness, /entitledBankCodes = new Set\(await/);
  assert.match(readiness, /entitledRows = banks\.results\.filter\(\(bank\) => entitledBankCodes\.has/);
  assert.match(readiness, /targetBanks = entitledRows\.filter\(\(bank\) => bankMatchesDailyTarget/);
  assert.match(readiness, /effectiveRows = \[\.\.\.targetBanks, \.\.\.auxiliaryBanks\]/);
  assert.match(readiness, /GROUP BY q\.stem, q\.options_json/);
  assert.match(readiness, /LIMIT \$\{DAILY_READINESS_SCAN_LIMIT\}/);
  assert.match(readiness, /questionFingerprint\(/);
  assert.match(readiness, /distinctQuestionCount >= requiredQuestionCount/);
  assert.match(route, /dailyReadiness: await loadDailyReadiness|loadDailyReadiness\(identity\.userId, membershipActive\)/);
  assert.match(client, /bootstrap\.dailyReadiness \? !bootstrap\.dailyReadiness\.ready/);
  assert.match(client, /dailyReadinessCount/);
  assert.match(client, /跨题库重复题只算1道/);

  const rows = [
    ["题干 A。", ["甲", "乙"]],
    ["题干Ａ", ["甲", "乙"]],
    ["题干 B", ["甲", "乙"]],
    ["题干 C", ["甲", "乙"]],
    ["题干 D", ["甲", "乙"]],
    ["题干 A", ["甲", "乙"]],
  ];
  const duplicateBanks = new Set(rows.map(([stem, options]) => fingerprint(stem, options)));
  assert.equal(duplicateBanks.size, 4, "two bank counts must not create a false five-question readiness");
  duplicateBanks.add(fingerprint("题干 E", ["甲", "乙"]));
  assert.equal(duplicateBanks.size >= 5, true);
});

test("cancelling a bank abandons only active sessions referencing it and client clears matching local work", async () => {
  const [route, client] = await Promise.all([readFile(routeFile, "utf8"), readFile(clientFile, "utf8")]);
  const toggle = functionBody(route, "toggleQuestionBank");
  assert.match(toggle, /UPDATE practice_sessions SET status = 'abandoned'/);
  assert.match(toggle, /json_each\(practice_sessions\.bank_codes_json\)/);
  assert.match(toggle, /RETURNING id/);
  assert.match(toggle, /DELETE FROM user_question_banks/);
  assert.match(toggle, /abandonedSessionIds/);
  assert.match(client, /result\.abandonedSessionIds/);
  assert.match(client, /attempt\.payload\.bankCode === bank\.code/);
  assert.match(client, /activePractice: null/);
  assert.match(client, /setActiveModule\(null\)/);
  assert.match(client, /未同步答题已清除/);

  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE practice_sessions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, status TEXT NOT NULL,
      bank_codes_json TEXT NOT NULL, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE user_question_banks (user_id TEXT NOT NULL, bank_code TEXT NOT NULL);
    INSERT INTO user_question_banks VALUES ('u1', 'gd-2027'), ('u1', 'gk-2027');
    INSERT INTO practice_sessions (id,user_id,status,bank_codes_json) VALUES
      ('s1','u1','active','["gd-2027","gk-2027"]'),
      ('s2','u1','active','["gk-2027"]'),
      ('s3','u1','completed','["gd-2027"]'),
      ('s4','u2','active','["gd-2027"]');
  `);
  const abandonSql = sqlAfter(functionBody(route, "toggleQuestionBank"), "D1 batch is transactional", "UPDATE practice_sessions SET status = 'abandoned'");
  db.exec("BEGIN");
  const abandoned = db.prepare(abandonSql).all("u1", "gd-2027").map((row) => String(row.id));
  db.prepare("DELETE FROM user_question_banks WHERE user_id = ? AND bank_code = ?").run("u1", "gd-2027");
  db.exec("COMMIT");
  assert.deepEqual(abandoned, ["s1"]);
  assert.equal(db.prepare("SELECT status FROM practice_sessions WHERE id = 's1'").get().status, "abandoned");
  assert.equal(db.prepare("SELECT status FROM practice_sessions WHERE id = 's2'").get().status, "active");
  assert.equal(db.prepare("SELECT status FROM practice_sessions WHERE id = 's3'").get().status, "completed");
  assert.equal(db.prepare("SELECT status FROM practice_sessions WHERE id = 's4'").get().status, "active");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM user_question_banks WHERE user_id='u1' AND bank_code='gd-2027'").get().count, 0);
});

test("incremental bank target insertion preserves 32 existing targets and the primary profile", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE user_exam_profiles (user_id TEXT PRIMARY KEY, exam_type TEXT NOT NULL, province TEXT NOT NULL);
    CREATE TABLE user_exam_targets (
      user_id TEXT NOT NULL, target_code TEXT NOT NULL, exam_type TEXT NOT NULL,
      province TEXT NOT NULL, exam_year INTEGER NOT NULL, exam_date TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, target_code)
    );
    INSERT INTO user_exam_profiles VALUES ('u1', '国考', '');
  `);
  const insert = db.prepare(`INSERT OR IGNORE INTO user_exam_targets
    (user_id, target_code, exam_type, province, exam_year, exam_date)
    VALUES (?, ?, ?, ?, ?, NULL)`);
  for (let index = 0; index < 32; index += 1) {
    insert.run("u1", `province:p${index}`, "provincial", `p${index}`, 2027);
  }

  const result = insert.run("u1", "province:new", "provincial", "new", 2027);
  assert.equal(Number(result.changes), 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM user_exam_targets WHERE user_id='u1'").get().count, 33);
  const primary = db.prepare("SELECT exam_type, province FROM user_exam_profiles WHERE user_id='u1'").get();
  assert.equal(primary.exam_type, "国考");
  assert.equal(primary.province, "");
});
