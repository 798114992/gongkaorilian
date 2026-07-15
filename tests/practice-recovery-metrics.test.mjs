import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ABANDONED_DAILY_CARRY_SQL, summarizeDailyCarry } from "../app/api/app/daily-carry.mjs";
import { eligibleFirstAttemptSql, platformScoreRateIncrementSql } from "../app/api/app/score-rate-sql.mjs";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

function migratedDb() {
  const db = new DatabaseSync(":memory:");
  const directory = join(root, "drizzle");
  for (const name of readdirSync(directory).filter((item) => /^\d{4}_.+\.sql$/.test(item)).sort()) {
    db.exec(readFileSync(join(directory, name), "utf8").replaceAll("--> statement-breakpoint", ""));
  }
  return db;
}

test("an invalidated daily session carries pending correct answers and only unique real questions", () => {
  const db = migratedDb();
  db.exec(`
    INSERT INTO practice_sessions (id,user_id,date_key,kind,mode,status,target_count)
      VALUES ('old','11111111-1111-1111-1111-111111111111','2026-07-15','daily','mixed','abandoned',5),
             ('newer','11111111-1111-1111-1111-111111111111','2026-07-15','daily','mixed','abandoned',5);
    INSERT INTO practice_attempts
      (attempt_key,practice_session_id,user_id,question_code,bank_code,module,selected_answer,is_correct,confidence,apply_status,duration_ms)
      VALUES ('a1','old','11111111-1111-1111-1111-111111111111','q1','GD-2024','言语',0,1,'pending','applied',31000),
             ('a2','old','11111111-1111-1111-1111-111111111111','q2','GD-2024','判断',1,0,'hesitant','applied',42000),
             ('a3','newer','11111111-1111-1111-1111-111111111111','q1','GD-2024','言语',0,1,'pending','applied',29000);
  `);
  const rows = db.prepare(ABANDONED_DAILY_CARRY_SQL).all("11111111-1111-1111-1111-111111111111", "2026-07-15");
  const carry = summarizeDailyCarry(rows, 5);
  assert.equal(carry.answered, 2);
  assert.equal(carry.correct, 1);
  assert.deepEqual(new Set(carry.questionCodes), new Set(["q1", "q2"]));
  assert.equal(carry.reviewAdded, 2, "pending correct remains conservative review credit without consuming another free question");
  db.close();
});

test("platform score rate counts one first answer per eligible user", () => {
  const db = migratedDb();
  db.exec(`
    INSERT INTO users (id,invite_code,analytics_eligible)
      VALUES ('11111111-1111-1111-1111-111111111111','A',1),
             ('22222222-2222-2222-2222-222222222222','B',0);
    INSERT INTO practice_attempts
      (attempt_key,user_id,question_code,bank_code,module,is_correct,apply_status)
      VALUES ('m1','11111111-1111-1111-1111-111111111111','metric-q','GD-2024','言语',1,'applied'),
             ('m2','11111111-1111-1111-1111-111111111111','metric-q','GD-2024','言语',0,'applied'),
             ('m3','22222222-2222-2222-2222-222222222222','metric-q','GD-2024','言语',0,'applied');
  `);
  const stats = db.prepare(`SELECT COUNT(*) AS attempts, SUM(metric_attempt.is_correct) AS correct
    FROM practice_attempts metric_attempt JOIN users metric_user ON metric_user.id = metric_attempt.user_id
    WHERE metric_attempt.question_code = 'metric-q' AND ${eligibleFirstAttemptSql("metric_attempt", "metric_user")}`).get();
  assert.deepEqual({ attempts: stats.attempts, correct: stats.correct }, { attempts: 1, correct: 1 });
  db.close();
});

test("platform score rate increment derives the new rate from counters, not a stale cached percentage", () => {
  const db = migratedDb();
  const first = "11111111-1111-1111-1111-111111111111";
  const second = "22222222-2222-2222-2222-222222222222";
  db.exec(`
    INSERT INTO users (id,invite_code,analytics_eligible) VALUES
      ('${first}','RATE-A',1), ('${second}','RATE-B',1);
    INSERT INTO questions
      (question_code,subject,module,stem,options_json,answer,explanation,source,source_exam_type,
       source_region,source_year,source_batch,score_rate,score_rate_correct,score_rate_attempts,score_rate_source)
      VALUES ('metric-live','行测','言语','示例题','["A","B"]','A','解析','广东-2024','provincial',
        '广东',2024,'GD-2024-XC-A',0,0,0,'platform');
    INSERT INTO practice_attempts
      (attempt_key,user_id,question_code,bank_code,module,is_correct,apply_status)
      VALUES ('live-1','${first}','metric-live','GD-2024','言语',1,'applying'),
             ('live-2','${second}','metric-live','GD-2024','言语',0,'applying');
  `);
  const sql = platformScoreRateIncrementSql(eligibleFirstAttemptSql("metric_attempt", "metric_user", "applying"));
  db.prepare(sql).run(1, 1, "平台合规用户首答", "metric-live", first, "live-1");
  assert.deepEqual({ ...db.prepare("SELECT score_rate,score_rate_correct,score_rate_attempts FROM questions WHERE question_code='metric-live'").get() },
    { score_rate: 100, score_rate_correct: 1, score_rate_attempts: 1 });
  db.prepare(sql).run(0, 0, "平台合规用户首答", "metric-live", second, "live-2");
  assert.deepEqual({ ...db.prepare("SELECT score_rate,score_rate_correct,score_rate_attempts FROM questions WHERE question_code='metric-live'").get() },
    { score_rate: 50, score_rate_correct: 1, score_rate_attempts: 2 });
  db.close();
});

test("daily prescription, job access and legacy bank identity are server-enforced", () => {
  const route = readFileSync(join(root, "app/api/app/route.ts"), "utf8");
  assert.match(route, /bankMatchesDailyTarget\(bank, profile\)/);
  assert.match(route, /dailyReadiness\?\.effectiveBankCodes \?\? effectiveSelected/);
  assert.match(route, /loadAbandonedDailyCarry\(userId, dateKey/);
  assert.match(route, /ci\.access_level = 'free'/);
  assert.match(route, /bankCode = existingBank\.bank_code/);
  assert.match(route, /eligibleFirstAttemptSql\("metric_attempt", "metric_user", "applying"\)/);
  assert.match(route, /eligibleFirstAttemptSql\("metric_attempt", "metric_user"\)/);
});
