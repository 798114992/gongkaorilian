export const ADMIN_SESSION_COOKIE = "gkrl_admin_session";
export const ADMIN_SESSION_SECONDS = 60 * 60 * 12;
export const ADMIN_PASSWORD_ITERATIONS = 210_000;

export const ADMIN_ROLES = [
  "super_admin",
  "content_editor",
  "question_editor",
  "radar_editor",
  "growth_operator",
  "reviewer",
  "read_only",
] as const;

export type AdminRole = (typeof ADMIN_ROLES)[number];

export const ADMIN_PERMISSIONS = [
  "dashboard.read",
  "content.read",
  "content.write",
  "content.review",
  "content.publish",
  "question.read",
  "question.write",
  "question.import",
  "question.review",
  "radar.read",
  "radar.write",
  "growth.read",
  "growth.write",
  "media.upload",
  "analytics.read",
  "system.read",
  "users.manage",
  "audit.read",
] as const;

export type AdminPermission = (typeof ADMIN_PERMISSIONS)[number];

const ROLE_PERMISSIONS: Record<AdminRole, readonly AdminPermission[]> = {
  super_admin: ADMIN_PERMISSIONS,
  content_editor: ["dashboard.read", "content.read", "content.write", "media.upload"],
  question_editor: ["dashboard.read", "question.read", "question.write", "question.import", "media.upload"],
  radar_editor: ["dashboard.read", "radar.read", "radar.write", "media.upload"],
  growth_operator: ["dashboard.read", "growth.read", "growth.write", "analytics.read"],
  reviewer: [
    "dashboard.read",
    "content.read",
    "content.review",
    "content.publish",
    "question.read",
    "question.review",
    "radar.read",
    "audit.read",
  ],
  read_only: [
    "dashboard.read",
    "content.read",
    "question.read",
    "radar.read",
    "growth.read",
    "analytics.read",
    "system.read",
    "audit.read",
  ],
};

export type AdminIdentity = {
  id: number;
  username: string;
  displayName: string;
  role: AdminRole;
  permissions: AdminPermission[];
  sessionId: string;
  expiresAt: string;
};

type AdminUserRow = {
  id: number;
  username: string;
  display_name: string;
  password_hash: string;
  password_salt: string;
  password_iterations: number;
  role: string;
  status: string;
};

type AdminPreparedStatement = {
  bind: (...values: unknown[]) => AdminPreparedStatement;
  all: <T = Record<string, unknown>>() => Promise<{ results: T[] }>;
  first: <T = Record<string, unknown>>() => Promise<T | null>;
  run: () => Promise<unknown>;
};

type AdminDatabase = {
  prepare: (query: string) => AdminPreparedStatement;
  batch: (statements: AdminPreparedStatement[]) => Promise<unknown>;
};

let schemaReady = false;

async function ensureColumns(
  db: AdminDatabase,
  table: string,
  columns: Array<{ name: string; definition: string }>,
) {
  const existing = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  const names = new Set(existing.results.map((column) => column.name));
  for (const column of columns) {
    if (!names.has(column.name)) await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column.name} ${column.definition}`).run();
  }
}

export async function ensureAdminSchema(db: AdminDatabase) {
  if (schemaReady) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS admin_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      password_iterations INTEGER NOT NULL DEFAULT 210000,
      role TEXT NOT NULL DEFAULT 'read_only',
      status TEXT NOT NULL DEFAULT 'active',
      last_login_at TEXT,
      created_by INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS admin_users_username_uq ON admin_users(username)"),
    db.prepare("CREATE INDEX IF NOT EXISTS admin_users_status_role_idx ON admin_users(status, role)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS admin_sessions (
      id TEXT PRIMARY KEY,
      admin_user_id INTEGER NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      ip_address TEXT NOT NULL DEFAULT '',
      user_agent TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      revoked_at TEXT
    )`),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS admin_sessions_token_hash_uq ON admin_sessions(token_hash)"),
    db.prepare("CREATE INDEX IF NOT EXISTS admin_sessions_user_expiry_idx ON admin_sessions(admin_user_id, expires_at)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS admin_audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_user_id INTEGER,
      username TEXT NOT NULL DEFAULT 'system',
      role TEXT NOT NULL DEFAULT 'system',
      action TEXT NOT NULL,
      resource_type TEXT NOT NULL DEFAULT 'system',
      resource_id TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      result TEXT NOT NULL DEFAULT 'success',
      details_json TEXT NOT NULL DEFAULT '{}',
      ip_address TEXT NOT NULL DEFAULT '',
      user_agent TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS admin_audit_logs_user_time_idx ON admin_audit_logs(admin_user_id, created_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS admin_audit_logs_action_time_idx ON admin_audit_logs(action, created_at)"),
  ]);
  await ensureColumns(db, "content_items", [
    { name: "review_note", definition: "TEXT NOT NULL DEFAULT ''" },
    { name: "submitted_by", definition: "INTEGER" },
    { name: "submitted_at", definition: "TEXT" },
    { name: "reviewed_by", definition: "INTEGER" },
    { name: "reviewed_at", definition: "TEXT" },
  ]);
  schemaReady = true;
}

