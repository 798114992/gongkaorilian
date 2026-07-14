import { env } from "cloudflare:workers";
import { ensureSchema, getD1 } from "../../../db/runtime";

export const dynamic = "force-dynamic";

const USER_COOKIE = "gkrl_uid";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

type UserRow = {
  id: string;
  invite_code: string;
  invited_by: string | null;
  membership_end: string | null;
};

type CodeRow = {
  id: number;
  code_preview: string;
  duration_days: number;
  max_uses: number;
  used_count: number;
  status: string;
  valid_from: string | null;
  valid_until: string | null;
};

function json(data: unknown, status = 200, cookie?: string) {
  const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
  if (cookie) headers.set("set-cookie", cookie);
  return new Response(JSON.stringify(data), { status, headers });
}

function readCookie(request: Request, name: string) {
  const cookie = request.headers.get("cookie") ?? "";
  for (const part of cookie.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return null;
}

function cookieHeader(userId: string) {
  return `${USER_COOKIE}=${encodeURIComponent(userId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}`;
}

function normalizeCode(value: string) {
  return value.trim().toUpperCase().replace(/\s+/g, "");
}

async function hashCode(value: string) {
  const bytes = new TextEncoder().encode(normalizeCode(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function addDays(currentEnd: string | null, days: number) {
  const now = Date.now();
  const current = currentEnd ? Date.parse(currentEnd) : 0;
  const base = Number.isFinite(current) && current > now ? current : now;
  return new Date(base + days * 86_400_000).toISOString();
}

function maskCode(code: string) {
  const compact = normalizeCode(code);
  return `${compact.slice(0, 4)}-****-${compact.slice(-4)}`;
}

function randomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const values = crypto.getRandomValues(new Uint8Array(16));
  const chars = Array.from(values, (value) => alphabet[value % alphabet.length]);
  return [chars.slice(0, 4), chars.slice(4, 8), chars.slice(8, 12), chars.slice(12, 16)]
    .map((group) => group.join(""))
    .join("-");
}

async function ensureUser(request: Request) {
  const db = getD1();
  let userId = readCookie(request, USER_COOKIE);
  let setCookie: string | undefined;

  if (!userId || !/^[0-9a-f-]{36}$/i.test(userId)) {
    userId = crypto.randomUUID();
    setCookie = cookieHeader(userId);
  }

  const inviteCode = `GK${userId.replaceAll("-", "").slice(0, 8).toUpperCase()}`;
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO users (id, invite_code) VALUES (?, ?)").bind(userId, inviteCode),
    db.prepare("INSERT OR IGNORE INTO user_states (user_id, progress_json) VALUES (?, '{}')").bind(userId),
  ]);
  return { userId, setCookie };
}

async function seedDefaults() {
  const db = getD1();
  const now = new Date().toISOString();
  const until = new Date(Date.now() + 365 * 86_400_000).toISOString();
  const demoCodes = [
    ["DEMO-7DAYS-2026", 7],
    ["DEMO-30DAYS-2026", 30],
    ["DEMO-365DAYS-2026", 365],
  ] as const;
  for (const [code, days] of demoCodes) {
    const hash = await hashCode(code);
    await db
      .prepare(`INSERT OR IGNORE INTO redemption_codes
        (code_hash, code_preview, batch_name, duration_days, max_uses, valid_from, valid_until)
        VALUES (?, ?, '内测演示码', ?, 1000, ?, ?)`)
      .bind(hash, maskCode(code), days, now, until)
      .run();
  }
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO configs (key, value) VALUES ('invite_reward_days', '3')"),
    db.prepare("INSERT OR IGNORE INTO configs (key, value) VALUES ('invite_monthly_cap', '30')"),
  ]);
}

async function getConfigNumber(key: string, fallback: number) {
  const row = await getD1().prepare("SELECT value FROM configs WHERE key = ?").bind(key).first<{ value: string }>();
  const value = Number(row?.value);
  return Number.isFinite(value) ? value : fallback;
}

