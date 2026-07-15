import { env } from "cloudflare:workers";
import { ensureSchema, getD1 } from "../../../db/runtime";
import { practiceDays as defaultPracticeDays, type PracticeDay, type Question } from "../../data/content";
import { audioTracks as defaultAudioTracks, type AudioTrack } from "../../data/audio";
import {
  type AdminIdentity,
  type AdminPermission,
  authenticateAdmin,
  createPasswordRecord,
  ensureAdminSchema,
  expiredAdminCookie,
  getAdminIdentity,
  hasAdminPermission,
  isAdminRole,
  revokeAdminSession,
  writeAdminAudit,
} from "./admin-auth";

export const dynamic = "force-dynamic";

const USER_COOKIE = "gkrl_uid";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
const TRIAL_DAYS = 3;
const TRIAL_SOURCE = "welcome-trial-v1";
const EVENT_NAMES = new Set([
  "app_open",
  "module_open",
  "quiz_submit",
  "redeem_success",
  "invite_copy",
  "audio_play",
  "audio_cached",
  "paywall_view",
  "paywall_action",
  "practice_answer",
  "practice_confidence",
  "practice_batch",
  "plan_override",
  "bank_toggle",
  "profile_save",
  "calendar_event_save",
  "reminder_enable",
  "micro_drill_open",
  "radar_notice_open",
  "position_save",
  "candidate_profile_save",
  "radar_todo_toggle",
]);

const STARTER_BANK_CODE = "starter-gk";
const CONTENT_TYPES = new Set([
  "practice_day",
  "morning_read",
  "current_affairs",
  "essay_micro",
  "audio_track",
  "exam_event",
  "exam_notice",
  "job_position",
  "drill_preset",
  "strategy_config",
]);
const CONTENT_STATUSES = new Set(["draft", "pending_review", "rejected", "scheduled", "published", "archived"]);
const DEFAULT_STRATEGY = {
  timePlans: {
    10: { morning: 0, practice: 10, essay: 0, questionCount: 5 },
    30: { morning: 5, practice: 20, essay: 5, questionCount: 10 },
    45: { morning: 5, practice: 30, essay: 10, questionCount: 15 },
    60: { morning: 10, practice: 35, essay: 15, questionCount: 20 },
  },
  reviewIntervals: [1, 3, 7, 14, 30],
  scoreRateSweetSpot: [40, 80],
  dueShare: 0.6,
  urgentDays: 30,
};
const allowedWrongReasons = new Set(["知识点不会", "方法没想到", "计算失误", "审题错误", "时间不足", "蒙对了"]);
const allowedConfidence = new Set(["confident", "hesitant", "guessed"]);

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

type Identity = {
  userId: string;
  signedIn: boolean;
  provider: "chatgpt" | "device";
  displayName: string;
};

type ImportedQuestion = {
  questionCode: string;
  subject: string;
  module: string;
  subType?: string;
  stem: string;
  options?: string[];
  answer?: string | null;
  explanation?: string;
  technique?: string;
  material?: string;
  prompt?: string;
  wordLimit?: number | null;
  scoringPoints?: string[];
  difficulty?: string;
  source?: string;
  region: string;
  examYear: number;
  frequency: string;
  importanceStars: number;
  scoreRate: number;
  suggestedSeconds: number;
  imageUrl: string;
  resourceUrl: string;
};

type QuestionProgressRow = {
  question_code: string;
  state: string;
  correct_count: number;
  wrong_count: number;
  uncertain_count: number;
  review_stage: number;
  next_review_at: string | null;
  favorite: number;
  wrong_reason: string;
  last_answered_at: string | null;
};

type QuestionCandidate = { question: ResolvedQuestion; progress?: QuestionProgressRow };

type ResolvedQuestion = {
  id: string;
  module: string;
  stem: string;
  options: string[];
  answer: number;
  explanation: string;
  knowledge: string;
  technique: string;
  source: string;
  difficulty: string;
  bankCode: string;
  bankName: string;
  scopeLabel: string;
  reviewedAt: string | null;
  targetCode: string | null;
  region: string;
  examYear: number | null;
  frequency: string;
  importanceStars: number;
  scoreRate: number;
  suggestedSeconds: number;
  imageUrl: string;
  resourceUrl: string;
};

type ExamTargetProfile = {
  code: string;
  label: string;
  examType: "国考" | "省考";
  province: string;
  examYear: number;
  examDate: string | null;
};

type PublishedExamEvent = {
  id: string;
  targetCode: string;
  targetLabel: string;
  eventType: string;
  title: string;
  eventDate: string;
  reminderDays: number;
  sourceUrl: string;
};

type PublishedExamNotice = {
  id: string;
  targetCode: string;
  targetLabel: string;
  noticeType: string;
  title: string;
  publishDate: string;
  summary: string;
  sourceUrl: string;
  status: string;
};

type PublishedJobPosition = {
  id: string;
  targetCode: string;
  targetLabel: string;
  examName: string;
  department: string;
  unit: string;
  title: string;
  code: string;
  region: string;
  recruitCount: number;
  education: string;
  degree: string;
  majors: string;
  majorCodes: string;
  freshLimit: string;
  politicalStatus: string;
  household: string;
  grassrootsYears: string;
  gender: string;
  certificates: string;
  remote: string;
  remarks: string;
  phone: string;
  sourceUrl: string;
};

type LoadedExamProfile = {
  onboarded: boolean;
  dailyMinutes: number;
  targets: ExamTargetProfile[];
  /** @deprecated Kept for one rolling-release window so an older cached client can still render. */
  examType: "国考" | "省考";
  /** @deprecated Use targets instead. */
  province: string;
  /** @deprecated Use targets instead. */
  examYear: number;
  /** @deprecated Use targets instead. */
  examDate: string | null;
};

function normalizeDailyMinutes(value: unknown): 30 | 45 | 60 {
  const minutes = Number(value);
  if (minutes === 45 || minutes === 60) return minutes;
  return 30;
}

function chinaDateKey(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function reviewAtAfterChinaDays(days: number) {
  const target = new Date(`${chinaDateKey()}T05:00:00+08:00`);
  target.setUTCDate(target.getUTCDate() + Math.max(1, days));
  return target.toISOString();
}

function targetSecondsFor(question: Pick<ResolvedQuestion, "module" | "knowledge">) {
  if (question.module.includes("常识") || question.module.includes("政治")) return 35;
  if (question.module.includes("资料")) return 90;
  if (question.module.includes("数量")) return 120;
  if (question.knowledge.includes("图形")) return 75;
  return 60;
}

function json(data: unknown, status = 200, cookie?: string) {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store, private",
  });
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

function validUserId(value: string | null): value is string {
  return Boolean(value && (/^[0-9a-f-]{36}$/i.test(value) || /^acct_[0-9a-f]{32}$/i.test(value)));
}

