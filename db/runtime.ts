import { env } from "@runtime-env";

let schemaReady = false;
let schemaPromise: Promise<void> | null = null;
const RUNTIME_SCHEMA_VERSION = "22";
const MIN_COMPATIBLE_RUNTIME_SCHEMA_VERSION = Number(RUNTIME_SCHEMA_VERSION);

function runtimeSchemaVersionIsCompatible(value: unknown) {
  const version = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(version) && version >= MIN_COMPATIBLE_RUNTIME_SCHEMA_VERSION;
}

export function getD1() {
  const db = (env as unknown as { DB?: D1Database }).DB;
  if (!db) {
    throw new Error("D1 数据库暂不可用，请检查 DB 绑定。");
  }
  return db;
}

async function ensureColumns(
  db: D1Database,
  table: string,
  columns: Array<{ name: string; definition: string }>,
) {
  const existing = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  const names = new Set(existing.results.map((column) => column.name));
  for (const column of columns) {
    if (!names.has(column.name)) {
      await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column.name} ${column.definition}`).run();
    }
  }
}

function quizSchemaStatements(db: D1Database) {
  return [
    db.prepare(`CREATE TABLE IF NOT EXISTS quiz_tests (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      question_count INTEGER NOT NULL DEFAULT 10,
      status TEXT NOT NULL DEFAULT 'draft',
      share_title TEXT NOT NULL DEFAULT '',
      disclaimer TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS quiz_tests_slug_uq ON quiz_tests(slug)"),
    db.prepare("CREATE INDEX IF NOT EXISTS quiz_tests_status_idx ON quiz_tests(status, updated_at)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS quiz_questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      quiz_id TEXT NOT NULL,
      question_code TEXT NOT NULL UNIQUE,
      stem TEXT NOT NULL,
      options_json TEXT NOT NULL DEFAULT '[]',
      correct_index INTEGER NOT NULL DEFAULT 0,
      explanation TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT '办公室语言',
      difficulty TEXT NOT NULL DEFAULT 'medium',
      weight INTEGER NOT NULL DEFAULT 10,
      status TEXT NOT NULL DEFAULT 'draft',
      review_status TEXT NOT NULL DEFAULT 'pending_review',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS quiz_questions_code_uq ON quiz_questions(question_code)"),
    db.prepare("CREATE INDEX IF NOT EXISTS quiz_questions_quiz_status_idx ON quiz_questions(quiz_id, status, review_status)"),
    db.prepare("CREATE INDEX IF NOT EXISTS quiz_questions_category_idx ON quiz_questions(quiz_id, category)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS quiz_result_levels (
      id TEXT PRIMARY KEY,
      quiz_id TEXT NOT NULL,
      level_key TEXT NOT NULL,
      title TEXT NOT NULL,
      min_score INTEGER NOT NULL,
      max_score INTEGER NOT NULL,
      theme TEXT NOT NULL DEFAULT 'blue',
      description TEXT NOT NULL DEFAULT '',
      share_text TEXT NOT NULL DEFAULT '',
      badge_label TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS quiz_result_levels_quiz_key_uq ON quiz_result_levels(quiz_id, level_key)"),
    db.prepare("CREATE INDEX IF NOT EXISTS quiz_result_levels_quiz_score_idx ON quiz_result_levels(quiz_id, min_score, max_score)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS quiz_attempts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      quiz_id TEXT NOT NULL,
      challenge_id TEXT NOT NULL DEFAULT '',
      source_attempt_id TEXT NOT NULL DEFAULT '',
      question_ids_json TEXT NOT NULL DEFAULT '[]',
      option_orders_json TEXT NOT NULL DEFAULT '[]',
      answers_json TEXT NOT NULL DEFAULT '{}',
      correct_count INTEGER,
      result_key TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT,
      share_count INTEGER NOT NULL DEFAULT 0
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS quiz_attempts_user_time_idx ON quiz_attempts(user_id, started_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS quiz_attempts_quiz_status_idx ON quiz_attempts(quiz_id, status, completed_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS quiz_attempts_source_idx ON quiz_attempts(source_attempt_id)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS quiz_share_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      quiz_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL DEFAULT '',
      challenge_id TEXT NOT NULL DEFAULT '',
      event_name TEXT NOT NULL,
      event_data TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS quiz_share_events_quiz_time_idx ON quiz_share_events(quiz_id, created_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS quiz_share_events_attempt_idx ON quiz_share_events(attempt_id, event_name)"),
  ];
}

function essayLibrarySchemaStatements(db: D1Database) {
  return [
    db.prepare(`CREATE TABLE IF NOT EXISTS essay_library_materials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bank_id INTEGER NOT NULL,
      label TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS essay_library_materials_bank_label_uq ON essay_library_materials(bank_id, label)"),
    db.prepare("CREATE INDEX IF NOT EXISTS essay_library_materials_bank_sort_idx ON essay_library_materials(bank_id, status, sort_order)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS essay_library_question_materials (
      question_id INTEGER NOT NULL,
      material_id INTEGER NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS essay_library_question_materials_uq ON essay_library_question_materials(question_id, material_id)"),
    db.prepare("CREATE INDEX IF NOT EXISTS essay_library_question_materials_question_idx ON essay_library_question_materials(question_id, sort_order)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS essay_answer_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_key TEXT NOT NULL,
      name TEXT NOT NULL,
      homepage_url TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS essay_answer_sources_key_uq ON essay_answer_sources(source_key)"),
    db.prepare("CREATE INDEX IF NOT EXISTS essay_answer_sources_status_sort_idx ON essay_answer_sources(status, sort_order)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS essay_reference_answers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question_id INTEGER NOT NULL,
      source_id INTEGER NOT NULL,
      source_title TEXT NOT NULL DEFAULT '',
      display_mode TEXT NOT NULL DEFAULT 'link_only',
      content TEXT NOT NULL DEFAULT '',
      excerpt TEXT NOT NULL DEFAULT '',
      source_url TEXT NOT NULL DEFAULT '',
      copyright_status TEXT NOT NULL DEFAULT 'pending_verification',
      publication_status TEXT NOT NULL DEFAULT 'draft',
      sort_order INTEGER NOT NULL DEFAULT 0,
      original_published_at TEXT,
      collected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_by INTEGER,
      updated_by INTEGER,
      published_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS essay_reference_answers_question_source_uq ON essay_reference_answers(question_id, source_id)"),
    db.prepare("CREATE INDEX IF NOT EXISTS essay_reference_answers_question_status_idx ON essay_reference_answers(question_id, publication_status, sort_order)"),
    db.prepare("CREATE INDEX IF NOT EXISTS essay_reference_answers_source_idx ON essay_reference_answers(source_id, publication_status)"),
  ];
}

function dailyQueueSchemaStatements(db: D1Database) {
  return [
    db.prepare(`CREATE TABLE IF NOT EXISTS user_daily_queue_items (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      date_key TEXT NOT NULL,
      item_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_parent_id TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      estimated_minutes INTEGER NOT NULL DEFAULT 5,
      status TEXT NOT NULL DEFAULT 'scheduled',
      origin TEXT NOT NULL DEFAULT 'manual',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT
    )`),
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS user_daily_queue_items_user_date_source_uq
      ON user_daily_queue_items(user_id, date_key, item_type, source_id)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS user_daily_queue_items_user_date_status_idx
      ON user_daily_queue_items(user_id, date_key, status, sort_order)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS user_daily_queue_items_user_source_idx
      ON user_daily_queue_items(user_id, item_type, source_id, status)`),
  ];
}

async function initializeSchema() {
  const db = getD1();
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      invite_code TEXT NOT NULL UNIQUE,
      invited_by TEXT,
      membership_type TEXT NOT NULL DEFAULT 'duration',
      membership_end TEXT,
      verified_at TEXT,
      analytics_eligible INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS user_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS user_sessions_user_expiry_idx ON user_sessions(user_id, expires_at)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS device_account_links (
      device_hash TEXT NOT NULL,
      user_id TEXT NOT NULL,
      first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS device_account_links_device_user_uq
      ON device_account_links(device_hash, user_id)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS device_account_links_user_device_idx
      ON device_account_links(user_id, device_hash)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS user_daily_usage (
      user_id TEXT NOT NULL,
      date_key TEXT NOT NULL,
      practice_count INTEGER NOT NULL DEFAULT 0,
      audio_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS user_daily_usage_user_date_uq ON user_daily_usage(user_id, date_key)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS user_daily_audio_access (
      user_id TEXT NOT NULL,
      date_key TEXT NOT NULL,
      asset_id TEXT NOT NULL,
      granted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS user_daily_audio_access_user_date_uq ON user_daily_audio_access(user_id, date_key)"),
    db.prepare("CREATE INDEX IF NOT EXISTS user_daily_audio_access_asset_idx ON user_daily_audio_access(asset_id, date_key)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS daily_checkins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      date_key TEXT NOT NULL,
      session_id TEXT,
      source TEXT NOT NULL DEFAULT 'daily_practice',
      completed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS daily_checkins_user_date_uq ON daily_checkins(user_id, date_key)"),
    db.prepare("CREATE INDEX IF NOT EXISTS daily_checkins_user_completed_idx ON daily_checkins(user_id, completed_at)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS daily_step_completions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      date_key TEXT NOT NULL,
      step TEXT NOT NULL,
      source_ref TEXT NOT NULL DEFAULT '',
      completed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS daily_step_completions_user_date_step_uq
      ON daily_step_completions(user_id, date_key, step)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS daily_step_completions_user_completed_idx
      ON daily_step_completions(user_id, completed_at)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS user_daily_queue_items (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      date_key TEXT NOT NULL,
      item_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_parent_id TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      estimated_minutes INTEGER NOT NULL DEFAULT 5,
      status TEXT NOT NULL DEFAULT 'scheduled',
      origin TEXT NOT NULL DEFAULT 'manual',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT
    )`),
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS user_daily_queue_items_user_date_source_uq
      ON user_daily_queue_items(user_id, date_key, item_type, source_id)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS user_daily_queue_items_user_date_status_idx
      ON user_daily_queue_items(user_id, date_key, status, sort_order)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS user_daily_queue_items_user_source_idx
      ON user_daily_queue_items(user_id, item_type, source_id, status)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS user_states (
      user_id TEXT PRIMARY KEY,
      progress_json TEXT NOT NULL DEFAULT '{}',
      version INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS redemption_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code_hash TEXT NOT NULL UNIQUE,
      code_preview TEXT NOT NULL,
      batch_name TEXT NOT NULL,
      grant_type TEXT NOT NULL DEFAULT 'duration',
      duration_days INTEGER NOT NULL,
      channel TEXT NOT NULL DEFAULT 'manual',
      created_by TEXT NOT NULL DEFAULT 'system',
      max_uses INTEGER NOT NULL DEFAULT 1,
      used_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      valid_from TEXT,
      valid_until TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS redemptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      membership_before_type TEXT,
      membership_before_end TEXT,
      membership_after_type TEXT,
      membership_after_end TEXT,
      redeemed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT
    )`),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS redemptions_code_user_uq ON redemptions(code_id, user_id)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS invite_relations (
      invitee_id TEXT PRIMARY KEY,
      inviter_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      verified_at TEXT,
      first_valid_practice_at TEXT,
      risk_status TEXT NOT NULL DEFAULT 'clear',
      inviter_grant_id TEXT,
      invitee_grant_id TEXT,
      bound_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      rewarded_at TEXT
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS membership_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      delta_days INTEGER NOT NULL,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS membership_ledger_source_uq ON membership_ledger(user_id, source_type, source_id)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      price_cents INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'CNY',
      grant_type TEXT NOT NULL,
      duration_days INTEGER,
      public_promise TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS products_status_sort_idx ON products(status, sort_order)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      order_no TEXT NOT NULL,
      user_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      product_name TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'CNY',
      status TEXT NOT NULL DEFAULT 'created',
      channel TEXT NOT NULL DEFAULT 'test',
      idempotency_key TEXT NOT NULL,
      return_context_json TEXT NOT NULL DEFAULT '{}',
      entitlement_grant_id TEXT,
      paid_at TEXT,
      closed_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS orders_order_no_uq ON orders(order_no)"),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS orders_user_idempotency_uq ON orders(user_id, idempotency_key)"),
    db.prepare("CREATE INDEX IF NOT EXISTS orders_user_created_idx ON orders(user_id, created_at)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS payment_transactions (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'test',
      provider_transaction_id TEXT NOT NULL,
      callback_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'CNY',
      status TEXT NOT NULL DEFAULT 'received',
      raw_payload_json TEXT NOT NULL DEFAULT '{}',
      processed_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS payment_transactions_provider_tx_uq ON payment_transactions(provider, provider_transaction_id)"),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS payment_transactions_callback_uq ON payment_transactions(provider, callback_id)"),
    db.prepare("CREATE INDEX IF NOT EXISTS payment_transactions_order_idx ON payment_transactions(order_id, created_at)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS refunds (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      transaction_id TEXT,
      provider TEXT NOT NULL DEFAULT 'test',
      provider_refund_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'CNY',
      status TEXT NOT NULL DEFAULT 'created',
      reason TEXT NOT NULL DEFAULT '',
      processed_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS refunds_provider_refund_uq ON refunds(provider, provider_refund_id)"),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS refunds_idempotency_uq ON refunds(idempotency_key)"),
    db.prepare("CREATE INDEX IF NOT EXISTS refunds_order_idx ON refunds(order_id, created_at)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS entitlement_grants (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      product_id TEXT,
      order_id TEXT,
      grant_type TEXT NOT NULL,
      duration_days INTEGER NOT NULL DEFAULT 0,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      granted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      revoked_at TEXT,
      revoke_reason TEXT NOT NULL DEFAULT ''
    )`),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS entitlement_grants_source_uq ON entitlement_grants(user_id, source_type, source_id)"),
    db.prepare("CREATE INDEX IF NOT EXISTS entitlement_grants_user_status_idx ON entitlement_grants(user_id, status)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS configs (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS content_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content_type TEXT NOT NULL,
      content_key TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      access_level TEXT NOT NULL DEFAULT 'member',
      status TEXT NOT NULL DEFAULT 'draft',
      publish_at TEXT,
      review_note TEXT NOT NULL DEFAULT '',
      submitted_by INTEGER,
      submitted_at TEXT,
      reviewed_by INTEGER,
      reviewed_at TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS content_items_key_uq ON content_items(content_key)"),
    db.prepare(`CREATE INDEX IF NOT EXISTS content_items_job_target_idx
      ON content_items(content_type, status, json_extract(payload_json, '$.targetCode'))`),
    db.prepare(`CREATE TABLE IF NOT EXISTS content_item_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content_id INTEGER NOT NULL,
      version INTEGER NOT NULL,
      content_type TEXT NOT NULL,
      content_key TEXT NOT NULL,
      title TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      access_level TEXT NOT NULL DEFAULT 'member',
      status TEXT NOT NULL,
      publish_at TEXT,
      change_type TEXT NOT NULL DEFAULT 'update',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS content_item_versions_content_version_uq ON content_item_versions(content_id, version)"),
    db.prepare("CREATE INDEX IF NOT EXISTS content_item_versions_content_idx ON content_item_versions(content_id, created_at)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS content_imports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content_type TEXT NOT NULL,
      file_name TEXT NOT NULL,
      file_size INTEGER NOT NULL DEFAULT 0,
      file_hash TEXT NOT NULL,
      source_name TEXT NOT NULL DEFAULT '',
      source_url TEXT NOT NULL DEFAULT '',
      source_published_at TEXT,
      data_version TEXT NOT NULL DEFAULT '',
      duplicate_strategy TEXT NOT NULL DEFAULT 'reject',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      total_rows INTEGER NOT NULL DEFAULT 0,
      uploaded_rows INTEGER NOT NULL DEFAULT 0,
      processed_rows INTEGER NOT NULL DEFAULT 0,
      imported_rows INTEGER NOT NULL DEFAULT 0,
      failed_rows INTEGER NOT NULL DEFAULT 0,
      duplicate_rows INTEGER NOT NULL DEFAULT 0,
      total_chunks INTEGER NOT NULL DEFAULT 0,
      uploaded_chunks INTEGER NOT NULL DEFAULT 0,
      processed_chunks INTEGER NOT NULL DEFAULT 0,
      cancel_requested INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'uploading',
      error_summary TEXT NOT NULL DEFAULT '',
      dispatch_attempts INTEGER NOT NULL DEFAULT 0,
      next_retry_at TEXT,
      review_status TEXT NOT NULL DEFAULT 'draft',
      created_by INTEGER,
      submitted_by INTEGER,
      submitted_at TEXT,
      reviewed_by INTEGER,
      reviewed_at TEXT,
      review_note TEXT NOT NULL DEFAULT '',
      published_at TEXT,
      rolled_back_at TEXT,
      sealed_at TEXT,
      started_at TEXT,
      last_heartbeat_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS content_imports_status_idx ON content_imports(status, updated_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS content_imports_hash_idx ON content_imports(file_hash, created_at)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS content_import_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      import_id INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL,
      row_offset INTEGER NOT NULL,
      row_count INTEGER NOT NULL,
      payload_hash TEXT NOT NULL,
      rows_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      attempts INTEGER NOT NULL DEFAULT 0,
      imported_rows INTEGER NOT NULL DEFAULT 0,
      failed_rows INTEGER NOT NULL DEFAULT 0,
      duplicate_rows INTEGER NOT NULL DEFAULT 0,
      error_summary TEXT NOT NULL DEFAULT '',
      lease_token TEXT,
      lease_until TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT
    )`),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS content_import_chunks_import_index_uq ON content_import_chunks(import_id, chunk_index)"),
    db.prepare("CREATE INDEX IF NOT EXISTS content_import_chunks_status_idx ON content_import_chunks(import_id, status, chunk_index)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS content_import_row_results (
      import_id INTEGER NOT NULL,
      row_index INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL,
      status TEXT NOT NULL,
      content_key TEXT NOT NULL DEFAULT '',
      content_version INTEGER,
      message TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS content_import_row_results_import_row_uq ON content_import_row_results(import_id, row_index)"),
    db.prepare("CREATE INDEX IF NOT EXISTS content_import_row_results_status_idx ON content_import_row_results(import_id, status)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS content_import_keys (
      import_id INTEGER NOT NULL,
      row_index INTEGER NOT NULL,
      content_key TEXT NOT NULL
    )`),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS content_import_keys_import_row_uq ON content_import_keys(import_id, row_index)"),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS content_import_keys_import_key_uq ON content_import_keys(import_id, content_key)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS content_import_errors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      import_id INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL,
      row_index INTEGER NOT NULL,
      content_key TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL,
      message TEXT NOT NULL,
      raw_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS content_import_errors_import_row_kind_uq ON content_import_errors(import_id, row_index, kind)"),
    db.prepare("CREATE INDEX IF NOT EXISTS content_import_errors_import_idx ON content_import_errors(import_id, row_index)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS content_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      content_type TEXT NOT NULL DEFAULT 'question',
      content_key TEXT NOT NULL,
      reason_code TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      context_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      resolved_by INTEGER,
      resolution_note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      resolved_at TEXT
    )`),
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS content_reports_open_uq
      ON content_reports(user_id, content_type, content_key, reason_code) WHERE status = 'pending'`),
    db.prepare("CREATE INDEX IF NOT EXISTS content_reports_status_time_idx ON content_reports(status, created_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS content_reports_user_time_idx ON content_reports(user_id, created_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS content_reports_content_idx ON content_reports(content_type, content_key)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS media_assets (
      id TEXT PRIMARY KEY,
      object_key TEXT NOT NULL UNIQUE,
      file_name TEXT NOT NULL,
      content_type TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      checksum TEXT NOT NULL,
      storage TEXT NOT NULL DEFAULT 'r2',
      fallback_data TEXT,
      access_level TEXT NOT NULL DEFAULT 'member',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS media_assets_status_idx ON media_assets(status, created_at)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS analytics_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      event_name TEXT NOT NULL,
      event_data TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS analytics_events_name_time_idx ON analytics_events(event_name, created_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS analytics_events_user_time_idx ON analytics_events(user_id, created_at)"),
    ...quizSchemaStatements(db),
    db.prepare(`CREATE TABLE IF NOT EXISTS question_banks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bank_code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      exam_type TEXT NOT NULL,
      province TEXT,
      exam_year INTEGER,
      subject TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      cover_color TEXT NOT NULL DEFAULT 'blue',
      status TEXT NOT NULL DEFAULT 'draft',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question_code TEXT NOT NULL UNIQUE,
      subject TEXT NOT NULL,
      module TEXT NOT NULL,
      sub_type TEXT NOT NULL DEFAULT '',
      stem TEXT NOT NULL,
      options_json TEXT NOT NULL DEFAULT '[]',
      answer TEXT,
      explanation TEXT NOT NULL DEFAULT '',
      technique TEXT NOT NULL DEFAULT '',
      material TEXT NOT NULL DEFAULT '',
      prompt TEXT NOT NULL DEFAULT '',
      word_limit INTEGER,
      scoring_points_json TEXT NOT NULL DEFAULT '[]',
      difficulty TEXT NOT NULL DEFAULT '中等',
      source TEXT NOT NULL DEFAULT '',
      source_exam_type TEXT NOT NULL DEFAULT '',
      source_region TEXT NOT NULL DEFAULT '全国',
      source_year INTEGER,
      source_batch TEXT NOT NULL DEFAULT '',
      truth_verified INTEGER NOT NULL DEFAULT 0,
      truth_verified_at TEXT,
      review_status TEXT NOT NULL DEFAULT 'pending_review',
      reviewed_by INTEGER,
      reviewed_at TEXT,
      review_note TEXT NOT NULL DEFAULT '',
      frequency TEXT NOT NULL DEFAULT '中频',
      frequency_occurrences INTEGER NOT NULL DEFAULT 0,
      frequency_papers INTEGER NOT NULL DEFAULT 0,
      frequency_years_json TEXT NOT NULL DEFAULT '[]',
      frequency_updated_at TEXT,
      importance_stars INTEGER NOT NULL DEFAULT 3,
      importance_rule_version TEXT NOT NULL DEFAULT '',
      importance_reason TEXT NOT NULL DEFAULT '',
      importance_override_reason TEXT NOT NULL DEFAULT '',
      score_rate INTEGER NOT NULL DEFAULT 60,
      score_rate_correct INTEGER NOT NULL DEFAULT 0,
      score_rate_attempts INTEGER NOT NULL DEFAULT 0,
      score_rate_scope TEXT NOT NULL DEFAULT '',
      score_rate_source TEXT NOT NULL DEFAULT 'platform',
      score_rate_updated_at TEXT,
      suggested_seconds INTEGER NOT NULL DEFAULT 60,
      image_url TEXT NOT NULL DEFAULT '',
      resource_url TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS questions_subject_module_idx ON questions(subject, module)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS question_bank_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bank_id INTEGER NOT NULL,
      question_id INTEGER NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS question_bank_items_bank_question_uq ON question_bank_items(bank_id, question_id)"),
    db.prepare("CREATE INDEX IF NOT EXISTS question_bank_items_bank_idx ON question_bank_items(bank_id, sort_order)"),
    ...essayLibrarySchemaStatements(db),
    db.prepare(`CREATE TABLE IF NOT EXISTS question_imports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bank_id INTEGER NOT NULL,
      file_name TEXT NOT NULL,
      file_size INTEGER NOT NULL DEFAULT 0,
      file_hash TEXT NOT NULL DEFAULT '',
      duplicate_strategy TEXT NOT NULL DEFAULT 'reject',
      total_rows INTEGER NOT NULL DEFAULT 0,
      uploaded_rows INTEGER NOT NULL DEFAULT 0,
      processed_rows INTEGER NOT NULL DEFAULT 0,
      imported_rows INTEGER NOT NULL DEFAULT 0,
      failed_rows INTEGER NOT NULL DEFAULT 0,
      duplicate_rows INTEGER NOT NULL DEFAULT 0,
      total_chunks INTEGER NOT NULL DEFAULT 0,
      uploaded_chunks INTEGER NOT NULL DEFAULT 0,
      processed_chunks INTEGER NOT NULL DEFAULT 0,
      cancel_requested INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'uploading',
      error_summary TEXT NOT NULL DEFAULT '',
      created_by INTEGER,
      sealed_at TEXT,
      started_at TEXT,
      last_heartbeat_at TEXT,
      lease_token TEXT,
      lease_until TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS question_import_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      import_id INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL,
      row_offset INTEGER NOT NULL,
      row_count INTEGER NOT NULL,
      payload_hash TEXT NOT NULL,
      rows_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      attempts INTEGER NOT NULL DEFAULT 0,
      imported_rows INTEGER NOT NULL DEFAULT 0,
      failed_rows INTEGER NOT NULL DEFAULT 0,
      duplicate_rows INTEGER NOT NULL DEFAULT 0,
      error_summary TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT
    )`),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS question_import_chunks_import_index_uq ON question_import_chunks(import_id, chunk_index)"),
    db.prepare("CREATE INDEX IF NOT EXISTS question_import_chunks_status_idx ON question_import_chunks(import_id, status, chunk_index)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS question_import_codes (
      import_id INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL,
      row_number INTEGER NOT NULL,
      question_code TEXT NOT NULL,
      base_version INTEGER NOT NULL DEFAULT 0
    )`),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS question_import_codes_import_row_uq ON question_import_codes(import_id, row_number)"),
    db.prepare("CREATE INDEX IF NOT EXISTS question_import_codes_code_idx ON question_import_codes(import_id, question_code)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS question_import_row_results (
      import_id INTEGER NOT NULL,
      row_number INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL,
      status TEXT NOT NULL,
      question_code TEXT NOT NULL DEFAULT '',
      question_version INTEGER,
      message TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS question_import_row_results_import_row_uq ON question_import_row_results(import_id, row_number)"),
    db.prepare("CREATE INDEX IF NOT EXISTS question_import_row_results_status_idx ON question_import_row_results(import_id, status)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS question_import_errors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      import_id INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL,
      row_number INTEGER NOT NULL,
      question_code TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'validation',
      message TEXT NOT NULL,
      raw_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS question_import_errors_import_row_uq ON question_import_errors(import_id, row_number)"),
    db.prepare("CREATE INDEX IF NOT EXISTS question_import_errors_import_idx ON question_import_errors(import_id, row_number)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS question_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question_id INTEGER NOT NULL,
      version INTEGER NOT NULL,
      question_code TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      change_type TEXT NOT NULL DEFAULT 'import',
      import_id INTEGER,
      source_row INTEGER,
      from_version INTEGER,
      admin_user_id INTEGER,
      review_status TEXT NOT NULL DEFAULT 'pending_review',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS question_versions_question_version_uq ON question_versions(question_id, version)"),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS question_versions_import_row_uq ON question_versions(import_id, source_row)"),
    db.prepare("CREATE INDEX IF NOT EXISTS question_versions_question_idx ON question_versions(question_id, created_at)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS user_exam_profiles (
      user_id TEXT PRIMARY KEY,
      exam_type TEXT NOT NULL DEFAULT '国考',
      province TEXT NOT NULL DEFAULT '',
      exam_year INTEGER NOT NULL DEFAULT 2027,
      exam_date TEXT,
      daily_minutes INTEGER NOT NULL DEFAULT 30,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS user_exam_targets (
      user_id TEXT NOT NULL,
      target_code TEXT NOT NULL,
      exam_type TEXT NOT NULL,
      province TEXT NOT NULL DEFAULT '',
      exam_year INTEGER NOT NULL,
      exam_date TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS user_exam_targets_user_target_uq ON user_exam_targets(user_id, target_code)"),
    db.prepare("CREATE INDEX IF NOT EXISTS user_exam_targets_user_idx ON user_exam_targets(user_id, created_at)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS user_question_banks (
      user_id TEXT NOT NULL,
      bank_code TEXT NOT NULL,
      added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS user_question_banks_user_bank_uq ON user_question_banks(user_id, bank_code)"),
    db.prepare("CREATE INDEX IF NOT EXISTS user_question_banks_user_idx ON user_question_banks(user_id, added_at)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS user_question_progress (
      user_id TEXT NOT NULL,
      question_code TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'learning',
      correct_count INTEGER NOT NULL DEFAULT 0,
      wrong_count INTEGER NOT NULL DEFAULT 0,
      uncertain_count INTEGER NOT NULL DEFAULT 0,
      last_answer INTEGER,
      last_correct INTEGER NOT NULL DEFAULT 0,
      last_duration_ms INTEGER NOT NULL DEFAULT 0,
      last_answered_at TEXT,
      next_review_at TEXT,
      favorite INTEGER NOT NULL DEFAULT 0,
      wrong_reason TEXT NOT NULL DEFAULT '',
      review_count INTEGER NOT NULL DEFAULT 0,
      review_stage INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS user_question_progress_user_question_uq ON user_question_progress(user_id, question_code)"),
    db.prepare("CREATE INDEX IF NOT EXISTS user_question_progress_due_idx ON user_question_progress(user_id, next_review_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS user_question_progress_state_idx ON user_question_progress(user_id, state)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS practice_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      attempt_key TEXT,
      practice_session_id TEXT,
      user_id TEXT NOT NULL,
      question_code TEXT NOT NULL,
      bank_code TEXT NOT NULL,
      module TEXT NOT NULL,
      selected_answer INTEGER,
      is_correct INTEGER NOT NULL,
      uncertain INTEGER NOT NULL DEFAULT 0,
      confidence TEXT NOT NULL DEFAULT 'confident',
      wrong_reason TEXT NOT NULL DEFAULT '',
      overtime INTEGER NOT NULL DEFAULT 0,
      was_due INTEGER NOT NULL DEFAULT 0,
      apply_status TEXT NOT NULL DEFAULT 'applied',
      duration_ms INTEGER NOT NULL DEFAULT 0,
      answered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS practice_attempts_user_time_idx ON practice_attempts(user_id, answered_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS practice_attempts_user_module_idx ON practice_attempts(user_id, module)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS practice_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      date_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'mixed',
      status TEXT NOT NULL DEFAULT 'active',
      plan_minutes INTEGER NOT NULL DEFAULT 30,
      target_count INTEGER NOT NULL DEFAULT 0,
      bank_codes_json TEXT NOT NULL DEFAULT '[]',
      question_codes_json TEXT NOT NULL DEFAULT '[]',
      answered_count INTEGER NOT NULL DEFAULT 0,
      correct_count INTEGER NOT NULL DEFAULT 0,
      review_added INTEGER NOT NULL DEFAULT 0,
      elapsed_seconds INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS practice_sessions_user_date_idx ON practice_sessions(user_id, date_key)"),
    db.prepare("CREATE INDEX IF NOT EXISTS practice_sessions_status_idx ON practice_sessions(user_id, status)"),
    db.prepare(`UPDATE practice_sessions SET status = 'abandoned', updated_at = CURRENT_TIMESTAMP
      WHERE status = 'active' AND EXISTS (
        SELECT 1 FROM practice_sessions newer
        WHERE newer.user_id = practice_sessions.user_id AND newer.date_key = practice_sessions.date_key
          AND newer.kind = practice_sessions.kind AND newer.mode = practice_sessions.mode
          AND newer.status = 'active'
          AND (newer.created_at > practice_sessions.created_at
            OR (newer.created_at = practice_sessions.created_at AND newer.id > practice_sessions.id)))`),
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS practice_sessions_active_uq
      ON practice_sessions(user_id, date_key, kind, mode) WHERE status = 'active'`),
    db.prepare(`CREATE TABLE IF NOT EXISTS essay_attempts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      question_code TEXT NOT NULL,
      date_key TEXT NOT NULL,
      stage TEXT NOT NULL DEFAULT 'draft',
      first_draft TEXT NOT NULL DEFAULT '',
      self_checks_json TEXT NOT NULL DEFAULT '[]',
      self_score INTEGER,
      loss_reasons_json TEXT NOT NULL DEFAULT '[]',
      revised_draft TEXT NOT NULL DEFAULT '',
      rewrite_draft TEXT NOT NULL DEFAULT '',
      elapsed_seconds INTEGER NOT NULL DEFAULT 0,
      rewrite_due_at TEXT,
      submitted_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS essay_attempts_user_question_date_uq ON essay_attempts(user_id, question_code, date_key)"),
    db.prepare("CREATE INDEX IF NOT EXISTS essay_attempts_rewrite_due_idx ON essay_attempts(user_id, rewrite_due_at)"),
  ]);
  await ensureColumns(db, "users", [
    { name: "membership_type", definition: "TEXT NOT NULL DEFAULT 'duration'" },
    { name: "verified_at", definition: "TEXT" },
    { name: "analytics_eligible", definition: "INTEGER NOT NULL DEFAULT 1" },
  ]);
  await ensureColumns(db, "redemption_codes", [
    { name: "grant_type", definition: "TEXT NOT NULL DEFAULT 'duration'" },
    { name: "channel", definition: "TEXT NOT NULL DEFAULT 'manual'" },
    { name: "created_by", definition: "TEXT NOT NULL DEFAULT 'system'" },
  ]);
  await ensureColumns(db, "redemptions", [
    { name: "status", definition: "TEXT NOT NULL DEFAULT 'pending'" },
    { name: "completed_at", definition: "TEXT" },
    { name: "membership_before_type", definition: "TEXT" },
    { name: "membership_before_end", definition: "TEXT" },
    { name: "membership_after_type", definition: "TEXT" },
    { name: "membership_after_end", definition: "TEXT" },
  ]);
  await ensureColumns(db, "user_states", [
    { name: "version", definition: "INTEGER NOT NULL DEFAULT 0" },
  ]);
  await ensureColumns(db, "invite_relations", [
    { name: "verified_at", definition: "TEXT" },
    { name: "first_valid_practice_at", definition: "TEXT" },
    { name: "risk_status", definition: "TEXT NOT NULL DEFAULT 'clear'" },
    { name: "inviter_grant_id", definition: "TEXT" },
    { name: "invitee_grant_id", definition: "TEXT" },
  ]);
  await ensureColumns(db, "content_items", [
    { name: "version", definition: "INTEGER NOT NULL DEFAULT 1" },
    { name: "access_level", definition: "TEXT NOT NULL DEFAULT 'member'" },
    { name: "review_note", definition: "TEXT NOT NULL DEFAULT ''" },
    { name: "submitted_by", definition: "INTEGER" },
    { name: "submitted_at", definition: "TEXT" },
    { name: "reviewed_by", definition: "INTEGER" },
    { name: "reviewed_at", definition: "TEXT" },
  ]);
  await ensureColumns(db, "content_item_versions", [
    { name: "access_level", definition: "TEXT NOT NULL DEFAULT 'member'" },
  ]);
  await ensureColumns(db, "media_assets", [
    { name: "access_level", definition: "TEXT NOT NULL DEFAULT 'member'" },
  ]);
  await ensureColumns(db, "content_imports", [
    { name: "duplicate_strategy", definition: "TEXT NOT NULL DEFAULT 'reject'" },
    { name: "dispatch_attempts", definition: "INTEGER NOT NULL DEFAULT 0" },
    { name: "next_retry_at", definition: "TEXT" },
    { name: "review_status", definition: "TEXT NOT NULL DEFAULT 'draft'" },
    { name: "submitted_by", definition: "INTEGER" },
    { name: "submitted_at", definition: "TEXT" },
    { name: "reviewed_by", definition: "INTEGER" },
    { name: "reviewed_at", definition: "TEXT" },
    { name: "review_note", definition: "TEXT NOT NULL DEFAULT ''" },
    { name: "published_at", definition: "TEXT" },
    { name: "rolled_back_at", definition: "TEXT" },
  ]);
  await db.batch([
    db.prepare(`UPDATE content_items SET status = 'draft', publish_at = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE status IN ('published','scheduled') AND (
        (content_type IN ('morning_read','current_affairs','essay_micro','audio_track') AND (
          COALESCE(json_extract(payload_json,'$.source'),'') = ''
          OR COALESCE(json_extract(payload_json,'$.sourceUrl'),'') NOT LIKE 'https://%'
          OR COALESCE(json_extract(payload_json,'$.sourceDate'),'') NOT GLOB '????-??-??'))
        OR (content_type = 'exam_notice' AND (COALESCE(json_extract(payload_json,'$.sourceUrl'),'') NOT LIKE 'https://%'
          OR COALESCE(json_extract(payload_json,'$.publishDate'),'') NOT GLOB '????-??-??'))
        OR (content_type = 'exam_event' AND (COALESCE(json_extract(payload_json,'$.sourceUrl'),'') NOT LIKE 'https://%'
          OR COALESCE(json_extract(payload_json,'$.eventDate'),'') NOT GLOB '????-??-??'))
        OR (content_type = 'job_position' AND (COALESCE(json_extract(payload_json,'$.sourceUrl'),'') NOT LIKE 'https://%'
          OR COALESCE(json_extract(payload_json,'$.updatedAt'),'') NOT GLOB '????-??-??'
          OR COALESCE(json_extract(payload_json,'$.dataVersion'),0) < 1))
      )`),
    db.prepare("UPDATE content_items SET access_level = 'member' WHERE access_level NOT IN ('free','member')"),
    db.prepare("UPDATE content_item_versions SET access_level = 'member' WHERE access_level NOT IN ('free','member')"),
    db.prepare("UPDATE media_assets SET access_level = 'member' WHERE access_level NOT IN ('free','member')"),
  ]);
  await ensureColumns(db, "questions", [
    { name: "source_exam_type", definition: "TEXT NOT NULL DEFAULT ''" },
    { name: "source_region", definition: "TEXT NOT NULL DEFAULT '全国'" },
    { name: "source_year", definition: "INTEGER" },
    { name: "source_batch", definition: "TEXT NOT NULL DEFAULT ''" },
    { name: "truth_verified", definition: "INTEGER NOT NULL DEFAULT 0" },
    { name: "truth_verified_at", definition: "TEXT" },
    { name: "review_status", definition: "TEXT NOT NULL DEFAULT 'pending_review'" },
    { name: "reviewed_by", definition: "INTEGER" },
    { name: "reviewed_at", definition: "TEXT" },
    { name: "review_note", definition: "TEXT NOT NULL DEFAULT ''" },
    { name: "frequency", definition: "TEXT NOT NULL DEFAULT '中频'" },
    { name: "frequency_occurrences", definition: "INTEGER NOT NULL DEFAULT 0" },
    { name: "frequency_papers", definition: "INTEGER NOT NULL DEFAULT 0" },
    { name: "frequency_years_json", definition: "TEXT NOT NULL DEFAULT '[]'" },
    { name: "frequency_updated_at", definition: "TEXT" },
    { name: "importance_stars", definition: "INTEGER NOT NULL DEFAULT 3" },
    { name: "importance_rule_version", definition: "TEXT NOT NULL DEFAULT ''" },
    { name: "importance_reason", definition: "TEXT NOT NULL DEFAULT ''" },
    { name: "importance_override_reason", definition: "TEXT NOT NULL DEFAULT ''" },
    { name: "score_rate", definition: "INTEGER NOT NULL DEFAULT 60" },
    { name: "score_rate_correct", definition: "INTEGER NOT NULL DEFAULT 0" },
    { name: "score_rate_attempts", definition: "INTEGER NOT NULL DEFAULT 0" },
    { name: "score_rate_scope", definition: "TEXT NOT NULL DEFAULT ''" },
    { name: "score_rate_source", definition: "TEXT NOT NULL DEFAULT 'platform'" },
    { name: "score_rate_updated_at", definition: "TEXT" },
    { name: "suggested_seconds", definition: "INTEGER NOT NULL DEFAULT 60" },
    { name: "image_url", definition: "TEXT NOT NULL DEFAULT ''" },
    { name: "resource_url", definition: "TEXT NOT NULL DEFAULT ''" },
    { name: "version", definition: "INTEGER NOT NULL DEFAULT 1" },
  ]);
  await ensureColumns(db, "question_banks", [
    { name: "paper_type", definition: "TEXT NOT NULL DEFAULT ''" },
    { name: "source_url", definition: "TEXT NOT NULL DEFAULT ''" },
    { name: "resource_url", definition: "TEXT NOT NULL DEFAULT ''" },
    { name: "library_enabled", definition: "INTEGER NOT NULL DEFAULT 0" },
    { name: "library_access_level", definition: "TEXT NOT NULL DEFAULT 'free'" },
    { name: "library_status", definition: "TEXT NOT NULL DEFAULT 'draft'" },
  ]);
  await ensureColumns(db, "question_bank_items", [
    { name: "question_number", definition: "TEXT NOT NULL DEFAULT ''" },
    { name: "score", definition: "INTEGER" },
  ]);
  await ensureColumns(db, "question_imports", [
    { name: "file_hash", definition: "TEXT NOT NULL DEFAULT ''" },
    { name: "duplicate_strategy", definition: "TEXT NOT NULL DEFAULT 'reject'" },
    { name: "uploaded_rows", definition: "INTEGER NOT NULL DEFAULT 0" },
    { name: "processed_rows", definition: "INTEGER NOT NULL DEFAULT 0" },
    { name: "duplicate_rows", definition: "INTEGER NOT NULL DEFAULT 0" },
    { name: "total_chunks", definition: "INTEGER NOT NULL DEFAULT 0" },
    { name: "uploaded_chunks", definition: "INTEGER NOT NULL DEFAULT 0" },
    { name: "processed_chunks", definition: "INTEGER NOT NULL DEFAULT 0" },
    { name: "cancel_requested", definition: "INTEGER NOT NULL DEFAULT 0" },
    { name: "created_by", definition: "INTEGER" },
    { name: "sealed_at", definition: "TEXT" },
    { name: "started_at", definition: "TEXT" },
    { name: "last_heartbeat_at", definition: "TEXT" },
    { name: "lease_token", definition: "TEXT" },
    { name: "lease_until", definition: "TEXT" },
    { name: "updated_at", definition: "TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP" },
  ]);
  await ensureColumns(db, "question_import_codes", [
    { name: "base_version", definition: "INTEGER NOT NULL DEFAULT 0" },
  ]);
  // Pre-persistent imports only stored aggregate counters, not their source
  // rows. They cannot be resumed safely after a deploy, so surface them as a
  // retryable failure instead of leaving an unfinishable "processing" job.
  await db.prepare(`UPDATE question_imports SET status = 'failed',
    error_summary = CASE WHEN error_summary = ''
      THEN '历史导入任务没有持久化分块，不能安全续传；请重新导入原文件' ELSE error_summary END,
    updated_at = CURRENT_TIMESTAMP
    WHERE status = 'processing' AND completed_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM question_import_chunks WHERE question_import_chunks.import_id = question_imports.id)`).run();
  await db.prepare(`INSERT OR IGNORE INTO question_versions
    (question_id, version, question_code, snapshot_json, change_type, review_status, created_at)
    SELECT id, version, question_code,
      json_object(
        'questionCode', question_code, 'subject', subject, 'module', module, 'subType', sub_type,
        'stem', stem, 'options', json(CASE WHEN json_valid(options_json) THEN options_json ELSE '[]' END), 'answer', answer, 'explanation', explanation,
        'technique', technique, 'material', material, 'prompt', prompt, 'wordLimit', word_limit,
        'scoringPoints', json(CASE WHEN json_valid(scoring_points_json) THEN scoring_points_json ELSE '[]' END), 'difficulty', difficulty, 'source', source,
        'sourceExamType', source_exam_type, 'sourceBatch', source_batch, 'region', source_region,
        'examYear', source_year, 'frequency', frequency, 'frequencyOccurrences', frequency_occurrences,
        'frequencyPapers', frequency_papers, 'frequencyYears', json(CASE WHEN json_valid(frequency_years_json) THEN frequency_years_json ELSE '[]' END),
        'frequencyUpdatedAt', frequency_updated_at, 'importanceStars', importance_stars,
        'importanceRuleVersion', importance_rule_version, 'importanceReason', importance_reason,
        'importanceOverrideReason', importance_override_reason, 'scoreRate', score_rate,
        'scoreRateCorrect', score_rate_correct, 'scoreRateAttempts', score_rate_attempts,
        'scoreRateScope', score_rate_scope, 'scoreRateSource', score_rate_source,
        'scoreRateUpdatedAt', score_rate_updated_at, 'suggestedSeconds', suggested_seconds,
        'imageUrl', image_url, 'resourceUrl', resource_url, 'status', status,
        'truthVerified', truth_verified, 'reviewStatus', review_status
      ), 'baseline', review_status, created_at
    FROM questions`).run();
  // Legacy rows must never become “verified real questions” merely because
  // descriptive fields are non-empty. Only the explicit import/review flow may
  // set truth_verified=1 and review_status='approved'.
  await db.prepare(`UPDATE questions SET review_status = 'pending_review', truth_verified_at = NULL
    WHERE truth_verified = 0 AND review_status = 'approved'`).run();
  // Historical uploads pre-dating byte-signature validation may contain an
  // active browser-executable payload (for example SVG/HTML).  Keep the row
  // for audit purposes, but make it impossible to serve until an operator
  // replaces it with a verified, canonical media type.
  await db.prepare(`UPDATE media_assets SET status = 'disabled', updated_at = CURRENT_TIMESTAMP
    WHERE status = 'active' AND lower(content_type) NOT IN (
      'image/jpeg', 'image/png', 'image/gif', 'image/webp',
      'audio/wav', 'audio/mpeg', 'audio/aac', 'audio/mp4', 'audio/ogg',
      'application/pdf'
    )`).run();
  await ensureColumns(db, "practice_attempts", [
    { name: "attempt_key", definition: "TEXT" },
    { name: "practice_session_id", definition: "TEXT" },
    { name: "selected_answer", definition: "INTEGER" },
    { name: "was_due", definition: "INTEGER NOT NULL DEFAULT 0" },
    { name: "apply_status", definition: "TEXT NOT NULL DEFAULT 'applied'" },
  ]);
  await ensureColumns(db, "essay_attempts", [
    { name: "rewrite_draft", definition: "TEXT NOT NULL DEFAULT ''" },
  ]);
  // daily_checkins is the only trusted source for streaks. Keep cleanup for
  // legacy invalid rows, but do not infer a full-day check-in merely from the
  // practice step: morning/essay may still be unfinished.
  await db.prepare(`DELETE FROM daily_checkins
    WHERE session_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM practice_sessions ps WHERE ps.id = daily_checkins.session_id
        AND ps.user_id = daily_checkins.user_id AND ps.date_key = daily_checkins.date_key
        AND ps.kind = 'daily' AND ps.mode = 'mixed' AND ps.status = 'completed'
        AND ps.target_count >= 5 AND ps.answered_count >= ps.target_count
    )`).run();
  await db.prepare(`UPDATE admin_audit_logs
    SET details_json = '{"redacted":true,"reason":"legacy sensitive audit payload removed"}'
    WHERE lower(details_json) LIKE '%"password"%'
       OR lower(details_json) LIKE '%"admintoken"%'
       OR lower(details_json) LIKE '%"authorization"%'
       OR lower(details_json) LIKE '%"codes"%'`).run();
  await db.prepare(`DELETE FROM user_sessions
    WHERE revoked_at IS NOT NULL OR datetime(expires_at) <= CURRENT_TIMESTAMP`).run();
  await db.prepare(`UPDATE practice_attempts SET practice_session_id = NULL
    WHERE practice_session_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM practice_attempts newer
      WHERE newer.user_id = practice_attempts.user_id
        AND newer.practice_session_id = practice_attempts.practice_session_id
        AND newer.question_code = practice_attempts.question_code
        AND newer.id > practice_attempts.id)`).run();
  await db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS practice_attempts_user_key_uq ON practice_attempts(user_id, attempt_key)").run();
  await db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS practice_attempts_session_question_uq
    ON practice_attempts(user_id, practice_session_id, question_code) WHERE practice_session_id IS NOT NULL`).run();
  await db.prepare(`INSERT INTO configs (key, value, updated_at) VALUES ('runtime_schema_version', ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`)
    .bind(RUNTIME_SCHEMA_VERSION).run();
  schemaReady = true;
}

async function deployedSchemaIsCurrent() {
  const db = getD1();
  try {
    const state = await db.prepare(`SELECT
      COALESCE((SELECT value FROM configs WHERE key = 'runtime_schema_version'), '') AS version,
      EXISTS(SELECT 1 FROM pragma_table_info('content_items') WHERE name = 'access_level') AS content_access,
      (SELECT COUNT(*) FROM pragma_table_info('content_items')
        WHERE name IN ('review_note','submitted_by','submitted_at','reviewed_by','reviewed_at')) AS content_review_columns,
      EXISTS(SELECT 1 FROM pragma_table_info('media_assets') WHERE name = 'access_level') AS media_access,
      EXISTS(SELECT 1 FROM pragma_table_info('users') WHERE name = 'analytics_eligible') AS analytics_eligible,
      EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'device_account_links') AS device_account_links,
      EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'content_imports') AS content_imports,
      EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'content_import_chunks') AS content_chunks,
      EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'daily_step_completions') AS daily_steps,
      EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'user_daily_queue_items') AS daily_queue,
      (SELECT COUNT(*) FROM pragma_table_info('user_daily_queue_items')
        WHERE name IN ('user_id','date_key','item_type','source_id','source_parent_id','title','detail','estimated_minutes','status','origin','sort_order','completed_at')) AS daily_queue_columns,
      EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'quiz_tests') AS quiz_tests,
      EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'quiz_questions') AS quiz_questions,
      EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'quiz_attempts') AS quiz_attempts,
      EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'essay_library_materials') AS essay_materials,
      EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'essay_library_question_materials') AS essay_question_materials,
      EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'essay_answer_sources') AS essay_sources,
      EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'essay_reference_answers') AS essay_answers,
      (SELECT COUNT(*) FROM pragma_table_info('question_banks')
        WHERE name IN ('paper_type','source_url','resource_url','library_enabled','library_access_level','library_status')) AS essay_bank_columns,
      (SELECT COUNT(*) FROM pragma_table_info('question_bank_items')
        WHERE name IN ('question_number','score')) AS essay_item_columns,
      (SELECT COUNT(*) FROM pragma_table_info('essay_library_materials')
        WHERE name IN ('bank_id','label','content','sort_order','status')) AS essay_material_columns,
      (SELECT COUNT(*) FROM pragma_table_info('essay_library_question_materials')
        WHERE name IN ('question_id','material_id','sort_order')) AS essay_question_material_columns,
      (SELECT COUNT(*) FROM pragma_table_info('essay_answer_sources')
        WHERE name IN ('source_key','name','status','sort_order')) AS essay_source_columns,
      (SELECT COUNT(*) FROM pragma_table_info('essay_reference_answers')
        WHERE name IN ('question_id','source_id','display_mode','content','excerpt','source_url','copyright_status','publication_status','sort_order')) AS essay_answer_columns`)
      .first<{
        version: string; content_access: number; content_review_columns: number; media_access: number;
        analytics_eligible: number; device_account_links: number; content_imports: number; content_chunks: number;
        daily_steps: number; daily_queue: number; daily_queue_columns: number;
        quiz_tests: number; quiz_questions: number; quiz_attempts: number;
        essay_materials: number; essay_question_materials: number; essay_sources: number; essay_answers: number;
        essay_bank_columns: number; essay_item_columns: number; essay_material_columns: number;
        essay_question_material_columns: number; essay_source_columns: number; essay_answer_columns: number;
      }>();
    const current = Boolean(state && Number(state.content_access) === 1 && Number(state.media_access) === 1
      && Number(state.content_review_columns) === 5 && Number(state.analytics_eligible) === 1
      && Number(state.device_account_links) === 1
      && Number(state.content_imports) === 1 && Number(state.content_chunks) === 1
      && Number(state.daily_steps) === 1
      && Number(state.daily_queue) === 1 && Number(state.daily_queue_columns) === 12
      && Number(state.quiz_tests) === 1 && Number(state.quiz_questions) === 1 && Number(state.quiz_attempts) === 1
      && Number(state.essay_materials) === 1 && Number(state.essay_question_materials) === 1
      && Number(state.essay_sources) === 1 && Number(state.essay_answers) === 1
      && Number(state.essay_bank_columns) === 6 && Number(state.essay_item_columns) === 2
      && Number(state.essay_material_columns) === 5 && Number(state.essay_question_material_columns) === 3
      && Number(state.essay_source_columns) === 4 && Number(state.essay_answer_columns) === 9
      // Database migrations are forward-only. A failed application rollback can
      // legitimately leave D1 on a newer additive schema, so accept newer
      // versions once every structure required by this build is present.
      && runtimeSchemaVersionIsCompatible(state.version));
    if (!current) return false;
    return true;
  } catch {
    return false;
  }
}

async function upgradeRuntimeSchemaFrom17() {
  const db = getD1();
  const state = await db.prepare(`SELECT
    COALESCE((SELECT value FROM configs WHERE key = 'runtime_schema_version'), '') AS version,
    EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'content_import_chunks') AS prior_schema_ready`)
    .first<{ version: string; prior_schema_ready: number }>();
  if (String(state?.version ?? "") !== "17" || Number(state?.prior_schema_ready ?? 0) !== 1) return false;
  await ensureColumns(db, "question_banks", [
    { name: "paper_type", definition: "TEXT NOT NULL DEFAULT ''" },
    { name: "source_url", definition: "TEXT NOT NULL DEFAULT ''" },
    { name: "resource_url", definition: "TEXT NOT NULL DEFAULT ''" },
    { name: "library_enabled", definition: "INTEGER NOT NULL DEFAULT 0" },
    { name: "library_access_level", definition: "TEXT NOT NULL DEFAULT 'free'" },
    { name: "library_status", definition: "TEXT NOT NULL DEFAULT 'draft'" },
  ]);
  await ensureColumns(db, "question_bank_items", [
    { name: "question_number", definition: "TEXT NOT NULL DEFAULT ''" },
    { name: "score", definition: "INTEGER" },
  ]);
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS daily_step_completions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      date_key TEXT NOT NULL,
      step TEXT NOT NULL,
      source_ref TEXT NOT NULL DEFAULT '',
      completed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS daily_step_completions_user_date_step_uq
      ON daily_step_completions(user_id, date_key, step)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS daily_step_completions_user_completed_idx
      ON daily_step_completions(user_id, completed_at)`),
    ...quizSchemaStatements(db),
    ...essayLibrarySchemaStatements(db),
    ...dailyQueueSchemaStatements(db),
    db.prepare(`INSERT INTO configs (key, value, updated_at) VALUES ('runtime_schema_version', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).bind(RUNTIME_SCHEMA_VERSION),
  ]);
  return true;
}

async function upgradeRuntimeSchemaFrom18() {
  const db = getD1();
  const state = await db.prepare(`SELECT
    COALESCE((SELECT value FROM configs WHERE key = 'runtime_schema_version'), '') AS version,
    EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'daily_step_completions') AS prior_schema_ready,
    EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'quiz_tests') AS quiz_ready`)
    .first<{ version: string; prior_schema_ready: number; quiz_ready: number }>();
  if (String(state?.version ?? "") !== "18" || Number(state?.prior_schema_ready ?? 0) !== 1 || Number(state?.quiz_ready ?? 0) !== 0) return false;
  await ensureColumns(db, "question_banks", [
    { name: "paper_type", definition: "TEXT NOT NULL DEFAULT ''" },
    { name: "source_url", definition: "TEXT NOT NULL DEFAULT ''" },
    { name: "resource_url", definition: "TEXT NOT NULL DEFAULT ''" },
    { name: "library_enabled", definition: "INTEGER NOT NULL DEFAULT 0" },
    { name: "library_access_level", definition: "TEXT NOT NULL DEFAULT 'free'" },
    { name: "library_status", definition: "TEXT NOT NULL DEFAULT 'draft'" },
  ]);
  await ensureColumns(db, "question_bank_items", [
    { name: "question_number", definition: "TEXT NOT NULL DEFAULT ''" },
    { name: "score", definition: "INTEGER" },
  ]);
  await db.batch([
    ...quizSchemaStatements(db),
    ...essayLibrarySchemaStatements(db),
    ...dailyQueueSchemaStatements(db),
    db.prepare(`INSERT INTO configs (key, value, updated_at) VALUES ('runtime_schema_version', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).bind(RUNTIME_SCHEMA_VERSION),
  ]);
  return true;
}

async function upgradeRuntimeSchemaFrom19() {
  const db = getD1();
  const state = await db.prepare(`SELECT
    COALESCE((SELECT value FROM configs WHERE key = 'runtime_schema_version'), '') AS version,
    EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'quiz_tests') AS prior_schema_ready,
    EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'essay_reference_answers') AS essay_ready`)
    .first<{ version: string; prior_schema_ready: number; essay_ready: number }>();
  if (String(state?.version ?? "") !== "19" || Number(state?.prior_schema_ready ?? 0) !== 1) return false;
  await ensureColumns(db, "question_banks", [
    { name: "paper_type", definition: "TEXT NOT NULL DEFAULT ''" },
    { name: "source_url", definition: "TEXT NOT NULL DEFAULT ''" },
    { name: "resource_url", definition: "TEXT NOT NULL DEFAULT ''" },
    { name: "library_enabled", definition: "INTEGER NOT NULL DEFAULT 0" },
    { name: "library_access_level", definition: "TEXT NOT NULL DEFAULT 'free'" },
    { name: "library_status", definition: "TEXT NOT NULL DEFAULT 'draft'" },
  ]);
  await ensureColumns(db, "question_bank_items", [
    { name: "question_number", definition: "TEXT NOT NULL DEFAULT ''" },
    { name: "score", definition: "INTEGER" },
  ]);
  await db.batch([
    ...essayLibrarySchemaStatements(db),
    ...dailyQueueSchemaStatements(db),
    db.prepare(`INSERT INTO configs (key, value, updated_at) VALUES ('runtime_schema_version', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).bind(RUNTIME_SCHEMA_VERSION),
  ]);
  return true;
}

async function upgradeRuntimeSchemaFrom20() {
  const db = getD1();
  const state = await db.prepare(`SELECT
    COALESCE((SELECT value FROM configs WHERE key = 'runtime_schema_version'), '') AS version,
    EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'essay_reference_answers') AS prior_schema_ready,
    EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'user_daily_queue_items') AS queue_ready`)
    .first<{ version: string; prior_schema_ready: number; queue_ready: number }>();
  if (String(state?.version ?? "") !== "20" || Number(state?.prior_schema_ready ?? 0) !== 1) return false;
  await ensureColumns(db, "question_banks", [
    { name: "library_access_level", definition: "TEXT NOT NULL DEFAULT 'free'" },
  ]);
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS user_daily_queue_items (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      date_key TEXT NOT NULL,
      item_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_parent_id TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      estimated_minutes INTEGER NOT NULL DEFAULT 5,
      status TEXT NOT NULL DEFAULT 'scheduled',
      origin TEXT NOT NULL DEFAULT 'manual',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT
    )`),
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS user_daily_queue_items_user_date_source_uq
      ON user_daily_queue_items(user_id, date_key, item_type, source_id)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS user_daily_queue_items_user_date_status_idx
      ON user_daily_queue_items(user_id, date_key, status, sort_order)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS user_daily_queue_items_user_source_idx
      ON user_daily_queue_items(user_id, item_type, source_id, status)`),
    db.prepare(`INSERT INTO configs (key, value, updated_at) VALUES ('runtime_schema_version', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).bind(RUNTIME_SCHEMA_VERSION),
  ]);
  return true;
}

