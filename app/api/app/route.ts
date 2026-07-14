import { env } from "cloudflare:workers";
import { ensureSchema, getD1 } from "../../../db/runtime";
import { practiceDays as defaultPracticeDays, type PracticeDay, type Question } from "../../data/content";
import { audioTracks as defaultAudioTracks, type AudioTrack } from "../../data/audio";

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
]);

const STARTER_BANK_CODE = "starter-gk";
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
}

async function getConfigNumber(key: string, fallback: number) {
  const row = await getD1().prepare("SELECT value FROM configs WHERE key = ?").bind(key).first<{ value: string }>();
  const value = Number(row?.value);
  return Number.isFinite(value) ? value : fallback;
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
  if (rows.results.length) return rows.results.map((row) => row.bank_code);
  await getD1().prepare("INSERT OR IGNORE INTO user_question_banks (user_id, bank_code) VALUES (?, ?)")
    .bind(userId, STARTER_BANK_CODE).run();
  return [STARTER_BANK_CODE];
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
  const starterCodes = starterQuestionList().map((question) => question.id);
  const placeholders = starterCodes.map(() => "?").join(",");
  const starterProgress = starterCodes.length
    ? await db.prepare(`SELECT state, last_answered_at, next_review_at FROM user_question_progress WHERE user_id = ? AND question_code IN (${placeholders})`)
      .bind(userId, ...starterCodes).all<{ state: string; last_answered_at: string | null; next_review_at: string | null }>()
    : { results: [] as Array<{ state: string; last_answered_at: string | null; next_review_at: string | null }> };
  const starter = {
    code: STARTER_BANK_CODE,
    name: "公考日练·行测基础",
    examType: "通用",
    province: "全国",
    examYear: new Date().getFullYear(),
    subject: "行测",
    description: "覆盖言语、判断、资料、数量、政治理论和常识，适合建立日练节奏。",
    coverColor: "blue",
    questionCount: starterCodes.length,
    studiedCount: starterProgress.results.filter((item) => item.last_answered_at).length,
    masteredCount: starterProgress.results.filter((item) => item.state === "mastered").length,
    weakCount: starterProgress.results.filter((item) => item.state === "weak").length,
    dueCount: starterProgress.results.filter((item) => item.next_review_at && Date.parse(item.next_review_at) <= Date.now()).length,
    added: selected.includes(STARTER_BANK_CODE),
    targetMatch: true,
    recommended: false,
    scopeLabel: "通用基础 · 非国考/省考真题",
    mismatchReason: "只用于练习基础题型，不代表目标考试的命题特点。",
  };
  return [starter, ...rows.results.map((row) => {
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
  }; })];
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