function normalizeUsername(value: unknown) {
  return String(value ?? "").normalize("NFKC").trim().toLowerCase();
}

export function isAdminRole(value: unknown): value is AdminRole {
  return ADMIN_ROLES.includes(String(value) as AdminRole);
}

export function permissionsForRole(role: AdminRole): AdminPermission[] {
  return [...ROLE_PERMISSIONS[role]];
}

export function hasAdminPermission(admin: AdminIdentity, permission: AdminPermission) {
  return admin.role === "super_admin" || admin.permissions.includes(permission);
}

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string) {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

async function passwordDigest(password: string, salt: Uint8Array, iterations: number) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: Uint8Array.from(salt).buffer, iterations },
    key,
    256,
  );
  return bytesToBase64Url(new Uint8Array(bits));
}

function constantTimeEqual(first: string, second: string) {
  const length = Math.max(first.length, second.length);
  let difference = first.length ^ second.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (first.charCodeAt(index) || 0) ^ (second.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export async function createPasswordRecord(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(18));
  return {
    hash: await passwordDigest(password, salt, ADMIN_PASSWORD_ITERATIONS),
    salt: bytesToBase64Url(salt),
    iterations: ADMIN_PASSWORD_ITERATIONS,
  };
}

async function passwordMatches(password: string, row: AdminUserRow) {
  const actual = await passwordDigest(password, base64UrlToBytes(row.password_salt), row.password_iterations);
  return constantTimeEqual(actual, row.password_hash);
}

async function createBootstrapAdmin(db: AdminDatabase, configuredSecret: string) {
  if (!configuredSecret) return false;
  // ADMIN_TOKEN is an installation bootstrap secret, never a permanent
  // alternate password. Once any administrator exists it must not be able to
  // reset or bypass the password stored in the database.
  const existingCount = await db.prepare("SELECT COUNT(*) AS count FROM admin_users")
    .first<{ count: number }>();
  if (Number(existingCount?.count ?? 0) > 0) return false;
  const record = await createPasswordRecord(configuredSecret);
  const inserted = await db.prepare(`INSERT OR IGNORE INTO admin_users
    (username, display_name, password_hash, password_salt, password_iterations, role, status, updated_at)
    VALUES ('admin', '超级管理员', ?, ?, ?, 'super_admin', 'active', CURRENT_TIMESTAMP)`)
    .bind(record.hash, record.salt, record.iterations).run();
  return Boolean(inserted.meta.changes);
}

function readCookie(request: Request, name: string) {
  const raw = request.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function requestMetadata(request: Request) {
  return {
    ipAddress: (request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for") ?? "").split(",")[0].trim().slice(0, 80),
    userAgent: (request.headers.get("user-agent") ?? "").slice(0, 400),
  };
}

function adminCookieSecurityAttributes() {
  if (process.env.ADMIN_INSECURE_LOCAL_PREVIEW === "1") return "HttpOnly; SameSite=Strict";
  return "HttpOnly; Secure; SameSite=Strict";
}

function sessionCookie(token: string) {
  return `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; ${adminCookieSecurityAttributes()}; Max-Age=${ADMIN_SESSION_SECONDS}`;
}

export function expiredAdminCookie() {
  return `${ADMIN_SESSION_COOKIE}=; Path=/; ${adminCookieSecurityAttributes()}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

function serializeAdmin(row: AdminUserRow, sessionId: string, expiresAt: string): AdminIdentity | null {
  if (!isAdminRole(row.role)) return null;
  return {
    id: Number(row.id),
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    permissions: permissionsForRole(row.role),
    sessionId,
    expiresAt,
  };
}

export async function authenticateAdmin(
  db: AdminDatabase,
  request: Request,
  configuredSecret: string,
  usernameValue: unknown,
  passwordValue: unknown,
) {
  await ensureAdminSchema(db);
  const username = normalizeUsername(usernameValue);
  const password = String(passwordValue ?? "");
  if (!/^[a-z0-9][a-z0-9._-]{2,39}$/.test(username) || !password || password.length > 512) return null;

  if (username === "admin" && configuredSecret && constantTimeEqual(password, configuredSecret)) {
    await createBootstrapAdmin(db, configuredSecret);
  }

  const row = await db.prepare(`SELECT id, username, display_name, password_hash, password_salt,
    password_iterations, role, status FROM admin_users WHERE username = ? ORDER BY id ASC LIMIT 1`).bind(username).first<AdminUserRow>();
  if (!row || row.status !== "active") return null;
  if (!(await passwordMatches(password, row))) return null;

  const token = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const tokenHash = await sha256(token);
  const sessionId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + ADMIN_SESSION_SECONDS * 1000).toISOString();
  const metadata = requestMetadata(request);
  await db.batch([
    db.prepare(`INSERT INTO admin_sessions
      (id, admin_user_id, token_hash, expires_at, ip_address, user_agent)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(sessionId, row.id, tokenHash, expiresAt, metadata.ipAddress, metadata.userAgent),
    db.prepare("UPDATE admin_users SET last_login_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(row.id),
    db.prepare("UPDATE admin_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE admin_user_id = ? AND id <> ? AND datetime(expires_at) <= CURRENT_TIMESTAMP")
      .bind(row.id, sessionId),
  ]);
  const admin = serializeAdmin(row, sessionId, expiresAt);
  return admin ? { admin, cookie: sessionCookie(token) } : null;
}

export async function getAdminIdentity(db: AdminDatabase, request: Request, touch = true): Promise<AdminIdentity | null> {
  await ensureAdminSchema(db);
  const token = readCookie(request, ADMIN_SESSION_COOKIE);
  if (!token || token.length > 200) return null;
  const tokenHash = await sha256(token);
  const row = await db.prepare(`SELECT u.id, u.username, u.display_name, u.password_hash, u.password_salt,
      u.password_iterations, u.role, u.status, s.id AS session_id, s.expires_at
    FROM admin_sessions s JOIN admin_users u ON u.id = s.admin_user_id
    WHERE s.token_hash = ? AND s.revoked_at IS NULL AND datetime(s.expires_at) > CURRENT_TIMESTAMP
      AND u.status = 'active'`).bind(tokenHash).first<AdminUserRow & { session_id: string; expires_at: string }>();
  if (!row) return null;
  if (touch) await db.prepare("UPDATE admin_sessions SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?").bind(row.session_id).run();
  return serializeAdmin(row, row.session_id, row.expires_at);
}

export async function revokeAdminSession(db: AdminDatabase, request: Request) {
  await ensureAdminSchema(db);
  const token = readCookie(request, ADMIN_SESSION_COOKIE);
  if (!token) return;
  await db.prepare("UPDATE admin_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE token_hash = ? AND revoked_at IS NULL")
    .bind(await sha256(token)).run();
}

function safeAuditDetails(value: unknown) {
  const blocked = new Set(["password", "adminToken", "token", "cookie"]);
  const scrub = (item: unknown, depth: number): unknown => {
    if (depth > 4) return "[truncated]";
    if (Array.isArray(item)) return item.slice(0, 30).map((entry) => scrub(entry, depth + 1));
    if (item && typeof item === "object") {
      return Object.fromEntries(Object.entries(item as Record<string, unknown>)
        .filter(([key]) => !blocked.has(key))
        .slice(0, 80)
        .map(([key, entry]) => [key, scrub(entry, depth + 1)]));
    }
    if (typeof item === "string") return item.slice(0, 600);
    return item;
  };
  const serialized = JSON.stringify(scrub(value, 0));
  return serialized.length > 12_000 ? JSON.stringify({ truncated: true }) : serialized;
}

export async function writeAdminAudit(
  db: AdminDatabase,
  request: Request,
  admin: AdminIdentity | null,
  entry: {
    action: string;
    resourceType?: string;
    resourceId?: string | number | null;
    summary?: string;
    result?: "success" | "failure" | "denied";
    details?: unknown;
  },
) {
  await ensureAdminSchema(db);
  const metadata = requestMetadata(request);
  await db.prepare(`INSERT INTO admin_audit_logs
    (admin_user_id, username, role, action, resource_type, resource_id, summary, result,
      details_json, ip_address, user_agent)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      admin?.id ?? null,
      admin?.username ?? "anonymous",
      admin?.role ?? "anonymous",
      entry.action.slice(0, 100),
      (entry.resourceType ?? "system").slice(0, 60),
      String(entry.resourceId ?? "").slice(0, 120),
      (entry.summary ?? "").slice(0, 300),
      entry.result ?? "success",
      safeAuditDetails(entry.details ?? {}),
      metadata.ipAddress,
      metadata.userAgent,
    ).run();
}