function cookieHeader(request: Request, userId: string) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${USER_COOKIE}=${encodeURIComponent(userId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}${secure}`;
}

function normalizeCode(value: string) {
  return value.trim().toUpperCase().replace(/\s+/g, "");
}

async function digestText(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hashCode(value: string) {
  return digestText(normalizeCode(value));
}

function addDays(currentEnd: string | null, days: number) {
  const now = Date.now();
  const current = currentEnd ? Date.parse(currentEnd) : 0;
  const base = Number.isFinite(current) && current > now ? current : now;
  return new Date(base + days * 86_400_000).toISOString();
}

function laterDate(first: string | null, second: string | null) {
  const firstValue = first ? Date.parse(first) : 0;
  const secondValue = second ? Date.parse(second) : 0;
  return firstValue >= secondValue ? first : second;
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

function displayNameFromHeaders(request: Request) {
  const encoded = request.headers.get("oai-authenticated-user-full-name");
  const encoding = request.headers.get("oai-authenticated-user-full-name-encoding");
  if (encoded && encoding === "percent-encoded-utf-8") {
    try { return decodeURIComponent(encoded); } catch { /* use fallback */ }
  }
  return "已登录用户";
}

async function migrateDeviceUser(deviceId: string, accountId: string) {
  if (deviceId === accountId || !validUserId(deviceId) || deviceId.startsWith("acct_")) return;
  const db = getD1();
  const [device, account, deviceState, accountState] = await Promise.all([
    db.prepare("SELECT membership_end FROM users WHERE id = ?").bind(deviceId).first<{ membership_end: string | null }>(),
    db.prepare("SELECT membership_end FROM users WHERE id = ?").bind(accountId).first<{ membership_end: string | null }>(),
    db.prepare("SELECT progress_json FROM user_states WHERE user_id = ?").bind(deviceId).first<{ progress_json: string }>(),
    db.prepare("SELECT progress_json FROM user_states WHERE user_id = ?").bind(accountId).first<{ progress_json: string }>(),
  ]);
  if (!device) return;
  const accountProgress = accountState?.progress_json ?? "{}";
  const progress = accountProgress === "{}" ? deviceState?.progress_json ?? "{}" : accountProgress;
  await db.batch([
    db.prepare("UPDATE users SET membership_end = ? WHERE id = ?").bind(laterDate(account?.membership_end ?? null, device.membership_end), accountId),
    db.prepare(`INSERT INTO user_states (user_id, progress_json, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id) DO UPDATE SET progress_json = excluded.progress_json, updated_at = CURRENT_TIMESTAMP`).bind(accountId, progress),
    db.prepare(`INSERT OR IGNORE INTO user_exam_profiles
      (user_id, exam_type, province, exam_year, exam_date, daily_minutes, updated_at)
      SELECT ?, exam_type, province, exam_year, exam_date, daily_minutes, CURRENT_TIMESTAMP
      FROM user_exam_profiles WHERE user_id = ?`).bind(accountId, deviceId),
    db.prepare(`INSERT OR IGNORE INTO user_exam_targets
      (user_id, target_code, exam_type, province, exam_year, exam_date, created_at, updated_at)
      SELECT ?, target_code, exam_type, province, exam_year, exam_date, created_at, CURRENT_TIMESTAMP
      FROM user_exam_targets WHERE user_id = ?`).bind(accountId, deviceId),
    db.prepare(`INSERT OR IGNORE INTO user_exam_targets
      (user_id, target_code, exam_type, province, exam_year, exam_date, updated_at)
      SELECT ?, CASE WHEN exam_type = '省考' THEN 'province:' || province ELSE 'national' END,
        CASE WHEN exam_type = '省考' THEN 'provincial' ELSE 'national' END,
        CASE WHEN exam_type = '省考' THEN province ELSE '' END, exam_year, exam_date, CURRENT_TIMESTAMP
      FROM user_exam_profiles WHERE user_id = ?`).bind(accountId, deviceId),
    db.prepare(`INSERT OR IGNORE INTO user_question_banks (user_id, bank_code, added_at)
      SELECT ?, bank_code, added_at FROM user_question_banks WHERE user_id = ?`).bind(accountId, deviceId),
    db.prepare(`INSERT OR IGNORE INTO user_question_progress
      (user_id, question_code, state, correct_count, wrong_count, uncertain_count, last_answer,
        last_correct, last_duration_ms, last_answered_at, next_review_at, favorite, wrong_reason,
        review_count, updated_at)
      SELECT ?, question_code, state, correct_count, wrong_count, uncertain_count, last_answer,
        last_correct, last_duration_ms, last_answered_at, next_review_at, favorite, wrong_reason,
        review_count, updated_at FROM user_question_progress WHERE user_id = ?`).bind(accountId, deviceId),
    db.prepare("UPDATE practice_attempts SET user_id = ? WHERE user_id = ?").bind(accountId, deviceId),
    db.prepare("UPDATE OR IGNORE redemptions SET user_id = ? WHERE user_id = ?").bind(accountId, deviceId),
    db.prepare("UPDATE OR IGNORE membership_ledger SET user_id = ? WHERE user_id = ?").bind(accountId, deviceId),
    db.prepare("UPDATE OR IGNORE invite_relations SET inviter_id = ? WHERE inviter_id = ?").bind(accountId, deviceId),
    db.prepare("UPDATE OR IGNORE invite_relations SET invitee_id = ? WHERE invitee_id = ?").bind(accountId, deviceId),
    db.prepare("UPDATE users SET invited_by = ? WHERE invited_by = ?").bind(accountId, deviceId),
  ]);
}

async function grantWelcomeTrial(userId: string) {
  const db = getD1();
  const claim = await db.prepare(`INSERT OR IGNORE INTO membership_ledger
    (user_id, delta_days, source_type, source_id, note) VALUES (?, ?, 'trial', ?, '新用户体验')`)
    .bind(userId, TRIAL_DAYS, TRIAL_SOURCE)
    .run();
  if (!claim.meta.changes) return;
  const user = await db.prepare("SELECT membership_end FROM users WHERE id = ?").bind(userId).first<{ membership_end: string | null }>();
  await db.prepare("UPDATE users SET membership_end = ? WHERE id = ?").bind(addDays(user?.membership_end ?? null, TRIAL_DAYS), userId).run();
}

async function ensureUser(request: Request) {
  const db = getD1();
  const cookieUserId = readCookie(request, USER_COOKIE);
  const email = request.headers.get("oai-authenticated-user-email")?.trim().toLowerCase() ?? "";
  let identity: Identity;

  if (email) {
    const hash = await digestText(`gongkao-account:${email}`);
    identity = {
      userId: `acct_${hash.slice(0, 32)}`,
      signedIn: true,
      provider: "chatgpt",
      displayName: displayNameFromHeaders(request),
    };
  } else {
    identity = {
      userId: validUserId(cookieUserId) ? cookieUserId : crypto.randomUUID(),
      signedIn: false,
      provider: "device",
      displayName: "设备体验用户",
    };
  }

  const inviteCode = `GK${identity.userId.replaceAll("-", "").replace("acct_", "").slice(0, 8).toUpperCase()}`;
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO users (id, invite_code) VALUES (?, ?)").bind(identity.userId, inviteCode),
    db.prepare("INSERT OR IGNORE INTO user_states (user_id, progress_json) VALUES (?, '{}')").bind(identity.userId),
  ]);
  if (identity.signedIn && validUserId(cookieUserId) && cookieUserId !== identity.userId) {
    await migrateDeviceUser(cookieUserId, identity.userId);
  }
  await grantWelcomeTrial(identity.userId);
  const setCookie = cookieUserId === identity.userId ? undefined : cookieHeader(request, identity.userId);
  return { ...identity, setCookie };
}

async function seedDefaults() {
  const db = getD1();
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO configs (key, value) VALUES ('invite_reward_days', '3')"),
    db.prepare("INSERT OR IGNORE INTO configs (key, value) VALUES ('invite_monthly_cap', '30')"),
    db.prepare("UPDATE redemption_codes SET status = 'disabled' WHERE batch_name = '内测演示码'"),
    db.prepare(`INSERT OR IGNORE INTO question_banks
      (bank_code, name, exam_type, province, exam_year, subject, description, cover_color, status)
      VALUES ('gk-2027', '2027国考行测', 'national', NULL, 2027, '行测', '按国考命题结构整理，支持后台持续导入真题与专项题。', 'navy', 'published')`),
    db.prepare(`INSERT OR IGNORE INTO question_banks
      (bank_code, name, exam_type, province, exam_year, subject, description, cover_color, status)
      VALUES ('joint-provincial-2027', '2027省考联考通用', 'special', '多省', 2027, '行测', '用于省考共通模块训练，各省差异题仍放在对应省份独立题库。', 'green', 'published')`),
    db.prepare(`INSERT OR IGNORE INTO question_banks
      (bank_code, name, exam_type, province, exam_year, subject, description, cover_color, status)
      VALUES ('gd-2027', '2027广东省考行测', 'provincial', '广东', 2027, '行测', '广东省考独立题库，题型、题量与考情单独维护。', 'orange', 'published')`),
    db.prepare(`INSERT OR IGNORE INTO question_banks
      (bank_code, name, exam_type, province, exam_year, subject, description, cover_color, status)
      VALUES ('zj-2027', '2027浙江省考行测', 'provincial', '浙江', 2027, '行测', '浙江省考独立题库，题型、题量与考情单独维护。', 'blue', 'published')`),
    db.prepare(`INSERT OR IGNORE INTO question_banks
      (bank_code, name, exam_type, province, exam_year, subject, description, cover_color, status)
      VALUES ('sd-2027', '2027山东省考行测', 'provincial', '山东', 2027, '行测', '山东省考独立题库，题型、题量与考情单独维护。', 'green', 'published')`),
    db.prepare(`INSERT OR IGNORE INTO question_banks
      (bank_code, name, exam_type, province, exam_year, subject, description, cover_color, status)
      VALUES ('police-post', '公安岗专项', 'special', '全国', NULL, '综合', '面向公安岗考生的专业科目与岗位专项练习。', 'navy', 'published')`),
    db.prepare(`INSERT OR IGNORE INTO question_banks
      (bank_code, name, exam_type, province, exam_year, subject, description, cover_color, status)
      VALUES ('law-enforcement', '行政执法专项', 'special', '全国', NULL, '综合', '聚焦行政执法类岗位高频法律与实务考点。', 'orange', 'published')`),
    db.prepare(`INSERT OR IGNORE INTO question_banks
      (bank_code, name, exam_type, province, exam_year, subject, description, cover_color, status)
      VALUES ('public-institution', '事业单位职测', 'special', '全国', NULL, '综合', '事业单位职测与综合应用能力日练入口。', 'blue', 'published')`),
  ]);
  await seedDefaultContentOnce();
}

async function seedDefaultContentOnce() {
  const db = getD1();
  const marker = await db.prepare("SELECT value FROM configs WHERE key = 'default_content_seed_version'").first<{ value: string }>();
  if (marker) return;
  const presets = [
    { id: "data-analysis", title: "资料分析速算", subtitle: "5—10分钟一组", icon: "📊", color: "blue", subject: "行测", module: "资料分析", subTypes: [], questionCount: 5, minutes: 8, sortOrder: 10, enabled: true },
    { id: "graphic-reasoning", title: "图形判断", subtitle: "高频规律微练", icon: "🧩", color: "purple", subject: "行测", module: "判断推理", subTypes: ["图形推理"], questionCount: 5, minutes: 8, sortOrder: 20, enabled: true },
    { id: "idiom", title: "言语易错成语", subtitle: "易混词精练", icon: "📖", color: "orange", subject: "行测", module: "言语理解", subTypes: ["选词填空"], questionCount: 5, minutes: 6, sortOrder: 30, enabled: true },
    { id: "current-affairs", title: "常识时政", subtitle: "高频真题快练", icon: "📰", color: "red", subject: "行测", module: "常识判断", subTypes: ["时政"], questionCount: 5, minutes: 5, sortOrder: 40, enabled: true },
    { id: "essay-expression", title: "申论规范表达", subtitle: "从材料到得分词", icon: "✍️", color: "green", subject: "申论", module: "规范表达", subTypes: [], questionCount: 1, minutes: 10, sortOrder: 50, enabled: true },
  ];
  const statements: D1PreparedStatement[] = [];
  for (const day of defaultPracticeDays) {
    statements.push(db.prepare(`INSERT OR IGNORE INTO content_items
      (content_type, content_key, title, payload_json, status, version)
      VALUES ('practice_day', ?, ?, ?, 'published', 1)`)
      .bind(`day-${day.day}`, `第${day.day}天日练`, JSON.stringify({ ...day, questions: [] })));
  }
  for (const track of defaultAudioTracks) {
    statements.push(db.prepare(`INSERT OR IGNORE INTO content_items
      (content_type, content_key, title, payload_json, status, version)
      VALUES ('audio_track', ?, ?, ?, 'published', 1)`)
      .bind(track.id, track.title, JSON.stringify(track)));
  }
  for (const preset of presets) {
    statements.push(db.prepare(`INSERT OR IGNORE INTO content_items
      (content_type, content_key, title, payload_json, status, version)
      VALUES ('drill_preset', ?, ?, ?, 'published', 1)`)
      .bind(`drill-${preset.id}`, preset.title, JSON.stringify(preset)));
  }
  statements.push(db.prepare(`INSERT OR IGNORE INTO content_items
    (content_type, content_key, title, payload_json, status, version)
    VALUES ('strategy_config', 'strategy-default', '默认日练策略', ?, 'published', 1)`)
    .bind(JSON.stringify(DEFAULT_STRATEGY)));
  statements.push(db.prepare("INSERT OR IGNORE INTO configs (key, value) VALUES ('default_content_seed_version', '1')"));
  await db.batch(statements);
}

async function getConfigNumber(key: string, fallback: number) {
  const row = await getD1().prepare("SELECT value FROM configs WHERE key = ?").bind(key).first<{ value: string }>();
  const value = Number(row?.value);
  return Number.isFinite(value) ? value : fallback;
}

function mergeStrategyConfig(base: Record<string, unknown>, incoming: Record<string, unknown>) {
  const basePlans = base.timePlans && typeof base.timePlans === "object" ? base.timePlans as Record<string, unknown> : {};
  const incomingPlans = incoming.timePlans && typeof incoming.timePlans === "object" ? incoming.timePlans as Record<string, unknown> : {};
  const timePlans: Record<string, unknown> = { ...basePlans, ...incomingPlans };
  for (const minutes of [10, 30, 45, 60]) {
    const key = String(minutes);
    const current = timePlans[key] && typeof timePlans[key] === "object" ? timePlans[key] as Record<string, unknown> : {};
    const plan: Record<string, unknown> = { ...current };
    const aliases: Array<[string, string]> = [
      [`morning${minutes}`, "morning"],
      [`practice${minutes}`, "practice"],
      [`essay${minutes}`, "essay"],
      [`questions${minutes}`, "questionCount"],
    ];
    for (const [sourceKey, targetKey] of aliases) {
      const value = Number(incoming[sourceKey]);
      if (Number.isFinite(value) && value >= 0) plan[targetKey] = Math.round(value);
    }
    timePlans[key] = plan;
  }
  const merged: Record<string, unknown> = { ...base, ...incoming, timePlans };
  const reviewRatio = Number(incoming.reviewRatio);
  if (Number.isFinite(reviewRatio)) merged.dueShare = Math.max(0, Math.min(1, reviewRatio / 100));
  const urgentExamDays = Number(incoming.urgentExamDays);
  if (Number.isFinite(urgentExamDays)) merged.urgentDays = Math.max(1, Math.min(180, Math.round(urgentExamDays)));
  const scoreRateMin = Number(incoming.scoreRateMin);
  const scoreRateMax = Number(incoming.scoreRateMax);
  if (Number.isFinite(scoreRateMin) && Number.isFinite(scoreRateMax) && scoreRateMin < scoreRateMax) {
    merged.scoreRateSweetSpot = [Math.max(0, scoreRateMin), Math.min(100, scoreRateMax)];
  }
  return merged;
}

async function loadStrategyConfig() {
  const rows = await getD1().prepare(`SELECT payload_json FROM content_items
    WHERE content_type = 'strategy_config' AND status IN ('published', 'scheduled')
      AND (publish_at IS NULL OR datetime(publish_at) <= CURRENT_TIMESTAMP)
    ORDER BY id`).all<{ payload_json: string }>();
  let merged: Record<string, unknown> = clone(DEFAULT_STRATEGY);
  for (const row of rows.results) {
    try {
      const incoming = JSON.parse(row.payload_json) as Record<string, unknown>;
      merged = mergeStrategyConfig(merged, incoming);
    } catch {
      // Invalid strategy drafts must not affect the safe defaults.
    }
  }
  const reviewIntervals = Array.isArray(merged.reviewIntervals)
    ? merged.reviewIntervals.map(Number).filter((value) => Number.isInteger(value) && value >= 1 && value <= 365).slice(0, 10)
    : [];
  const sweetSpot = Array.isArray(merged.scoreRateSweetSpot) ? merged.scoreRateSweetSpot.map(Number).slice(0, 2) : [];
  return {
    ...DEFAULT_STRATEGY,
    ...merged,
    reviewIntervals: reviewIntervals.length ? reviewIntervals : DEFAULT_STRATEGY.reviewIntervals,
    scoreRateSweetSpot: sweetSpot.length === 2 && sweetSpot[0] >= 0 && sweetSpot[1] <= 100 && sweetSpot[0] < sweetSpot[1]
      ? sweetSpot : DEFAULT_STRATEGY.scoreRateSweetSpot,
    dueShare: Math.max(0, Math.min(1, Number(merged.dueShare ?? DEFAULT_STRATEGY.dueShare))),
    urgentDays: Math.max(1, Math.min(180, Math.floor(Number(merged.urgentDays ?? DEFAULT_STRATEGY.urgentDays)))),
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function starterQuestionList(): ResolvedQuestion[] {
  return defaultPracticeDays.flatMap((day) => day.questions.map((question) => ({
    ...clone(question),
    technique: "先定位题型，再用题干中的关键词排除干扰项。",
    source: `公考日练原创 · 第${day.day}组`,
    difficulty: "中等",
    bankCode: STARTER_BANK_CODE,
    bankName: "公考日练·行测基础",
    scopeLabel: "国省共通基础",
    reviewedAt: "2026-07-14",
    targetCode: null,
    region: "全国",
    examYear: 2026,
    frequency: "中频",
    importanceStars: 3,
    scoreRate: 60,
    suggestedSeconds: 60,
    imageUrl: "",
    resourceUrl: "",
  })));
}

function parseOptions(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function answerIndex(value: string | null) {
  if (!value) return -1;
  const normalized = value.trim().toUpperCase();
  if (/^[A-H]$/.test(normalized)) return normalized.charCodeAt(0) - 65;
  const numeric = Number(normalized);
  return Number.isInteger(numeric) ? numeric : -1;
}

function publicQuestion(question: ResolvedQuestion, progress?: QuestionProgressRow) {
  const due = Boolean(progress?.next_review_at && Date.parse(progress.next_review_at) <= Date.now());
  return {
    id: question.id,
    module: question.module,
    stem: question.stem,
    options: question.options,
    knowledge: question.knowledge,
    source: question.source,
    difficulty: question.difficulty,
    bankCode: question.bankCode,
    bankName: question.bankName,
    scopeLabel: question.scopeLabel,
    reviewedAt: question.reviewedAt,
    region: question.region,
    examYear: question.examYear,
    frequency: question.frequency,
    importanceStars: question.importanceStars,
    scoreRate: question.scoreRate,
    suggestedSeconds: question.suggestedSeconds,
    imageUrl: question.imageUrl,
    resourceUrl: question.resourceUrl,
    truthLabel: question.region && question.examYear ? `${question.region}-${question.examYear}` : question.region || "真题",
    state: progress?.state ?? "new",
    due,
    favorite: Boolean(progress?.favorite),
    wrongReason: progress?.wrong_reason ?? "",
  };
}

function priorityFor(progress?: QuestionProgressRow) {
  if (progress?.next_review_at && Date.parse(progress.next_review_at) <= Date.now()) return 0;
  if (progress?.state === "weak") return 1;
  if (!progress) return 2;
  if (progress.state === "learning") return 3;
  return 4;
}

function questionValueRank(
  question: ResolvedQuestion,
  sweetSpot: [number, number] = [40, 80],
  weights: { frequency: number; importance: number; scoreRate: number } = { frequency: 25, importance: 25, scoreRate: 20 },
) {
  const scoreDistance = question.scoreRate >= sweetSpot[0] && question.scoreRate <= sweetSpot[1]
    ? 0
    : Math.min(Math.abs(question.scoreRate - sweetSpot[0]), Math.abs(question.scoreRate - sweetSpot[1]));
  const normalizedScorePenalty = Math.min(1, scoreDistance / 40) * weights.scoreRate;
  const normalizedFrequencyPenalty = (question.frequency === "高频" ? 0 : question.frequency === "中频" ? 0.5 : 1) * weights.frequency;
  const normalizedImportancePenalty = ((5 - question.importanceStars) / 4) * weights.importance;
  return normalizedScorePenalty + normalizedFrequencyPenalty + normalizedImportancePenalty;
}

function questionFingerprint(question: ResolvedQuestion) {
  const compact = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[\s，。；：、,.!?！？:;"'“”‘’（）()【】\[\]]+/g, "");
  return `${compact(question.stem)}|${question.options.map(compact).join("|")}`;
}

function takeBalanced(
  items: QuestionCandidate[],
  count: number,
  selectedItems: QuestionCandidate[],
  bankCycle: string[],
) {
  const selectedIds = new Set(selectedItems.map((item) => item.question.id));
  const grouped = new Map<string, QuestionCandidate[]>();
  for (const item of items) {
    if (selectedIds.has(item.question.id)) continue;
    const queue = grouped.get(item.question.bankCode) ?? [];
    queue.push(item);
    grouped.set(item.question.bankCode, queue);
  }
  const cycle = bankCycle.length ? bankCycle : Array.from(grouped.keys());
  let remaining = Math.max(0, count);
  while (remaining > 0) {
    let addedThisRound = 0;
    for (const bankCode of cycle) {
      if (remaining <= 0) break;
      const queue = grouped.get(bankCode);
      while (queue?.length && selectedIds.has(queue[0].question.id)) queue.shift();
      const next = queue?.shift();
      if (!next) continue;
      selectedItems.push(next);
      selectedIds.add(next.question.id);
      remaining -= 1;
      addedThisRound += 1;
    }
    if (!addedThisRound) break;
  }
}

async function selectedBankCodes(userId: string) {
  const rows = await getD1().prepare("SELECT bank_code FROM user_question_banks WHERE user_id = ? ORDER BY added_at")
    .bind(userId).all<{ bank_code: string }>();
  return rows.results.map((row) => row.bank_code).filter((code) => code !== STARTER_BANK_CODE);
}

async function loadExamProfile(userId: string): Promise<LoadedExamProfile> {
  const db = getD1();
  const [row, targetRows] = await Promise.all([
    db.prepare(`SELECT exam_type, province, exam_year, exam_date, daily_minutes
      FROM user_exam_profiles WHERE user_id = ?`).bind(userId).first<{
        exam_type: string; province: string; exam_year: number; exam_date: string | null; daily_minutes: number;
      }>(),
    db.prepare(`SELECT target_code, exam_type, province, exam_year, exam_date
      FROM user_exam_targets WHERE user_id = ? ORDER BY created_at, target_code`).bind(userId).all<{
        target_code: string; exam_type: string; province: string; exam_year: number; exam_date: string | null;
      }>(),
  ]);
  const targets = Array.from(new Map(targetRows.results.map((target) => {
    const province = target.exam_type === "national" ? "" : normalizeProvince(target.province);
    const code = target.exam_type === "national" ? "national" : `province:${province}`;
    return [code, {
    code,
    label: target.exam_type === "national" ? "国考" : `${province}省考`,
    examType: target.exam_type === "national" ? "国考" as const : "省考" as const,
    province,
    examYear: target.exam_year,
    examDate: target.exam_date,
  } satisfies ExamTargetProfile] as const;
  })).values());
  if (row) {
    const isProvincial = row.exam_type === "省考";
    const province = isProvincial ? normalizeProvince(row.province) : "";
    const legacyTarget = {
      code: isProvincial ? `province:${province}` : "national",
      label: isProvincial ? `${province}省考` : "国考",
      examType: isProvincial ? "省考" : "国考",
      province,
      examYear: row.exam_year,
      examDate: row.exam_date,
    } satisfies ExamTargetProfile;
    const primaryIndex = targets.findIndex((target) => target.code === legacyTarget.code);
    if (primaryIndex === -1) targets.unshift(legacyTarget);
    else if (primaryIndex > 0) targets.unshift(...targets.splice(primaryIndex, 1));
  }
  const primary = targets[0];
  return {
    onboarded: targets.length > 0,
    dailyMinutes: normalizeDailyMinutes(row?.daily_minutes),
    targets,
    examType: primary?.examType ?? "国考",
    province: primary?.province ?? "",
    examYear: primary?.examYear ?? new Date().getFullYear() + 1,
    examDate: primary?.examDate ?? null,
  };
}

function bankMatchesTargets(bank: { exam_type: string; province?: string | null }, profile: LoadedExamProfile) {
  if (bank.exam_type === "special") return true;
  if (bank.exam_type === "national") return profile.targets.some((target) => target.examType === "国考");
  const province = normalizeProvince(bank.province);
  return profile.targets.some((target) => target.examType === "省考" && normalizeProvince(target.province) === province);
}

function displayExamType(value: string) {
  return value === "national" ? "国考" : value === "provincial" ? "省考" : "专项";
}

function questionScopeLabel(examType: string, province: unknown) {
  if (examType === "national") return "国考题源";
  if (examType === "provincial") return `${normalizeProvince(province) || "省考"}省考题源`;
  return "通用专项";
}

function normalizeProvince(value: unknown) {
  return trimmed(value, 24)
    .replace(/特别行政区$/, "")
    .replace(/壮族自治区$|回族自治区$|维吾尔自治区$|自治区$/, "")
    .replace(/省$|市$/, "");
}

async function loadQuestionBanks(userId: string) {
  const db = getD1();
  const [selected, rows, profile] = await Promise.all([
    selectedBankCodes(userId),
    db.prepare(`SELECT qb.bank_code, qb.name, qb.exam_type, qb.province, qb.exam_year, qb.subject,
      qb.description, qb.cover_color, COUNT(DISTINCT q.question_code) AS question_count,
      COUNT(DISTINCT CASE WHEN uqp.last_answered_at IS NOT NULL THEN q.question_code END) AS studied_count,
      COUNT(DISTINCT CASE WHEN uqp.state = 'mastered' THEN q.question_code END) AS mastered_count,
      COUNT(DISTINCT CASE WHEN uqp.state = 'weak' THEN q.question_code END) AS weak_count,
      COUNT(DISTINCT CASE WHEN datetime(uqp.next_review_at) <= CURRENT_TIMESTAMP THEN q.question_code END) AS due_count
      FROM question_banks qb
      LEFT JOIN question_bank_items qbi ON qbi.bank_id = qb.id
      LEFT JOIN questions q ON q.id = qbi.question_id AND q.status = 'active'
      LEFT JOIN user_question_progress uqp ON uqp.question_code = q.question_code AND uqp.user_id = ?
      WHERE qb.status = 'published'
      GROUP BY qb.id ORDER BY qb.updated_at DESC`).bind(userId).all<{
        bank_code: string; name: string; exam_type: string; province: string | null; exam_year: number | null;
        subject: string; description: string; cover_color: string; question_count: number; studied_count: number; mastered_count: number;
        weak_count: number; due_count: number;
      }>(),
    loadExamProfile(userId),
  ]);
  return rows.results.map((row) => {
    const targetMatch = bankMatchesTargets(row, profile);
    const matchingTarget = profile.targets.find((target) => row.exam_type === "national"
      ? target.examType === "国考"
      : row.exam_type === "provincial" ? target.examType === "省考" && normalizeProvince(target.province) === normalizeProvince(row.province) : true);
    const recommended = targetMatch && (!row.exam_year || matchingTarget?.examYear === row.exam_year);
    const scopeLabel = row.exam_type === "provincial" ? `${normalizeProvince(row.province) || "未设置"}省考专属` : row.exam_type === "national" ? "国考专属" : "专项训练";
    const mismatchReason = targetMatch ? "" : row.exam_type === "provincial"
      ? `添加后会同步加入“${normalizeProvince(row.province) || "该省"}省考”报考目标。`
      : row.exam_type === "national" ? "添加后会同步加入“国考”报考目标。" : "可作为专项题库加入。";
    return {
    code: row.bank_code,
    name: row.name,
    examType: displayExamType(row.exam_type),
    province: normalizeProvince(row.province) || "全国",
    examYear: row.exam_year,
    subject: row.subject,
    description: row.description,
    coverColor: row.cover_color,
    questionCount: Number(row.question_count),
    studiedCount: Number(row.studied_count),
    masteredCount: Number(row.mastered_count),
    weakCount: Number(row.weak_count),
    dueCount: Number(row.due_count),
    added: selected.includes(row.bank_code),
    targetMatch,
    recommended,
    scopeLabel,
    mismatchReason,
  }; });
}

async function loadStudyInsights(userId: string) {
  const db = getD1();
  const selectedBanks = (await selectedBankCodes(userId)).slice(0, 32);
  const [summary, modules, states, recent] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(is_correct), 0) AS correct,
      COALESCE(AVG(duration_ms), 0) AS avg_duration,
      COALESCE(SUM(CASE WHEN confidence IN ('hesitant', 'guessed') OR uncertain = 1 THEN 1 ELSE 0 END), 0) AS uncertain_total,
      COALESCE(SUM(overtime), 0) AS overtime_total
      FROM practice_attempts WHERE user_id = ?`).bind(userId)
      .first<{ total: number; correct: number; avg_duration: number; uncertain_total: number; overtime_total: number }>(),
    db.prepare(`SELECT module, COUNT(*) AS total, COALESCE(SUM(is_correct), 0) AS correct,
      COALESCE(AVG(duration_ms), 0) AS avg_duration FROM practice_attempts WHERE user_id = ?
        AND answered_at >= datetime('now', '-14 days')
      GROUP BY module ORDER BY total DESC LIMIT 8`).bind(userId)
      .all<{ module: string; total: number; correct: number; avg_duration: number }>(),
    db.prepare(`SELECT state, COUNT(*) AS total FROM user_question_progress WHERE user_id = ? GROUP BY state`)
      .bind(userId).all<{ state: string; total: number }>(),
    db.prepare(`SELECT date(answered_at, '+8 hours') AS day, COUNT(*) AS total, COALESCE(SUM(is_correct), 0) AS correct
      FROM practice_attempts WHERE user_id = ? AND answered_at >= datetime('now', '-6 days')
      GROUP BY date(answered_at, '+8 hours') ORDER BY day`).bind(userId)
      .all<{ day: string; total: number; correct: number }>(),
  ]);
  const stateMap = Object.fromEntries(states.results.map((row) => [row.state, Number(row.total)]));
  const total = Number(summary?.total ?? 0);
  const correct = Number(summary?.correct ?? 0);
  const dueScopes: string[] = [];
  const dueBindings: unknown[] = [userId];
  if (selectedBanks.includes(STARTER_BANK_CODE)) {
    const starterCodes = starterQuestionList().map((question) => question.id);
    dueScopes.push(`uqp.question_code IN (${starterCodes.map(() => "?").join(",")})`);
    dueBindings.push(...starterCodes);
  }
  const publishedBanks = selectedBanks.filter((code) => code !== STARTER_BANK_CODE);
  if (publishedBanks.length) {
    dueScopes.push(`EXISTS (
      SELECT 1 FROM question_bank_items qbi
      JOIN questions q ON q.id = qbi.question_id
      JOIN question_banks qb ON qb.id = qbi.bank_id
      WHERE q.question_code = uqp.question_code AND qb.status = 'published'
        AND qb.bank_code IN (${publishedBanks.map(() => "?").join(",")})
    )`);
    dueBindings.push(...publishedBanks);
  }
  const dueCount = dueScopes.length
    ? await db.prepare(`SELECT COUNT(*) AS total FROM user_question_progress uqp
      WHERE uqp.user_id = ? AND datetime(uqp.next_review_at) <= CURRENT_TIMESTAMP
        AND (${dueScopes.join(" OR ")})`).bind(...dueBindings).first<{ total: number }>().then((row) => Number(row?.total ?? 0))
    : 0;
  const tomorrowDueCount = dueScopes.length
    ? await db.prepare(`SELECT COUNT(*) AS total FROM user_question_progress uqp
      WHERE uqp.user_id = ?
        AND datetime(uqp.next_review_at) <= datetime('now', '+8 hours', 'start of day', '+2 days', '-8 hours')
        AND (${dueScopes.join(" OR ")})`).bind(...dueBindings).first<{ total: number }>().then((row) => Number(row?.total ?? 0))
    : 0;
  const moduleInsights = modules.results.map((row) => ({
    module: row.module,
    total: Number(row.total),
    accuracy: Number(row.total) ? Math.round((Number(row.correct) / Number(row.total)) * 100) : 0,
    avgSeconds: Math.round(Number(row.avg_duration) / 1000),
  }));
  const focusCandidates = moduleInsights.filter((item) => item.total >= 3);
  const focusModule = [...(focusCandidates.length ? focusCandidates : moduleInsights)]
    .sort((a, b) => a.accuracy - b.accuracy || b.avgSeconds - a.avgSeconds)[0] ?? null;
  const focusQuestionCount = focusModule ? 5 : 0;
  const estimatedMinutes = Math.max(5, Math.ceil(tomorrowDueCount * 1.2 + focusQuestionCount * 1.2));
  return {
    total,
    accuracy: total ? Math.round((correct / total) * 100) : 0,
    avgSeconds: total ? Math.round(Number(summary?.avg_duration ?? 0) / 1000) : 0,
    uncertainCount: Number(summary?.uncertain_total ?? 0),
    overtimeCount: Number(summary?.overtime_total ?? 0),
    dueCount,
    stateCounts: {
      learning: stateMap.learning ?? 0,
      weak: stateMap.weak ?? 0,
      mastered: stateMap.mastered ?? 0,
    },
    modules: moduleInsights,
    recent: recent.results.map((row) => ({ day: row.day, total: Number(row.total), accuracy: Number(row.total) ? Math.round((Number(row.correct) / Number(row.total)) * 100) : 0 })),
    tomorrowPlan: {
      dueCount: tomorrowDueCount,
      focusModule: focusModule?.module ?? null,
      focusQuestionCount,
      estimatedMinutes,
      taskText: `${tomorrowDueCount ? `先回炉${tomorrowDueCount}道到期题` : "先完成到期检查"}${focusModule ? `，再练${focusQuestionCount}道${focusModule.module}` : "，再按主攻题库补充新题"}，预计${estimatedMinutes}分钟。`,
    },
  };
}

async function loadWrongAudioQuestions(userId: string): Promise<Question[]> {
  const db = getD1();
  const rows = await db.prepare(`SELECT question_code FROM user_question_progress
    WHERE user_id = ? AND wrong_count > 0 AND last_answered_at IS NOT NULL
    ORDER BY last_answered_at DESC LIMIT 20`).bind(userId).all<{ question_code: string }>();
  const orderedCodes = rows.results.map((row) => row.question_code);
  if (!orderedCodes.length) return [];

  const questionMap = new Map<string, Question>();
  for (const question of starterQuestionList()) {
    if (orderedCodes.includes(question.id)) questionMap.set(question.id, question);
  }
  const databaseCodes = orderedCodes.filter((code) => !questionMap.has(code));
  if (databaseCodes.length) {
    const placeholders = databaseCodes.map(() => "?").join(",");
    const databaseRows = await db.prepare(`SELECT question_code, module, sub_type, stem, options_json,
      answer, explanation, source, difficulty FROM questions
      WHERE status = 'active' AND question_code IN (${placeholders})`).bind(...databaseCodes).all<Record<string, unknown>>();
    for (const row of databaseRows.results) {
      const id = String(row.question_code);
      questionMap.set(id, {
        id,
        module: String(row.module),
        stem: String(row.stem),
        options: parseOptions(String(row.options_json ?? "[]")),
        answer: answerIndex(row.answer ? String(row.answer) : null),
        explanation: String(row.explanation ?? ""),
        knowledge: String(row.sub_type ?? row.module),
        source: String(row.source ?? "题库导入"),
        difficulty: String(row.difficulty ?? "中等"),
      });
    }
  }
  return orderedCodes.map((code) => questionMap.get(code)).filter((question): question is Question => Boolean(question));
}