async function bootstrap(request: Request) {
  await ensureSchema();
  await seedDefaults();
  const { userId, setCookie } = await ensureUser(request);
  const db = getD1();
  const [user, state, ledger, inviteStats, inviteDays, inviteCap] = await Promise.all([
    db.prepare("SELECT id, invite_code, invited_by, membership_end FROM users WHERE id = ?").bind(userId).first<UserRow>(),
    db.prepare("SELECT progress_json FROM user_states WHERE user_id = ?").bind(userId).first<{ progress_json: string }>(),
    db.prepare(`SELECT delta_days, source_type, note, created_at
      FROM membership_ledger WHERE user_id = ? ORDER BY id DESC LIMIT 20`).bind(userId).all(),
    db.prepare(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'rewarded' THEN 1 ELSE 0 END) AS rewarded,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending
      FROM invite_relations WHERE inviter_id = ?`).bind(userId).first<{ total: number; rewarded: number; pending: number }>(),
    getConfigNumber("invite_reward_days", 3),
    getConfigNumber("invite_monthly_cap", 30),
  ]);

  if (!user) return json({ error: "用户初始化失败" }, 500, setCookie);
  let progress = {};
  try {
    progress = JSON.parse(state?.progress_json ?? "{}");
  } catch {
    progress = {};
  }

  return json(
    {
      user: {
        id: user.id,
        inviteCode: user.invite_code,
        membershipEnd: user.membership_end,
        membershipActive: Boolean(user.membership_end && Date.parse(user.membership_end) > Date.now()),
      },
      progress,
      ledger: ledger.results,
      inviteStats: inviteStats ?? { total: 0, rewarded: 0, pending: 0 },
      inviteConfig: { rewardDays: inviteDays, monthlyCap: inviteCap },
    },
    200,
    setCookie,
  );
}

async function saveProgress(request: Request, userId: string, payload: Record<string, unknown>) {
  const value = JSON.stringify(payload.progress ?? {});
  if (value.length > 120_000) return json({ error: "学习记录过大" }, 400);
  await getD1()
    .prepare(`INSERT INTO user_states (user_id, progress_json, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id) DO UPDATE SET progress_json = excluded.progress_json, updated_at = CURRENT_TIMESTAMP`)
    .bind(userId, value)
    .run();
  return json({ ok: true });
}

async function bindInvite(userId: string, payload: Record<string, unknown>) {
  const inviteCode = String(payload.inviteCode ?? "").trim().toUpperCase();
  if (!inviteCode) return json({ error: "邀请码不能为空" }, 400);
  const db = getD1();
  const inviter = await db.prepare("SELECT id FROM users WHERE invite_code = ?").bind(inviteCode).first<{ id: string }>();
  if (!inviter) return json({ error: "邀请码无效" }, 404);
  if (inviter.id === userId) return json({ error: "不能邀请自己" }, 400);
  const existing = await db.prepare("SELECT inviter_id, status FROM invite_relations WHERE invitee_id = ?").bind(userId).first<{ inviter_id: string; status: string }>();
  if (existing) return json({ ok: true, status: existing.status, message: "已绑定邀请关系" });
  await db.batch([
    db.prepare("INSERT INTO invite_relations (invitee_id, inviter_id) VALUES (?, ?)").bind(userId, inviter.id),
    db.prepare("UPDATE users SET invited_by = ? WHERE id = ? AND invited_by IS NULL").bind(inviter.id, userId),
  ]);
  return json({ ok: true, status: "pending", message: "好友关系已绑定，首次激活后双方获得奖励" });
}

async function rewardInvite(inviteeId: string) {
  const db = getD1();
  const relation = await db.prepare("SELECT inviter_id, status FROM invite_relations WHERE invitee_id = ?").bind(inviteeId).first<{ inviter_id: string; status: string }>();
  if (!relation || relation.status !== "pending") return;

  const rewardDays = await getConfigNumber("invite_reward_days", 3);
  const monthlyCap = await getConfigNumber("invite_monthly_cap", 30);
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const awarded = await db.prepare(`SELECT COALESCE(SUM(delta_days), 0) AS total
    FROM membership_ledger WHERE user_id = ? AND source_type = 'invite_reward' AND created_at >= ?`)
    .bind(relation.inviter_id, monthStart.toISOString())
    .first<{ total: number }>();
  const inviterDays = Math.max(0, Math.min(rewardDays, monthlyCap - Number(awarded?.total ?? 0)));

  const claimed = await db.prepare("UPDATE invite_relations SET status = 'rewarded', rewarded_at = CURRENT_TIMESTAMP WHERE invitee_id = ? AND status = 'pending'").bind(inviteeId).run();
  if (!claimed.meta.changes) return;

  const [invitee, inviter] = await Promise.all([
    db.prepare("SELECT membership_end FROM users WHERE id = ?").bind(inviteeId).first<{ membership_end: string | null }>(),
    db.prepare("SELECT membership_end FROM users WHERE id = ?").bind(relation.inviter_id).first<{ membership_end: string | null }>(),
  ]);
  const source = `invite:${inviteeId}`;
  const statements = [
    db.prepare("UPDATE users SET membership_end = ? WHERE id = ?").bind(addDays(invitee?.membership_end ?? null, rewardDays), inviteeId),
    db.prepare(`INSERT OR IGNORE INTO membership_ledger
      (user_id, delta_days, source_type, source_id, note) VALUES (?, ?, 'invitee_reward', ?, '受邀激活奖励')`)
      .bind(inviteeId, rewardDays, source),
  ];
  if (inviterDays > 0) {
    statements.push(
      db.prepare("UPDATE users SET membership_end = ? WHERE id = ?").bind(addDays(inviter?.membership_end ?? null, inviterDays), relation.inviter_id),
      db.prepare(`INSERT OR IGNORE INTO membership_ledger
        (user_id, delta_days, source_type, source_id, note) VALUES (?, ?, 'invite_reward', ?, '邀请好友激活奖励')`)
        .bind(relation.inviter_id, inviterDays, source),
    );
  }
  await db.batch(statements);
}

async function redeem(userId: string, payload: Record<string, unknown>) {
  const code = normalizeCode(String(payload.code ?? ""));
  if (!code) return json({ error: "请输入兑换码" }, 400);
  const db = getD1();
  const codeHash = await hashCode(code);
  const row = await db.prepare(`SELECT id, code_preview, duration_days, max_uses, used_count, status, valid_from, valid_until
    FROM redemption_codes WHERE code_hash = ?`).bind(codeHash).first<CodeRow>();
  const now = new Date();
  if (!row) return json({ error: "兑换码不存在" }, 404);
  if (row.status !== "active") return json({ error: "兑换码已停用" }, 400);
  if (row.valid_from && Date.parse(row.valid_from) > now.getTime()) return json({ error: "兑换码尚未生效" }, 400);
  if (row.valid_until && Date.parse(row.valid_until) < now.getTime()) return json({ error: "兑换码已过期" }, 400);
  if (row.used_count >= row.max_uses) return json({ error: "兑换码使用次数已达上限" }, 400);
  const used = await db.prepare("SELECT id FROM redemptions WHERE code_id = ? AND user_id = ?").bind(row.id, userId).first();
  if (used) return json({ error: "你已经使用过这个兑换码" }, 400);
  const user = await db.prepare("SELECT membership_end FROM users WHERE id = ?").bind(userId).first<{ membership_end: string | null }>();
  const newEnd = addDays(user?.membership_end ?? null, row.duration_days);
  const sourceId = `redeem:${row.id}:${userId}`;

  try {
    const [claim] = await db.batch([
      db.prepare(`UPDATE redemption_codes SET used_count = used_count + 1
        WHERE id = ? AND status = 'active' AND used_count < max_uses`).bind(row.id),
      db.prepare("INSERT INTO redemptions (code_id, user_id) VALUES (?, ?)").bind(row.id, userId),
      db.prepare("UPDATE users SET membership_end = ? WHERE id = ?").bind(newEnd, userId),
      db.prepare(`INSERT INTO membership_ledger
        (user_id, delta_days, source_type, source_id, note) VALUES (?, ?, 'redeem', ?, ?)`)
        .bind(userId, row.duration_days, sourceId, `兑换 ${row.duration_days} 天会员`),
    ]);
    if (!claim.meta.changes) return json({ error: "兑换码已被抢先使用，请更换兑换码" }, 409);
  } catch {
    return json({ error: "兑换失败，请勿重复提交" }, 409);
  }

  await rewardInvite(userId);
  return json({ ok: true, days: row.duration_days, membershipEnd: newEnd });
}

function getAdminSecret() {
  return (env as unknown as { ADMIN_TOKEN?: string }).ADMIN_TOKEN ?? process.env.ADMIN_TOKEN ?? "";
}

function isAdmin(payload: Record<string, unknown>) {
  const configured = getAdminSecret();
  const supplied = String(payload.adminToken ?? "");
  return Boolean(configured && supplied && configured === supplied);
}

async function adminList(payload: Record<string, unknown>) {
  if (!isAdmin(payload)) return json({ error: "管理员口令错误" }, 401);
  const db = getD1();
  const [codes, redemptions, rewardDays, monthlyCap] = await Promise.all([
    db.prepare(`SELECT id, code_preview, batch_name, duration_days, max_uses, used_count, status, valid_until, created_at
      FROM redemption_codes ORDER BY id DESC LIMIT 100`).all(),
    db.prepare(`SELECT r.redeemed_at, r.user_id, c.code_preview, c.duration_days
      FROM redemptions r JOIN redemption_codes c ON c.id = r.code_id ORDER BY r.id DESC LIMIT 100`).all(),
    getConfigNumber("invite_reward_days", 3),
    getConfigNumber("invite_monthly_cap", 30),
  ]);
  return json({ codes: codes.results, redemptions: redemptions.results, config: { rewardDays, monthlyCap } });
}

async function adminCreateCodes(payload: Record<string, unknown>) {
  if (!isAdmin(payload)) return json({ error: "管理员口令错误" }, 401);
  const durationDays = Math.floor(Number(payload.durationDays));
  const count = Math.floor(Number(payload.count));
  const maxUses = Math.max(1, Math.floor(Number(payload.maxUses ?? 1)));
  const batchName = String(payload.batchName ?? "新建批次").trim().slice(0, 40) || "新建批次";
  const validUntil = payload.validUntil ? new Date(String(payload.validUntil)).toISOString() : null;
  if (!Number.isFinite(durationDays) || durationDays < 1 || durationDays > 3650) return json({ error: "会员天数需在 1—3650 天之间" }, 400);
  if (!Number.isFinite(count) || count < 1 || count > 200) return json({ error: "每批生成数量需在 1—200 个之间" }, 400);
  const db = getD1();
  const plainCodes: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const code = randomCode();
    plainCodes.push(code);
    await db.prepare(`INSERT INTO redemption_codes
      (code_hash, code_preview, batch_name, duration_days, max_uses, valid_until)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(await hashCode(code), maskCode(code), batchName, durationDays, maxUses, validUntil)
      .run();
  }
  return json({ ok: true, codes: plainCodes });
}

async function adminDisableCode(payload: Record<string, unknown>) {
  if (!isAdmin(payload)) return json({ error: "管理员口令错误" }, 401);
  const id = Number(payload.id);
  await getD1().prepare("UPDATE redemption_codes SET status = 'disabled' WHERE id = ?").bind(id).run();
  return json({ ok: true });
}

async function adminUpdateConfig(payload: Record<string, unknown>) {
  if (!isAdmin(payload)) return json({ error: "管理员口令错误" }, 401);
  const rewardDays = Math.max(0, Math.min(365, Math.floor(Number(payload.rewardDays))));
  const monthlyCap = Math.max(0, Math.min(3650, Math.floor(Number(payload.monthlyCap))));
  const db = getD1();
  await db.batch([
    db.prepare(`INSERT INTO configs (key, value, updated_at) VALUES ('invite_reward_days', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).bind(String(rewardDays)),
    db.prepare(`INSERT INTO configs (key, value, updated_at) VALUES ('invite_monthly_cap', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).bind(String(monthlyCap)),
  ]);
  return json({ ok: true });
}

export async function GET(request: Request) {
  try {
    return await bootstrap(request);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "初始化失败" }, 500);
  }
}

export async function POST(request: Request) {
  try {
    await ensureSchema();
    await seedDefaults();
    const payload = (await request.json()) as Record<string, unknown>;
    const action = String(payload.action ?? "");
    if (action.startsWith("admin")) {
      if (action === "adminList") return adminList(payload);
      if (action === "adminCreateCodes") return adminCreateCodes(payload);
      if (action === "adminDisableCode") return adminDisableCode(payload);
      if (action === "adminUpdateConfig") return adminUpdateConfig(payload);
      return json({ error: "未知管理操作" }, 400);
    }
    const { userId, setCookie } = await ensureUser(request);
    let response: Response;
    if (action === "saveProgress") response = await saveProgress(request, userId, payload);
    else if (action === "bindInvite") response = await bindInvite(userId, payload);
    else if (action === "redeem") response = await redeem(userId, payload);
    else response = json({ error: "未知操作" }, 400);
    if (setCookie) response.headers.set("set-cookie", setCookie);
    return response;
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "请求失败" }, 500);
  }
}

