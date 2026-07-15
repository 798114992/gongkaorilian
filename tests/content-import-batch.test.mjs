import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const routeFile = new URL("../app/api/app/route.ts", import.meta.url);
const managerFile = new URL("../app/admin/AdminContentManager.tsx", import.meta.url);
const schemaFile = new URL("../db/schema.ts", import.meta.url);
const runtimeFile = new URL("../db/runtime.ts", import.meta.url);

function section(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0, `missing section start: ${start}`);
  assert.ok(to > from, `missing section end: ${end}`);
  return source.slice(from, to);
}

function contentBatchSql(route) {
  const processor = section(route, "async function processContentImportChunk", "async function adminFinishContentImport");
  const batch = section(processor, "await db.batch([", "]);\n      const persisted");
  const statements = [...batch.matchAll(/db\.prepare\(`([\s\S]*?)`\)\s*\.bind/g)].map((match) => match[1]);
  assert.equal(statements.length, 5, "content row persistence must stay one five-statement atomic batch");
  const guard = templateConstant(route, "CONTENT_IMPORT_WRITE_GUARD_SQL");
  return statements.map((sql) => sql.replaceAll("${CONTENT_IMPORT_WRITE_GUARD_SQL}", guard));
}

function contentCatchSql(route) {
  const processor = section(route, "async function processContentImportChunk", "async function adminFinishContentImport");
  const catchBlock = section(processor, "} catch (error) {", "\n  }\n}");
  const statements = [...catchBlock.matchAll(/db\.prepare\(`([\s\S]*?)`\)\s*\.bind/g)].map((match) => match[1]);
  assert.equal(statements.length, 6, "content import catch must atomically arbitrate cancellation and failure");
  return statements;
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

test("content import create/update SQL is SQLite-compatible and replay-idempotent", async () => {
  const route = await readFile(routeFile, "utf8");
  const [snapshotSql, createSql, updateSql, versionSql, resultSql] = contentBatchSql(route);
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE content_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, content_type TEXT NOT NULL, content_key TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL, payload_json TEXT NOT NULL, access_level TEXT NOT NULL DEFAULT 'member',
      status TEXT NOT NULL DEFAULT 'draft', publish_at TEXT, version INTEGER NOT NULL DEFAULT 1,
      review_note TEXT NOT NULL DEFAULT '', submitted_by INTEGER, submitted_at TEXT,
      reviewed_by INTEGER, reviewed_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE content_item_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, content_id INTEGER NOT NULL, version INTEGER NOT NULL,
      content_type TEXT NOT NULL, content_key TEXT NOT NULL, title TEXT NOT NULL,
      payload_json TEXT NOT NULL, access_level TEXT NOT NULL, status TEXT NOT NULL,
      publish_at TEXT, change_type TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX content_item_versions_content_version_uq ON content_item_versions(content_id, version);
    CREATE TABLE content_import_row_results (
      import_id INTEGER NOT NULL, row_index INTEGER NOT NULL, chunk_index INTEGER NOT NULL,
      status TEXT NOT NULL, content_key TEXT NOT NULL DEFAULT '', content_version INTEGER,
      message TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX content_import_row_results_import_row_uq ON content_import_row_results(import_id, row_index);
    CREATE TABLE content_imports (
      id INTEGER PRIMARY KEY, status TEXT NOT NULL, cancel_requested INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE content_import_chunks (
      id INTEGER PRIMARY KEY, import_id INTEGER NOT NULL, status TEXT NOT NULL, lease_token TEXT
    );
    INSERT INTO content_imports VALUES (91,'processing',0);
    INSERT INTO content_import_chunks VALUES (55,91,'processing','lease-91');
    INSERT INTO content_items (content_type, content_key, title, payload_json, access_level, status, version)
      VALUES ('job_position', 'position-existing', '旧职位', '{"old":true}', 'member', 'draft', 2);
  `);

  const accepted = JSON.stringify([
    { importId: 91, rowIndex: 2, contentKey: "position-new", title: "新增职位", accessLevel: "member",
      payloadJson: JSON.stringify({ code: "NEW", importSource: { dataVersion: "v1" } }), mode: "create", expectedVersion: 0, nextVersion: 1 },
    { importId: 91, rowIndex: 3, contentKey: "position-existing", title: "更新职位", accessLevel: "free",
      payloadJson: JSON.stringify({ code: "UPD", importSource: { dataVersion: "v1" } }), mode: "update", expectedVersion: 2, nextVersion: 3 },
  ]);
  for (const sql of [snapshotSql, createSql, updateSql, versionSql, resultSql]) {
    assert.ok((sql.match(/\?/g) ?? []).length <= 100, "D1 statement exceeds 100 bound parameters");
  }

  const runBatch = () => {
    db.exec("BEGIN");
    try {
      db.prepare(snapshotSql).run(accepted, 55, "lease-91", 91);
      db.prepare(createSql).run("job_position", accepted, 55, "lease-91", 91);
      db.prepare(updateSql).run(accepted, "job_position", 55, "lease-91", 91);
      db.prepare(versionSql).run(accepted, "job_position", 55, "lease-91", 91);
      db.prepare(resultSql).run(91, 0, accepted, "job_position", 55, "lease-91", 91);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };

  runBatch();
  assert.deepEqual(db.prepare("SELECT content_key, title, access_level, version FROM content_items ORDER BY content_key").all().map((row) => ({ ...row })), [
    { content_key: "position-existing", title: "更新职位", access_level: "free", version: 3 },
    { content_key: "position-new", title: "新增职位", access_level: "member", version: 1 },
  ]);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM content_item_versions").get().count, 3);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM content_import_row_results WHERE import_id = 91").get().count, 2);

  // Replaying a chunk after the atomic batch committed but before its lease was
  // closed must not update content or make another version.
  runBatch();
  assert.equal(db.prepare("SELECT version FROM content_items WHERE content_key = 'position-existing'").get().version, 3);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM content_item_versions").get().count, 3);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM content_import_row_results WHERE import_id = 91").get().count, 2);

  const lateCreate = JSON.stringify([{ importId: 91, rowIndex: 4, contentKey: "position-after-cancel",
    title: "取消后不得写入", accessLevel: "member", payloadJson: "{}", mode: "create", expectedVersion: 0, nextVersion: 1 }]);
  db.exec("UPDATE content_imports SET status='cancelling',cancel_requested=1 WHERE id=91; UPDATE content_import_chunks SET status='cancelled',lease_token=NULL WHERE id=55");
  db.prepare(createSql).run("job_position", lateCreate, 55, "lease-91", 91);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM content_items WHERE content_key='position-after-cancel'").get().count, 0,
    "a cancelled or lease-lost content import must fail closed");
});

test("content import catch preserves cancellation and rejects stale leases atomically", async () => {
  const route = await readFile(routeFile, "utf8");
  const [cancelChunkSql, cancelJobSql, cancelRemainderSql, failChunkSql, failJobSql, releaseFailedLeaseSql]
    = contentCatchSql(route);
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE content_imports (
      id INTEGER PRIMARY KEY, cancel_requested INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL,
      error_summary TEXT NOT NULL DEFAULT '', next_retry_at TEXT, last_heartbeat_at TEXT,
      completed_at TEXT, updated_at TEXT
    );
    CREATE TABLE content_import_chunks (
      id INTEGER PRIMARY KEY, import_id INTEGER NOT NULL, status TEXT NOT NULL,
      error_summary TEXT NOT NULL DEFAULT '', lease_token TEXT, lease_until TEXT,
      rows_json TEXT NOT NULL DEFAULT '[]', completed_at TEXT, updated_at TEXT
    );
    INSERT INTO content_imports (id,cancel_requested,status,error_summary,next_retry_at) VALUES
      (1,1,'cancelling','old error',CURRENT_TIMESTAMP),
      (2,0,'processing','',CURRENT_TIMESTAMP),
      (3,0,'processing','',CURRENT_TIMESTAMP),
      (4,1,'cancelling','',CURRENT_TIMESTAMP);
    INSERT INTO content_import_chunks (id,import_id,status,lease_token,lease_until,rows_json) VALUES
      (11,1,'processing','cancel-owner',datetime('now','+2 minutes'),'[{"rowIndex":2}]'),
      (12,1,'queued',NULL,NULL,'[{"rowIndex":3}]'),
      (13,1,'processing','sibling-owner',datetime('now','+2 minutes'),'[{"rowIndex":4}]'),
      (14,1,'completed',NULL,NULL,'[]'),
      (21,2,'processing','fail-owner',datetime('now','+2 minutes'),'[{"rowIndex":2}]'),
      (31,3,'processing','new-owner',datetime('now','+2 minutes'),'[{"rowIndex":2}]'),
      (41,4,'processing','new-cancel-owner',datetime('now','+2 minutes'),'[{"rowIndex":2}]');
  `);

  const runCatch = (importId, chunkId, leaseToken, chunkIndex, message) => {
    db.exec("BEGIN");
    try {
      db.prepare(cancelChunkSql).run(chunkId, importId, leaseToken, importId);
      db.prepare(cancelJobSql).run(importId, chunkId, importId, leaseToken);
      db.prepare(cancelRemainderSql).run(importId, importId);
      db.prepare(failChunkSql).run(message, chunkId, importId, leaseToken, importId);
      db.prepare(failJobSql).run(`分块${chunkIndex + 1}：${message}`, importId, chunkId, importId, leaseToken);
      db.prepare(releaseFailedLeaseSql).run(chunkId, importId, leaseToken, importId);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };

  runCatch(1, 11, "cancel-owner", 0, "must not become failed");
  assert.deepEqual({ ...db.prepare("SELECT status,error_summary,next_retry_at FROM content_imports WHERE id=1").get() },
    { status: "cancelled", error_summary: "", next_retry_at: null });
  assert.deepEqual(db.prepare("SELECT id,status,lease_token,rows_json FROM content_import_chunks WHERE import_id=1 ORDER BY id")
    .all().map((row) => ({ ...row })), [
    { id: 11, status: "cancelled", lease_token: null, rows_json: "[]" },
    { id: 12, status: "cancelled", lease_token: null, rows_json: "[]" },
    { id: 13, status: "cancelled", lease_token: null, rows_json: "[]" },
    { id: 14, status: "completed", lease_token: null, rows_json: "[]" },
  ]);

  runCatch(2, 21, "fail-owner", 0, "boom");
  assert.deepEqual({ ...db.prepare("SELECT status,error_summary FROM content_imports WHERE id=2").get() },
    { status: "failed", error_summary: "分块1：boom" });
  assert.deepEqual({ ...db.prepare("SELECT status,error_summary,lease_token FROM content_import_chunks WHERE id=21").get() },
    { status: "failed", error_summary: "boom", lease_token: null });

  runCatch(3, 31, "expired-owner", 0, "stale failure");
  assert.deepEqual({ ...db.prepare("SELECT status,error_summary FROM content_imports WHERE id=3").get() },
    { status: "processing", error_summary: "" });
  assert.deepEqual({ ...db.prepare("SELECT status,lease_token,rows_json FROM content_import_chunks WHERE id=31").get() },
    { status: "processing", lease_token: "new-owner", rows_json: '[{"rowIndex":2}]' });

  runCatch(4, 41, "expired-cancel-owner", 0, "stale cancellation");
  assert.deepEqual({ ...db.prepare("SELECT status,error_summary FROM content_imports WHERE id=4").get() },
    { status: "cancelling", error_summary: "" });
  assert.deepEqual({ ...db.prepare("SELECT status,lease_token,rows_json FROM content_import_chunks WHERE id=41").get() },
    { status: "processing", lease_token: "new-cancel-owner", rows_json: '[{"rowIndex":2}]' });
  db.close();
});

test("content imports use independent durable tables and bounded two-level fanout", async () => {
  const [route, manager, schema, runtime] = await Promise.all([
    readFile(routeFile, "utf8"), readFile(managerFile, "utf8"), readFile(schemaFile, "utf8"), readFile(runtimeFile, "utf8"),
  ]);
  for (const name of ["contentImports", "contentImportChunks", "contentImportRowResults", "contentImportKeys", "contentImportErrors"]) {
    assert.match(schema, new RegExp(`export const ${name} = sqliteTable`));
  }
  for (const table of ["content_imports", "content_import_chunks", "content_import_row_results", "content_import_keys", "content_import_errors"]) {
    assert.match(runtime, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(route, /CONTENT_IMPORT_MAX_FILE_ROWS = 50_000/);
  assert.match(route, /CONTENT_IMPORT_MAX_CHUNKS = 75/);
  assert.match(route, /CONTENT_IMPORT_WORKER_SLOTS = 15/);
  assert.match(route, /CONTENT_IMPORT_CHUNKS_PER_SLOT = 5/);
  assert.match(route, /slot \+ offset \* CONTENT_IMPORT_WORKER_SLOTS/);
  assert.match(route, /fanoutContentImportInternal/);
  assert.match(route, /processContentImportChunkInternal/);
  assert.match(route, /lease_until = datetime\('now','\+2 minutes'\)/);
  assert.match(route, /WHERE import_id = \? AND chunk_index = \?/);
  assert.match(runtime, /content_import_row_results_import_row_uq/);
  assert.match(route, /source_name, source_url, source_published_at/);
  assert.match(route, /data_version, duplicate_strategy, metadata_json/);
  assert.match(route, /dispatch_attempts = dispatch_attempts \+ 1/);
  assert.match(route, /next_retry_at/);
  assert.match(route, /async function dispatchDueImportWork/);
  assert.match(route, /job\.kind === "question"/);
  assert.match(route, /requestQuestionImportContinuation\(Number\(job\.id\), origin\)/);
  const post = section(route, "export async function POST", "const identity = await ensureUser");
  assert.ok(post.indexOf("request.headers.has(INTERNAL_IMPORT_HEADER)") < post.indexOf("await ensureSchema()"));
  assert.match(manager, /文件已完整上传并封存/);
  assert.doesNotMatch(manager, /现在可以关闭页面，后台会继续导入/);
  assert.match(manager, /后续安全请求会继续派发/);
  assert.match(manager, /bulkImportType/);
  assert.match(manager, /内容JSON/);
  assert.match(manager, /adminDownloadContentImportErrors/);
  assert.match(manager, /adminRetryContentImport/);
  assert.match(manager, /adminCancelContentImport/);
  assert.match(manager, /adminSubmitContentImportReview/);
  assert.match(manager, /adminReviewContentImport/);
  assert.match(manager, /adminRollbackContentImport/);
  assert.doesNotMatch(section(manager, "const importPositions", "const resumeContentImport"), /adminUpsertContentBatch/);
});

test("content import finish rejects chunk-index gaps, row gaps and overlaps", async () => {
  const route = await readFile(routeFile, "utf8");
  const finish = section(route, "async function adminFinishContentImport", "async function adminGetContentImport");
  const match = finish.match(/const integrity = await db\.prepare\(`([\s\S]*?)`\)/);
  assert.ok(match, "missing strict content import integrity query");
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE content_import_chunks (
    import_id INTEGER NOT NULL, chunk_index INTEGER NOT NULL, row_offset INTEGER NOT NULL, row_count INTEGER NOT NULL
  )`);
  const integrity = () => db.prepare(match[1]).get(7);
  db.exec(`INSERT INTO content_import_chunks VALUES (7,0,0,2),(7,1,2,2),(7,2,4,1)`);
  assert.deepEqual({ ...integrity() }, { chunks: 3, rows: 5, bad_indexes: 0, bad_ranges: 0, final_offset: 5 });
  db.exec("DELETE FROM content_import_chunks; INSERT INTO content_import_chunks VALUES (7,0,0,2),(7,2,2,3)");
  assert.equal(integrity().bad_indexes, 1);
  db.exec("DELETE FROM content_import_chunks; INSERT INTO content_import_chunks VALUES (7,0,0,2),(7,1,3,2)");
  assert.equal(integrity().bad_ranges, 1, "row gap must fail");
  db.exec("DELETE FROM content_import_chunks; INSERT INTO content_import_chunks VALUES (7,0,0,3),(7,1,2,2)");
  assert.equal(integrity().bad_ranges, 1, "row overlap must fail");
  db.close();
});

test("content import batch workflow is version-bound, reviewed and auditable", async () => {
  const route = await readFile(routeFile, "utf8");
  const submit = section(route, "async function adminSubmitContentImportReview", "async function adminReviewContentImport");
  const review = section(route, "async function adminReviewContentImport", "async function adminRollbackContentImport");
  const rollback = section(route, "async function adminRollbackContentImport", "async function adminStartQuestionImport");
  assert.match(submit, /ci\.version = cir\.content_version/);
  assert.match(submit, /review_status = 'submitting'/);
  assert.match(submit, /if \(!results\[0\]\?\.meta\.changes\)/);
  assert.match(submit, /status = 'pending_review'/);
  assert.match(review, /content\.review/);
  assert.match(review, /提交人与审核人需分离/);
  assert.match(review, /status = \?/);
  assert.match(review, /reviewing_approve/);
  assert.match(review, /UPDATE media_assets AS ma SET access_level = 'free'/);
  assert.match(review, /json_tree\(ci\.payload_json\)/);
  assert.match(review, /CONTENT_IMPORT_REVIEW_CONFLICT/);
  assert.match(rollback, /data_version/);
  assert.match(rollback, /review_status = 'rolling_back'/);
  assert.match(rollback, /import_create/);
  assert.match(rollback, /import_rollback/);
  for (const action of ["adminSubmitContentImportReview", "adminReviewContentImport", "adminRollbackContentImport"])
    assert.match(route, new RegExp(`"${action}"`), `${action} must be audited as a write action`);
});

test("content import workflow claims and free-media promotion execute atomically in SQLite", async () => {
  const route = await readFile(routeFile, "utf8");
  const submit = section(route, "async function adminSubmitContentImportReview", "async function adminReviewContentImport");
  const review = section(route, "async function adminReviewContentImport", "async function adminRollbackContentImport");
  const rollback = section(route, "async function adminRollbackContentImport", "async function adminStartQuestionImport");
  const firstPreparedSql = (source) => {
    const batch = source.slice(source.indexOf("const results = await db.batch(["));
    const match = batch.match(/db\.prepare\(`([\s\S]*?)`\)/);
    assert.ok(match, "missing batch claim SQL");
    return match[1];
  };
  const reviewPrepared = [...review.matchAll(/db\.prepare\(`([\s\S]*?)`\)/g)].map((match) => match[1]);
  const promoteSql = reviewPrepared.find((sql) => sql.includes("UPDATE media_assets AS ma SET access_level = 'free'"));
  assert.ok(promoteSql, "missing free media promotion SQL");

  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE content_imports (
      id INTEGER PRIMARY KEY, status TEXT, review_status TEXT, imported_rows INTEGER,
      updated_at TEXT, submitted_by INTEGER, data_version TEXT
    );
    CREATE TABLE content_import_row_results (
      import_id INTEGER, row_index INTEGER, status TEXT, content_key TEXT, content_version INTEGER
    );
    CREATE TABLE content_items (
      id INTEGER PRIMARY KEY, content_key TEXT, content_type TEXT, payload_json TEXT,
      access_level TEXT, status TEXT, version INTEGER
    );
    CREATE TABLE media_assets (
      id TEXT PRIMARY KEY, status TEXT, content_type TEXT, access_level TEXT, updated_at TEXT
    );
    INSERT INTO content_imports VALUES (41,'completed','draft',1,CURRENT_TIMESTAMP,7,'v1');
    INSERT INTO content_import_row_results VALUES (41,2,'imported','audio-one',1);
    INSERT INTO content_items VALUES (
      1,'audio-one','audio_track',
      '{"audioUrl":"/api/app?media=11111111-1111-4111-8111-111111111111","importSource":{"importId":41}}',
      'free','draft',1
    );
    INSERT INTO media_assets VALUES (
      '11111111-1111-4111-8111-111111111111','active','audio/mpeg','member',CURRENT_TIMESTAMP
    );
  `);
  assert.equal(db.prepare(firstPreparedSql(submit)).run(41).changes, 1);
  db.exec("UPDATE content_imports SET review_status='pending_review'; UPDATE content_items SET status='pending_review'");
  assert.equal(db.prepare(firstPreparedSql(review)).run("reviewing_approve", 41, "published").changes, 1);
  db.exec("UPDATE content_items SET status='published',version=2");
  db.prepare(promoteSql).run(41);
  assert.equal(db.prepare("SELECT access_level FROM media_assets").get().access_level, "free");
  db.exec("UPDATE content_imports SET review_status='published'; UPDATE content_import_row_results SET content_version=2");
  assert.equal(db.prepare(firstPreparedSql(rollback)).run(41).changes, 1);
  db.close();
});

test("every content import UI action has permission and dispatcher registration", async () => {
  const [route, manager] = await Promise.all([readFile(routeFile, "utf8"), readFile(managerFile, "utf8")]);
  const actions = [...new Set([...manager.matchAll(/action:\s*"(admin[A-Za-z0-9]*ContentImport[A-Za-z0-9]*)"/g)].map((match) => match[1]))];
  assert.ok(actions.length >= 7, "expected the complete content import action surface");
  for (const action of actions) {
    assert.match(route, new RegExp(`\\b${action}: \\[`), `${action} must declare an admin permission`);
    assert.match(route, new RegExp(`action === "${action}"`), `${action} must be dispatched by the API`);
  }
});