async function loadContent(membershipActive: boolean, profile?: LoadedExamProfile) {
  const rows = await getD1().prepare(`SELECT content_type, content_key, title, payload_json, version
    FROM content_items WHERE status IN ('published', 'scheduled') AND (publish_at IS NULL OR datetime(publish_at) <= CURRENT_TIMESTAMP)
    ORDER BY id ASC`).all<{ content_type: string; content_key: string; payload_json: string }>();
  const dayMap = new Map<string, PracticeDay>();
  const audioMap = new Map<string, AudioTrack>();
  const examEventMap = new Map<string, PublishedExamEvent>();
  const examNoticeMap = new Map<string, PublishedExamNotice>();
  const jobPositionMap = new Map<string, PublishedJobPosition>();
  const morningReads: Array<Record<string, unknown>> = [];
  const currentAffairsContent: Array<Record<string, unknown>> = [];
  const essayMicros: Array<Record<string, unknown>> = [];
  const drillPresets: Array<Record<string, unknown>> = [];
  let strategyConfig: Record<string, unknown> = clone(DEFAULT_STRATEGY);
  const activeTargetCodes = new Set(profile?.targets.map((target) => target.code) ?? []);
  const matchesTargets = (item: Record<string, unknown>) => {
    const raw = Array.isArray(item.targetCodes)
      ? item.targetCodes
      : String(item.targetCodes ?? "").split(/[,，、|｜;；\n]+/);
    const requested = raw.map((value) => String(value).trim()).filter(Boolean);
    return !requested.length || requested.some((code) => activeTargetCodes.has(code));
  };
  for (const row of rows.results) {
    try {
      const parsed = JSON.parse(row.payload_json) as PracticeDay | AudioTrack | Record<string, unknown>;
      if (row.content_type === "practice_day") {
        const day = parsed as PracticeDay;
        dayMap.set(`day-${Number(day.day) || dayMap.size + 1}`, day);
      }
      if (row.content_type === "audio_track") audioMap.set(row.content_key, parsed as AudioTrack);
      const envelope: Record<string, unknown> = {
        id: row.content_key,
        contentKey: row.content_key,
        title: (row as { title?: string }).title ?? String((parsed as Record<string, unknown>).title ?? ""),
        version: Number((row as { version?: number }).version ?? 1),
        ...(parsed as Record<string, unknown>),
      };
      if (row.content_type === "morning_read" && matchesTargets(envelope)) morningReads.push(envelope);
      if (row.content_type === "current_affairs" && matchesTargets(envelope)) currentAffairsContent.push(envelope);
      if (row.content_type === "essay_micro" && matchesTargets(envelope)) essayMicros.push(envelope);
      if (row.content_type === "drill_preset" && envelope.enabled !== false && matchesTargets(envelope)) drillPresets.push(envelope);
      if (row.content_type === "strategy_config") {
        const incoming = parsed as Record<string, unknown>;
        strategyConfig = mergeStrategyConfig(strategyConfig, incoming);
      }
      if (row.content_type === "exam_event") {
        const item = parsed as Record<string, unknown>;
        const targetCode = trimmed(item.targetCode, 60);
        const eventDate = trimmed(item.eventDate, 10);
        const title = trimmed(item.title, 40);
        if (targetCode && title && /^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
          examEventMap.set(row.content_key, {
            id: `official-${row.content_key}`,
            targetCode,
            targetLabel: trimmed(item.targetLabel, 24) || (targetCode === "national" ? "国考" : targetCode.replace(/^province:/, "") + "省考"),
            eventType: trimmed(item.eventType, 24) || "公告发布",
            title,
            eventDate,
            reminderDays: [0, 1, 3, 7, 14].includes(Number(item.reminderDays)) ? Number(item.reminderDays) : 3,
            sourceUrl: /^https?:\/\//i.test(trimmed(item.sourceUrl, 400)) ? trimmed(item.sourceUrl, 400) : "",
          });
        }
      }
      if (row.content_type === "exam_notice") {
        const item = parsed as Record<string, unknown>;
        const targetCode = trimmed(item.targetCode, 60);
        const title = trimmed(item.title, 80);
        if (targetCode && title) {
          examNoticeMap.set(row.content_key, {
            id: `notice-${row.content_key}`,
            targetCode,
            targetLabel: trimmed(item.targetLabel, 24) || (targetCode === "national" ? "国考" : targetCode.replace(/^province:/, "") + "省考"),
            noticeType: trimmed(item.noticeType, 24) || "公告发布",
            title,
            publishDate: /^\d{4}-\d{2}-\d{2}$/.test(trimmed(item.publishDate, 10)) ? trimmed(item.publishDate, 10) : chinaDateKey(),
            summary: trimmed(item.summary, 220),
            sourceUrl: /^https?:\/\//i.test(trimmed(item.sourceUrl, 400)) ? trimmed(item.sourceUrl, 400) : "",
            status: trimmed(item.status, 24) || "已发布",
          });
        }
      }
      if (row.content_type === "job_position") {
        const item = parsed as Record<string, unknown>;
        const targetCode = trimmed(item.targetCode, 60);
        const title = trimmed(item.title, 80);
        const code = trimmed(item.code, 40) || row.content_key;
        if (targetCode && title) {
          jobPositionMap.set(row.content_key, {
            id: `position-${row.content_key}`,
            targetCode,
            targetLabel: trimmed(item.targetLabel, 24) || (targetCode === "national" ? "国考" : targetCode.replace(/^province:/, "") + "省考"),
            examName: trimmed(item.examName, 80),
            department: trimmed(item.department, 80),
            unit: trimmed(item.unit, 80),
            title,
            code,
            region: trimmed(item.region, 60),
            recruitCount: Math.max(0, Math.min(999, Math.round(Number(item.recruitCount ?? 0)))),
            education: trimmed(item.education, 60) || "不限",
            degree: trimmed(item.degree, 60) || "不限",
            majors: trimmed(item.majors, 160) || "不限",
            majorCodes: trimmed(item.majorCodes, 160),
            freshLimit: trimmed(item.freshLimit, 80) || "不限",
            politicalStatus: trimmed(item.politicalStatus, 60) || "不限",
            household: trimmed(item.household, 80) || "不限",
            grassrootsYears: trimmed(item.grassrootsYears, 60) || "不限",
            gender: trimmed(item.gender, 20) || "不限",
            certificates: trimmed(item.certificates, 120) || "不限",
            remote: trimmed(item.remote, 100),
            remarks: trimmed(item.remarks, 220),
            phone: trimmed(item.phone, 80),
            sourceUrl: /^https?:\/\//i.test(trimmed(item.sourceUrl, 400)) ? trimmed(item.sourceUrl, 400) : "",
          });
        }
      }
    } catch {
      // Invalid draft data never blocks the learner experience.
    }
  }
  const scheduledDate = (item: Record<string, unknown>) => {
    const value = String(item.publishDate ?? item.date ?? "").trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "";
  };
  const matchDay = (item: Record<string, unknown>) => {
    const day = Number(item.day);
    if (Number.isInteger(day) && day > 0) return day;
    const publishDate = scheduledDate(item);
    if (publishDate && publishDate === chinaDateKey()) return Number(Array.from(dayMap.values())[0]?.day ?? 1);
    return null;
  };
  const ensureDay = (day: number) => {
    const key = `day-${day}`;
    const existing = dayMap.get(key);
    if (existing) return existing;
    const created: PracticeDay = {
      day,
      label: "今日精练",
      morning: { title: "", lead: "", paragraphs: [], keywords: [] },
      questions: [],
      currentAffairs: [],
      essay: { expressions: [], prompt: "", reference: "" },
    };
    dayMap.set(key, created);
    return created;
  };
  for (const item of morningReads) {
    const day = matchDay(item);
    if (!day) continue;
    const existing = ensureDay(day);
    const source = item.morning && typeof item.morning === "object" ? item.morning as Record<string, unknown> : item;
    const rawParagraphs = Array.isArray(source.paragraphs)
      ? source.paragraphs
      : String(source.body ?? "").split(/\n+/);
    const rawKeywords = Array.isArray(source.keywords)
      ? source.keywords
      : String(source.keywords ?? "").split(/[、,，|｜；;\n]+/);
    existing.date = scheduledDate(item) || existing.date;
    existing.label = trimmed(item.category, 40) || existing.label;
    existing.morning = {
      title: trimmed(source.title ?? item.title, 160),
      lead: trimmed(source.lead ?? source.kicker ?? source.summary, 500),
      paragraphs: rawParagraphs.map((value) => trimmed(value, 2_000)).filter(Boolean).slice(0, 20),
      keywords: rawKeywords.map((value) => trimmed(value, 40)).filter(Boolean).slice(0, 12),
    };
  }
  for (const item of currentAffairsContent) {
    const day = matchDay(item);
    if (!day) continue;
    const existing = ensureDay(day);
    existing.date = scheduledDate(item) || existing.date;
    const entries = Array.isArray(item.items) ? item.items : [item];
    existing.currentAffairs = entries.map((entry) => ({
      tag: trimmed((entry as Record<string, unknown>).tag ?? (entry as Record<string, unknown>).category, 24) || "时政",
      title: trimmed((entry as Record<string, unknown>).title, 120),
      detail: trimmed((entry as Record<string, unknown>).detail
        ?? [(entry as Record<string, unknown>).summary, (entry as Record<string, unknown>).body].filter(Boolean).join("\n"), 1_000),
    })).filter((entry) => entry.title);
  }
  for (const item of essayMicros) {
    const day = matchDay(item);
    if (!day) continue;
    const existing = ensureDay(day);
    const source = item.essay && typeof item.essay === "object" ? item.essay as Record<string, unknown> : item;
    const rawExpressions = Array.isArray(source.expressions) ? source.expressions : [];
    const rawScoringPoints = Array.isArray(source.scoringPoints)
      ? source.scoringPoints
      : String(source.scoringPoints ?? "").split(/[|｜；;\n]+/);
    existing.date = scheduledDate(item) || existing.date;
    existing.label = trimmed(item.theme, 40) || existing.label;
    existing.essay = {
      expressions: rawExpressions.flatMap((value) => {
        if (!value || typeof value !== "object") return [];
        const expression = value as Record<string, unknown>;
        const phrase = trimmed(expression.phrase, 300);
        return phrase ? [{ phrase, scene: trimmed(expression.scene, 80) }] : [];
      }).slice(0, 20),
      material: trimmed(source.material, 12_000),
      prompt: trimmed(source.prompt, 2_000),
      reference: trimmed(source.reference ?? source.referenceAnswer, 8_000),
      scoringPoints: rawScoringPoints.map((value) => trimmed(value, 500)).filter(Boolean).slice(0, 30),
      wordLimit: Math.max(20, Math.min(5_000, Math.round(Number(source.wordLimit)) || 150)),
    };
  }
  const practiceDays = Array.from(dayMap.values()).sort((a, b) => a.day - b.day);
  const audioTracks = Array.from(audioMap.values()).sort((a, b) => Number(a.sortOrder ?? 0) - Number(b.sortOrder ?? 0));
  const examEvents = Array.from(examEventMap.values()).sort((a, b) => a.eventDate.localeCompare(b.eventDate));
  const examNotices = Array.from(examNoticeMap.values()).sort((a, b) => b.publishDate.localeCompare(a.publishDate));
  const jobPositions = Array.from(jobPositionMap.values()).sort((a, b) => a.targetLabel.localeCompare(b.targetLabel) || a.department.localeCompare(b.department));
  const common = {
    practiceDays,
    audioTracks,
    examEvents,
    examNotices,
    jobPositions,
    morningReads,
    currentAffairs: currentAffairsContent,
    essayMicros,
    drillPresets: drillPresets.sort((a, b) => Number(a.sortOrder ?? 0) - Number(b.sortOrder ?? 0)),
    strategyConfig,
  };
  if (membershipActive) return { ...common, access: "premium" as const };

  const previewDay = practiceDays[0] ? clone(practiceDays[0]) : null;
  if (previewDay) {
    previewDay.questions = previewDay.questions.slice(0, 5).map((question) => ({ ...question, explanation: "会员可查看完整解析与解题技巧。" }));
    previewDay.currentAffairs = previewDay.currentAffairs.slice(0, 3);
    previewDay.essay.expressions = previewDay.essay.expressions.slice(0, 1);
    previewDay.essay.reference = "兑换会员码后查看参考答案。";
  }
  return {
    ...common,
    practiceDays: previewDay ? [previewDay] : [],
    audioTracks: audioTracks.slice(0, 1),
    jobPositions: jobPositions.slice(0, 12),
    access: "preview" as const,
  };
}