async function loadContent(membershipActive: boolean) {
  const rows = await getD1().prepare(`SELECT content_type, content_key, payload_json
    FROM content_items WHERE status = 'published' AND (publish_at IS NULL OR publish_at <= CURRENT_TIMESTAMP)
    ORDER BY id ASC`).all<{ content_type: string; content_key: string; payload_json: string }>();
  const dayMap = new Map(defaultPracticeDays.map((day) => [`day-${day.day}`, clone(day)]));
  const audioMap = new Map(defaultAudioTracks.map((track) => [track.id, clone(track)]));
  const examEventMap = new Map<string, PublishedExamEvent>();
  for (const row of rows.results) {
    try {
      const parsed = JSON.parse(row.payload_json) as PracticeDay | AudioTrack | Record<string, unknown>;
      if (row.content_type === "practice_day") dayMap.set(row.content_key, parsed as PracticeDay);
      if (row.content_type === "audio_track") audioMap.set(row.content_key, parsed as AudioTrack);
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
    } catch {
      // Invalid draft data never blocks the learner experience.
    }
  }
  const practiceDays = Array.from(dayMap.values()).sort((a, b) => a.day - b.day);
  const audioTracks = Array.from(audioMap.values());
  const examEvents = Array.from(examEventMap.values()).sort((a, b) => a.eventDate.localeCompare(b.eventDate));
  if (membershipActive) return { practiceDays, audioTracks, examEvents, access: "premium" as const };

  const previewDay = clone(practiceDays[0]);
  previewDay.questions = previewDay.questions.slice(0, 5).map((question) => ({ ...question, explanation: "会员可查看完整解析与解题技巧。" }));
  previewDay.currentAffairs = previewDay.currentAffairs.slice(0, 3);
  previewDay.essay.expressions = previewDay.essay.expressions.slice(0, 1);
  previewDay.essay.reference = "兑换会员码后查看参考答案。";
  return { practiceDays: [previewDay], audioTracks: audioTracks.slice(0, 1), examEvents, access: "preview" as const };
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
  const content = await loadContent(membershipActive);
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
    const [remaining, available] = await Promise.all([
      db.prepare("SELECT bank_code FROM user_question_banks WHERE user_id = ?").bind(userId).all<{ bank_code: string }>(),
      db.prepare(`SELECT COUNT(DISTINCT q.id) AS total FROM user_question_banks uqb
        JOIN question_banks qb ON qb.bank_code = uqb.bank_code AND qb.status = 'published'
        JOIN question_bank_items qbi ON qbi.bank_id = qb.id
        JOIN questions q ON q.id = qbi.question_id AND q.status = 'active'
        WHERE uqb.user_id = ?`).bind(userId).first<{ total: number }>(),
    ]);
    const hasStarter = remaining.results.some((item) => item.bank_code === STARTER_BANK_CODE);
    if (!hasStarter && !Number(available?.total ?? 0)) {
      await db.prepare("INSERT OR IGNORE INTO user_question_banks (user_id, bank_code) VALUES (?, ?)").bind(userId, STARTER_BANK_CODE).run();
    }
  }
  return json({ ok: true, banks: await loadQuestionBanks(userId), profile: await loadExamProfile(userId) });
}