async function upgradeRuntimeSchemaFrom21() {
  const db = getD1();
  const state = await db.prepare(`SELECT
    COALESCE((SELECT value FROM configs WHERE key = 'runtime_schema_version'), '') AS version,
    EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'question_banks') AS question_banks_ready`)
    .first<{ version: string; question_banks_ready: number }>();
  if (String(state?.version ?? "") !== "21" || Number(state?.question_banks_ready ?? 0) !== 1) return false;
  await ensureColumns(db, "question_banks", [
    { name: "library_access_level", definition: "TEXT NOT NULL DEFAULT 'free'" },
  ]);
  await db.prepare(`INSERT INTO configs (key, value, updated_at) VALUES ('runtime_schema_version', ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`)
    .bind(RUNTIME_SCHEMA_VERSION).run();
  return true;
}

export async function ensureSchema() {
  if (schemaReady) return;
  if (!schemaPromise) {
    schemaPromise = (async () => {
      const allowLegacyBootstrap = String((env as unknown as { RUNTIME_SCHEMA_BOOTSTRAP?: string })
        .RUNTIME_SCHEMA_BOOTSTRAP ?? "").toLowerCase() === "local-only";
      // A self-hosted SQLite database starts empty. Its process is not subject
      // to D1's per-request statement budget, so the idempotent bootstrap is
      // the safest way to create or repair the complete schema on startup.
      if (allowLegacyBootstrap) {
        await initializeSchema();
        return;
      }
      if (await deployedSchemaIsCurrent()) {
        schemaReady = true;
        return;
      }
      // Sites deployments do not execute Drizzle SQL automatically. Keep each
      // production upgrade bounded and explicit so a cold request can advance
      // one known schema version without invoking the legacy full bootstrap.
      if (await upgradeRuntimeSchemaFrom17() || await upgradeRuntimeSchemaFrom18()
        || await upgradeRuntimeSchemaFrom19() || await upgradeRuntimeSchemaFrom20()
        || await upgradeRuntimeSchemaFrom21()) {
        schemaReady = true;
        return;
      }
      // Production deployments must apply the tracked Drizzle migrations.
      // The legacy bootstrap contains more statements than D1 Free permits in
      // one Worker invocation, so it is opt-in for local recovery only instead
      // of silently exhausting the cold-request query budget.
      if (!allowLegacyBootstrap) {
        throw new Error("数据库迁移尚未应用；请先部署 drizzle 迁移，禁止在生产请求中执行超预算建表。");
      }
      await initializeSchema();
    })().catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }
  await schemaPromise;
}