async function bootstrap(request: Request) {
  await ensureSchema();
  await seedDefaults();
  const identity = await ensureUser(request);
  const db = getD1();
  const [user, state, ledger, inviteStats, inviteDays, inviteCap, examProfile, questionBanks, studyInsights, wrongAudioQuestions] = await Promise.all([
    db.prepare("SELECT id, invite_code, invited_by, membership_end FROM users WHERE id = ?").bind(identity.userId).first<UserRow>(),
    db.prepare("SELECT progress_json FROM user_states WHERE user_id = ?").bind(identity.userId).first<{ progress_json: string }>(),
    db.prepare(`SELECT delta_days, source_type, note, created_at
      FROM membership_ledger WHERE user_id = ? ORDER BY id DESC LIMIT 20`).bind(identity.userId).all(),
    db.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN status = 'rewarded' THEN 1 ELSE 0 END) AS rewarded,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending
      FROM invite_relations WHERE inviter_id = ?`).bind(identity.userId).first<{ total: number; rewarded: number; pending: number }>(),
    getConfigNumber("invite_reward_days", 3),
    getConfigNumber("invite_monthly_cap", 30),
    loadExamProfile(identity.userId),
    loadQuestionBanks(identity.userId),
    loadStudyInsights(identity.userId),
    loadWrongAudioQuestions(identity.userId),
  ]);
  if (!user) return json({ error: "用户初始化失败" }, 500, identity.setCookie);
  let progress = {};
  try { progress = JSON.parse(state?.progress_json ?? "{}"); } catch { progress = {}; }
  const membershipActive = Boolean(user.membership_end && Date.parse(user.membership_end) > Date.now());
  const content = await loadContent(membershipActive, examProfile);
  return json({
    user: {
      id: user.id,
      inviteCode: user.invite_code,
      membershipEnd: user.membership_end,
      membershipActive,
      signedIn: identity.signedIn,
      authProvider: identity.provider,
      displayName: identity.displayName,
    },
    content,
    progress,
    examProfile,
    questionBanks,
    studyInsights,
    wrongAudioQuestions,
    todayKey: chinaDateKey(),
    ledger: ledger.results,
    inviteStats: inviteStats ?? { total: 0, rewarded: 0, pending: 0 },
    inviteConfig: { rewardDays: inviteDays, monthlyCap: inviteCap },
  }, 200, identity.setCookie);
}

async function saveProgress(userId: string, payload: Record<string, unknown>) {
  const value = JSON.stringify(payload.progress ?? {});
  if (value.length > 120_000) return json({ error: "学习记录过大" }, 400);
  await getD1().prepare(`INSERT INTO user_states (user_id, progress_json, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET progress_json = excluded.progress_json, updated_at = CURRENT_TIMESTAMP`)
    .bind(userId, value).run();
  return json({ ok: true });
}

async function saveExamProfile(userId: string, payload: Record<string, unknown>) {
  const currentYear = new Date().getFullYear();
  const allowedMinutes = new Set([30, 45, 60]);
  const db = getD1();
  const currentProfile = await loadExamProfile(userId);
  const dailyMinutesValue = Number(payload.dailyMinutes);
  const dailyMinutes = allowedMinutes.has(dailyMinutesValue) ? dailyMinutesValue : normalizeDailyMinutes(currentProfile.dailyMinutes);
  const replacingTargets = Array.isArray(payload.targets);
  const rawTargets = replacingTargets
    ? payload.targets.slice(0, 32)
    : [{
      examType: payload.examType,
      province: payload.province,
      examYear: payload.examYear,
      examDate: payload.examDate,
    }];
  const targetMap = new Map<string, ExamTargetProfile>();
  // A cached single-target client may still submit the old flat shape. Merge it
  // into the new collection so an upgrade can never silently erase other targets.
  if (!replacingTargets) currentProfile.targets.forEach((target) => targetMap.set(target.code, target));
  for (const raw of rawTargets) {
    const item = raw as Record<string, unknown>;
    const examType = item.examType === "省考" ? "省考" : "国考";
    const province = examType === "省考" ? normalizeProvince(item.province) : "";
    if (examType === "省考" && !province) continue;
    const examYear = Math.max(currentYear, Math.min(currentYear + 3, Math.floor(Number(item.examYear)) || currentYear + 1));
    const dateValue = trimmed(item.examDate, 10);
    const examDate = /^\d{4}-\d{2}-\d{2}$/.test(dateValue) ? dateValue : null;
    const code = examType === "国考" ? "national" : `province:${province}`;
    targetMap.set(code, { code, label: examType === "国考" ? "国考" : `${province}省考`, examType, province, examYear, examDate });
  }
  const targets = Array.from(targetMap.values());
  if (!targets.length) return json({ error: "请至少选择一个报考目标" }, 400);
  const primary = targets[0];
  const targetProfile: LoadedExamProfile = {
    onboarded: true,
    dailyMinutes,
    targets,
    examType: primary.examType,
    province: primary.province,
    examYear: primary.examYear,
    examDate: primary.examDate,
  };
  await db.batch([
    db.prepare(`INSERT INTO user_exam_profiles (user_id, exam_type, province, exam_year, exam_date, daily_minutes, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id) DO UPDATE SET exam_type = excluded.exam_type, province = excluded.province,
      exam_year = excluded.exam_year, exam_date = excluded.exam_date, daily_minutes = excluded.daily_minutes,
      updated_at = CURRENT_TIMESTAMP`).bind(userId, primary.examType, primary.province, primary.examYear, primary.examDate, dailyMinutes),
    db.prepare("DELETE FROM user_exam_targets WHERE user_id = ?").bind(userId),
    ...targets.map((target) => db.prepare(`INSERT INTO user_exam_targets
      (user_id, target_code, exam_type, province, exam_year, exam_date, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`).bind(userId, target.code, target.examType === "国考" ? "national" : "provincial", target.province, target.examYear, target.examDate)),
  ]);
  return json({ ok: true, profile: targetProfile, selectedBanks: await selectedBankCodes(userId) });
}

async function toggleQuestionBank(userId: string, payload: Record<string, unknown>) {
  const bankCode = trimmed(payload.bankCode, 80);
  const added = payload.added === true;
  if (!/^[a-zA-Z0-9_-]{3,80}$/.test(bankCode)) return json({ error: "题库编号无效" }, 400);
  if (bankCode === STARTER_BANK_CODE) return json({ error: "演示题库已停用，请添加已发布的真题库" }, 410);
  const db = getD1();
  let bank: { id: number; exam_type: string; province: string | null; exam_year: number | null } | null = null;
  if (bankCode !== STARTER_BANK_CODE) {
    bank = await db.prepare("SELECT id, exam_type, province, exam_year FROM question_banks WHERE bank_code = ? AND status = 'published'")
      .bind(bankCode).first<{ id: number; exam_type: string; province: string | null; exam_year: number | null }>() ?? null;
    if (!bank) return json({ error: "题库不存在或尚未发布" }, 404);
  }
  if (added) {
    const statements: D1PreparedStatement[] = [
      db.prepare("INSERT OR IGNORE INTO user_question_banks (user_id, bank_code) VALUES (?, ?)").bind(userId, bankCode),
    ];
    if (bank && (bank.exam_type === "national" || bank.exam_type === "provincial")) {
      const profile = await loadExamProfile(userId);
      const province = bank.exam_type === "provincial" ? normalizeProvince(bank.province) : "";
      const targetCode = bank.exam_type === "national" ? "national" : `province:${province}`;
      const targetExists = profile.targets.some((target) => target.code === targetCode);
      if (!targetExists) {
        const examYear = bank.exam_year ?? new Date().getFullYear() + 1;
        statements.push(...profile.targets.map((target) => db.prepare(`INSERT OR IGNORE INTO user_exam_targets
          (user_id, target_code, exam_type, province, exam_year, exam_date, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`).bind(
            userId,
            target.code,
            target.examType === "国考" ? "national" : "provincial",
            target.province,
            target.examYear,
            target.examDate,
          )));
        statements.push(db.prepare(`INSERT OR IGNORE INTO user_exam_targets
          (user_id, target_code, exam_type, province, exam_year, exam_date, updated_at)
          VALUES (?, ?, ?, ?, ?, NULL, CURRENT_TIMESTAMP)`).bind(userId, targetCode, bank.exam_type, province, examYear));
        if (!profile.onboarded) statements.push(db.prepare(`INSERT INTO user_exam_profiles
          (user_id, exam_type, province, exam_year, exam_date, daily_minutes, updated_at)
          VALUES (?, ?, ?, ?, NULL, 30, CURRENT_TIMESTAMP)
          ON CONFLICT(user_id) DO UPDATE SET updated_at = CURRENT_TIMESTAMP`)
          .bind(userId, bank.exam_type === "national" ? "国考" : "省考", province, examYear));
      }
    }
    await db.batch(statements);
  } else {
    await db.prepare("DELETE FROM user_question_banks WHERE user_id = ? AND bank_code = ?").bind(userId, bankCode).run();
  }
  return json({ ok: true, banks: await loadQuestionBanks(userId), profile: await loadExamProfile(userId) });
}

async function dbQuestionCandidates(userId: string, bankCodes: string[]) {
  if (!bankCodes.length) return [] as Array<{ question: ResolvedQuestion; progress?: QuestionProgressRow }>;
  const placeholders = bankCodes.map(() => "?").join(",");
  const rows = await getD1().prepare(`WITH candidates AS (
      SELECT q.question_code, q.module, q.sub_type, q.stem, q.options_json,
        q.answer, q.explanation, q.technique, q.difficulty, q.source, q.updated_at,
        q.source_region, q.source_year, q.frequency, q.importance_stars, q.score_rate,
        q.suggested_seconds, q.image_url, q.resource_url,
        qb.bank_code, qb.name AS bank_name, qb.exam_type AS bank_exam_type, qb.province AS bank_province,
        uqp.state, uqp.correct_count, uqp.wrong_count, uqp.uncertain_count, uqp.review_stage, uqp.next_review_at,
        uqp.favorite, uqp.wrong_reason, uqp.last_answered_at, qbi.sort_order,
        CASE WHEN datetime(uqp.next_review_at) <= CURRENT_TIMESTAMP THEN 0 WHEN uqp.state = 'weak' THEN 1
          WHEN uqp.question_code IS NULL THEN 2 WHEN uqp.state = 'learning' THEN 3 ELSE 4 END AS priority_rank
      FROM questions q
      JOIN question_bank_items qbi ON qbi.question_id = q.id
      JOIN question_banks qb ON qb.id = qbi.bank_id
      LEFT JOIN user_question_progress uqp ON uqp.question_code = q.question_code AND uqp.user_id = ?
      WHERE q.status = 'active' AND q.subject = '行测' AND qb.status = 'published'
        AND qb.bank_code IN (${placeholders})
    ), ranked AS (
      SELECT *, ROW_NUMBER() OVER (
        PARTITION BY bank_code
        ORDER BY priority_rank,
          CASE WHEN score_rate BETWEEN 40 AND 80 THEN 0 ELSE 1 END,
          CASE frequency WHEN '高频' THEN 0 WHEN '中频' THEN 1 ELSE 2 END,
          importance_stars DESC, COALESCE(last_answered_at, '1970-01-01'), sort_order, question_code
      ) AS bank_rank
      FROM candidates
    )
    SELECT * FROM ranked
    WHERE bank_rank <= 40
    ORDER BY priority_rank, bank_rank, bank_code
    LIMIT 640`).bind(userId, ...bankCodes).all<Record<string, unknown>>();
  return rows.results.map((row) => {
    const progress = row.state ? {
      question_code: String(row.question_code),
      state: String(row.state),
      correct_count: Number(row.correct_count ?? 0),
      wrong_count: Number(row.wrong_count ?? 0),
      uncertain_count: Number(row.uncertain_count ?? 0),
      review_stage: Number(row.review_stage ?? 0),
      next_review_at: row.next_review_at ? String(row.next_review_at) : null,
      favorite: Number(row.favorite ?? 0),
      wrong_reason: String(row.wrong_reason ?? ""),
      last_answered_at: row.last_answered_at ? String(row.last_answered_at) : null,
    } satisfies QuestionProgressRow : undefined;
    return {
      question: {
        id: String(row.question_code),
        module: String(row.module),
        stem: String(row.stem),
        options: parseOptions(String(row.options_json ?? "[]")),
        answer: answerIndex(row.answer ? String(row.answer) : null),
        explanation: String(row.explanation ?? ""),
        knowledge: String(row.sub_type ?? row.module),
        technique: String(row.technique ?? ""),
        source: String(row.source ?? "题库导入"),
        difficulty: String(row.difficulty ?? "中等"),
        bankCode: String(row.bank_code),
        bankName: String(row.bank_name),
        scopeLabel: questionScopeLabel(String(row.bank_exam_type), row.bank_province),
        reviewedAt: row.updated_at ? String(row.updated_at) : null,
        targetCode: String(row.bank_exam_type) === "national"
          ? "national"
          : String(row.bank_exam_type) === "provincial"
            ? `province:${normalizeProvince(row.bank_province)}`
            : null,
        region: String(row.source_region || normalizeProvince(row.bank_province) || "全国"),
        examYear: Number.isInteger(Number(row.source_year)) ? Number(row.source_year) : null,
        frequency: String(row.frequency ?? "中频"),
        importanceStars: Math.max(1, Math.min(5, Number(row.importance_stars ?? 3))),
        scoreRate: Math.max(0, Math.min(100, Number(row.score_rate ?? 60))),
        suggestedSeconds: Math.max(10, Number(row.suggested_seconds ?? 60)),
        imageUrl: String(row.image_url ?? ""),
        resourceUrl: String(row.resource_url ?? ""),
      },
      progress,
    };
  });
}

async function getPracticeBatch(userId: string, payload: Record<string, unknown>) {
  const requested = Array.isArray(payload.bankCodes) ? payload.bankCodes.map(String) : [];
  const selected = await selectedBankCodes(userId);
  const allowed = new Set(selected);
  const primaryBankCode = allowed.has(String(payload.primaryBankCode ?? "")) ? String(payload.primaryBankCode) : "";
  const bankCodes = (requested.length ? requested : selected).filter((code) => allowed.has(code)).slice(0, 32);
  if (primaryBankCode && bankCodes.includes(primaryBankCode)) {
    bankCodes.splice(bankCodes.indexOf(primaryBankCode), 1);
    bankCodes.unshift(primaryBankCode);
  }
  const mode = payload.mode === "review" ? "review" : "mixed";
  const focusModule = trimmed(payload.focusModule, 40);
  const focusSubTypes = Array.isArray(payload.focusSubTypes)
    ? payload.focusSubTypes.map((value) => trimmed(value, 40)).filter(Boolean).slice(0, 12)
    : [];
  const strictFocus = payload.strictFocus === true;
  const requestedFrequency = new Set(["高频", "中频", "低频"]).has(String(payload.frequency)) ? String(payload.frequency) : "";
  const minImportanceStars = Math.max(0, Math.min(5, Math.floor(Number(payload.importanceStars)) || 0));
  const rawScoreRateMin = Math.max(0, Math.min(100, Number(payload.scoreRateMin) || 0));
  const rawScoreRateMax = Math.max(0, Math.min(100, Number(payload.scoreRateMax) || 100));
  const scoreRateMin = Math.min(rawScoreRateMin, rawScoreRateMax);
  const scoreRateMax = Math.max(rawScoreRateMin, rawScoreRateMax);
  const user = await getD1().prepare("SELECT membership_end FROM users WHERE id = ?").bind(userId).first<{ membership_end: string | null }>();
  const active = Boolean(user?.membership_end && Date.parse(user.membership_end) > Date.now());
  const requestedLimit = Math.max(1, Math.min(active ? 20 : 5, Math.floor(Number(payload.limit)) || 10));
  const resumeQuestionCodes = Array.isArray(payload.resumeQuestionCodes)
    ? Array.from(new Set(payload.resumeQuestionCodes.map(String).filter((code) => /^[a-zA-Z0-9_-]{2,80}$/.test(code)))).slice(0, 20)
    : [];
  const starter = starterQuestionList();
  const starterRows = bankCodes.includes(STARTER_BANK_CODE)
    ? await getD1().prepare(`SELECT question_code, state, correct_count, wrong_count, uncertain_count, review_stage,
      next_review_at, favorite, wrong_reason, last_answered_at FROM user_question_progress
      WHERE user_id = ? AND question_code IN (${starter.map(() => "?").join(",")})`)
      .bind(userId, ...starter.map((question) => question.id)).all<QuestionProgressRow>()
    : { results: [] as QuestionProgressRow[] };
  const starterMap = new Map(starterRows.results.map((row) => [row.question_code, row]));
  const candidates: Array<{ question: ResolvedQuestion; progress?: QuestionProgressRow }> = bankCodes.includes(STARTER_BANK_CODE)
    ? starter.map((question) => ({ question, progress: starterMap.get(question.id) }))
    : [];
  candidates.push(...await dbQuestionCandidates(userId, bankCodes.filter((code) => code !== STARTER_BANK_CODE)));
  const [profile, strategy] = await Promise.all([loadExamProfile(userId), loadStrategyConfig()]);
  const sweetSpot: [number, number] = [Number(strategy.scoreRateSweetSpot[0]), Number(strategy.scoreRateSweetSpot[1])];
  const valueWeights = {
    frequency: Math.max(0, Math.min(100, Number(strategy.frequencyWeight ?? 25))),
    importance: Math.max(0, Math.min(100, Number(strategy.importanceWeight ?? 25))),
    scoreRate: Math.max(0, Math.min(100, Number(strategy.scoreRateWeight ?? 20))),
  };
  const bankOrder = new Map(bankCodes.map((code, index) => [code, index]));
  const allSorted = [...candidates].sort((a, b) => priorityFor(a.progress) - priorityFor(b.progress)
    || Number(bankOrder.get(a.question.bankCode) ?? 99) - Number(bankOrder.get(b.question.bankCode) ?? 99)
    || questionValueRank(a.question, sweetSpot, valueWeights) - questionValueRank(b.question, sweetSpot, valueWeights)
    || (a.progress?.last_answered_at ?? "").localeCompare(b.progress?.last_answered_at ?? ""));

  const fingerprintBanks = new Map<string, Set<string>>();
  for (const item of allSorted) {
    const fingerprint = questionFingerprint(item.question);
    const banks = fingerprintBanks.get(fingerprint) ?? new Set<string>();
    banks.add(item.question.bankCode);
    fingerprintBanks.set(fingerprint, banks);
  }
  const contentMap = new Map<string, QuestionCandidate>();
  for (const item of allSorted) {
    const fingerprint = questionFingerprint(item.question);
    if (!contentMap.has(fingerprint)) contentMap.set(fingerprint, item);
  }
  const sorted = Array.from(contentMap.entries()).map(([fingerprint, item]) => ({
    ...item,
    question: {
      ...item.question,
      scopeLabel: (fingerprintBanks.get(fingerprint)?.size ?? 0) > 1 ? "跨库共通题" : item.question.scopeLabel,
    },
  }));

  const urgentTargets = new Set(profile.targets.filter((target) => {
    if (!target.examDate) return false;
    const days = Math.ceil((Date.parse(`${target.examDate}T23:59:59+08:00`) - Date.now()) / 86_400_000);
    return Number.isFinite(days) && days >= 0 && days <= strategy.urgentDays;
  }).map((target) => target.code));
  const targetByBank = new Map(candidates.map((item) => [item.question.bankCode, item.question.targetCode]));
  const urgentBankCodes = new Set(bankCodes.filter((code) => {
    const targetCode = targetByBank.get(code);
    return Boolean(targetCode && urgentTargets.has(targetCode));
  }));
  const otherBankCodes = bankCodes.filter((code) => code !== primaryBankCode);
  const regionWeight = Math.max(0, Math.min(100, Number(strategy.regionWeight ?? 30)));
  const primaryRepeats = primaryBankCode ? Math.max(1, Math.min(3, 1 + Math.round(regionWeight / 50))) : 0;
  const bankCycle = primaryBankCode ? [...Array(primaryRepeats).fill(primaryBankCode), ...otherBankCodes] : [...bankCodes];
  for (const code of otherBankCodes) if (urgentBankCodes.has(code)) bankCycle.push(code);

  let chosen: typeof sorted;
  if (resumeQuestionCodes.length) {
    const candidateMap = new Map(allSorted.map((item) => [item.question.id, item]));
    chosen = resumeQuestionCodes.map((code) => candidateMap.get(code)).filter((item): item is (typeof sorted)[number] => Boolean(item));
  } else if (mode === "review") {
    chosen = [];
    const due = sorted.filter((item) => Boolean(item.progress?.next_review_at && Date.parse(item.progress.next_review_at) <= Date.now()));
    takeBalanced(due, requestedLimit, chosen, bankCycle);
  } else if (strictFocus && focusModule) {
    const frequencyRank: Record<string, number> = { 低频: 1, 中频: 2, 高频: 3 };
    const minimumFrequencyRank = requestedFrequency ? frequencyRank[requestedFrequency] : 0;
    const focusPool = sorted.filter((item) => {
      const moduleMatches = item.question.module.includes(focusModule)
        || item.question.knowledge.includes(focusModule)
        || focusSubTypes.some((subType) => item.question.module.includes(subType) || item.question.knowledge.includes(subType));
      return moduleMatches
        && (frequencyRank[item.question.frequency] ?? 0) >= minimumFrequencyRank
        && item.question.importanceStars >= minImportanceStars
        && item.question.scoreRate >= scoreRateMin
        && item.question.scoreRate <= scoreRateMax;
    });
    chosen = [];
    takeBalanced(focusPool, requestedLimit, chosen, bankCycle);
  } else {
    const due = sorted.filter((item) => Boolean(item.progress?.next_review_at && Date.parse(item.progress.next_review_at) <= Date.now()));
    const fresh = sorted.filter((item) => !item.progress);
    const focusFresh = focusModule ? fresh.filter((item) => item.question.module.includes(focusModule) || item.question.knowledge.includes(focusModule)) : fresh;
    const selectedItems: typeof sorted = [];
    takeBalanced(due, Math.ceil(requestedLimit * strategy.dueShare), selectedItems, bankCycle);
    takeBalanced(focusFresh, requestedLimit - selectedItems.length, selectedItems, bankCycle);
    takeBalanced(fresh, requestedLimit - selectedItems.length, selectedItems, bankCycle);
    takeBalanced(due, requestedLimit - selectedItems.length, selectedItems, bankCycle);
    chosen = selectedItems;
  }
  const questions = chosen.slice(0, requestedLimit).map((item) => {
    const question = publicQuestion(item.question, item.progress);
    const planReason = question.due
      ? item.progress?.state === "weak" ? "错题到期" : "记忆到期"
      : item.question.bankCode === primaryBankCode
        ? "主攻考试"
        : urgentBankCodes.has(item.question.bankCode)
          ? "临近考试"
          : "兼顾题库";
    return { ...question, planReason };
  });
  const byBank = Array.from(questions.reduce((map, question) => {
    const current = map.get(question.bankCode) ?? { bankCode: question.bankCode, bankName: question.bankName, count: 0 };
    current.count += 1;
    map.set(question.bankCode, current);
    return map;
  }, new Map<string, { bankCode: string; bankName: string; count: number }>()).values());
  return json({
    questions,
    mode,
    limit: requestedLimit,
    access: active ? "premium" : "preview",
    composition: {
      due: questions.filter((item) => item.due).length,
      weak: questions.filter((item) => item.state === "weak").length,
      new: questions.filter((item) => item.state === "new").length,
      primary: questions.filter((item) => item.bankCode === primaryBankCode).length,
      other: questions.filter((item) => item.bankCode !== primaryBankCode).length,
      byBank,
    },
  });
}

async function getEssayPracticeBatch(userId: string, payload: Record<string, unknown>) {
  const requested = Array.isArray(payload.bankCodes) ? payload.bankCodes.map(String) : [];
  const selected = (await selectedBankCodes(userId)).filter((code) => code !== STARTER_BANK_CODE);
  const allowed = new Set(selected);
  const bankCodes = (requested.length ? requested : selected).filter((code) => allowed.has(code)).slice(0, 32);
  if (!bankCodes.length) return json({ questions: [], mode: "essay", limit: 0, access: "preview" });
  const user = await getD1().prepare("SELECT membership_end FROM users WHERE id = ?").bind(userId).first<{ membership_end: string | null }>();
  const active = Boolean(user?.membership_end && Date.parse(user.membership_end) > Date.now());
  const limit = Math.max(1, Math.min(active ? 10 : 2, Math.floor(Number(payload.limit)) || 3));
  const placeholders = bankCodes.map(() => "?").join(",");
  const focusModule = trimmed(payload.focusModule, 40);
  const moduleClause = focusModule ? "AND (q.module LIKE ? OR q.sub_type LIKE ?)" : "";
  const bindings: unknown[] = [...bankCodes];
  if (focusModule) bindings.push(`%${focusModule}%`, `%${focusModule}%`);
  const rows = await getD1().prepare(`SELECT q.question_code, q.module, q.sub_type, q.stem, q.material, q.prompt,
    q.word_limit, q.scoring_points_json, q.explanation, q.technique, q.source, q.source_region, q.source_year,
    q.frequency, q.importance_stars, q.score_rate, q.suggested_seconds, q.image_url, q.resource_url,
    qb.bank_code, qb.name AS bank_name, qb.exam_type, qb.province
    FROM questions q
    JOIN question_bank_items qbi ON qbi.question_id = q.id
    JOIN question_banks qb ON qb.id = qbi.bank_id
    WHERE q.status = 'active' AND q.subject = '申论' AND qb.status = 'published'
      AND qb.bank_code IN (${placeholders}) ${moduleClause}
    GROUP BY q.question_code
    ORDER BY CASE WHEN q.score_rate BETWEEN 40 AND 80 THEN 0 ELSE 1 END,
      CASE q.frequency WHEN '高频' THEN 0 WHEN '中频' THEN 1 ELSE 2 END,
      q.importance_stars DESC, q.source_year DESC, q.question_code
    LIMIT ?`).bind(...bindings, limit).all<Record<string, unknown>>();
  const questions = rows.results.map((row) => {
    const region = String(row.source_region || normalizeProvince(row.province) || "全国");
    const examYear = Number.isInteger(Number(row.source_year)) ? Number(row.source_year) : null;
    let scoringPoints: string[] = [];
    try {
      const parsed = JSON.parse(String(row.scoring_points_json ?? "[]"));
      if (Array.isArray(parsed)) scoringPoints = parsed.map(String);
    } catch {
      scoringPoints = [];
    }
    return {
      id: String(row.question_code),
      subject: "申论",
      module: String(row.module),
      subType: String(row.sub_type ?? ""),
      stem: String(row.stem),
      material: String(row.material ?? ""),
      prompt: String(row.prompt ?? ""),
      wordLimit: Number(row.word_limit ?? 0) || null,
      scoringPoints,
      reference: active ? String(row.explanation ?? "") : "会员可查看参考答案与得分点。",
      technique: active ? String(row.technique ?? "") : "",
      source: String(row.source ?? ""),
      region,
      examYear,
      truthLabel: examYear ? `${region}-${examYear}` : region,
      frequency: String(row.frequency ?? "中频"),
      importanceStars: Number(row.importance_stars ?? 3),
      scoreRate: Number(row.score_rate ?? 60),
      suggestedSeconds: Number(row.suggested_seconds ?? 600),
      imageUrl: String(row.image_url ?? ""),
      resourceUrl: String(row.resource_url ?? ""),
      bankCode: String(row.bank_code),
      bankName: String(row.bank_name),
      scopeLabel: questionScopeLabel(String(row.exam_type), row.province),
    };
  });
  return json({ questions, mode: "essay", limit, access: active ? "premium" : "preview" });
}

async function resolveQuestion(questionCode: string, bankCode: string) {
  const starter = starterQuestionList().find((question) => question.id === questionCode && bankCode === STARTER_BANK_CODE);
  if (starter) return starter;
  const row = await getD1().prepare(`SELECT q.question_code, q.module, q.sub_type, q.stem, q.options_json, q.answer,
    q.explanation, q.technique, q.difficulty, q.source, q.updated_at, q.source_region, q.source_year,
    q.frequency, q.importance_stars, q.score_rate, q.suggested_seconds, q.image_url, q.resource_url,
    qb.bank_code, qb.name AS bank_name,
    qb.exam_type AS bank_exam_type, qb.province AS bank_province
    FROM questions q JOIN question_bank_items qbi ON qbi.question_id = q.id
    JOIN question_banks qb ON qb.id = qbi.bank_id
    WHERE q.question_code = ? AND qb.bank_code = ? AND q.status = 'active' AND qb.status = 'published' LIMIT 1`)
    .bind(questionCode, bankCode).first<Record<string, unknown>>();
  if (!row) return null;
  return {
    id: String(row.question_code), module: String(row.module), stem: String(row.stem), options: parseOptions(String(row.options_json ?? "[]")),
    answer: answerIndex(row.answer ? String(row.answer) : null), explanation: String(row.explanation ?? ""),
    knowledge: String(row.sub_type ?? row.module), technique: String(row.technique ?? ""), source: String(row.source ?? "题库导入"),
    difficulty: String(row.difficulty ?? "中等"), bankCode: String(row.bank_code), bankName: String(row.bank_name),
    scopeLabel: questionScopeLabel(String(row.bank_exam_type), row.bank_province),
    reviewedAt: row.updated_at ? String(row.updated_at) : null,
    targetCode: String(row.bank_exam_type) === "national"
      ? "national"
      : String(row.bank_exam_type) === "provincial"
        ? `province:${normalizeProvince(row.bank_province)}`
        : null,
    region: String(row.source_region || normalizeProvince(row.bank_province) || "全国"),
    examYear: Number.isInteger(Number(row.source_year)) ? Number(row.source_year) : null,
    frequency: String(row.frequency ?? "中频"),
    importanceStars: Math.max(1, Math.min(5, Number(row.importance_stars ?? 3))),
    scoreRate: Math.max(0, Math.min(100, Number(row.score_rate ?? 60))),
    suggestedSeconds: Math.max(10, Number(row.suggested_seconds ?? 60)),
    imageUrl: String(row.image_url ?? ""),
    resourceUrl: String(row.resource_url ?? ""),
  } satisfies ResolvedQuestion;
}

async function submitPracticeAnswer(userId: string, payload: Record<string, unknown>) {
  const questionCode = trimmed(payload.questionCode, 80);
  const bankCode = trimmed(payload.bankCode, 80);
  const selectedAnswer = Math.floor(Number(payload.selectedAnswer));
  const uncertain = payload.uncertain === true;
  const durationMs = Math.max(0, Math.min(30 * 60_000, Math.floor(Number(payload.durationMs)) || 0));
  const question = await resolveQuestion(questionCode, bankCode);
  if (!question || selectedAnswer < 0 || selectedAnswer >= question.options.length || question.answer < 0) return json({ error: "题目或答案无效" }, 400);
  const db = getD1();
  const previous = await db.prepare(`SELECT state, correct_count, wrong_count, uncertain_count, review_count, review_stage,
    next_review_at, last_answered_at
    FROM user_question_progress WHERE user_id = ? AND question_code = ?`).bind(userId, questionCode)
    .first<{ state: string; correct_count: number; wrong_count: number; uncertain_count: number; review_count: number;
      review_stage: number; next_review_at: string | null; last_answered_at: string | null }>();
  const correct = selectedAnswer === question.answer;
  const strategy = await loadStrategyConfig();
  const targetSeconds = question.suggestedSeconds || targetSecondsFor(question);
  const overtime = durationMs > targetSeconds * 1000;
  const needsReview = !correct || uncertain || overtime;
  const isDue = Boolean(previous?.next_review_at && Date.parse(previous.next_review_at) <= Date.now());
  const correctCount = Number(previous?.correct_count ?? 0) + (correct ? 1 : 0);
  const wrongCount = Number(previous?.wrong_count ?? 0) + (correct ? 0 : 1);
  const uncertainCount = Number(previous?.uncertain_count ?? 0) + (uncertain ? 1 : 0);
  const finalStage = Math.max(0, strategy.reviewIntervals.length - 1);
  const previousStage = Math.max(0, Math.min(finalStage, Number(previous?.review_stage ?? 0)));
  const reviewStage = needsReview
    ? 0
    : previous
      ? isDue ? Math.min(finalStage, previousStage + 1) : Math.max(Math.min(1, finalStage), previousStage)
      : Math.min(1, finalStage);
  const reviewDays = strategy.reviewIntervals[reviewStage] ?? 1;
  const state = needsReview ? "weak" : reviewStage >= 2 ? "mastered" : "learning";
  const nextReviewAt = reviewAtAfterChinaDays(reviewDays);
  const results = await db.batch([
    db.prepare(`INSERT INTO user_question_progress
      (user_id, question_code, state, correct_count, wrong_count, uncertain_count, last_answer, last_correct,
       last_duration_ms, last_answered_at, next_review_at, review_count, review_stage, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, question_code) DO UPDATE SET state = excluded.state, correct_count = excluded.correct_count,
      wrong_count = excluded.wrong_count, uncertain_count = excluded.uncertain_count, last_answer = excluded.last_answer,
      last_correct = excluded.last_correct, last_duration_ms = excluded.last_duration_ms,
      last_answered_at = CURRENT_TIMESTAMP, next_review_at = excluded.next_review_at,
      review_count = excluded.review_count, review_stage = excluded.review_stage, updated_at = CURRENT_TIMESTAMP`)
      .bind(userId, questionCode, state, correctCount, wrongCount, uncertainCount, selectedAnswer, correct ? 1 : 0,
        durationMs, nextReviewAt, Number(previous?.review_count ?? 0) + (isDue ? 1 : 0), reviewStage),
    db.prepare(`INSERT INTO practice_attempts
      (user_id, question_code, bank_code, module, is_correct, uncertain, confidence, wrong_reason, overtime, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?)`).bind(userId, questionCode, bankCode, question.module,
        correct ? 1 : 0, uncertain ? 1 : 0, uncertain ? "hesitant" : "confident", overtime ? 1 : 0, durationMs),
  ]);
  return json({
    ok: true,
    correct,
    correctAnswer: question.answer,
    explanation: question.explanation,
    technique: question.technique,
    state,
    nextReviewAt,
    reviewDays,
    reviewStage,
    needsReview,
    attemptId: Number(results[1]?.meta?.last_row_id ?? 0),
    overtime,
    targetSeconds,
  });
}

async function updateQuestionMeta(userId: string, payload: Record<string, unknown>) {
  const questionCode = trimmed(payload.questionCode, 80);
  if (!questionCode) return json({ error: "题目编号不能为空" }, 400);
  const db = getD1();
  const attemptId = Math.max(0, Math.floor(Number(payload.attemptId)) || 0);
  await db.prepare(`INSERT OR IGNORE INTO user_question_progress (user_id, question_code, state)
    VALUES (?, ?, 'learning')`).bind(userId, questionCode).run();
  if (typeof payload.favorite === "boolean") {
    await db.prepare("UPDATE user_question_progress SET favorite = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND question_code = ?")
      .bind(payload.favorite ? 1 : 0, userId, questionCode).run();
  }
  if (typeof payload.wrongReason === "string") {
    const reason = allowedWrongReasons.has(payload.wrongReason) ? payload.wrongReason : "";
    await db.prepare("UPDATE user_question_progress SET wrong_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND question_code = ?")
      .bind(reason, userId, questionCode).run();
    if (attemptId) await db.prepare(`UPDATE practice_attempts SET wrong_reason = ?
      WHERE id = ? AND user_id = ? AND question_code = ?`).bind(reason, attemptId, userId, questionCode).run();
  }
  let nextReviewAt: string | null = null;
  let state: string | null = null;
  if (typeof payload.confidence === "string") {
    const confidence = allowedConfidence.has(payload.confidence) ? payload.confidence : "";
    if (!confidence) return json({ error: "掌握状态无效" }, 400);
    const attempt = attemptId
      ? await db.prepare(`SELECT uncertain FROM practice_attempts
        WHERE id = ? AND user_id = ? AND question_code = ?`).bind(attemptId, userId, questionCode).first<{ uncertain: number }>()
      : null;
    if (attemptId) await db.prepare(`UPDATE practice_attempts SET confidence = ?, uncertain = ?
      WHERE id = ? AND user_id = ? AND question_code = ?`)
      .bind(confidence, confidence === "confident" ? Number(attempt?.uncertain ?? 0) : 1, attemptId, userId, questionCode).run();
    if (confidence !== "confident") {
      nextReviewAt = reviewAtAfterChinaDays(1);
      const increment = attempt && !attempt.uncertain ? 1 : 0;
      await db.prepare(`UPDATE user_question_progress SET state = 'weak', review_stage = 0,
        uncertain_count = uncertain_count + ?, next_review_at = ?,
        wrong_reason = CASE WHEN ? = 'guessed' THEN '蒙对了' ELSE wrong_reason END,
        updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND question_code = ?`)
        .bind(increment, nextReviewAt, confidence, userId, questionCode).run();
      state = "weak";
    }
  }
  const current = await db.prepare(`SELECT state, next_review_at FROM user_question_progress
    WHERE user_id = ? AND question_code = ?`).bind(userId, questionCode).first<{ state: string; next_review_at: string | null }>();
  return json({ ok: true, state: state ?? current?.state ?? "learning", nextReviewAt: nextReviewAt ?? current?.next_review_at ?? null });
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
  const awarded = await db.prepare(`SELECT COALESCE(SUM(delta_days), 0) AS total FROM membership_ledger
    WHERE user_id = ? AND source_type = 'invite_reward' AND created_at >= ?`)
    .bind(relation.inviter_id, monthStart.toISOString()).first<{ total: number }>();
  const inviterDays = Math.max(0, Math.min(rewardDays, monthlyCap - Number(awarded?.total ?? 0)));
  const claimed = await db.prepare("UPDATE invite_relations SET status = 'rewarded', rewarded_at = CURRENT_TIMESTAMP WHERE invitee_id = ? AND status = 'pending'").bind(inviteeId).run();
  if (!claimed.meta.changes) return;
  try {
    const [invitee, inviter] = await Promise.all([
      db.prepare("SELECT membership_end FROM users WHERE id = ?").bind(inviteeId).first<{ membership_end: string | null }>(),
      db.prepare("SELECT membership_end FROM users WHERE id = ?").bind(relation.inviter_id).first<{ membership_end: string | null }>(),
    ]);
    const source = `invite:${inviteeId}`;
    const statements = [
      db.prepare("UPDATE users SET membership_end = ? WHERE id = ?").bind(addDays(invitee?.membership_end ?? null, rewardDays), inviteeId),
      db.prepare(`INSERT OR IGNORE INTO membership_ledger
        (user_id, delta_days, source_type, source_id, note) VALUES (?, ?, 'invitee_reward', ?, '受邀激活奖励')`).bind(inviteeId, rewardDays, source),
    ];
    if (inviterDays > 0) statements.push(
      db.prepare("UPDATE users SET membership_end = ? WHERE id = ?").bind(addDays(inviter?.membership_end ?? null, inviterDays), relation.inviter_id),
      db.prepare(`INSERT OR IGNORE INTO membership_ledger
        (user_id, delta_days, source_type, source_id, note) VALUES (?, ?, 'invite_reward', ?, '邀请好友激活奖励')`).bind(relation.inviter_id, inviterDays, source),
    );
    await db.batch(statements);
  } catch (error) {
    await db.prepare("UPDATE invite_relations SET status = 'pending', rewarded_at = NULL WHERE invitee_id = ?").bind(inviteeId).run();
    throw error;
  }
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
  const used = await db.prepare("SELECT id FROM redemptions WHERE code_id = ? AND user_id = ?").bind(row.id, userId).first();
  if (used) return json({ error: "你已经使用过这个兑换码" }, 400);

  const claim = await db.prepare(`UPDATE redemption_codes SET used_count = used_count + 1
    WHERE id = ? AND status = 'active' AND used_count < max_uses`).bind(row.id).run();
  if (!claim.meta.changes) return json({ error: "兑换码使用次数已达上限" }, 409);

  try {
    const user = await db.prepare("SELECT membership_end FROM users WHERE id = ?").bind(userId).first<{ membership_end: string | null }>();
    const newEnd = addDays(user?.membership_end ?? null, row.duration_days);
    const sourceId = `redeem:${row.id}:${userId}`;
    await db.batch([
      db.prepare("INSERT INTO redemptions (code_id, user_id) VALUES (?, ?)").bind(row.id, userId),
      db.prepare("UPDATE users SET membership_end = ? WHERE id = ?").bind(newEnd, userId),
      db.prepare(`INSERT INTO membership_ledger
        (user_id, delta_days, source_type, source_id, note) VALUES (?, ?, 'redeem', ?, ?)`).bind(userId, row.duration_days, sourceId, `兑换 ${row.duration_days} 天会员`),
    ]);
    await rewardInvite(userId);
    return json({ ok: true, days: row.duration_days, membershipEnd: newEnd });
  } catch {
    await db.prepare("UPDATE redemption_codes SET used_count = MAX(0, used_count - 1) WHERE id = ?").bind(row.id).run();
    return json({ error: "兑换失败，请勿重复提交" }, 409);
  }
}

async function trackEvent(userId: string, payload: Record<string, unknown>) {
  const eventName = String(payload.eventName ?? "");
  if (!EVENT_NAMES.has(eventName)) return json({ error: "未知统计事件" }, 400);
  const eventData = JSON.stringify(payload.eventData ?? {});
  if (eventData.length > 2_000) return json({ error: "事件数据过大" }, 400);
  await getD1().prepare("INSERT INTO analytics_events (user_id, event_name, event_data) VALUES (?, ?, ?)").bind(userId, eventName, eventData).run();
  return json({ ok: true }, 201);
}

function getAdminSecret() {
  return (env as unknown as { ADMIN_TOKEN?: string }).ADMIN_TOKEN ?? process.env.ADMIN_TOKEN ?? "";
}

const ADMIN_CONTEXT = Symbol("admin-context");
type AuthorizedAdminPayload = Record<string, unknown> & { [ADMIN_CONTEXT]?: AdminIdentity };

function setAdminContext(payload: Record<string, unknown>, admin: AdminIdentity) {
  Object.defineProperty(payload, ADMIN_CONTEXT, { value: admin, configurable: false, enumerable: false });
}

function adminFromPayload(payload: Record<string, unknown>) {
  return (payload as AuthorizedAdminPayload)[ADMIN_CONTEXT] ?? null;
}

function isAdmin(payload: Record<string, unknown>) {
  return Boolean(adminFromPayload(payload));
}

function canAdmin(payload: Record<string, unknown>, permission: AdminPermission) {
  const admin = adminFromPayload(payload);
  return Boolean(admin && hasAdminPermission(admin, permission));
}

function adminUnauthorized() {
  return json({ authenticated: false, error: "管理员登录已失效，请重新登录" }, 401, expiredAdminCookie());
}

function adminForbidden(permission: AdminPermission) {
  return json({ error: "当前管理员没有执行此操作的权限", requiredPermission: permission }, 403);
}

function getMediaBucket() {
  return (env as unknown as { MEDIA?: R2Bucket }).MEDIA ?? null;
}

async function digestBytes(value: ArrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", value);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function adminUploadMedia(request: Request, admin: AdminIdentity) {
  const form = await request.formData();
  if (!hasAdminPermission(admin, "media.upload")) return adminForbidden("media.upload");
  const value = form.get("file");
  if (!(value instanceof File)) return json({ error: "请选择要上传的文件" }, 400);
  const allowed = /^(audio\/|image\/)|^application\/(pdf|octet-stream)$/i.test(value.type);
  if (!allowed) return json({ error: "仅支持音频、图片或PDF文件" }, 400);
  if (value.size < 1 || value.size > 25 * 1024 * 1024) return json({ error: "文件大小需在1B—25MB之间" }, 400);
  const bytes = await value.arrayBuffer();
  const id = crypto.randomUUID();
  const safeName = value.name.normalize("NFKC").replace(/[^\p{L}\p{N}._-]+/gu, "-").slice(-120) || "asset";
  const objectKey = `${chinaDateKey().replaceAll("-", "/")}/${id}-${safeName}`;
  const checksum = await digestBytes(bytes);
  const bucket = getMediaBucket();
  let storage = "r2";
  let fallbackData: string | null = null;
  if (bucket) {
    await bucket.put(objectKey, bytes, { httpMetadata: { contentType: value.type || "application/octet-stream" } });
  } else {
    if (value.size > 2 * 1024 * 1024) {
      return json({ error: "本地预览未绑定媒体存储，仅允许2MB以内文件；发布环境会自动使用R2存储。" }, 503);
    }
    storage = "d1-fallback";
    fallbackData = bytesToBase64(new Uint8Array(bytes));
  }
  await getD1().prepare(`INSERT INTO media_assets
    (id, object_key, file_name, content_type, byte_size, checksum, storage, fallback_data, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`)
    .bind(id, objectKey, value.name.slice(0, 180), value.type || "application/octet-stream", value.size,
      checksum, storage, fallbackData).run();
  return json({
    ok: true,
    asset: { id, fileName: value.name, contentType: value.type, byteSize: value.size, storage, url: `/api/app?media=${id}` },
  }, 201);
}

function requestedByteRange(header: string | null, size: number) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match) return { invalid: true as const };
  let start = match[1] ? Number(match[1]) : NaN;
  let end = match[2] ? Number(match[2]) : NaN;
  if (!Number.isFinite(start) && Number.isFinite(end)) {
    const suffixLength = Math.min(size, Math.max(0, end));
    start = size - suffixLength;
    end = size - 1;
  } else {
    if (!Number.isFinite(start)) start = 0;
    if (!Number.isFinite(end)) end = size - 1;
  }
  start = Math.max(0, Math.floor(start));
  end = Math.min(size - 1, Math.floor(end));
  if (start > end || start >= size) return { invalid: true as const };
  return { invalid: false as const, start, end, length: end - start + 1 };
}

async function serveMedia(assetId: string, request: Request) {
  if (!/^[0-9a-f-]{36}$/i.test(assetId)) return json({ error: "媒体不存在" }, 404);
  const row = await getD1().prepare(`SELECT object_key, file_name, content_type, byte_size, storage, fallback_data
    FROM media_assets WHERE id = ? AND status = 'active'`).bind(assetId).first<{
      object_key: string; file_name: string; content_type: string; byte_size: number; storage: string; fallback_data: string | null;
    }>();
  if (!row) return json({ error: "媒体不存在" }, 404);
  const headers = new Headers({
    "content-type": row.content_type,
    "cache-control": "public, max-age=31536000, immutable",
    "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(row.file_name)}`,
    "accept-ranges": "bytes",
  });
  const range = requestedByteRange(request.headers.get("range"), row.byte_size);
  if (range?.invalid) {
    headers.set("content-range", `bytes */${row.byte_size}`);
    return new Response(null, { status: 416, headers });
  }
  const status = range ? 206 : 200;
  headers.set("content-length", String(range?.length ?? row.byte_size));
  if (range) headers.set("content-range", `bytes ${range.start}-${range.end}/${row.byte_size}`);
  if (row.storage === "r2") {
    const bucket = getMediaBucket();
    if (!bucket) return json({ error: "媒体存储暂不可用" }, 503);
    const object = await bucket.get(row.object_key, range ? { range: { offset: range.start, length: range.length } } : undefined);
    if (!object) return json({ error: "媒体文件已丢失" }, 404);
    object.writeHttpMetadata(headers);
    return new Response(object.body, { status, headers });
  }
  if (!row.fallback_data) return json({ error: "媒体文件已丢失" }, 404);
  const bytes = base64ToBytes(row.fallback_data);
  const body = range ? bytes.slice(range.start, range.end + 1) : bytes;
  return new Response(body, { status, headers });
}

async function adminList(payload: Record<string, unknown>) {
  if (!isAdmin(payload)) return json({ error: "管理员口令错误" }, 401);
  const db = getD1();
  const [codes, redemptions, content, mediaAssets, questionBanks, questionImports, eventCounts, activeUsers, rewardDays, monthlyCap] = await Promise.all([
    db.prepare(`SELECT id, code_preview, batch_name, duration_days, max_uses, used_count, status, valid_until, created_at
      FROM redemption_codes ORDER BY id DESC LIMIT 100`).all(),
    db.prepare(`SELECT r.redeemed_at, r.user_id, c.code_preview, c.duration_days
      FROM redemptions r JOIN redemption_codes c ON c.id = r.code_id ORDER BY r.id DESC LIMIT 100`).all(),
    db.prepare(`SELECT ci.id, ci.content_type, ci.content_key, ci.title, ci.payload_json, ci.status,
      ci.publish_at, ci.version, ci.updated_at,
      (SELECT COUNT(*) FROM content_item_versions civ WHERE civ.content_id = ci.id) AS version_count
      FROM content_items ci ORDER BY ci.id DESC LIMIT 500`).all(),
    db.prepare(`SELECT id, file_name, content_type, byte_size, storage, status, created_at,
      '/api/app?media=' || id AS url FROM media_assets ORDER BY created_at DESC LIMIT 200`).all(),
    db.prepare(`SELECT b.id, b.bank_code, b.name, b.exam_type, b.province, b.exam_year, b.subject,
      b.description, b.cover_color, b.status, b.updated_at, COUNT(i.id) AS question_count
      FROM question_banks b LEFT JOIN question_bank_items i ON i.bank_id = b.id
      GROUP BY b.id ORDER BY b.id DESC LIMIT 200`).all(),
    db.prepare(`SELECT qi.id, qi.bank_id, qb.name AS bank_name, qi.file_name, qi.total_rows,
      qi.imported_rows, qi.failed_rows, qi.status, qi.error_summary, qi.created_at, qi.completed_at
      FROM question_imports qi JOIN question_banks qb ON qb.id = qi.bank_id
      ORDER BY qi.id DESC LIMIT 50`).all(),
    db.prepare(`SELECT event_name, COUNT(*) AS count FROM analytics_events
      WHERE created_at >= datetime('now', '-7 days') GROUP BY event_name ORDER BY count DESC`).all(),
    db.prepare(`SELECT COUNT(DISTINCT user_id) AS count FROM analytics_events
      WHERE created_at >= datetime('now', '-7 days')`).first<{ count: number }>(),
    getConfigNumber("invite_reward_days", 3),
    getConfigNumber("invite_monthly_cap", 30),
  ]);
  return json({
    codes: codes.results,
    redemptions: redemptions.results,
    content: content.results.map((item) => {
      let parsed: unknown = {};
      try { parsed = JSON.parse(String((item as Record<string, unknown>).payload_json ?? "{}")); } catch { parsed = {}; }
      return { ...item, payload: parsed };
    }),
    mediaAssets: mediaAssets.results,
    questionBanks: questionBanks.results,
    questionImports: questionImports.results,
    analytics: { activeUsers: Number(activeUsers?.count ?? 0), eventCounts: eventCounts.results },
    config: { rewardDays, monthlyCap },
  });
}

async function adminCreateCodes(payload: Record<string, unknown>) {
  if (!isAdmin(payload)) return json({ error: "管理员口令错误" }, 401);
  const durationDays = Math.floor(Number(payload.durationDays));
  const count = Math.floor(Number(payload.count));
  const maxUses = Math.max(1, Math.floor(Number(payload.maxUses ?? 1)));
  const batchName = String(payload.batchName ?? "新建批次").trim().slice(0, 40) || "新建批次";
  let validUntil: string | null = null;
  if (payload.validUntil) {
    const value = Date.parse(String(payload.validUntil));
    if (!Number.isFinite(value)) return json({ error: "兑换截止日期无效" }, 400);
    validUntil = new Date(value).toISOString();
  }
  if (!Number.isFinite(durationDays) || durationDays < 1 || durationDays > 3650) return json({ error: "会员天数需在 1—3650 天之间" }, 400);
  if (!Number.isFinite(count) || count < 1 || count > 200) return json({ error: "每批生成数量需在 1—200 个之间" }, 400);
  const db = getD1();
  const plainCodes: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const code = randomCode();
    plainCodes.push(code);
    await db.prepare(`INSERT INTO redemption_codes
      (code_hash, code_preview, batch_name, duration_days, max_uses, valid_until) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(await hashCode(code), maskCode(code), batchName, durationDays, maxUses, validUntil).run();
  }
  return json({ ok: true, codes: plainCodes });
}

async function adminDisableCode(payload: Record<string, unknown>) {
  if (!isAdmin(payload)) return json({ error: "管理员口令错误" }, 401);
  await getD1().prepare("UPDATE redemption_codes SET status = 'disabled' WHERE id = ?").bind(Number(payload.id)).run();
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

async function adminUpsertContentBatch(payload: Record<string, unknown>) {
  if (!isAdmin(payload)) return json({ error: "管理员口令错误" }, 401);
  if (!Array.isArray(payload.items) || payload.items.length < 1 || payload.items.length > 100) return json({ error: "每次需导入 1—100 条内容" }, 400);
  const db = getD1();
  const admin = adminFromPayload(payload)!;
  const saved: Array<{ id: number; contentKey: string; version: number }> = [];
  for (const raw of payload.items) {
    const item = raw as Record<string, unknown>;
    const contentType = String(item.contentType ?? "");
    const contentKey = String(item.contentKey ?? "").trim();
    const title = String(item.title ?? "").trim().slice(0, 120);
    let status = CONTENT_STATUSES.has(String(item.status)) ? String(item.status) : "draft";
    if (!CONTENT_TYPES.has(contentType)) return json({ error: `不支持的内容类型：${contentType}` }, 400);
    const radarContent = new Set(["exam_event", "exam_notice", "job_position"]).has(contentType);
    const writePermission: AdminPermission = radarContent ? "radar.write" : "content.write";
    if (!hasAdminPermission(admin, writePermission) && admin.role !== "super_admin") return adminForbidden(writePermission);
    if (new Set(["published", "scheduled", "archived", "rejected"]).has(status)
      && admin.role !== "reviewer" && admin.role !== "super_admin") {
      return json({ error: "内容需先提交审核，只有审核员可以发布、驳回或下线" }, 403);
    }
    if (!/^[a-z0-9][a-z0-9_-]{2,80}$/i.test(contentKey) || !title) return json({ error: "内容标识或标题无效" }, 400);
    if (!item.payload || typeof item.payload !== "object" || Array.isArray(item.payload)) return json({ error: `${contentKey} 内容必须是结构化对象` }, 400);
    const payloadJson = JSON.stringify(item.payload);
    if (payloadJson.length > 120_000) return json({ error: `${contentKey} 内容过大` }, 400);
    let publishAt: string | null = null;
    if (item.publishAt) {
      const value = Date.parse(String(item.publishAt));
      if (!Number.isFinite(value)) return json({ error: `${contentKey} 发布时间无效` }, 400);
      publishAt = new Date(value).toISOString();
    }
    if (status === "scheduled" && (!publishAt || Date.parse(publishAt) <= Date.now())) return json({ error: `${contentKey} 定时发布时间必须晚于当前时间` }, 400);
    if (status === "published" && publishAt && Date.parse(publishAt) > Date.now()) status = "scheduled";
    const existing = await db.prepare(`SELECT id, content_type, content_key, title, payload_json, status,
      publish_at, version FROM content_items WHERE content_key = ?`).bind(contentKey).first<Record<string, unknown>>();
    if (existing) {
      if (new Set(["published", "scheduled"]).has(String(existing.status))
        && admin.role !== "reviewer" && admin.role !== "super_admin") {
        return json({ error: `${contentKey} 已发布；请复制为新草稿并提交审核，避免绕过审核直接改动线上内容` }, 409);
      }
      const currentVersion = Math.max(1, Number(existing.version ?? 1));
      const nextVersion = currentVersion + 1;
      await db.batch([
        db.prepare(`INSERT OR IGNORE INTO content_item_versions
          (content_id, version, content_type, content_key, title, payload_json, status, publish_at, change_type)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'snapshot')`)
          .bind(Number(existing.id), currentVersion, String(existing.content_type), String(existing.content_key),
            String(existing.title), String(existing.payload_json), String(existing.status), existing.publish_at ?? null),
        db.prepare(`UPDATE content_items SET content_type = ?, title = ?, payload_json = ?, status = ?,
          publish_at = ?, review_note = CASE WHEN ? = 'pending_review' THEN '' ELSE review_note END,
          submitted_by = CASE WHEN ? = 'pending_review' THEN ? ELSE submitted_by END,
          submitted_at = CASE WHEN ? = 'pending_review' THEN CURRENT_TIMESTAMP ELSE submitted_at END,
          reviewed_by = CASE WHEN ? IN ('published','scheduled','archived','rejected') THEN ? ELSE reviewed_by END,
          reviewed_at = CASE WHEN ? IN ('published','scheduled','archived','rejected') THEN CURRENT_TIMESTAMP ELSE reviewed_at END,
          version = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
          .bind(contentType, title, payloadJson, status, publishAt, status, status, admin.id, status,
            status, admin.id, status, nextVersion, Number(existing.id)),
        db.prepare(`INSERT OR REPLACE INTO content_item_versions
          (content_id, version, content_type, content_key, title, payload_json, status, publish_at, change_type)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'update')`)
          .bind(Number(existing.id), nextVersion, contentType, contentKey, title, payloadJson, status, publishAt),
      ]);
      saved.push({ id: Number(existing.id), contentKey, version: nextVersion });
    } else {
      const inserted = await db.prepare(`INSERT INTO content_items
        (content_type, content_key, title, payload_json, status, publish_at, version,
          submitted_by, submitted_at, reviewed_by, reviewed_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 1,
          CASE WHEN ? = 'pending_review' THEN ? ELSE NULL END,
          CASE WHEN ? = 'pending_review' THEN CURRENT_TIMESTAMP ELSE NULL END,
          CASE WHEN ? IN ('published','scheduled','archived','rejected') THEN ? ELSE NULL END,
          CASE WHEN ? IN ('published','scheduled','archived','rejected') THEN CURRENT_TIMESTAMP ELSE NULL END,
          CURRENT_TIMESTAMP)`)
        .bind(contentType, contentKey, title, payloadJson, status, publishAt,
          status, admin.id, status, status, admin.id, status).run();
      const id = Number(inserted.meta.last_row_id);
      await db.prepare(`INSERT INTO content_item_versions
        (content_id, version, content_type, content_key, title, payload_json, status, publish_at, change_type)
        VALUES (?, 1, ?, ?, ?, ?, ?, ?, 'create')`)
        .bind(id, contentType, contentKey, title, payloadJson, status, publishAt).run();
      saved.push({ id, contentKey, version: 1 });
    }
  }
  return json({ ok: true, count: saved.length, items: saved });
}