async function dbQuestionCandidates(userId: string, bankCodes: string[]) {
  if (!bankCodes.length) return [] as Array<{ question: ResolvedQuestion; progress?: QuestionProgressRow }>;
  const placeholders = bankCodes.map(() => "?").join(",");
  const rows = await getD1().prepare(`WITH candidates AS (
      SELECT q.question_code, q.module, q.sub_type, q.stem, q.options_json,
        q.answer, q.explanation, q.technique, q.difficulty, q.source, q.updated_at,
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
        ORDER BY priority_rank, COALESCE(last_answered_at, '1970-01-01'), sort_order, question_code
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
  const strictFocus = payload.strictFocus === true;
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
  const bankOrder = new Map(bankCodes.map((code, index) => [code, index]));
  const allSorted = [...candidates].sort((a, b) => priorityFor(a.progress) - priorityFor(b.progress)
    || Number(bankOrder.get(a.question.bankCode) ?? 99) - Number(bankOrder.get(b.question.bankCode) ?? 99)
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

  const profile = await loadExamProfile(userId);
  const urgentTargets = new Set(profile.targets.filter((target) => {
    if (!target.examDate) return false;
    const days = Math.ceil((Date.parse(`${target.examDate}T23:59:59+08:00`) - Date.now()) / 86_400_000);
    return Number.isFinite(days) && days >= 0 && days <= 30;
  }).map((target) => target.code));
  const targetByBank = new Map(candidates.map((item) => [item.question.bankCode, item.question.targetCode]));
  const urgentBankCodes = new Set(bankCodes.filter((code) => {
    const targetCode = targetByBank.get(code);
    return Boolean(targetCode && urgentTargets.has(targetCode));
  }));
  const otherBankCodes = bankCodes.filter((code) => code !== primaryBankCode);
  const bankCycle = primaryBankCode ? [primaryBankCode, ...otherBankCodes, primaryBankCode] : [...bankCodes];
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
    const focusPool = sorted.filter((item) => item.question.module.includes(focusModule) || item.question.knowledge.includes(focusModule));
    chosen = [];
    takeBalanced(focusPool, requestedLimit, chosen, bankCycle);
  } else {
    const due = sorted.filter((item) => Boolean(item.progress?.next_review_at && Date.parse(item.progress.next_review_at) <= Date.now()));
    const fresh = sorted.filter((item) => !item.progress);
    const focusFresh = focusModule ? fresh.filter((item) => item.question.module.includes(focusModule) || item.question.knowledge.includes(focusModule)) : fresh;
    const selectedItems: typeof sorted = [];
    takeBalanced(due, Math.ceil(requestedLimit * 0.6), selectedItems, bankCycle);
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

async function resolveQuestion(questionCode: string, bankCode: string) {
  const starter = starterQuestionList().find((question) => question.id === questionCode && bankCode === STARTER_BANK_CODE);
  if (starter) return starter;
  const row = await getD1().prepare(`SELECT q.question_code, q.module, q.sub_type, q.stem, q.options_json, q.answer,
    q.explanation, q.technique, q.difficulty, q.source, q.updated_at, qb.bank_code, qb.name AS bank_name,
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
  const targetSeconds = targetSecondsFor(question);
  const overtime = durationMs > targetSeconds * 1000;
  const needsReview = !correct || uncertain || overtime;
  const isDue = Boolean(previous?.next_review_at && Date.parse(previous.next_review_at) <= Date.now());
  const correctCount = Number(previous?.correct_count ?? 0) + (correct ? 1 : 0);
  const wrongCount = Number(previous?.wrong_count ?? 0) + (correct ? 0 : 1);
  const uncertainCount = Number(previous?.uncertain_count ?? 0) + (uncertain ? 1 : 0);
  const previousStage = Math.max(0, Math.min(4, Number(previous?.review_stage ?? 0)));
  const reviewStage = needsReview
    ? 0
    : previous
      ? isDue ? Math.min(4, previousStage + 1) : Math.max(1, previousStage)
      : 1;
  const reviewDays = [1, 3, 7, 14, 30][reviewStage];
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

function isAdmin(payload: Record<string, unknown>) {
  const configured = getAdminSecret();
  const supplied = String(payload.adminToken ?? "");
  return Boolean(configured && supplied && configured === supplied);
}

async function adminList(payload: Record<string, unknown>) {
  if (!isAdmin(payload)) return json({ error: "管理员口令错误" }, 401);
  const db = getD1();
  const [codes, redemptions, content, questionBanks, questionImports, eventCounts, activeUsers, rewardDays, monthlyCap] = await Promise.all([
    db.prepare(`SELECT id, code_preview, batch_name, duration_days, max_uses, used_count, status, valid_until, created_at
      FROM redemption_codes ORDER BY id DESC LIMIT 100`).all(),
    db.prepare(`SELECT r.redeemed_at, r.user_id, c.code_preview, c.duration_days
      FROM redemptions r JOIN redemption_codes c ON c.id = r.code_id ORDER BY r.id DESC LIMIT 100`).all(),
    db.prepare(`SELECT id, content_type, content_key, title, status, publish_at, updated_at
      FROM content_items ORDER BY id DESC LIMIT 100`).all(),
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
    content: content.results,
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
  const statements: D1PreparedStatement[] = [];
  for (const raw of payload.items) {
    const item = raw as Record<string, unknown>;
    const contentType = String(item.contentType ?? "");
    const contentKey = String(item.contentKey ?? "").trim();
    const title = String(item.title ?? "").trim().slice(0, 120);
    const status = item.status === "published" ? "published" : "draft";
    if (!new Set(["practice_day", "audio_track", "exam_event"]).has(contentType)) return json({ error: `不支持的内容类型：${contentType}` }, 400);
    if (!/^[a-z0-9][a-z0-9_-]{2,80}$/i.test(contentKey) || !title) return json({ error: "内容标识或标题无效" }, 400);
    const payloadJson = JSON.stringify(item.payload ?? {});
    if (payloadJson.length > 120_000) return json({ error: `${contentKey} 内容过大` }, 400);
    let publishAt: string | null = null;
    if (item.publishAt) {
      const value = Date.parse(String(item.publishAt));
      if (!Number.isFinite(value)) return json({ error: `${contentKey} 发布时间无效` }, 400);
      publishAt = new Date(value).toISOString();
    }
    statements.push(db.prepare(`INSERT INTO content_items
      (content_type, content_key, title, payload_json, status, publish_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(content_key) DO UPDATE SET content_type = excluded.content_type, title = excluded.title,
        payload_json = excluded.payload_json, status = excluded.status, publish_at = excluded.publish_at, updated_at = CURRENT_TIMESTAMP`)
      .bind(contentType, contentKey, title, payloadJson, status, publishAt));
  }
  await db.batch(statements);
  return json({ ok: true, count: statements.length });
}

async function adminDisableContent(payload: Record<string, unknown>) {
  if (!isAdmin(payload)) return json({ error: "管理员口令错误" }, 401);
  await getD1().prepare("UPDATE content_items SET status = 'draft', updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(Number(payload.id)).run();
  return json({ ok: true });
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
  const options = Array.isArray(item.options) ? item.options.map((value) => trimmed(value, 2_000)).filter(Boolean).slice(0, 8) : [];
  const scoringPoints = Array.isArray(item.scoringPoints) ? item.scoringPoints.map((value) => trimmed(value, 500)).filter(Boolean).slice(0, 30) : [];
  const answer = trimmed(item.answer, 8).toUpperCase() || null;
  if (!/^[A-Z0-9][A-Z0-9_-]{2,79}$/.test(questionCode)) return { error: "题目编号格式错误" };
  if (!new Set(["行测", "申论"]).has(subject)) return { error: "科目只能是行测或申论" };
  if (!questionModule) return { error: "模块不能为空" };
  if (!stem) return { error: "题干/材料不能为空" };
  if (!source) return { error: "来源不能为空，请填写考试、年份或原创说明" };
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
           material, prompt, word_limit, scoring_points_json, difficulty, source, status, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', CURRENT_TIMESTAMP)
          ON CONFLICT(question_code) DO UPDATE SET subject = excluded.subject, module = excluded.module,
            sub_type = excluded.sub_type, stem = excluded.stem, options_json = excluded.options_json,
            answer = excluded.answer, explanation = excluded.explanation, technique = excluded.technique,
            material = excluded.material, prompt = excluded.prompt, word_limit = excluded.word_limit,
            scoring_points_json = excluded.scoring_points_json, difficulty = excluded.difficulty,
            source = excluded.source, status = 'active', updated_at = CURRENT_TIMESTAMP`)
          .bind(item.questionCode, item.subject, item.module, item.subType ?? "", item.stem,
            JSON.stringify(item.options ?? []), item.answer ?? null, item.explanation ?? "", item.technique ?? "",
            item.material ?? "", item.prompt ?? "", item.wordLimit ?? null, JSON.stringify(item.scoringPoints ?? []),
            item.difficulty ?? "中等", item.source ?? ""),
        db.prepare(`INSERT OR IGNORE INTO question_bank_items (bank_id, question_id, sort_order)
          SELECT ?, id, ? FROM questions WHERE question_code = ?`).bind(bankId, offset + index, item.questionCode),
      );
    });
    await db.batch(statements);
  }
  await db.prepare(`UPDATE question_imports SET imported_rows = imported_rows + ?, failed_rows = failed_rows + ?
    WHERE id = ?`).bind(accepted.length, errors.length, importId).run();
  return json({ ok: true, imported: accepted.length, failed: errors.length, errors });
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

export async function GET(request: Request) {
  try { return await bootstrap(request); } catch (error) { return json({ error: error instanceof Error ? error.message : "初始化失败" }, 500); }
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
      if (action === "adminUpsertContentBatch") return adminUpsertContentBatch(payload);
      if (action === "adminDisableContent") return adminDisableContent(payload);
      if (action === "adminUpsertQuestionBank") return adminUpsertQuestionBank(payload);
      if (action === "adminSetQuestionBankStatus") return adminSetQuestionBankStatus(payload);
      if (action === "adminStartQuestionImport") return adminStartQuestionImport(payload);
      if (action === "adminImportQuestionBatch") return adminImportQuestionBatch(payload);
      if (action === "adminFinishQuestionImport") return adminFinishQuestionImport(payload);
      return json({ error: "未知管理操作" }, 400);
    }
    const identity = await ensureUser(request);
    let response: Response;
    if (action === "saveProgress") response = await saveProgress(identity.userId, payload);
    else if (action === "saveExamProfile") response = await saveExamProfile(identity.userId, payload);
    else if (action === "toggleQuestionBank") response = await toggleQuestionBank(identity.userId, payload);
    else if (action === "getPracticeBatch") response = await getPracticeBatch(identity.userId, payload);
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
