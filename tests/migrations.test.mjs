import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { RELIABLE_FREQUENCY_SQL } from "../app/api/app/study-insights-sql.mjs";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const migrationDirectory = join(root, "drizzle");
const migrationPattern = /^\d{4}_.+\.sql$/;

function migrationFiles() {
  return readdirSync(migrationDirectory).filter((name) => migrationPattern.test(name)).sort();
}

function migrationSql(name) {
  return readFileSync(join(migrationDirectory, name), "utf8").replaceAll("--> statement-breakpoint", "");
}

function applyMigrations(db, files) {
  for (const name of files) db.exec(migrationSql(name));
}

function tableColumns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
}

function indexNames(db, table) {
  return db.prepare(`PRAGMA index_list(${table})`).all().map((row) => row.name);
}

test("all migrations build a fresh database with the current durable schema", () => {
  const db = new DatabaseSync(":memory:");
  applyMigrations(db, migrationFiles());

  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
  for (const table of [
    "user_sessions", "user_daily_usage", "daily_checkins", "practice_sessions", "essay_attempts",
    "question_import_chunks", "question_import_codes", "question_import_row_results",
    "question_import_errors", "question_versions", "products", "orders",
    "payment_transactions", "refunds", "entitlement_grants", "content_reports", "device_account_links",
    "quiz_tests", "quiz_questions", "quiz_result_levels", "quiz_attempts", "quiz_share_events",
  ]) assert.ok(tables.has(table), `missing migrated table ${table}`);

  for (const column of ["attempt_key", "practice_session_id", "selected_answer", "was_due", "apply_status"])
    assert.ok(tableColumns(db, "practice_attempts").includes(column), `missing practice_attempts.${column}`);
  for (const column of ["truth_verified", "review_status", "reviewed_by", "reviewed_at", "review_note", "version"])
    assert.ok(tableColumns(db, "questions").includes(column), `missing questions.${column}`);
  for (const column of ["file_hash", "duplicate_strategy", "uploaded_rows", "processed_rows", "total_chunks", "cancel_requested", "lease_token", "lease_until"])
    assert.ok(tableColumns(db, "question_imports").includes(column), `missing question_imports.${column}`);
  assert.ok(tableColumns(db, "question_import_codes").includes("base_version"), "missing question_import_codes.base_version");
  for (const column of ["duplicate_strategy", "dispatch_attempts", "next_retry_at", "review_status", "submitted_by",
    "submitted_at", "reviewed_by", "reviewed_at", "review_note", "published_at", "rolled_back_at"])
    assert.ok(tableColumns(db, "content_imports").includes(column), `missing content_imports.${column}`);
  for (const column of ["user_id", "content_type", "content_key", "reason_code", "status", "resolved_by", "resolution_note", "resolved_at"])
    assert.ok(tableColumns(db, "content_reports").includes(column), `missing content_reports.${column}`);
  for (const table of ["content_items", "content_item_versions", "media_assets"])
    assert.ok(tableColumns(db, table).includes("access_level"), `missing ${table}.access_level`);

  assert.equal(db.prepare("SELECT value FROM configs WHERE key='runtime_schema_version'").get().value, "19");
  assert.equal(db.prepare("SELECT value FROM configs WHERE key='default_system_seed_version'").get().value, "2026-07-15-v2");
  assert.equal(db.prepare("SELECT value FROM configs WHERE key='default_content_seed_version'").get().value, "1");
  assert.equal(db.prepare("SELECT value FROM configs WHERE key='default_quiz_seed_version'").get().value, "1");
  assert.equal(db.prepare("SELECT price_cents FROM products WHERE id='gkrl-lifetime-2980'").get().price_cents, 2980);
  assert.equal(db.prepare("SELECT question_count FROM quiz_tests WHERE id='quiz-juzhang-thinking'").get().question_count, 10);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM quiz_questions WHERE quiz_id='quiz-juzhang-thinking' AND status='published' AND review_status='approved'").get().n, 12);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM quiz_result_levels WHERE quiz_id='quiz-juzhang-thinking' AND status='active'").get().n, 4);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM question_banks WHERE status='draft'").get().n, 8);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM question_banks qb WHERE qb.status='published' AND NOT EXISTS (
    SELECT 1 FROM question_bank_items qbi JOIN questions q ON q.id=qbi.question_id
    WHERE qbi.bank_id=qb.id AND q.status='active' AND q.truth_verified=1 AND q.review_status='approved'
  )`).get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM content_items WHERE content_type='drill_preset' AND status='published'").get().n, 5);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM content_items WHERE content_type='strategy_config' AND status='published'").get().n, 1);

  assert.ok(indexNames(db, "practice_sessions").includes("practice_sessions_active_uq"));
  assert.ok(indexNames(db, "practice_attempts").includes("practice_attempts_session_question_uq"));
  assert.ok(indexNames(db, "question_versions").includes("question_versions_question_version_uq"));
  assert.ok(indexNames(db, "content_reports").includes("content_reports_open_uq"));
  assert.ok(indexNames(db, "device_account_links").includes("device_account_links_device_user_uq"));
  assert.ok(indexNames(db, "device_account_links").includes("device_account_links_user_device_idx"));
  db.close();
});

test("0017 upgrades an existing 0016 database with identity and immutable import baselines", () => {
  const db = new DatabaseSync(":memory:");
  const files = migrationFiles();
  const migration17 = files.find((name) => name.startsWith("0017_"));
  assert.ok(migration17, "missing tracked 0017 migration");
  applyMigrations(db, files.filter((name) => name < migration17));
  assert.equal(db.prepare("SELECT value FROM configs WHERE key='runtime_schema_version'").get().value, "16");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='device_account_links'").get().count, 0);
  assert.equal(tableColumns(db, "question_import_codes").includes("base_version"), false);

  applyMigrations(db, [migration17]);
  assert.equal(db.prepare("SELECT value FROM configs WHERE key='runtime_schema_version'").get().value, "17");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='device_account_links'").get().count, 1);
  assert.equal(tableColumns(db, "question_import_codes").includes("base_version"), true);
  db.close();
});

test("study insight frequency queries execute against a freshly migrated database", () => {
  const db = new DatabaseSync(":memory:");
  applyMigrations(db, migrationFiles());
  db.exec(`
    INSERT INTO questions
      (question_code, subject, module, sub_type, stem, truth_verified, review_status,
       frequency_occurrences, frequency_papers, frequency_years_json, frequency_updated_at)
      VALUES ('insight-q', '行测', '判断推理', '图形推理', 'test', 1, 'approved', 4, 5,
        '[2024,2025,2026]', CURRENT_TIMESTAMP);
    INSERT INTO practice_attempts
      (attempt_key, user_id, question_code, bank_code, module, is_correct, apply_status)
      VALUES ('insight-attempt', 'insight-user', 'insight-q', 'bank', '判断推理', 1, 'applied');
    INSERT INTO user_question_progress (user_id, question_code, state)
      VALUES ('insight-user', 'insight-q', 'mastered');
  `);
  const highFrequency = db.prepare(`SELECT DISTINCT
      COALESCE(NULLIF(TRIM(q.sub_type), ''), NULLIF(TRIM(q.module), '')) AS knowledge_point
    FROM practice_attempts pa JOIN questions q ON q.question_code = pa.question_code
    WHERE pa.user_id = ? AND pa.apply_status = 'applied' AND ${RELIABLE_FREQUENCY_SQL}`)
    .all("insight-user");
  assert.deepEqual(highFrequency.map((row) => row.knowledge_point), ["图形推理"]);
  const mastered = db.prepare(`SELECT DISTINCT
      COALESCE(NULLIF(TRIM(q.sub_type), ''), NULLIF(TRIM(q.module), '')) AS knowledge_point
    FROM practice_attempts pa
    JOIN questions q ON q.question_code = pa.question_code
    JOIN user_question_progress uqp ON uqp.user_id = pa.user_id AND uqp.question_code = pa.question_code
    WHERE pa.user_id = ? AND pa.apply_status = 'applied' AND uqp.state = 'mastered'`)
    .all("insight-user");
  assert.deepEqual(mastered.map((row) => row.knowledge_point), ["图形推理"]);
  db.close();
});

test("0015 downgrades legacy published content that misses renderer core fields", () => {
  const db = new DatabaseSync(":memory:");
  const files = migrationFiles();
  const gateIndex = files.findIndex((name) => name.startsWith("0015_"));
  assert.notEqual(gateIndex, -1, "missing 0015 release-gate migration");
  applyMigrations(db, files.slice(0, gateIndex));
  const rows = [
    ["morning_read", "bad-morning", { title: "晨读", date: "2026-07-15", body: "", source: "权威", sourceUrl: "https://example.gov.cn", sourceDate: "2026-07-15" }],
    ["current_affairs", "bad-current", { title: "时政", date: "2026-07-15", summary: "摘要", body: "", importanceStars: 4, source: "权威", sourceUrl: "https://example.gov.cn", sourceDate: "2026-07-15" }],
    ["essay_micro", "bad-essay", { title: "申论", theme: "治理", material: "材料", prompt: "任务", referenceAnswer: "答案", wordLimit: 150, scoringPoints: [], source: "权威", sourceUrl: "https://example.gov.cn", sourceDate: "2026-07-15" }],
    ["audio_track", "bad-audio", { title: "电台", seriesId: "news", seriesTitle: "时政", description: "简介", text: "", source: "权威", sourceUrl: "https://example.gov.cn", sourceDate: "2026-07-15" }],
    ["exam_notice", "bad-notice", { targetCode: "national", title: "公告", noticeType: "招录公告", summary: "", sourceUrl: "https://example.gov.cn", publishDate: "2026-07-15" }],
    ["exam_event", "bad-event", { targetCode: "national", title: "报名", eventType: "", reminderDays: 3, sourceUrl: "https://example.gov.cn", eventDate: "2027-01-01" }],
    ["job_position", "bad-position", { targetCode: "national", examName: "国考", department: "部门", title: "职位", code: "", region: "北京", recruitCount: 1, sourceUrl: "https://example.gov.cn", updatedAt: "2026-07-15", dataVersion: 1 }],
    ["morning_read", "good-morning", { title: "晨读", date: "2026-07-15", body: "正文", source: "权威", sourceUrl: "https://example.gov.cn", sourceDate: "2026-07-15" }],
  ];
  const insert = db.prepare(`INSERT INTO content_items
    (content_type,content_key,title,payload_json,access_level,status) VALUES (?,?,?,?,'free','published')`);
  for (const [type, key, payload] of rows) insert.run(type, key, key, JSON.stringify(payload));
  db.exec(migrationSql(files[gateIndex]));
  assert.deepEqual(
    db.prepare("SELECT content_key,status FROM content_items WHERE content_key LIKE 'bad-%' ORDER BY content_key").all()
      .map((row) => ({ ...row })),
    rows.slice(0, 7).map(([, key]) => ({ content_key: key, status: "draft" })).sort((a, b) => a.content_key.localeCompare(b.content_key)),
  );
  assert.equal(db.prepare("SELECT status FROM content_items WHERE content_key='good-morning'").get().status, "published");
  db.close();
});

test("the 0010 integrity migration repairs legacy rows before adding unique guards", () => {
  const db = new DatabaseSync(":memory:");
  const files = migrationFiles();
  const integrityIndex = files.findIndex((name) => name.startsWith("0010_"));
  assert.notEqual(integrityIndex, -1, "missing 0010 integrity migration");
  applyMigrations(db, files.slice(0, integrityIndex));

  db.exec(`
    INSERT INTO practice_sessions (id,user_id,date_key,kind,mode,status,created_at)
      VALUES ('s-old','u1','2026-07-15','daily','mixed','active','2026-07-15 08:00:00'),
             ('s-new','u1','2026-07-15','daily','mixed','active','2026-07-15 09:00:00');
    INSERT INTO practice_attempts (attempt_key,practice_session_id,user_id,question_code,bank_code,module,is_correct)
      VALUES ('a1','s-new','u1','q1','b1','言语',0),
             ('a2','s-new','u1','q1','b1','言语',1);
    INSERT INTO redemption_codes (code_hash,code_preview,batch_name,duration_days,max_uses,used_count)
      VALUES ('hash','PREVIEW','legacy',7,5,0);
    INSERT INTO redemptions (code_id,user_id) VALUES (1,'u1'),(1,'u2');
    INSERT INTO questions (question_code,subject,module,stem,truth_verified,review_status)
      VALUES ('legacy-q','行测','言语','legacy',0,'approved');
    INSERT INTO admin_audit_logs (action,details_json)
      VALUES ('legacy','{"password":"should-not-survive"}');
    INSERT INTO question_imports (bank_id,file_name,total_rows,imported_rows,failed_rows,status)
      VALUES (1,'legacy.xlsx',10,4,1,'processing');
  `);

  db.exec(migrationSql(files[integrityIndex]));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM practice_sessions WHERE status='active'").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM practice_attempts WHERE practice_session_id IS NOT NULL").get().n, 1);
  assert.equal(db.prepare("SELECT used_count FROM redemption_codes WHERE id=1").get().used_count, 2);
  assert.deepEqual(db.prepare("SELECT DISTINCT status FROM redemptions").all().map((row) => row.status), ["completed"]);
  assert.equal(db.prepare("SELECT review_status FROM questions WHERE question_code='legacy-q'").get().review_status, "pending_review");
  assert.doesNotMatch(db.prepare("SELECT details_json FROM admin_audit_logs").get().details_json, /password/i);

  applyMigrations(db, files.slice(integrityIndex + 1));
  const legacyImport = db.prepare("SELECT status,file_hash,error_summary FROM question_imports WHERE file_name='legacy.xlsx'").get();
  assert.equal(legacyImport.status, "failed");
  assert.equal(legacyImport.file_hash, "");
  assert.match(legacyImport.error_summary, /不能安全续传/);
  const targetIndexSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='content_items_job_target_idx'").get().sql;
  assert.match(targetIndexSql, /content_type.*status.*json_extract/i);
  assert.throws(() => db.exec(`INSERT INTO practice_sessions (id,user_id,date_key,kind,mode,status)
    VALUES ('s-third','u1','2026-07-15','daily','mixed','active')`), /UNIQUE constraint failed/);
  assert.throws(() => db.exec(`INSERT INTO practice_attempts
    (attempt_key,practice_session_id,user_id,question_code,bank_code,module,is_correct)
    VALUES ('a3','s-new','u1','q1','b1','言语',1)`), /UNIQUE constraint failed/);
  db.close();
});

test("the 0013 hardening migration keeps only valid daily check-ins, safe media and live sessions", () => {
  const db = new DatabaseSync(":memory:");
  const files = migrationFiles();
  const hardeningIndex = files.findIndex((name) => name.startsWith("0013_"));
  assert.notEqual(hardeningIndex, -1, "missing 0013 hardening migration");
  applyMigrations(db, files.slice(0, hardeningIndex));
  db.exec(`
    INSERT INTO user_states (user_id,progress_json) VALUES ('forged','{"checkins":["2026-07-15"]}');
    INSERT INTO practice_sessions (id,user_id,date_key,kind,mode,status,target_count,answered_count,completed_at)
      VALUES ('valid','u1','2026-07-15','daily','mixed','completed',10,10,'2026-07-15 10:00:00'),
             ('short','u2','2026-07-15','daily','mixed','completed',10,9,'2026-07-15 10:00:00'),
             ('bonus','u3','2026-07-15','bonus','mixed','completed',5,5,'2026-07-15 10:00:00'),
             ('zero','u4','2026-07-15','daily','mixed','completed',0,0,'2026-07-15 10:00:00'),
             ('tiny','u7','2026-07-15','daily','mixed','completed',1,1,'2026-07-15 10:00:00'),
             ('active','u5','2026-07-15','daily','mixed','active',10,10,NULL),
             ('review','u6','2026-07-15','daily','review','completed',10,10,'2026-07-15 10:00:00');
    INSERT INTO daily_checkins (user_id,date_key,session_id,source)
      VALUES ('u6','2026-07-15','review','daily_practice'),
             ('u7','2026-07-15','tiny','daily_practice');
    INSERT INTO media_assets
      (id,object_key,file_name,content_type,byte_size,checksum,status)
      VALUES ('safe-media','safe','safe.png','image/png',8,'safe','active'),
             ('unsafe-media','unsafe','payload.svg','image/svg+xml',16,'unsafe','active');
    INSERT INTO user_sessions (token_hash,user_id,expires_at,revoked_at)
      VALUES ('active-session','u1',datetime('now','+1 day'),NULL),
             ('expired-session','u2',datetime('now','-1 day'),NULL),
             ('revoked-session','u3',datetime('now','+1 day'),CURRENT_TIMESTAMP);
  `);
  db.exec(migrationSql(files[hardeningIndex]));
  assert.deepEqual(
    db.prepare("SELECT user_id,date_key,session_id,source FROM daily_checkins ORDER BY user_id").all().map((row) => ({ ...row })),
    [{ user_id: "u1", date_key: "2026-07-15", session_id: "valid", source: "daily_practice" }],
  );
  assert.deepEqual(
    db.prepare("SELECT id,status FROM media_assets ORDER BY id").all().map((row) => ({ ...row })),
    [{ id: "safe-media", status: "active" }, { id: "unsafe-media", status: "disabled" }],
  );
  assert.deepEqual(db.prepare("SELECT token_hash FROM user_sessions").all().map((row) => row.token_hash), ["active-session"]);
  db.close();
});

test("the 0013 migration gives explicit free previews and keeps all other content member-only", () => {
  const db = new DatabaseSync(":memory:");
  const files = migrationFiles();
  const accessIndex = files.findIndex((name) => name.startsWith("0013_"));
  assert.notEqual(accessIndex, -1, "missing 0013 access-level migration");
  applyMigrations(db, files.slice(0, accessIndex));
  db.exec(`
    INSERT INTO content_items (content_type,content_key,title,payload_json,status)
      VALUES ('audio_track','audio-first','First','{"audioUrl":"/api/app?media=free-media"}','published'),
             ('audio_track','audio-second','Second','{"audioUrl":"/api/app?media=member-media"}','published'),
             ('exam_notice','notice-one','Notice','{}','published'),
             ('job_position','position-one','Position','{}','published');
    INSERT INTO content_item_versions
      (content_id,version,content_type,content_key,title,payload_json,status)
      VALUES (1,1,'audio_track','audio-first','First','{}','published');
    INSERT INTO media_assets (id,object_key,file_name,content_type,byte_size,checksum,status)
      VALUES ('free-media','free-media','free.mp3','audio/mpeg',3,'free','active'),
             ('member-media','member-media','member.mp3','audio/mpeg',3,'member','active');
  `);
  db.exec(migrationSql(files[accessIndex]));
  assert.deepEqual(
    db.prepare("SELECT content_key,access_level FROM content_items ORDER BY id").all().map((row) => ({ ...row })),
    [
      { content_key: "audio-first", access_level: "free" },
      { content_key: "audio-second", access_level: "member" },
      { content_key: "notice-one", access_level: "free" },
      { content_key: "position-one", access_level: "member" },
    ],
  );
  assert.equal(db.prepare("SELECT access_level FROM content_item_versions WHERE content_id=1").get().access_level, "free");
  assert.equal(db.prepare("SELECT access_level FROM media_assets WHERE id='free-media'").get().access_level, "free");
  assert.equal(db.prepare("SELECT access_level FROM media_assets WHERE id='member-media'").get().access_level, "member");
  db.close();
});

test("database constraints enforce redemption, check-in, import and version idempotency", () => {
  const db = new DatabaseSync(":memory:");
  applyMigrations(db, migrationFiles());

  db.exec(`
    INSERT INTO redemption_codes (code_hash,code_preview,batch_name,duration_days,max_uses)
      VALUES ('capacity-hash','CAP','capacity',7,1);
    INSERT OR IGNORE INTO redemptions (code_id,user_id,status)
      SELECT id,'u1','pending' FROM redemption_codes c WHERE code_hash='capacity-hash'
        AND (SELECT COUNT(*) FROM redemptions r WHERE r.code_id=c.id) < c.max_uses;
    INSERT OR IGNORE INTO redemptions (code_id,user_id,status)
      SELECT id,'u2','pending' FROM redemption_codes c WHERE code_hash='capacity-hash'
        AND (SELECT COUNT(*) FROM redemptions r WHERE r.code_id=c.id) < c.max_uses;

    INSERT OR IGNORE INTO membership_ledger (user_id,delta_days,source_type,source_id)
      VALUES ('u1',7,'invite_reward','invite:u2');
    INSERT OR IGNORE INTO membership_ledger (user_id,delta_days,source_type,source_id)
      VALUES ('u1',7,'invite_reward','invite:u2');

    INSERT OR IGNORE INTO daily_checkins (user_id,date_key,session_id) VALUES ('u1','2026-07-15','s1');
    INSERT OR IGNORE INTO daily_checkins (user_id,date_key,session_id) VALUES ('u1','2026-07-15','s2');

    INSERT INTO question_banks (bank_code,name,exam_type,subject) VALUES ('BANK','Bank','national','行测');
    INSERT INTO question_imports (bank_id,file_name,total_rows) VALUES (1,'questions.xlsx',1);
    INSERT OR IGNORE INTO question_import_chunks
      (import_id,chunk_index,row_offset,row_count,payload_hash,rows_json) VALUES (1,0,0,1,'h','[]');
    INSERT OR IGNORE INTO question_import_chunks
      (import_id,chunk_index,row_offset,row_count,payload_hash,rows_json) VALUES (1,0,0,1,'h2','[]');

    INSERT INTO content_imports
      (content_type,file_name,file_hash,total_rows,total_chunks)
      VALUES ('job_position','positions.xlsx','content-hash',1,1);
    INSERT OR IGNORE INTO content_import_chunks
      (import_id,chunk_index,row_offset,row_count,payload_hash,rows_json)
      VALUES (1,0,0,1,'chunk-hash','[]');
    INSERT OR IGNORE INTO content_import_chunks
      (import_id,chunk_index,row_offset,row_count,payload_hash,rows_json)
      VALUES (1,0,0,1,'other-hash','[]');
    INSERT OR IGNORE INTO content_import_row_results
      (import_id,row_index,chunk_index,status,content_key) VALUES (1,2,0,'imported','position-1');
    INSERT OR IGNORE INTO content_import_row_results
      (import_id,row_index,chunk_index,status,content_key) VALUES (1,2,0,'failed','position-1');
    INSERT OR IGNORE INTO content_import_keys (import_id,row_index,content_key) VALUES (1,2,'position-1');
    INSERT OR IGNORE INTO content_import_keys (import_id,row_index,content_key) VALUES (1,3,'position-1');

    INSERT INTO questions (question_code,subject,module,stem) VALUES ('pending-q','行测','言语','stem');
    INSERT OR IGNORE INTO question_versions
      (question_id,version,question_code,snapshot_json) VALUES (1,1,'pending-q','{}');
    INSERT OR IGNORE INTO question_versions
      (question_id,version,question_code,snapshot_json) VALUES (1,1,'pending-q','{"duplicate":true}');

    INSERT OR IGNORE INTO content_reports (user_id,content_key,reason_code)
      VALUES ('u1','pending-q','answer');
    INSERT OR IGNORE INTO content_reports (user_id,content_key,reason_code)
      VALUES ('u1','pending-q','answer');
    INSERT OR IGNORE INTO content_reports (user_id,content_key,reason_code)
      VALUES ('u2','pending-q','answer');
  `);

  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM redemptions").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM membership_ledger").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM daily_checkins").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM question_import_chunks").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM content_import_chunks").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM content_import_row_results").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM content_import_keys").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM question_versions").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM content_reports").get().n, 2);
  db.exec(`UPDATE content_reports SET status='resolved' WHERE user_id='u1' AND content_key='pending-q';
    INSERT INTO content_reports (user_id,content_key,reason_code) VALUES ('u1','pending-q','answer');`);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM content_reports").get().n, 3);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM content_reports WHERE user_id='u1' AND status='pending'").get().n, 1);
  assert.deepEqual(
    { ...db.prepare("SELECT truth_verified,review_status FROM questions WHERE question_code='pending-q'").get() },
    { truth_verified: 0, review_status: "pending_review" },
  );
  db.close();
});

test("invite eligibility starts after binding and same-browser risk blocks the atomic claim", () => {
  const db = new DatabaseSync(":memory:");
  applyMigrations(db, migrationFiles());
  db.exec(`
    INSERT INTO users (id,invite_code,verified_at) VALUES
      ('inviter','GKINVITER','2026-07-01 00:00:00'),
      ('invitee','GKINVITEE','2026-07-01 00:00:00');
    INSERT INTO invite_relations (invitee_id,inviter_id,bound_at,verified_at)
      VALUES ('invitee','inviter','2026-07-15 12:00:00','2026-07-15 12:00:00');
    INSERT INTO practice_sessions
      (id,user_id,date_key,kind,mode,status,target_count,answered_count,completed_at)
      VALUES
      ('before-bind','invitee','2026-07-15','daily','mixed','completed',5,5,'2026-07-15 11:00:00'),
      ('review-after','invitee','2026-07-15','daily','review','completed',5,5,'2026-07-15 13:00:00');
  `);
  const eligibleSql = `SELECT 1 AS eligible FROM invite_relations ir WHERE ir.invitee_id = 'invitee'
    AND ir.status = 'pending' AND ir.risk_status = 'clear' AND EXISTS (
      SELECT 1 FROM practice_sessions ps WHERE ps.user_id = ir.invitee_id AND ps.status = 'completed'
        AND ps.kind = 'daily' AND ps.mode = 'mixed' AND ps.target_count >= 5 AND ps.answered_count >= 5
        AND ps.completed_at IS NOT NULL AND datetime(ps.completed_at) >= datetime(ir.bound_at)
    ) LIMIT 1`;
  assert.equal(db.prepare(eligibleSql).get(), undefined);
  db.exec(`INSERT INTO practice_sessions
    (id,user_id,date_key,kind,mode,status,target_count,answered_count,completed_at)
    VALUES ('after-bind','invitee','2026-07-15','daily','mixed','completed',5,5,'2026-07-15 13:30:00')`);
  assert.deepEqual({ ...db.prepare(eligibleSql).get() }, { eligible: 1 });

  db.exec(`INSERT INTO analytics_events (user_id,event_name,event_data)
    VALUES ('invitee','account_switch_detected','{"otherUserId":"inviter"}');
    BEGIN;
    UPDATE invite_relations SET risk_status = 'blocked_same_browser'
      WHERE invitee_id = 'invitee' AND status = 'pending' AND risk_status = 'clear' AND EXISTS (
        SELECT 1 FROM analytics_events ae WHERE ae.event_name = 'account_switch_detected'
          AND ae.user_id = invite_relations.invitee_id
          AND json_extract(ae.event_data, '$.otherUserId') = invite_relations.inviter_id
      );
    UPDATE invite_relations SET status = 'rewarded'
      WHERE invitee_id = 'invitee' AND status = 'pending' AND risk_status = 'clear';
    COMMIT;`);
  assert.deepEqual(
    { ...db.prepare("SELECT status,risk_status FROM invite_relations WHERE invitee_id='invitee'").get() },
    { status: "pending", risk_status: "blocked_same_browser" },
  );
  db.close();
});

test("China-local redemption cutoff includes the full selected day", () => {
  const value = Date.parse("2026-07-31T23:59:59.999+08:00");
  assert.equal(new Date(value).toISOString(), "2026-07-31T15:59:59.999Z");
});

test("migration journal, SQL files and snapshots form one continuous chain", async () => {
  const journal = JSON.parse(await readFile(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
  const files = migrationFiles();
  assert.deepEqual(journal.entries.map((entry) => entry.idx), journal.entries.map((_, index) => index));
  assert.deepEqual(journal.entries.map((entry) => `${entry.tag}.sql`), files);
  for (const entry of journal.entries) {
    const snapshot = JSON.parse(await readFile(new URL(`../drizzle/meta/${String(entry.idx).padStart(4, "0")}_snapshot.json`, import.meta.url), "utf8"));
    assert.equal(snapshot.dialect, "sqlite");
    assert.ok(snapshot.tables && Object.keys(snapshot.tables).length > 0);
  }

  const finalEntry = journal.entries.at(-1);
  const finalSnapshot = JSON.parse(await readFile(
    new URL(`../drizzle/meta/${String(finalEntry.idx).padStart(4, "0")}_snapshot.json`, import.meta.url), "utf8",
  ));
  for (const table of ["question_import_chunks", "question_versions", "content_imports", "content_import_chunks",
    "content_import_row_results", "content_import_keys", "content_import_errors", "products", "orders",
    "entitlement_grants", "content_reports", "device_account_links", "quiz_tests", "quiz_questions",
    "quiz_result_levels", "quiz_attempts", "quiz_share_events"])
    assert.ok(finalSnapshot.tables[table], `final snapshot is missing ${table}`);
});

test("runtime schema guard uses a one-query deployed-schema probe and keeps legacy bootstrap opt-in", async () => {
  const [runtime, policy] = await Promise.all([
    readFile(new URL("../db/runtime.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/MIGRATION_POLICY.md", import.meta.url), "utf8"),
  ]);
  assert.match(runtime, /CREATE TABLE IF NOT EXISTS/);
  assert.match(runtime, /PRAGMA table_info/);
  assert.match(runtime, /if \(!names\.has\(column\.name\)\)/);
  assert.match(runtime, /async function deployedSchemaIsCurrent/);
  assert.match(runtime, /runtime_schema_version/);
  assert.match(runtime, /await deployedSchemaIsCurrent\(\)/);
  assert.match(runtime, /RUNTIME_SCHEMA_BOOTSTRAP/);
  assert.match(runtime, /=== "local-only"/);
  assert.match(runtime, /禁止在生产请求中执行超预算建表/);
  assert.match(runtime, /ps\.kind = 'daily' AND ps\.mode = 'mixed' AND ps\.status = 'completed'[\s\S]*?ps\.target_count >= 5 AND ps\.answered_count >= ps\.target_count/);
  assert.match(policy, /tracked database/i);
  assert.match(policy, /runtime bootstrap/i);
  assert.match(policy, /backup/i);
});