async function adminDisableContent(payload: Record<string, unknown>) {
  if (!isAdmin(payload)) return json({ error: "管理员口令错误" }, 401);
  payload.status = "archived";
  return adminSetContentStatus(payload);
}

async function adminSetContentStatus(payload: Record<string, unknown>) {
  if (!isAdmin(payload)) return json({ error: "管理员口令错误" }, 401);
  const id = Math.floor(Number(payload.id));
  const status = String(payload.status ?? "draft");
  if (!Number.isFinite(id) || id < 1 || !CONTENT_STATUSES.has(status)) return json({ error: "内容或状态无效" }, 400);
  const db = getD1();
  const current = await db.prepare(`SELECT id, content_type, content_key, title, payload_json, status,
    publish_at, version FROM content_items WHERE id = ?`).bind(id).first<Record<string, unknown>>();
  if (!current) return json({ error: "内容不存在" }, 404);
  const admin = adminFromPayload(payload)!;
  const radarContent = new Set(["exam_event", "exam_notice", "job_position"]).has(String(current.content_type));
  if (new Set(["published", "scheduled"]).has(String(current.status))
    && new Set(["draft", "pending_review"]).has(status)
    && admin.role !== "reviewer" && admin.role !== "super_admin") {
    return json({ error: "已发布内容不能由编辑直接撤回；请复制为新草稿后提交审核" }, 409);
  }
  if (new Set(["published", "scheduled", "archived", "rejected"]).has(status)) {
    if (admin.role !== "reviewer" && admin.role !== "super_admin") return json({ error: "只有审核员可以发布、驳回或下线内容" }, 403);
    if (admin.role === "reviewer" && new Set(["published", "scheduled", "rejected"]).has(status)
      && String(current.status) !== "pending_review") {
      return json({ error: "内容尚未提交审核，不能直接发布或驳回" }, 409);
    }
  } else {
    const writePermission: AdminPermission = radarContent ? "radar.write" : "content.write";
    if (!hasAdminPermission(admin, writePermission)) return adminForbidden(writePermission);
  }
  const nextVersion = Math.max(1, Number(current.version ?? 1)) + 1;
  let publishAt = current.publish_at ? String(current.publish_at) : null;
  if (payload.publishAt) {
    const requestedPublishAt = Date.parse(String(payload.publishAt));
    if (!Number.isFinite(requestedPublishAt)) return json({ error: "发布时间无效" }, 400);
    publishAt = new Date(requestedPublishAt).toISOString();
  }
  if (status === "published") publishAt = null;
  if (status === "scheduled" && (!publishAt || Date.parse(publishAt) <= Date.now())) return json({ error: "请先设置未来的发布时间" }, 400);
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO content_item_versions
      (content_id, version, content_type, content_key, title, payload_json, status, publish_at, change_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'snapshot')`)
      .bind(id, Number(current.version ?? 1), String(current.content_type), String(current.content_key),
        String(current.title), String(current.payload_json), String(current.status), current.publish_at ?? null),
    db.prepare(`UPDATE content_items SET status = ?, publish_at = ?, review_note = ?,
      submitted_by = CASE WHEN ? = 'pending_review' THEN ? ELSE submitted_by END,
      submitted_at = CASE WHEN ? = 'pending_review' THEN CURRENT_TIMESTAMP ELSE submitted_at END,
      reviewed_by = CASE WHEN ? IN ('published','scheduled','archived','rejected') THEN ? ELSE reviewed_by END,
      reviewed_at = CASE WHEN ? IN ('published','scheduled','archived','rejected') THEN CURRENT_TIMESTAMP ELSE reviewed_at END,
      version = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bind(status, publishAt, trimmed(payload.reviewNote, 1000), status, admin.id, status,
        status, admin.id, status, nextVersion, id),
    db.prepare(`INSERT OR REPLACE INTO content_item_versions
      (content_id, version, content_type, content_key, title, payload_json, status, publish_at, change_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'status')`)
      .bind(id, nextVersion, String(current.content_type), String(current.content_key), String(current.title),
        String(current.payload_json), status, publishAt),
  ]);
  return json({ ok: true, id, status, version: nextVersion });
}

