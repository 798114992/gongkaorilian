import { env } from "cloudflare:workers";

let schemaReady = false;

export function getD1() {
  const db = (env as unknown as { DB?: D1Database }).DB;
  if (!db) {
    throw new Error("D1 数据库暂不可用，请检查 DB 绑定。");
  }
  return db;
}

export async function ensureSchema() {
  if (schemaReady) return;
  const db = getD1();
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      invite_code TEXT NOT NULL UNIQUE,
      invited_by TEXT,
      membership_end TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS user_states (
      user_id TEXT PRIMARY KEY,
      progress_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS redemption_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code_hash TEXT NOT NULL UNIQUE,
      code_preview TEXT NOT NULL,
      batch_name TEXT NOT NULL,
      duration_days INTEGER NOT NULL,
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
      redeemed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS redemptions_code_user_uq ON redemptions(code_id, user_id)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS invite_relations (
      invitee_id TEXT PRIMARY KEY,
      inviter_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
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
      status TEXT NOT NULL DEFAULT 'draft',
      publish_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS content_items_key_uq ON content_items(content_key)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS analytics_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      event_name TEXT NOT NULL,
      event_data TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS analytics_events_name_time_idx ON analytics_events(event_name, created_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS analytics_events_user_time_idx ON analytics_events(user_id, created_at)"),
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
      status TEXT NOT NULL DEFAULT 'active',
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
    db.prepare(`CREATE TABLE IF NOT EXISTS question_imports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bank_id INTEGER NOT NULL,
      file_name TEXT NOT NULL,
      file_size INTEGER NOT NULL DEFAULT 0,
      total_rows INTEGER NOT NULL DEFAULT 0,
      imported_rows INTEGER NOT NULL DEFAULT 0,
      failed_rows INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'processing',
      error_summary TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT
    )`),
  ]);
  schemaReady = true;
}