async function adminListContentVersions(payload: Record<string, unknown>) {
  if (!isAdmin(payload)) return json({ error: "管理员口令错误" }, 401);
  const id = Math.floor(Number(payload.id));
  if (!Number.isFinite(id) || id < 1) return json({ error: "内容不存在" }, 400);
  const content = await getD1().prepare("SELECT content_type FROM content_items WHERE id = ?").bind(id).first<{ content_type: string }>();
  if (!content) return json({ error: "内容不存在" }, 404);
  const permission: AdminPermission = new Set(["exam_event", "exam_notice", "job_position"]).has(content.content_type) ? "radar.read" : "content.read";
  if (!canAdmin(payload, permission)) return adminForbidden(permission);
  const rows = await getD1().prepare(`SELECT id, content_id, version, content_type, content_key, title,
    payload_json, status, publish_at, change_type, created_at
    FROM content_item_versions WHERE content_id = ? ORDER BY version DESC LIMIT 100`).bind(id).all();
  return json({ ok: true, versions: rows.results });
}

async function adminRollbackContent(payload: Record<string, unknown>) {
  if (!isAdmin(payload)) return json({ error: "管理员口令错误" }, 401);
  const contentId = Math.floor(Number(payload.id));
  const version = Math.floor(Number(payload.version));
  const db = getD1();
  const [current, snapshot] = await Promise.all([
    db.prepare("SELECT * FROM content_items WHERE id = ?").bind(contentId).first<Record<string, unknown>>(),
    db.prepare("SELECT * FROM content_item_versions WHERE content_id = ? AND version = ?")
      .bind(contentId, version).first<Record<string, unknown>>(),
  ]);
  if (!current || !snapshot) return json({ error: "内容或历史版本不存在" }, 404);
  const nextVersion = Math.max(1, Number(current.version ?? 1)) + 1;
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO content_item_versions
      (content_id, version, content_type, content_key, title, payload_json, status, publish_at, change_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'snapshot')`)
      .bind(contentId, Number(current.version ?? 1), String(current.content_type), String(current.content_key),
        String(current.title), String(current.payload_json), String(current.status), current.publish_at ?? null),
    db.prepare(`UPDATE content_items SET content_type = ?, title = ?, payload_json = ?, status = ?,
      publish_at = ?, version = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bind(String(snapshot.content_type), String(snapshot.title), String(snapshot.payload_json), String(snapshot.status),
        snapshot.publish_at ?? null, nextVersion, contentId),
    db.prepare(`INSERT OR REPLACE INTO content_item_versions
      (content_id, version, content_type, content_key, title, payload_json, status, publish_at, change_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'rollback')`)
      .bind(contentId, nextVersion, String(snapshot.content_type), String(current.content_key), String(snapshot.title),
        String(snapshot.payload_json), String(snapshot.status), snapshot.publish_at ?? null),
  ]);
  return json({ ok: true, id: contentId, restoredFrom: version, version: nextVersion });
}

async function adminDuplicateContent(payload: Record<string, unknown>) {
  if (!isAdmin(payload)) return json({ error: "管理员口令错误" }, 401);
  const id = Math.floor(Number(payload.id));
  const newKey = trimmed(payload.contentKey, 80);
  const title = trimmed(payload.title, 120);
  if (!/^[a-z0-9][a-z0-9_-]{2,80}$/i.test(newKey)) return json({ error: "新内容标识无效" }, 400);
  const db = getD1();
  const source = await db.prepare("SELECT * FROM content_items WHERE id = ?").bind(id).first<Record<string, unknown>>();
  if (!source) return json({ error: "源内容不存在" }, 404);
  const permission: AdminPermission = new Set(["exam_event", "exam_notice", "job_position"]).has(String(source.content_type)) ? "radar.write" : "content.write";
  if (!canAdmin(payload, permission)) return adminForbidden(permission);
  const result = await db.prepare(`INSERT INTO content_items
    (content_type, content_key, title, payload_json, status, publish_at, version, updated_at)
    VALUES (?, ?, ?, ?, 'draft', NULL, 1, CURRENT_TIMESTAMP)`)
    .bind(String(source.content_type), newKey, title || `${String(source.title)}（副本）`, String(source.payload_json)).run();
  const newId = Number(result.meta.last_row_id);
  await db.prepare(`INSERT INTO content_item_versions
    (content_id, version, content_type, content_key, title, payload_json, status, publish_at, change_type)
    VALUES (?, 1, ?, ?, ?, ?, 'draft', NULL, 'duplicate')`)
    .bind(newId, String(source.content_type), newKey, title || `${String(source.title)}（副本）`, String(source.payload_json)).run();
  return json({ ok: true, id: newId, contentKey: newKey, version: 1 });
}

function trimmed(value: unknown, maxLength: number) {
  return String(value ?? "").trim().slice(0, maxLength);
}

async function adminUpsertQuestionBank(payload: Record<string, unknown>) {
  if (!isAdmin(payload)) return json({ error: "管理员口令错误" }, 401);
  const bankCode = trimmed(payload.bankCode, 60).toUpperCase();
  const name = trimmed(payload.name, 80);
  const examType = trimmed(payload.examType, 20);
  const province = trimmed(payload.province, 20) || null;
  const subject = trimmed(payload.subject, 10);
  const description = trimmed(payload.description, 500);
  const coverColor = new Set(["blue", "orange", "green", "purple"]).has(String(payload.coverColor)) ? String(payload.coverColor) : "blue";
  const status = payload.status === "published" ? "published" : "draft";
  const bankIdValue = Math.floor(Number(payload.bankId));
  const bankId = Number.isFinite(bankIdValue) && bankIdValue > 0 ? bankIdValue : null;
  const yearValue = Number(payload.examYear);
  const examYear = Number.isInteger(yearValue) && yearValue >= 2020 && yearValue <= 2100 ? yearValue : null;
  if (!/^[A-Z0-9][A-Z0-9_-]{2,59}$/.test(bankCode)) return json({ error: "题库编码需使用3—60位大写字母、数字、横线或下划线" }, 400);
  if (!name) return json({ error: "请输入题库名称" }, 400);
  if (!new Set(["national", "provincial", "special"]).has(examType)) return json({ error: "考试类型无效" }, 400);
  if (examType === "provincial" && !province) return json({ error: "省考题库必须填写省份" }, 400);
  if (!new Set(["行测", "申论", "综合"]).has(subject)) return json({ error: "题库科目无效" }, 400);
  const db = getD1();
  const duplicate = await db.prepare("SELECT id FROM question_banks WHERE bank_code = ?").bind(bankCode).first<{ id: number }>();
  if (duplicate && duplicate.id !== bankId) return json({ error: "题库编码已被其他题库使用" }, 409);
  if (bankId) {
    const updated = await db.prepare(`UPDATE question_banks SET bank_code = ?, name = ?, exam_type = ?, province = ?,
      exam_year = ?, subject = ?, description = ?, cover_color = ?, status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`).bind(bankCode, name, examType, province, examYear, subject, description, coverColor, status, bankId).run();
    if (!updated.meta.changes) return json({ error: "要编辑的题库不存在" }, 404);
  } else {
    await db.prepare(`INSERT INTO question_banks
      (bank_code, name, exam_type, province, exam_year, subject, description, cover_color, status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`)
      .bind(bankCode, name, examType, province, examYear, subject, description, coverColor, status).run();
  }
  const bank = await db.prepare("SELECT id FROM question_banks WHERE bank_code = ?").bind(bankCode).first<{ id: number }>();
  return json({ ok: true, id: bank?.id, bankCode });
}

async function adminSetQuestionBankStatus(payload: Record<string, unknown>) {
  if (!isAdmin(payload)) return json({ error: "管理员口令错误" }, 401);
  const id = Math.floor(Number(payload.id));
  const status = payload.status === "published" ? "published" : "draft";
  if (!Number.isFinite(id) || id < 1) return json({ error: "题库不存在" }, 400);
  await getD1().prepare("UPDATE question_banks SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(status, id).run();
  return json({ ok: true });
}

async function adminStartQuestionImport(payload: Record<string, unknown>) {
  if (!isAdmin(payload)) return json({ error: "管理员口令错误" }, 401);
  const bankId = Math.floor(Number(payload.bankId));
  const fileName = trimmed(payload.fileName, 160);
  const fileSize = Math.max(0, Math.floor(Number(payload.fileSize ?? 0)));
  const totalRows = Math.max(0, Math.floor(Number(payload.totalRows ?? 0)));
  if (!Number.isFinite(bankId) || bankId < 1) return json({ error: "请先选择目标题库" }, 400);
  if (!/\.(xlsx|xls|csv)$/i.test(fileName)) return json({ error: "仅支持 XLSX、XLS 或 CSV 文件" }, 400);
  if (fileSize > 20 * 1024 * 1024) return json({ error: "单个文件不能超过20MB" }, 400);
  if (totalRows < 1 || totalRows > 50_000) return json({ error: "每个文件需包含1—50000道题" }, 400);
  const db = getD1();
  const bank = await db.prepare("SELECT id FROM question_banks WHERE id = ?").bind(bankId).first();
  if (!bank) return json({ error: "目标题库不存在" }, 404);
  const result = await db.prepare(`INSERT INTO question_imports
    (bank_id, file_name, file_size, total_rows, status) VALUES (?, ?, ?, ?, 'processing')`)
    .bind(bankId, fileName, fileSize, totalRows).run();
  return json({ ok: true, importId: Number(result.meta.last_row_id) });
}

function validateImportedQuestion(raw: unknown): { question?: ImportedQuestion; error?: string } {
  const item = raw as Record<string, unknown>;
  const questionCode = trimmed(item.questionCode, 80).toUpperCase();
  const subject = trimmed(item.subject, 10);
  const questionModule = trimmed(item.module, 40);
  const stem = trimmed(item.stem, 12_000);
  const prompt = trimmed(item.prompt, 2_000);
  const explanation = trimmed(item.explanation, 8_000);
  const source = trimmed(item.source, 120);
  const region = trimmed(item.region ?? item.sourceRegion, 24).replace(/[·•]/g, "-");
  const examYear = Math.floor(Number(item.examYear ?? item.sourceYear));
  const frequency = new Set(["高频", "中频", "低频"]).has(String(item.frequency)) ? String(item.frequency) : "中频";
  const importanceStars = Math.max(1, Math.min(5, Math.floor(Number(item.importanceStars)) || 3));
  const scoreRate = Math.max(0, Math.min(100, Math.round(Number(item.scoreRate))));
  const suggestedSeconds = Math.max(10, Math.min(subject === "申论" ? 3600 : 900, Math.round(Number(item.suggestedSeconds)) || 60));
  const safeAssetUrl = (value: unknown) => {
    const url = trimmed(value, 500);
    return /^(https?:\/\/|\/api\/app\?media=)/i.test(url) ? url : "";
  };
  const imageUrl = safeAssetUrl(item.imageUrl);
  const resourceUrl = safeAssetUrl(item.resourceUrl);
  const options = Array.isArray(item.options) ? item.options.map((value) => trimmed(value, 2_000)).filter(Boolean).slice(0, 8) : [];
  const scoringPoints = Array.isArray(item.scoringPoints) ? item.scoringPoints.map((value) => trimmed(value, 500)).filter(Boolean).slice(0, 30) : [];
  const answer = trimmed(item.answer, 8).toUpperCase() || null;
  if (!/^[A-Z0-9][A-Z0-9_-]{2,79}$/.test(questionCode)) return { error: "题目编号格式错误" };
  if (!new Set(["行测", "申论"]).has(subject)) return { error: "科目只能是行测或申论" };
  if (!questionModule) return { error: "模块不能为空" };
  if (!stem) return { error: "题干/材料不能为空" };
  if (!source) return { error: "真题来源不能为空" };
  if (!region) return { error: "真题必须填写地区" };
  if (!Number.isInteger(examYear) || examYear < 1990 || examYear > new Date().getFullYear()) return { error: "真题年份无效" };
  if (!Number.isFinite(Number(item.scoreRate)) || scoreRate < 0 || scoreRate > 100) return { error: "拿分率需为0—100" };
  if (!explanation) return { error: "解析/参考答案不能为空" };
  if (subject === "行测" && (options.length < 2 || !answer || !/^[A-H]$/.test(answer))) return { error: "行测题必须填写至少2个选项及A—H正确答案" };
  if (subject === "申论" && !prompt) return { error: "申论题必须填写申论任务" };
  const wordValue = Number(item.wordLimit);
  const wordLimit = Number.isInteger(wordValue) && wordValue > 0 && wordValue <= 5000 ? wordValue : null;
  return { question: {
    questionCode,
    subject,
    module: questionModule,
    subType: trimmed(item.subType, 40),
    stem,
    options,
    answer,
    explanation,
    technique: trimmed(item.technique, 4_000),
    material: trimmed(item.material, 12_000),
    prompt,
    wordLimit,
    scoringPoints,
    difficulty: new Set(["简单", "中等", "较难"]).has(String(item.difficulty)) ? String(item.difficulty) : "中等",
    source,
    region,
    examYear,
    frequency,
    importanceStars,
    scoreRate,
    suggestedSeconds,
    imageUrl,
    resourceUrl,
  } };
}

function importedQuestionIdentityMatches(row: Record<string, unknown>, item: ImportedQuestion) {
  const normalize = (value: unknown) => String(value ?? "").normalize("NFKC").trim().replace(/\s+/g, " ");
  const existingOptions = parseOptions(String(row.options_json ?? "[]")).map(normalize);
  const incomingOptions = (item.options ?? []).map(normalize);
  return normalize(row.subject) === normalize(item.subject)
    && normalize(row.module) === normalize(item.module)
    && normalize(row.sub_type) === normalize(item.subType)
    && normalize(row.stem) === normalize(item.stem)
    && JSON.stringify(existingOptions) === JSON.stringify(incomingOptions)
    && normalize(row.answer).toUpperCase() === normalize(item.answer).toUpperCase()
    && normalize(row.prompt) === normalize(item.prompt);
}

async function adminImportQuestionBatch(payload: Record<string, unknown>) {
  if (!isAdmin(payload)) return json({ error: "管理员口令错误" }, 401);
  const bankId = Math.floor(Number(payload.bankId));
  const importId = Math.floor(Number(payload.importId));
  const offset = Math.max(0, Math.floor(Number(payload.offset ?? 0)));
  if (!Array.isArray(payload.rows) || payload.rows.length < 1 || payload.rows.length > 40) return json({ error: "每批需包含1—40道题" }, 400);
  const db = getD1();
  const job = await db.prepare("SELECT id FROM question_imports WHERE id = ? AND bank_id = ? AND status = 'processing'").bind(importId, bankId).first();
  if (!job) return json({ error: "导入任务不存在或已经结束" }, 409);
  const valid: Array<{ question: ImportedQuestion; row: number }> = [];
  const errors: Array<{ row: number; message: string }> = [];
  payload.rows.forEach((raw, index) => {
    const result = validateImportedQuestion(raw);
    if (result.question) valid.push({ question: result.question, row: offset + index + 2 });
    else errors.push({ row: offset + index + 2, message: result.error ?? "未知错误" });
  });
  let accepted = valid;
  if (valid.length) {
    const placeholders = valid.map(() => "?").join(",");
    const existingRows = await db.prepare(`SELECT q.question_code, q.subject, q.module, q.sub_type, q.stem,
      q.options_json, q.answer, q.prompt, COUNT(DISTINCT qb.id) AS bank_count,
      MAX(CASE WHEN qb.id = ? THEN 1 ELSE 0 END) AS in_current_bank,
      GROUP_CONCAT(DISTINCT qb.name) AS bank_names
      FROM questions q
      LEFT JOIN question_bank_items qbi ON qbi.question_id = q.id
      LEFT JOIN question_banks qb ON qb.id = qbi.bank_id
      WHERE q.question_code IN (${placeholders}) GROUP BY q.id`)
      .bind(bankId, ...valid.map((item) => item.question.questionCode))
      .all<Record<string, unknown>>();
    const existingMap = new Map(existingRows.results.map((item) => [String(item.question_code), item]));
    accepted = valid.filter((item) => {
      const existing = existingMap.get(item.question.questionCode);
      if (!existing) return true;
      if (Number(existing.in_current_bank) === 1 && Number(existing.bank_count) === 1) return true;
      if (importedQuestionIdentityMatches(existing, item.question)) return true;
      errors.push({ row: item.row, message: `题目编号已用于“${String(existing.bank_names ?? "其他题库")}”且核心内容不一致；共通题可复用编号，但题干、选项和答案必须一致` });
      return false;
    });
  }
  if (accepted.length) {
    const statements: D1PreparedStatement[] = [];
    accepted.forEach(({ question: item }, index) => {
      statements.push(
        db.prepare(`INSERT INTO questions
          (question_code, subject, module, sub_type, stem, options_json, answer, explanation, technique,
           material, prompt, word_limit, scoring_points_json, difficulty, source, source_region, source_year,
           frequency, importance_stars, score_rate, suggested_seconds, image_url, resource_url, status, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', CURRENT_TIMESTAMP)
          ON CONFLICT(question_code) DO UPDATE SET subject = excluded.subject, module = excluded.module,
            sub_type = excluded.sub_type, stem = excluded.stem, options_json = excluded.options_json,
            answer = excluded.answer, explanation = excluded.explanation, technique = excluded.technique,
            material = excluded.material, prompt = excluded.prompt, word_limit = excluded.word_limit,
            scoring_points_json = excluded.scoring_points_json, difficulty = excluded.difficulty,
            source = excluded.source, source_region = excluded.source_region, source_year = excluded.source_year,
            frequency = excluded.frequency, importance_stars = excluded.importance_stars,
            score_rate = excluded.score_rate, suggested_seconds = excluded.suggested_seconds,
            image_url = excluded.image_url, resource_url = excluded.resource_url,
            status = 'active', updated_at = CURRENT_TIMESTAMP`)
          .bind(item.questionCode, item.subject, item.module, item.subType ?? "", item.stem,
            JSON.stringify(item.options ?? []), item.answer ?? null, item.explanation ?? "", item.technique ?? "",
            item.material ?? "", item.prompt ?? "", item.wordLimit ?? null, JSON.stringify(item.scoringPoints ?? []),
            item.difficulty ?? "中等", item.source ?? "", item.region, item.examYear, item.frequency,
            item.importanceStars, item.scoreRate, item.suggestedSeconds, item.imageUrl, item.resourceUrl),
        db.prepare(`INSERT OR IGNORE INTO question_bank_items (bank_id, question_id, sort_order)
          SELECT ?, id, ? FROM questions WHERE question_code = ?`).bind(bankId, offset + index, item.questionCode),
      );
    });
    await db.batch(statements);
  }
  await db.prepare(`UPDATE question_imports SET imported_rows = imported_rows + ?, failed_rows = failed_rows + ?
    WHERE id = ?`).bind(accepted.length, errors.length, importId).run();
  return json({
    ok: true,
    imported: accepted.length,
    failed: errors.length,
    errors,
    importedQuestions: accepted.map(({ question }) => ({
      questionCode: question.questionCode,
      region: question.region,
      examYear: question.examYear,
      truthLabel: `${question.region}-${question.examYear}`,
      frequency: question.frequency,
      importanceStars: question.importanceStars,
      scoreRate: question.scoreRate,
      suggestedSeconds: question.suggestedSeconds,
      imageUrl: question.imageUrl,
      resourceUrl: question.resourceUrl,
    })),
  });
}

async function adminFinishQuestionImport(payload: Record<string, unknown>) {
  if (!isAdmin(payload)) return json({ error: "管理员口令错误" }, 401);
  const importId = Math.floor(Number(payload.importId));
  const errorSummary = trimmed(payload.errorSummary, 8_000);
  if (payload.aborted === true) {
    await getD1().prepare(`UPDATE question_imports SET status = 'failed', error_summary = ?, completed_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'processing'`).bind(errorSummary || "导入中断", importId).run();
    return json({ ok: true });
  }
  await getD1().prepare(`UPDATE question_imports SET status = CASE WHEN failed_rows > 0 THEN 'completed_with_errors' ELSE 'completed' END,
    error_summary = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'processing'`)
    .bind(errorSummary, importId).run();
  return json({ ok: true });
}

function adminPublicShape(admin: AdminIdentity) {
  return {
    id: admin.id,
    username: admin.username,
    displayName: admin.displayName,
    role: admin.role,
    permissions: admin.permissions,
  };
}

async function adminLogin(request: Request, payload: Record<string, unknown>) {
  const db = getD1();
  await ensureAdminSchema(db);
  const username = trimmed(payload.username, 40).normalize("NFKC").toLowerCase();
  const ipAddress = (request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for") ?? "").split(",")[0].trim().slice(0, 80);
  const recentFailures = await db.prepare(`SELECT COUNT(*) AS count FROM admin_audit_logs
    WHERE action = 'adminLogin' AND result IN ('failure','denied') AND created_at >= datetime('now','-15 minutes')
      AND ((? <> '' AND ip_address = ?) OR details_json LIKE ?)`)
    .bind(ipAddress, ipAddress, `%\"username\":\"${username.replaceAll("%", "").replaceAll("_", "")}\"%`)
    .first<{ count: number }>();
  if (Number(recentFailures?.count ?? 0) >= 10) {
    await writeAdminAudit(db, request, null, {
      action: "adminLogin", resourceType: "session", summary: `管理员登录被限流：${username || "未知账号"}`,
      result: "denied", details: { username, reason: "rate_limit" },
    });
    const response = json({ authenticated: false, error: "登录尝试过于频繁，请15分钟后再试" }, 429);
    response.headers.set("retry-after", "900");
    return response;
  }
  const result = await authenticateAdmin(db, request, getAdminSecret(), username, payload.password ?? payload.adminToken);
  if (!result) {
    await writeAdminAudit(db, request, null, {
      action: "adminLogin",
      resourceType: "session",
      summary: `管理员登录失败：${trimmed(payload.username, 40) || "未知账号"}`,
      result: "failure",
      details: { username: trimmed(payload.username, 40) },
    });
    return json({ authenticated: false, error: "账号或密码错误" }, 401);
  }
  await writeAdminAudit(db, request, result.admin, {
    action: "adminLogin",
    resourceType: "session",
    resourceId: result.admin.sessionId,
    summary: "管理员登录成功",
  });
  return json({
    ok: true,
    authenticated: true,
    admin: adminPublicShape(result.admin),
    expiresAt: result.admin.expiresAt,
  }, 200, result.cookie);
}

async function adminSession(request: Request) {
  const db = getD1();
  const admin = await getAdminIdentity(db, request);
  if (!admin) return adminUnauthorized();
  const [review, imports, scheduled] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS count FROM content_items WHERE status = 'pending_review'").first<{ count: number }>(),
    db.prepare("SELECT COUNT(*) AS count FROM question_imports WHERE status = 'processing'").first<{ count: number }>(),
    db.prepare("SELECT COUNT(*) AS count FROM content_items WHERE status = 'scheduled' AND datetime(publish_at) <= datetime('now','+7 days')").first<{ count: number }>(),
  ]);
  const pendingCounts = { review: Number(review?.count ?? 0), imports: Number(imports?.count ?? 0), scheduled: Number(scheduled?.count ?? 0) };
  return json({ authenticated: true, admin: adminPublicShape(admin), expiresAt: admin.expiresAt,
    pendingCount: pendingCounts.review + pendingCounts.imports + pendingCounts.scheduled, pendingCounts });
}

async function adminLogout(request: Request) {
  const db = getD1();
  const admin = await getAdminIdentity(db, request, false);
  await revokeAdminSession(db, request);
  if (admin) await writeAdminAudit(db, request, admin, { action: "adminLogout", resourceType: "session", resourceId: admin.sessionId, summary: "管理员退出登录" });
  return json({ ok: true, authenticated: false }, 200, expiredAdminCookie());
}

function listPagination(payload: Record<string, unknown>, maxPageSize = 100) {
  const page = Math.max(1, Math.floor(Number(payload.page ?? 1)) || 1);
  const pageSize = Math.max(1, Math.min(maxPageSize, Math.floor(Number(payload.pageSize ?? 20)) || 20));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function parseContentRows(rows: Array<Record<string, unknown>>) {
  return rows.map((item) => {
    let parsed: unknown = {};
    try { parsed = JSON.parse(String(item.payload_json ?? "{}")); } catch { parsed = {}; }
    return { ...item, payload: parsed };
  });
}

async function adminDashboard(payload: Record<string, unknown>) {
  if (!canAdmin(payload, "dashboard.read")) return adminForbidden("dashboard.read");
  const db = getD1();
  const [users, activeUsers, publishedContent, pendingReview, banks, questionsCount, redemptions7d,
    failedImports, processingImports, emptyPublishedBanks, staleReview, scheduledSoon, recent] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS count FROM users").first<{ count: number }>(),
    db.prepare("SELECT COUNT(DISTINCT user_id) AS count FROM analytics_events WHERE created_at >= datetime('now','-7 days')").first<{ count: number }>(),
    db.prepare("SELECT COUNT(*) AS count FROM content_items WHERE status IN ('published','scheduled')").first<{ count: number }>(),
    db.prepare("SELECT COUNT(*) AS count FROM content_items WHERE status = 'pending_review'").first<{ count: number }>(),
    db.prepare("SELECT COUNT(*) AS count FROM question_banks").first<{ count: number }>(),
    db.prepare("SELECT COUNT(*) AS count FROM questions WHERE status = 'active'").first<{ count: number }>(),
    db.prepare("SELECT COUNT(*) AS count FROM redemptions WHERE redeemed_at >= datetime('now','-7 days')").first<{ count: number }>(),
    db.prepare("SELECT COUNT(*) AS count FROM question_imports WHERE status IN ('failed','completed_with_errors')").first<{ count: number }>(),
    db.prepare("SELECT COUNT(*) AS count FROM question_imports WHERE status = 'processing'").first<{ count: number }>(),
    db.prepare(`SELECT COUNT(*) AS count FROM question_banks b WHERE b.status = 'published'
      AND NOT EXISTS (SELECT 1 FROM question_bank_items i WHERE i.bank_id = b.id)`).first<{ count: number }>(),
    db.prepare("SELECT COUNT(*) AS count FROM content_items WHERE status = 'pending_review' AND submitted_at < datetime('now','-2 days')").first<{ count: number }>(),
    db.prepare("SELECT COUNT(*) AS count FROM content_items WHERE status = 'scheduled' AND datetime(publish_at) <= datetime('now','+7 days')").first<{ count: number }>(),
    db.prepare(`SELECT id, username, role, action, resource_type, resource_id, summary, result, created_at
      FROM admin_audit_logs ORDER BY id DESC LIMIT 12`).all(),
  ]);
  const number = (value: { count: number } | null) => Number(value?.count ?? 0);
  const todos: Array<Record<string, unknown>> = [];
  const anomalies: Array<Record<string, unknown>> = [];
  if (number(pendingReview)) todos.push({ id: "pending-review", type: "review", title: "待审核内容", description: "内容已提交，等待审核后发布", count: number(pendingReview), href: "/admin/content?status=pending_review", priority: "high" });
  if (number(processingImports)) todos.push({ id: "processing-imports", type: "import", title: "导入任务进行中", description: "题库文件仍在处理", count: number(processingImports), href: "/admin/imports", priority: "medium" });
  if (number(scheduledSoon)) todos.push({ id: "scheduled-soon", type: "schedule", title: "7天内待发布", description: "检查定时内容和素材完整性", count: number(scheduledSoon), href: "/admin/content?status=scheduled", priority: "medium" });
  if (number(failedImports)) anomalies.push({ id: "failed-imports", type: "import", title: "导入失败或有错误", description: "需要下载错误信息并修正数据", count: number(failedImports), href: "/admin/imports", severity: "error" });
  if (number(emptyPublishedBanks)) anomalies.push({ id: "empty-banks", type: "question_bank", title: "已发布空题库", description: "用户能看到但无法开始练习", count: number(emptyPublishedBanks), href: "/admin/question-banks", severity: "warning" });
  if (number(staleReview)) anomalies.push({ id: "stale-review", type: "review", title: "审核超过48小时", description: "待审核内容已积压", count: number(staleReview), href: "/admin/content?status=pending_review", severity: "warning" });
  return json({
    metrics: {
      users: number(users), activeUsers7d: number(activeUsers), publishedContent: number(publishedContent),
      pendingReview: number(pendingReview), questionBanks: number(banks), questions: number(questionsCount), redemptions7d: number(redemptions7d),
    },
    pendingCount: number(pendingReview) + number(processingImports) + number(scheduledSoon),
    pendingCounts: { review: number(pendingReview), imports: number(processingImports), scheduled: number(scheduledSoon) },
    todos,
    anomalies,
    recentActivity: recent.results,
  });
}

async function adminListQuestions(payload: Record<string, unknown>) {
  if (!canAdmin(payload, "question.read")) return adminForbidden("question.read");
  const db = getD1();
  const { page, pageSize, offset } = listPagination(payload, 100);
  const conditions = ["1=1"];
  const binds: unknown[] = [];
  const keyword = trimmed(payload.keyword, 100);
  if (keyword) { conditions.push("(q.question_code LIKE ? OR q.stem LIKE ? OR q.source LIKE ?)"); binds.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`); }
  if (payload.status) { conditions.push("q.status = ?"); binds.push(trimmed(payload.status, 30)); }
  if (Number(payload.bankId) > 0) { conditions.push("EXISTS (SELECT 1 FROM question_bank_items qi WHERE qi.question_id = q.id AND qi.bank_id = ?)"); binds.push(Math.floor(Number(payload.bankId))); }
  const where = conditions.join(" AND ");
  const [questionBanks, questionImports, questions, total, summary, bankSummary, importSummary] = await Promise.all([
    db.prepare(`SELECT b.id, b.bank_code, b.name, b.exam_type, b.province, b.exam_year, b.subject,
      b.description, b.cover_color, b.status, b.updated_at, COUNT(i.id) AS question_count
      FROM question_banks b LEFT JOIN question_bank_items i ON i.bank_id = b.id GROUP BY b.id ORDER BY b.id DESC LIMIT 500`).all(),
    db.prepare(`SELECT qi.id, qi.bank_id, qb.name AS bank_name, qi.file_name, qi.file_size, qi.total_rows,
      qi.imported_rows, qi.failed_rows, qi.status, qi.error_summary, qi.created_at, qi.completed_at
      FROM question_imports qi JOIN question_banks qb ON qb.id = qi.bank_id ORDER BY qi.id DESC LIMIT 200`).all(),
    db.prepare(`SELECT q.id, q.question_code, q.subject, q.module, q.sub_type, q.stem, q.difficulty,
      q.source, q.source_region, q.source_year, q.frequency, q.importance_stars, q.score_rate,
      q.suggested_seconds, q.status, q.updated_at FROM questions q WHERE ${where}
      ORDER BY q.id DESC LIMIT ? OFFSET ?`).bind(...binds, pageSize, offset).all(),
    db.prepare(`SELECT COUNT(*) AS count FROM questions q WHERE ${where}`).bind(...binds).first<{ count: number }>(),
    db.prepare(`SELECT COUNT(*) AS question_count,
      SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active_count,
      SUM(CASE WHEN source_year IS NULL OR source_region = '' THEN 1 ELSE 0 END) AS incomplete_count FROM questions`).first(),
    db.prepare(`SELECT COUNT(*) AS total_banks,
      SUM(CASE WHEN status = 'published' THEN 1 ELSE 0 END) AS published_banks,
      SUM(CASE WHEN status = 'published' AND NOT EXISTS (
        SELECT 1 FROM question_bank_items i WHERE i.bank_id = question_banks.id
      ) THEN 1 ELSE 0 END) AS empty_published_banks FROM question_banks`).first(),
    db.prepare(`SELECT COALESCE(SUM(imported_rows), 0) AS imported_rows,
      SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing_imports,
      SUM(CASE WHEN status IN ('failed','completed_with_errors') THEN 1 ELSE 0 END) AS failed_imports
      FROM question_imports`).first(),
  ]);
  const rawSummary = (summary ?? {}) as Record<string, unknown>;
  const rawBankSummary = (bankSummary ?? {}) as Record<string, unknown>;
  const rawImportSummary = (importSummary ?? {}) as Record<string, unknown>;
  const importsProcessing = Number(rawImportSummary.processing_imports ?? 0);
  const importsFailed = Number(rawImportSummary.failed_imports ?? 0);
  const importedRows = Number(rawImportSummary.imported_rows ?? 0);
  return json({ questionBanks: questionBanks.results, questionImports: questionImports.results, questions: questions.results,
    pagination: { page, pageSize, total: Number(total?.count ?? 0) },
    summary: {
      totalQuestions: Number(rawSummary.question_count ?? 0),
      activeQuestions: Number(rawSummary.active_count ?? 0),
      incompleteQuestions: Number(rawSummary.incomplete_count ?? 0),
      question_count: Number(rawSummary.question_count ?? 0),
      active_count: Number(rawSummary.active_count ?? 0),
      incomplete_count: Number(rawSummary.incomplete_count ?? 0),
      totalBanks: Number(rawBankSummary.total_banks ?? 0),
      publishedBanks: Number(rawBankSummary.published_banks ?? 0),
      emptyPublishedBanks: Number(rawBankSummary.empty_published_banks ?? 0),
      importsProcessing, importsFailed, processingImports: importsProcessing, failedImports: importsFailed, importedRows,
    } });
}

async function adminListContent(payload: Record<string, unknown>) {
  if (!canAdmin(payload, "content.read")) return adminForbidden("content.read");
  const db = getD1();
  const { page, pageSize, offset } = listPagination(payload, 100);
  const conditions = ["content_type NOT IN ('exam_event','exam_notice','job_position')"];
  const binds: unknown[] = [];
  if (payload.contentType) { conditions.push("content_type = ?"); binds.push(trimmed(payload.contentType, 40)); }
  if (payload.status) { conditions.push("status = ?"); binds.push(trimmed(payload.status, 30)); }
  const keyword = trimmed(payload.keyword, 100);
  if (keyword) { conditions.push("(title LIKE ? OR content_key LIKE ?)"); binds.push(`%${keyword}%`, `%${keyword}%`); }
  const where = conditions.join(" AND ");
  const [content, total, media, statusCounts] = await Promise.all([
    db.prepare(`SELECT id, content_type, content_key, title, payload_json, status, publish_at, version,
      review_note, submitted_by, submitted_at, reviewed_by, reviewed_at, updated_at,
      (SELECT COUNT(*) FROM content_item_versions v WHERE v.content_id = content_items.id) AS version_count
      FROM content_items WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).bind(...binds, pageSize, offset).all<Record<string, unknown>>(),
    db.prepare(`SELECT COUNT(*) AS count FROM content_items WHERE ${where}`).bind(...binds).first<{ count: number }>(),
    db.prepare(`SELECT id, file_name, content_type, byte_size, storage, status, created_at,
      '/api/app?media=' || id AS url FROM media_assets ORDER BY created_at DESC LIMIT 200`).all(),
    db.prepare("SELECT status, COUNT(*) AS count FROM content_items WHERE content_type NOT IN ('exam_event','exam_notice','job_position') GROUP BY status").all(),
  ]);
  const contentStatusCounts = Object.fromEntries(statusCounts.results.map((item) => [String((item as Record<string, unknown>).status), Number((item as Record<string, unknown>).count ?? 0)]));
  return json({ content: parseContentRows(content.results), mediaAssets: media.results,
    pagination: { page, pageSize, total: Number(total?.count ?? 0) }, summary: {
      total: Object.values(contentStatusCounts).reduce((sum, value) => sum + Number(value), 0),
      draft: contentStatusCounts.draft ?? 0,
      pendingReview: contentStatusCounts.pending_review ?? 0,
      scheduled: contentStatusCounts.scheduled ?? 0,
      published: contentStatusCounts.published ?? 0,
      rejected: contentStatusCounts.rejected ?? 0,
      archived: contentStatusCounts.archived ?? 0,
      mediaAssets: media.results.length,
      statusCounts: statusCounts.results,
    } });
}

async function adminListRadar(payload: Record<string, unknown>) {
  if (!canAdmin(payload, "radar.read")) return adminForbidden("radar.read");
  const db = getD1();
  const { page, pageSize, offset } = listPagination(payload, 100);
  const conditions = ["content_type IN ('exam_event','exam_notice','job_position')"];
  const binds: unknown[] = [];
  if (payload.contentType) { conditions.push("content_type = ?"); binds.push(trimmed(payload.contentType, 40)); }
  if (payload.status) { conditions.push("status = ?"); binds.push(trimmed(payload.status, 30)); }
  const keyword = trimmed(payload.keyword, 100);
  if (keyword) { conditions.push("(title LIKE ? OR content_key LIKE ?)"); binds.push(`%${keyword}%`, `%${keyword}%`); }
  const where = conditions.join(" AND ");
  const [rows, total, summary] = await Promise.all([
    db.prepare(`SELECT id, content_type, content_key, title, payload_json, status, publish_at, version,
      review_note, submitted_by, submitted_at, reviewed_by, reviewed_at, updated_at
      FROM content_items WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).bind(...binds, pageSize, offset).all<Record<string, unknown>>(),
    db.prepare(`SELECT COUNT(*) AS count FROM content_items WHERE ${where}`).bind(...binds).first<{ count: number }>(),
    db.prepare("SELECT content_type, status, COUNT(*) AS count FROM content_items WHERE content_type IN ('exam_event','exam_notice','job_position') GROUP BY content_type, status").all(),
  ]);
  const radarSummary = summary.results as Array<Record<string, unknown>>;
  const countType = (type: string) => radarSummary.filter((item) => String(item.content_type) === type).reduce((sum, item) => sum + Number(item.count ?? 0), 0);
  const countStatus = (status: string) => radarSummary.filter((item) => String(item.status) === status).reduce((sum, item) => sum + Number(item.count ?? 0), 0);
  return json({ content: parseContentRows(rows.results), pagination: { page, pageSize, total: Number(total?.count ?? 0) }, summary: radarSummary, stats: {
    total: radarSummary.reduce((sum, item) => sum + Number(item.count ?? 0), 0),
    notices: countType("exam_notice"), events: countType("exam_event"), positions: countType("job_position"),
    pendingReview: countStatus("pending_review"), published: countStatus("published"),
  } });
}

async function adminGetContent(payload: Record<string, unknown>) {
  const id = Math.floor(Number(payload.id));
  const contentKey = trimmed(payload.contentKey, 80);
  if ((!Number.isFinite(id) || id < 1) && !contentKey) return json({ error: "内容不存在" }, 400);
  const row = id > 0
    ? await getD1().prepare(`SELECT * FROM content_items WHERE id = ?`).bind(id).first<Record<string, unknown>>()
    : await getD1().prepare(`SELECT * FROM content_items WHERE content_key = ?`).bind(contentKey).first<Record<string, unknown>>();
  if (!row) return json({ error: "内容不存在" }, 404);
  const permission: AdminPermission = new Set(["exam_event", "exam_notice", "job_position"]).has(String(row.content_type)) ? "radar.read" : "content.read";
  if (!canAdmin(payload, permission)) return adminForbidden(permission);
  return json({ content: parseContentRows([row])[0] });
}

async function adminListGrowth(payload: Record<string, unknown>) {
  if (!canAdmin(payload, "growth.read")) return adminForbidden("growth.read");
  const db = getD1();
  const [codes, redemptions, events, activeUsers, rewardDays, monthlyCap] = await Promise.all([
    db.prepare(`SELECT id, code_preview, batch_name, duration_days, max_uses, used_count, status, valid_until, created_at
      FROM redemption_codes ORDER BY id DESC LIMIT 300`).all(),
    db.prepare(`SELECT r.id, r.redeemed_at, r.user_id, c.code_preview, c.duration_days
      FROM redemptions r JOIN redemption_codes c ON c.id = r.code_id ORDER BY r.id DESC LIMIT 300`).all(),
    db.prepare("SELECT event_name, COUNT(*) AS count FROM analytics_events WHERE created_at >= datetime('now','-7 days') GROUP BY event_name ORDER BY count DESC").all(),
    db.prepare("SELECT COUNT(DISTINCT user_id) AS count FROM analytics_events WHERE created_at >= datetime('now','-7 days')").first<{ count: number }>(),
    getConfigNumber("invite_reward_days", 3),
    getConfigNumber("invite_monthly_cap", 30),
  ]);
  return json({ codes: codes.results, redemptions: redemptions.results, config: { rewardDays, monthlyCap },
    analytics: { activeUsers: Number(activeUsers?.count ?? 0), eventCounts: events.results } });
}

async function adminListAnalytics(payload: Record<string, unknown>) {
  if (!canAdmin(payload, "analytics.read")) return adminForbidden("analytics.read");
  const db = getD1();
  const days = Number(payload.days) <= 14 ? 14 : 30;
  const windowModifier = `-${days} days`;
  const [totalUsers, active7, active30, members, attempts30, dailyTrend, eventCounts, modules, redemptions30, invites30] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS count FROM users").first<{ count: number }>(),
    db.prepare("SELECT COUNT(DISTINCT user_id) AS count FROM analytics_events WHERE created_at >= datetime('now','-7 days')").first<{ count: number }>(),
    db.prepare("SELECT COUNT(DISTINCT user_id) AS count FROM analytics_events WHERE created_at >= datetime('now','-30 days')").first<{ count: number }>(),
    db.prepare("SELECT COUNT(*) AS count FROM users WHERE datetime(membership_end) > CURRENT_TIMESTAMP").first<{ count: number }>(),
    db.prepare(`SELECT COUNT(*) AS answers, COALESCE(AVG(is_correct),0) AS accuracy FROM practice_attempts
      WHERE answered_at >= datetime('now','-30 days')`).first<{ answers: number; accuracy: number }>(),
    db.prepare(`SELECT date(created_at,'+8 hours') AS date, COUNT(DISTINCT user_id) AS active_users,
      SUM(CASE WHEN event_name = 'app_open' THEN 1 ELSE 0 END) AS opens,
      SUM(CASE WHEN event_name = 'practice_answer' THEN 1 ELSE 0 END) AS answers
      FROM analytics_events WHERE created_at >= datetime('now', ?)
      GROUP BY date(created_at,'+8 hours') ORDER BY date ASC`).bind(windowModifier).all<Record<string, unknown>>(),
    db.prepare(`SELECT event_name, COUNT(*) AS count, COUNT(DISTINCT user_id) AS users
      FROM analytics_events WHERE created_at >= datetime('now','-30 days') GROUP BY event_name ORDER BY count DESC`).all<Record<string, unknown>>(),
    db.prepare(`SELECT module, COUNT(*) AS answers, COALESCE(AVG(is_correct),0) AS accuracy
      FROM practice_attempts WHERE answered_at >= datetime('now','-30 days') GROUP BY module ORDER BY answers DESC`).all<Record<string, unknown>>(),
    db.prepare("SELECT COUNT(*) AS count FROM redemptions WHERE redeemed_at >= datetime('now','-30 days')").first<{ count: number }>(),
    db.prepare("SELECT COUNT(*) AS count FROM invite_relations WHERE bound_at >= datetime('now','-30 days')").first<{ count: number }>(),
  ]);
  const events = eventCounts.results;
  const eventUsers = (eventName: string) => Number(events.find((item) => String(item.event_name) === eventName)?.users ?? 0);
  const funnelBase = eventUsers("app_open");
  const funnelSteps = [
    { key: "app_open", label: "打开应用", users: funnelBase },
    { key: "practice_batch", label: "领取练习", users: eventUsers("practice_batch") },
    { key: "practice_answer", label: "完成答题", users: eventUsers("practice_answer") },
  ];
  return json({
    overview: {
      totalUsers: Number(totalUsers?.count ?? 0), activeUsers7d: Number(active7?.count ?? 0), activeUsers30d: Number(active30?.count ?? 0),
      memberUsers: Number(members?.count ?? 0), practiceAnswers30d: Number(attempts30?.answers ?? 0),
      accuracy30d: Math.round(Number(attempts30?.accuracy ?? 0) * 10_000) / 100,
    },
    dailyTrend: dailyTrend.results.map((item) => ({ date: item.date, activeUsers: Number(item.active_users ?? 0), opens: Number(item.opens ?? 0), answers: Number(item.answers ?? 0) })),
    funnel: funnelSteps.map((step) => ({ ...step, rate: funnelBase > 0 ? Math.round(step.users / funnelBase * 10_000) / 100 : 0 })),
    eventCounts: events.map((item) => ({ eventName: item.event_name, count: Number(item.count ?? 0), users: Number(item.users ?? 0) })),
    moduleStats: modules.results.map((item) => ({ module: item.module, answers: Number(item.answers ?? 0), accuracy: Math.round(Number(item.accuracy ?? 0) * 10_000) / 100 })),
    growth: { redemptions30d: Number(redemptions30?.count ?? 0), invites30d: Number(invites30?.count ?? 0) },
    days,
  });
}

async function adminListUsers(payload: Record<string, unknown>) {
  if (!canAdmin(payload, "system.read") && !canAdmin(payload, "users.manage")) return adminForbidden("system.read");
  const rows = await getD1().prepare(`SELECT id, username, display_name, role, status, last_login_at, created_by, created_at, updated_at
    FROM admin_users ORDER BY id ASC`).all();
  return json({ admins: rows.results.map((row) => ({
    id: row.id, username: row.username, displayName: row.display_name, role: row.role, status: row.status,
    lastLoginAt: row.last_login_at, createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at,
  })) });
}

async function adminListAuditLogs(payload: Record<string, unknown>) {
  if (!canAdmin(payload, "audit.read")) return adminForbidden("audit.read");
  const { page, pageSize, offset } = listPagination(payload, 100);
  const conditions = ["1=1"];
  const binds: unknown[] = [];
  if (payload.action) { conditions.push("action = ?"); binds.push(trimmed(payload.action, 100)); }
  if (payload.username) { conditions.push("username LIKE ?"); binds.push(`%${trimmed(payload.username, 40)}%`); }
  if (payload.result) { conditions.push("result = ?"); binds.push(trimmed(payload.result, 20)); }
  const where = conditions.join(" AND ");
  const db = getD1();
  const [rows, total] = await Promise.all([
    db.prepare(`SELECT id, admin_user_id, username, role, action, resource_type, resource_id, summary,
      result, details_json, ip_address, created_at FROM admin_audit_logs WHERE ${where}
      ORDER BY id DESC LIMIT ? OFFSET ?`).bind(...binds, pageSize, offset).all<Record<string, unknown>>(),
    db.prepare(`SELECT COUNT(*) AS count FROM admin_audit_logs WHERE ${where}`).bind(...binds).first<{ count: number }>(),
  ]);
  const auditLogs = rows.results.map((row) => {
    let details: unknown = {};
    try { details = JSON.parse(String(row.details_json ?? "{}")); } catch { details = {}; }
    return { id: row.id, adminUserId: row.admin_user_id, username: row.username, role: row.role,
      action: row.action, resourceType: row.resource_type, resourceId: row.resource_id, summary: row.summary,
      result: row.result, details, ipAddress: row.ip_address, createdAt: row.created_at };
  });
  return json({ auditLogs, pagination: { page, pageSize, total: Number(total?.count ?? 0) } });
}

async function adminListSystem(payload: Record<string, unknown>) {
  if (!canAdmin(payload, "system.read") && !canAdmin(payload, "users.manage") && !canAdmin(payload, "audit.read")) return adminForbidden("system.read");
  const db = getD1();
  const { page, pageSize, offset } = listPagination(payload, 100);
  const [admins, audit, total] = await Promise.all([
    db.prepare(`SELECT id, username, display_name, role, status, last_login_at, created_by, created_at, updated_at
      FROM admin_users ORDER BY id ASC`).all(),
    db.prepare(`SELECT id, admin_user_id, username, role, action, resource_type, resource_id, summary,
      result, details_json, ip_address, created_at FROM admin_audit_logs ORDER BY id DESC LIMIT ? OFFSET ?`).bind(pageSize, offset).all<Record<string, unknown>>(),
    db.prepare("SELECT COUNT(*) AS count FROM admin_audit_logs").first<{ count: number }>(),
  ]);
  return json({
    admins: (canAdmin(payload, "system.read") || canAdmin(payload, "users.manage") ? admins.results : []).map((row) => ({ id: row.id, username: row.username, displayName: row.display_name,
      role: row.role, status: row.status, lastLoginAt: row.last_login_at, createdAt: row.created_at })),
    auditLogs: audit.results.map((row) => ({ id: row.id, adminUserId: row.admin_user_id, username: row.username,
      role: row.role, action: row.action, resourceType: row.resource_type, resourceId: row.resource_id,
      summary: row.summary, result: row.result, details: (() => { try { return JSON.parse(String(row.details_json)); } catch { return {}; } })(),
      ipAddress: row.ip_address, createdAt: row.created_at })),
    pagination: { page, pageSize, total: Number(total?.count ?? 0) },
  });
}

async function adminCreateUser(payload: Record<string, unknown>) {
  if (!canAdmin(payload, "users.manage")) return adminForbidden("users.manage");
  const username = trimmed(payload.username, 40).normalize("NFKC").toLowerCase();
  const displayName = trimmed(payload.displayName, 80);
  const password = String(payload.password ?? "");
  if (!/^[a-z0-9][a-z0-9._-]{2,39}$/.test(username)) return json({ error: "管理员账号需为3—40位小写字母、数字、点、横线或下划线" }, 400);
  if (!displayName) return json({ error: "请输入管理员姓名" }, 400);
  if (password.length < 10 || password.length > 128) return json({ error: "管理员密码需为10—128位" }, 400);
  if (!isAdminRole(payload.role)) return json({ error: "管理员角色无效" }, 400);
  const current = adminFromPayload(payload)!;
  const passwordRecord = await createPasswordRecord(password);
  try {
    const result = await getD1().prepare(`INSERT INTO admin_users
      (username, display_name, password_hash, password_salt, password_iterations, role, status, created_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?, CURRENT_TIMESTAMP)`)
      .bind(username, displayName, passwordRecord.hash, passwordRecord.salt, passwordRecord.iterations, payload.role, current.id).run();
    return json({ ok: true, admin: { id: Number(result.meta.last_row_id), username, displayName, role: payload.role, status: "active" } }, 201);
  } catch {
    return json({ error: "管理员账号已存在" }, 409);
  }
}

async function activeSuperAdminCount() {
  const value = await getD1().prepare("SELECT COUNT(*) AS count FROM admin_users WHERE role = 'super_admin' AND status = 'active'").first<{ count: number }>();
  return Number(value?.count ?? 0);
}

async function adminSetUserStatus(payload: Record<string, unknown>) {
  if (!canAdmin(payload, "users.manage")) return adminForbidden("users.manage");
  const id = Math.floor(Number(payload.id));
  const status = payload.status === "active" ? "active" : payload.status === "disabled" ? "disabled" : "";
  if (!Number.isFinite(id) || id < 1 || !status) return json({ error: "管理员或状态无效" }, 400);
  const current = adminFromPayload(payload)!;
  if (id === current.id && status === "disabled") return json({ error: "不能停用当前登录账号" }, 400);
  const target = await getD1().prepare("SELECT role, status FROM admin_users WHERE id = ?").bind(id).first<{ role: string; status: string }>();
  if (!target) return json({ error: "管理员不存在" }, 404);
  if (target.role === "super_admin" && target.status === "active" && status === "disabled" && await activeSuperAdminCount() <= 1) return json({ error: "至少需要保留一名启用的超级管理员" }, 400);
  await getD1().batch([
    getD1().prepare("UPDATE admin_users SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(status, id),
    getD1().prepare("UPDATE admin_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE admin_user_id = ? AND revoked_at IS NULL AND ? = 'disabled'").bind(id, status),
  ]);
  return json({ ok: true, id, status });
}

async function adminUpdateUser(payload: Record<string, unknown>) {
  if (!canAdmin(payload, "users.manage")) return adminForbidden("users.manage");
  const id = Math.floor(Number(payload.id));
  const db = getD1();
  const target = await db.prepare("SELECT id, role, status FROM admin_users WHERE id = ?").bind(id).first<{ id: number; role: string; status: string }>();
  if (!target) return json({ error: "管理员不存在" }, 404);
  const displayName = payload.displayName === undefined ? null : trimmed(payload.displayName, 80);
  const role = payload.role === undefined ? null : String(payload.role);
  if (displayName !== null && !displayName) return json({ error: "管理员姓名不能为空" }, 400);
  if (role !== null && !isAdminRole(role)) return json({ error: "管理员角色无效" }, 400);
  if (target.role === "super_admin" && role && role !== "super_admin" && target.status === "active" && await activeSuperAdminCount() <= 1) return json({ error: "至少需要保留一名启用的超级管理员" }, 400);
  const statements = [db.prepare(`UPDATE admin_users SET display_name = COALESCE(?, display_name),
    role = COALESCE(?, role), updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(displayName, role, id)];
  if (payload.password !== undefined) {
    const password = String(payload.password);
    if (password.length < 10 || password.length > 128) return json({ error: "管理员密码需为10—128位" }, 400);
    const record = await createPasswordRecord(password);
    statements.push(db.prepare(`UPDATE admin_users SET password_hash = ?, password_salt = ?, password_iterations = ?,
      updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(record.hash, record.salt, record.iterations, id));
    statements.push(db.prepare("UPDATE admin_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE admin_user_id = ? AND revoked_at IS NULL").bind(id));
  }
  await db.batch(statements);
  return json({ ok: true, id });
}

async function adminSubmitContentReview(payload: Record<string, unknown>) {
  payload.status = "pending_review";
  return adminSetContentStatus(payload);
}

async function adminReviewContent(payload: Record<string, unknown>) {
  const admin = adminFromPayload(payload);
  if (!admin || (admin.role !== "reviewer" && admin.role !== "super_admin")) return adminForbidden("content.review");
  if (payload.decision === "reject") payload.status = "rejected";
  else if (payload.decision === "approve") {
    const contentId = Math.floor(Number(payload.id));
    const content = await getD1().prepare("SELECT publish_at, payload_json FROM content_items WHERE id = ?")
      .bind(contentId).first<{ publish_at: string | null; payload_json: string }>();
    if (!content) return json({ error: "内容不存在" }, 404);
    let storedRequestedAt = "";
    try {
      const storedPayload = JSON.parse(content.payload_json) as Record<string, unknown>;
      storedRequestedAt = String(storedPayload.requestedPublishAt ?? storedPayload.publishAt ?? "");
    } catch { storedRequestedAt = ""; }
    const requestedAt = String(payload.publishAt ?? payload.requestedPublishAt ?? content.publish_at ?? storedRequestedAt ?? "");
    const publishAt = requestedAt ? Date.parse(requestedAt) : 0;
    if (publishAt > Date.now()) payload.publishAt = new Date(publishAt).toISOString();
    payload.status = publishAt > Date.now() ? "scheduled" : "published";
  } else return json({ error: "审核决定无效" }, 400);
  return adminSetContentStatus(payload);
}

const ADMIN_ACTION_PERMISSIONS: Record<string, AdminPermission[]> = {
  adminDashboard: ["dashboard.read"],
  adminList: ["system.read"],
  adminListQuestions: ["question.read"],
  adminListContent: ["content.read"],
  adminListRadar: ["radar.read"],
  adminListGrowth: ["growth.read"],
  adminListAnalytics: ["analytics.read"],
  adminListSystem: ["system.read", "users.manage", "audit.read"],
  adminListUsers: ["system.read", "users.manage"],
  adminListAuditLogs: ["audit.read"],
  adminGetContent: ["content.read", "radar.read"],
  adminCreateCodes: ["growth.write"],
  adminDisableCode: ["growth.write"],
  adminUpdateConfig: ["growth.write"],
  adminListContentVersions: ["content.read", "radar.read"],
  adminRollbackContent: ["content.publish"],
  adminDisableContent: ["content.publish"],
  adminDuplicateContent: ["content.write", "radar.write"],
  adminUpsertQuestionBank: ["question.write"],
  adminSetQuestionBankStatus: ["question.write"],
  adminStartQuestionImport: ["question.import"],
  adminImportQuestionBatch: ["question.import"],
  adminFinishQuestionImport: ["question.import"],
  adminCreateUser: ["users.manage"],
  adminSetUserStatus: ["users.manage"],
  adminUpdateUser: ["users.manage"],
  adminReviewContent: ["content.review"],
  adminSubmitContentReview: ["content.write", "radar.write"],
};

const ADMIN_WRITE_ACTIONS = new Set([
  "adminCreateCodes", "adminDisableCode", "adminUpdateConfig", "adminUpsertContentBatch",
  "adminDisableContent", "adminSetContentStatus", "adminRollbackContent", "adminDuplicateContent",
  "adminUpsertQuestionBank", "adminSetQuestionBankStatus", "adminStartQuestionImport",
  "adminImportQuestionBatch", "adminFinishQuestionImport", "adminCreateUser", "adminSetUserStatus",
  "adminUpdateUser", "adminSubmitContentReview", "adminReviewContent",
]);

function resourceTypeForAdminAction(action: string) {
  if (action.includes("QuestionImport")) return "question_import";
  if (action.includes("QuestionBank")) return "question_bank";
  if (action.includes("Content")) return "content";
  if (action.includes("Code")) return "redemption_code";
  if (action.includes("Config")) return "config";
  if (action.includes("User")) return "admin_user";
  return "admin";
}

function adminHasAnyPermission(admin: AdminIdentity, permissions: AdminPermission[]) {
  return permissions.some((permission) => hasAdminPermission(admin, permission));
}

async function auditAdminResponse(
  request: Request,
  admin: AdminIdentity,
  action: string,
  payload: Record<string, unknown>,
  response: Response,
) {
  if (!ADMIN_WRITE_ACTIONS.has(action)) return;
  let responseBody: Record<string, unknown> = {};
  try { responseBody = await response.clone().json() as Record<string, unknown>; } catch { responseBody = {}; }
  const resourceId = responseBody.id ?? responseBody.importId ?? payload.id ?? payload.importId ?? payload.bankId ?? "";
  await writeAdminAudit(getD1(), request, admin, {
    action,
    resourceType: resourceTypeForAdminAction(action),
    resourceId: String(resourceId ?? ""),
    summary: response.ok ? `${action} 操作成功` : `${action} 操作失败`,
    result: response.ok ? "success" : "failure",
    details: { request: payload, response: responseBody },
  });
}

async function dispatchAdminAction(request: Request, payload: Record<string, unknown>, action: string) {
  const admin = await getAdminIdentity(getD1(), request);
  if (!admin) return adminUnauthorized();
  setAdminContext(payload, admin);
  const permissions = ADMIN_ACTION_PERMISSIONS[action];
  if (permissions && !adminHasAnyPermission(admin, permissions)) {
    await writeAdminAudit(getD1(), request, admin, {
      action, resourceType: resourceTypeForAdminAction(action), summary: "权限不足，操作被拒绝",
      result: "denied", details: { requiredPermissions: permissions },
    });
    return adminForbidden(permissions[0]);
  }
  let response: Response;
  if (action === "adminDashboard") response = await adminDashboard(payload);
  else if (action === "adminList") response = await adminList(payload);
  else if (action === "adminListQuestions") response = await adminListQuestions(payload);
  else if (action === "adminListContent") response = await adminListContent(payload);
  else if (action === "adminListRadar") response = await adminListRadar(payload);
  else if (action === "adminListGrowth") response = await adminListGrowth(payload);
  else if (action === "adminListAnalytics") response = await adminListAnalytics(payload);
  else if (action === "adminListSystem") response = await adminListSystem(payload);
  else if (action === "adminListUsers") response = await adminListUsers(payload);
  else if (action === "adminListAuditLogs") response = await adminListAuditLogs(payload);
  else if (action === "adminGetContent") response = await adminGetContent(payload);
  else if (action === "adminCreateCodes") response = await adminCreateCodes(payload);
  else if (action === "adminDisableCode") response = await adminDisableCode(payload);
  else if (action === "adminUpdateConfig") response = await adminUpdateConfig(payload);
  else if (action === "adminUpsertContentBatch") response = await adminUpsertContentBatch(payload);
  else if (action === "adminDisableContent") response = await adminDisableContent(payload);
  else if (action === "adminSetContentStatus") response = await adminSetContentStatus(payload);
  else if (action === "adminListContentVersions") response = await adminListContentVersions(payload);
  else if (action === "adminRollbackContent") response = await adminRollbackContent(payload);
  else if (action === "adminDuplicateContent") response = await adminDuplicateContent(payload);
  else if (action === "adminUpsertQuestionBank") response = await adminUpsertQuestionBank(payload);
  else if (action === "adminSetQuestionBankStatus") response = await adminSetQuestionBankStatus(payload);
  else if (action === "adminStartQuestionImport") response = await adminStartQuestionImport(payload);
  else if (action === "adminImportQuestionBatch") response = await adminImportQuestionBatch(payload);
  else if (action === "adminFinishQuestionImport") response = await adminFinishQuestionImport(payload);
  else if (action === "adminCreateUser") response = await adminCreateUser(payload);
  else if (action === "adminSetUserStatus") response = await adminSetUserStatus(payload);
  else if (action === "adminUpdateUser") response = await adminUpdateUser(payload);
  else if (action === "adminSubmitContentReview") response = await adminSubmitContentReview(payload);
  else if (action === "adminReviewContent") response = await adminReviewContent(payload);
  else return json({ error: "未知管理操作" }, 400);
  await auditAdminResponse(request, admin, action, payload, response);
  return response;
}

export async function GET(request: Request) {
  try {
    await ensureSchema();
    const url = new URL(request.url);
    const mediaId = url.searchParams.get("media");
    if (mediaId) return serveMedia(mediaId, request);
    return await bootstrap(request);
  } catch (error) { return json({ error: error instanceof Error ? error.message : "初始化失败" }, 500); }
}

export async function POST(request: Request) {
  try {
    await ensureSchema();
    await seedDefaults();
    if ((request.headers.get("content-type") ?? "").toLowerCase().includes("multipart/form-data")) {
      const admin = await getAdminIdentity(getD1(), request);
      if (!admin) return adminUnauthorized();
      if (!hasAdminPermission(admin, "media.upload")) {
        await writeAdminAudit(getD1(), request, admin, { action: "adminUploadMedia", resourceType: "media", summary: "权限不足，媒体上传被拒绝", result: "denied" });
        return adminForbidden("media.upload");
      }
      const response = await adminUploadMedia(request, admin);
      let responseBody: Record<string, unknown> = {};
      try { responseBody = await response.clone().json() as Record<string, unknown>; } catch { responseBody = {}; }
      const asset = responseBody.asset as Record<string, unknown> | undefined;
      await writeAdminAudit(getD1(), request, admin, {
        action: "adminUploadMedia", resourceType: "media", resourceId: String(asset?.id ?? ""),
        summary: response.ok ? "媒体上传成功" : "媒体上传失败", result: response.ok ? "success" : "failure",
        details: responseBody,
      });
      return response;
    }
    const payload = (await request.json()) as Record<string, unknown>;
    const action = String(payload.action ?? "");
    if (action === "adminLogin") return adminLogin(request, payload);
    if (action === "adminSession") return adminSession(request);
    if (action === "adminLogout") return adminLogout(request);
    if (action.startsWith("admin")) {
      delete payload.adminToken;
      return dispatchAdminAction(request, payload, action);
    }
    const identity = await ensureUser(request);
    let response: Response;
    if (action === "saveProgress") response = await saveProgress(identity.userId, payload);
    else if (action === "saveExamProfile") response = await saveExamProfile(identity.userId, payload);
    else if (action === "toggleQuestionBank") response = await toggleQuestionBank(identity.userId, payload);
    else if (action === "getPracticeBatch") response = await getPracticeBatch(identity.userId, payload);
    else if (action === "getEssayPracticeBatch") response = await getEssayPracticeBatch(identity.userId, payload);
    else if (action === "submitPracticeAnswer") response = await submitPracticeAnswer(identity.userId, payload);
    else if (action === "updateQuestionMeta") response = await updateQuestionMeta(identity.userId, payload);
    else if (action === "bindInvite") response = await bindInvite(identity.userId, payload);
    else if (action === "redeem") response = await redeem(identity.userId, payload);
    else if (action === "trackEvent") response = await trackEvent(identity.userId, payload);
    else response = json({ error: "未知操作" }, 400);
    if (identity.setCookie) response.headers.set("set-cookie", identity.setCookie);
    return response;
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "请求失败" }, 500);
  }
}
