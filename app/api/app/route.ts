import { env } from "cloudflare:workers";
import { ensureSchema, getD1 } from "../../../db/runtime";
import { practiceDays as defaultPracticeDays, type PracticeDay, type Question } from "../../data/content";
import { audioTracks as defaultAudioTracks, type AudioTrack } from "../../data/audio";
import { scheduleRequestTask } from "../../../worker/execution-context";
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
import {
  QUESTION_BANK_CAN_PUBLISH_SQL,
  QUESTION_BANK_PUBLISHABLE_ITEM_SQL,
  inspectQuestionBankIdentityChange,
  questionMatchesQuestionBankScope,
} from "./question-bank-policy.mjs";
import { RELIABLE_FREQUENCY_SQL } from "./study-insights-sql.mjs";
import { eligibleFirstAttemptSql, platformScoreRateIncrementSql } from "./score-rate-sql.mjs";
import { QUESTION_VALUE_METRICS_SQL, questionValueMetricBindsForReview } from "./question-value-metrics-sql.mjs";
import { ABANDONED_DAILY_CARRY_SQL, summarizeDailyCarry } from "./daily-carry.mjs";
import { audioReferencePolicy, managedMediaAssetId, mediaUrlForAsset } from "./media-policy.mjs";
import { validatePublishableContent } from "./content-publishability.mjs";
import { BOOTSTRAP_MAX_REQUESTS } from "../../bootstrap-retry.mjs";
import { effectiveDailyPlanMinutes, requiredDailyQuestionCount } from "./daily-plan-policy.mjs";
import { practiceSessionSubmissionPolicy } from "./practice-session-policy.mjs";
import {
  CLAIM_DAILY_FREE_AUDIO_SQL,
  COUNT_DAILY_FREE_AUDIO_SQL,
  dailyAudioPreviewIndex,
} from "./audio-quota.mjs";
import {
  isEssayAnswerPubliclyVisible,
  sanitizePublicEssayAnswer,
  validateEssayAnswerPublication,
} from "./essay-library-policy.mjs";

export const dynamic = "force-dynamic";

const USER_COOKIE = "gkrl_uid";
const DEVICE_COOKIE = "gkrl_device";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
const USER_SESSION_SECONDS = 60 * 60 * 24 * 30;
const ANONYMOUS_SESSION_SECONDS = 60 * 60 * 24 * 7;
const ANONYMOUS_SESSION_PREFIX = "anon1";
const DEVICE_SESSION_PREFIX = "device2";
const LEGACY_DEVICE_SESSION_PREFIX = "device1";
let processAnonymousSecret: Uint8Array | null = null;
let defaultsReady = false;
let defaultsPromise: Promise<void> | null = null;
const DEFAULT_SEED_VERSION = "2026-07-15-v3";
const passiveBootstrapWindows = new Map<string, { startedAt: number; count: number }>();
const publicWriteWindows = new Map<string, { startedAt: number; count: number }>();
const PUBLIC_ACTIONS = new Set([
  "saveProgress", "saveExamProfile", "searchJobPositions", "toggleQuestionBank", "getPracticeBatch",
  "getEssayPracticeBatch", "saveEssayAttempt", "submitPracticeAnswer", "updateQuestionMeta",
  "submitContentReport", "getPracticeSessionSummary", "recordDailyStep", "recordDailyCheckin", "authorizeAudioPlayback", "bindInvite", "redeem",
  "getCommerceProducts", "createTestOrder", "completeTestPayment", "trackEvent",
  "getQuiz", "startQuizAttempt", "submitQuizAnswer", "completeQuizAttempt", "recordQuizShare",
  "getEssayReferenceLibrary",
]);
const PASSIVE_PUBLIC_ACTIONS = new Set([
  "searchJobPositions", "getEssayPracticeBatch", "getPracticeSessionSummary", "getCommerceProducts",
  "getEssayReferenceLibrary",
]);
const TRIAL_DAYS = 3;
const TRIAL_SOURCE = "welcome-trial-v1";
const EVENT_NAMES = new Set([
  "app_open",
  "module_open",
  "quiz_submit",
  "quiz_view",
  "quiz_start",
  "quiz_answer",
  "quiz_complete",
  "quiz_share",
  "quiz_challenge_open",
  "redeem_success",
  "invite_copy",
  "audio_play",
  "audio_pause",
  "audio_close",
  "audio_complete",
  "audio_speed_change",
  "audio_seek",
  "audio_cached",
  "paywall_view",
  "paywall_action",
  "test_order_created",
  "test_payment_completed",
  "entitlement_granted",
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
  "essay_practice_open",
  "essay_draft_submit",
  "essay_revision_submit",
  "essay_reference_library_open",
  "essay_reference_paper_open",
  "essay_reference_share",
  "essay_reference_deep_link_open",
  "daily_practice_complete",
  "daily_gain_view",
  "three_day_report_view",
  "three_day_report_share",
  "trial_start",
  "invite_bound",
  "invite_rewarded",
]);

const STARTER_BANK_CODE = "starter-gk";
const DEFAULT_QUIZ_ID = "quiz-juzhang-thinking";
const DEFAULT_QUIZ_SLUG = "juzhang-thinking";
const DEFAULT_QUIZ_QUESTION_COUNT = 10;
const SELECTABLE_PROVINCES = new Set([
  "北京", "天津", "上海", "重庆", "河北", "山西", "内蒙古", "辽宁", "吉林", "黑龙江",
  "江苏", "浙江", "安徽", "福建", "江西", "山东", "河南", "湖北", "湖南", "广东",
  "广西", "海南", "四川", "贵州", "云南", "西藏", "陕西", "甘肃", "青海", "宁夏", "新疆",
]);
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
const DEFAULT_QUIZ_RESULTS = [
  {
    key: "free_soul",
    title: "体制外自由灵魂",
    minScore: 0,
    maxScore: 0,
    theme: "neon",
    badgeLabel: "隐藏结果",
    description: "恭喜你，精准避开了全部正确答案。你不是听不懂，只是每次都坚定地选择了更快乐的答案。",
    shareText: "我精准避开了全部正确答案，测出了体制外自由灵魂。",
  },
  {
    key: "staff",
    title: "科员段位·稳了",
    minScore: 1,
    maxScore: 4,
    theme: "blue",
    badgeLabel: "1—4题",
    description: "你已经能听懂大部分要求，剩下的主要靠会议纪要保命。",
    shareText: "我测出了科员段位·稳了，你能到哪一级？",
  },
  {
    key: "section_chief",
    title: "科长段位·有点稳",
    minScore: 5,
    maxScore: 7,
    theme: "orange",
    badgeLabel: "5—7题",
    description: "能接任务、会抓重点，还知道什么时候必须汇报。",
    shareText: "我测出了科长段位·有点稳，你来试试？",
  },
  {
    key: "director",
    title: "局长段位·建议低调",
    minScore: 8,
    maxScore: 10,
    theme: "gold",
    badgeLabel: "8—10题",
    description: "领导刚说上半句，你已经开始安排下半年的工作了。",
    shareText: "我测出了局长段位·建议低调，你敢用同一套题挑战吗？",
  },
];
const DEFAULT_QUIZ_QUESTIONS = [
  {
    code: "jz-001",
    stem: "领导说“这个事原则上是不可以的”，你最应该理解为？",
    options: ["可以，但需要补齐条件和流程", "绝对不可以，马上撤退", "可以，且最好现在就发朋友圈庆祝"],
    correctIndex: 0,
    explanation: "“原则上”通常意味着存在边界和例外，关键是把依据、流程、风险说清楚。",
    category: "体制内语言",
    difficulty: "easy",
  },
  {
    code: "jz-002",
    stem: "领导说“我不想再说第二遍”，此时最稳的动作是？",
    options: ["记录要点并复述确认", "点头如捣蒜但什么都不记", "认真回答：那我申请听第三遍"],
    correctIndex: 0,
    explanation: "高压表达背后是对执行确定性的要求，记录和复述能降低误解。",
    category: "执行沟通",
    difficulty: "easy",
  },
  {
    code: "jz-003",
    stem: "会上有人说“这个问题历史原因比较复杂”，你应该优先想到？",
    options: ["先梳理现状、历史沿革和责任边界", "复杂就别碰，自动进入玄学领域", "建议把历史原因交给历史老师"],
    correctIndex: 0,
    explanation: "复杂问题不能先站队，先把事实链、时间线和责任边界拆开。",
    category: "问题拆解",
    difficulty: "medium",
  },
  {
    code: "jz-004",
    stem: "领导说“你先拿个初稿出来”，初稿最好是什么状态？",
    options: ["结构完整、关键数据留痕、可继续修改", "随便写三行，突出一个初", "用空白文档表达无限可能"],
    correctIndex: 0,
    explanation: "初稿不是草率稿，而是让讨论有抓手的版本。",
    category: "材料写作",
    difficulty: "easy",
  },
  {
    code: "jz-005",
    stem: "同事说“这个事以前一直这么干”，你最该补一句？",
    options: ["现在的依据、风险和口径是否仍然一致", "以前这么干，那以后也永远这么干", "那就把以前请回来继续干"],
    correctIndex: 0,
    explanation: "惯例不能代替依据，尤其政策、权限、流程变化后要重新核对。",
    category: "风险意识",
    difficulty: "medium",
  },
  {
    code: "jz-006",
    stem: "领导让你“再完善一下”，最应该先完善哪类内容？",
    options: ["目标、依据、措施、责任人和时间节点", "字体颜色，先把文档打扮得很努力", "增加十页空话，让厚度战胜质疑"],
    correctIndex: 0,
    explanation: "完善通常不是加字数，而是让方案更能落地、更可追踪。",
    category: "方案意识",
    difficulty: "medium",
  },
  {
    code: "jz-007",
    stem: "有人在群里问一个敏感事项，你还不确定口径，最稳的是？",
    options: ["先不公开表态，核对依据后统一回复", "凭感觉秒回，主打一个热情", "发一个表情包让问题自然消失"],
    correctIndex: 0,
    explanation: "不确定口径时，快不如准；统一回复能避免信息不一致。",
    category: "口径管理",
    difficulty: "medium",
  },
  {
    code: "jz-008",
    stem: "领导说“你们研究一下”，真实含义更接近？",
    options: ["形成可选方案、利弊和建议结论", "大家围坐一起认真沉默", "研究一下今天吃什么"],
    correctIndex: 0,
    explanation: "“研究”不是泛泛讨论，而是给决策者可判断的方案。",
    category: "决策支持",
    difficulty: "easy",
  },
  {
    code: "jz-009",
    stem: "材料里出现“持续推进、稳步提升、闭环管理”，你应避免什么？",
    options: ["只堆词不落到具体动作和指标", "把这些词都背下来，考试和人生都稳了", "每个词后面加感叹号增强气势"],
    correctIndex: 0,
    explanation: "规范表达要服务于动作和指标，不然就是空转。",
    category: "规范表达",
    difficulty: "hard",
  },
  {
    code: "jz-010",
    stem: "一项工作跨多个部门，最容易出问题的是？",
    options: ["牵头单位、配合单位、完成时限和反馈机制不清", "部门太多，会议室椅子不够", "大家都很忙，所以自动变成没人忙"],
    correctIndex: 0,
    explanation: "跨部门事项必须先明确牵头、配合、时限和反馈。",
    category: "统筹协调",
    difficulty: "hard",
  },
  {
    code: "jz-011",
    stem: "群众反映问题情绪很急，你第一步更应该做什么？",
    options: ["先接住诉求，核实事实，再按权限流转", "立刻开始讲大道理", "告诉对方你也很急，双方达成情绪共鸣"],
    correctIndex: 0,
    explanation: "先稳定沟通、核实事实，再依法依规处理。",
    category: "群众工作",
    difficulty: "medium",
  },
  {
    code: "jz-012",
    stem: "上级临时要数据，手头数据还没完全校验，你应该？",
    options: ["注明口径、时间点和待核部分，先报可确认数据", "为了显得完整，先补几个看起来圆润的数", "把表格做成彩色，转移注意力"],
    correctIndex: 0,
    explanation: "数据可以分阶段报，但口径、时间点和不确定部分必须说清楚。",
    category: "数据意识",
    difficulty: "hard",
  },
];
const allowedWrongReasons = new Set(["知识点不会", "方法没想到", "计算失误", "审题错误", "时间不足", "蒙对了"]);
const allowedConfidence = new Set(["confident", "hesitant", "guessed"]);
const CONTENT_REPORT_REASONS = new Set([
  "stem_or_option",
  "answer",
  "explanation",
  "asset",
  "source_label",
  "other",
]);
const CONTENT_REPORT_DAILY_LIMIT = 10;
// D1 Free allows 50 queries per Worker invocation and 100 bound parameters per
// statement. Keep imports in small, durable units so a retry never crosses
// either limit. 800 rows = at most 10 x 80-row chunks. This deliberately leaves
// several calls below Cloudflare's 16-Worker loop ceiling for the originating
// admin request, the Sites access layer and safe retry headroom.
const QUESTION_IMPORT_CHUNK_ROWS = 80;
const QUESTION_IMPORT_MAX_FILE_ROWS = 800;
const QUESTION_IMPORT_MAX_CHUNKS_PER_FILE = 10;
const QUESTION_IMPORT_UPLOAD_BYTES = 480 * 1024;
const QUESTION_IMPORT_MAX_BINDING_BYTES = 768 * 1024;
const QUESTION_IMPORT_D1_QUERY_LIMIT = 50;
const QUESTION_IMPORT_D1_QUERY_RESERVE = 24;
const QUESTION_IMPORT_CHUNK_QUERY_BUDGET = 15;
const QUESTION_IMPORT_MAX_CHUNKS_PER_INVOCATION = Math.max(1, Math.floor(
  (QUESTION_IMPORT_D1_QUERY_LIMIT - QUESTION_IMPORT_D1_QUERY_RESERVE) / QUESTION_IMPORT_CHUNK_QUERY_BUDGET,
));
const QUESTION_IMPORT_WRITE_GUARD_SQL = `EXISTS (
  SELECT 1 FROM question_import_chunks import_lease
  JOIN question_imports import_job ON import_job.id = import_lease.import_id
  JOIN question_banks import_bank ON import_bank.id = import_job.bank_id
  WHERE import_lease.id = ? AND import_lease.import_id = ?
    AND import_lease.status = 'processing'
    AND import_job.status = 'processing' AND import_job.cancel_requested = 0
    AND import_job.lease_token = ? AND import_bank.status = 'draft'
)`;
const QUESTION_IMPORT_POST_STATE_SQL = `(q.version = CASE
    WHEN json_extract(incoming.value, '$.mode') = 'write'
      THEN CAST(json_extract(incoming.value, '$.expectedVersion') AS INTEGER) + 1
    ELSE CAST(json_extract(incoming.value, '$.expectedVersion') AS INTEGER) END
  AND q.subject = json_extract(incoming.value, '$.question.subject')
  AND q.module = json_extract(incoming.value, '$.question.module')
  AND COALESCE(q.sub_type, '') = COALESCE(json_extract(incoming.value, '$.question.subType'), '')
  AND q.stem = json_extract(incoming.value, '$.question.stem')
  AND q.options_json = COALESCE(json(json_extract(incoming.value, '$.question.options')), '[]')
  AND COALESCE(q.answer, '') = COALESCE(json_extract(incoming.value, '$.question.answer'), '')
  AND COALESCE(q.prompt, '') = COALESCE(json_extract(incoming.value, '$.question.prompt'), '')
  AND q.source = COALESCE(json_extract(incoming.value, '$.question.source'), '')
  AND q.source_exam_type = COALESCE(json_extract(incoming.value, '$.question.sourceExamType'), '')
  AND q.source_region = json_extract(incoming.value, '$.question.region')
  AND q.source_year = CAST(json_extract(incoming.value, '$.question.examYear') AS INTEGER)
  AND q.source_batch = COALESCE(json_extract(incoming.value, '$.question.sourceBatch'), '')
  AND (json_extract(incoming.value, '$.mode') = 'reuse' OR (
    q.truth_verified = 0 AND q.review_status = 'pending_review' AND q.status = 'active'
    AND q.explanation = COALESCE(json_extract(incoming.value, '$.question.explanation'), '')
    AND q.technique = COALESCE(json_extract(incoming.value, '$.question.technique'), '')
    AND q.material = COALESCE(json_extract(incoming.value, '$.question.material'), '')
    AND COALESCE(q.word_limit, 0) = COALESCE(CAST(json_extract(incoming.value, '$.question.wordLimit') AS INTEGER), 0)
    AND q.scoring_points_json = COALESCE(json(json_extract(incoming.value, '$.question.scoringPoints')), '[]')
    AND q.difficulty = COALESCE(json_extract(incoming.value, '$.question.difficulty'), '中等')
    AND q.frequency = COALESCE(json_extract(incoming.value, '$.question.frequency'), '')
    AND q.frequency_occurrences = COALESCE(CAST(json_extract(incoming.value, '$.question.frequencyOccurrences') AS INTEGER), 0)
    AND q.frequency_papers = COALESCE(CAST(json_extract(incoming.value, '$.question.frequencyPapers') AS INTEGER), 0)
    AND q.frequency_years_json = COALESCE(json(json_extract(incoming.value, '$.question.frequencyYears')), '[]')
    AND COALESCE(q.frequency_updated_at, '') = COALESCE(json_extract(incoming.value, '$.question.frequencyUpdatedAt'), '')
    AND q.importance_stars = COALESCE(CAST(json_extract(incoming.value, '$.question.importanceStars') AS INTEGER), 0)
    AND q.importance_rule_version = COALESCE(json_extract(incoming.value, '$.question.importanceRuleVersion'), '')
    AND q.importance_reason = COALESCE(json_extract(incoming.value, '$.question.importanceReason'), '')
    AND q.importance_override_reason = COALESCE(json_extract(incoming.value, '$.question.importanceOverrideReason'), '')
    AND q.score_rate = COALESCE(CAST(json_extract(incoming.value, '$.question.scoreRate') AS INTEGER), 0)
    AND q.score_rate_correct = COALESCE(CAST(json_extract(incoming.value, '$.question.scoreRateCorrect') AS INTEGER), 0)
    AND q.score_rate_attempts = COALESCE(CAST(json_extract(incoming.value, '$.question.scoreRateAttempts') AS INTEGER), 0)
    AND q.score_rate_scope = COALESCE(json_extract(incoming.value, '$.question.scoreRateScope'), '')
    AND q.score_rate_source = COALESCE(json_extract(incoming.value, '$.question.scoreRateSource'), 'platform')
    AND COALESCE(q.score_rate_updated_at, '') = COALESCE(json_extract(incoming.value, '$.question.scoreRateUpdatedAt'), '')
    AND q.suggested_seconds = COALESCE(CAST(json_extract(incoming.value, '$.question.suggestedSeconds') AS INTEGER), 60)
    AND q.image_url = COALESCE(json_extract(incoming.value, '$.question.imageUrl'), '')
    AND q.resource_url = COALESCE(json_extract(incoming.value, '$.question.resourceUrl'), '')
  )))`;
const QUESTION_NOT_LOCKED_BY_IMPORT_SQL = `NOT EXISTS (
  SELECT 1 FROM question_import_codes import_code
  JOIN question_imports import_job ON import_job.id = import_code.import_id
  WHERE import_code.question_code = questions.question_code
    AND import_job.cancel_requested = 0
    AND import_job.status IN ('uploading','queued','processing','cancelling')
)`;
// Large content imports fan out into fixed worker slots after the complete file
// is durably sealed. Each slot owns at most five chunks, so a 50,000-row
// position table continues after the browser closes without creating a long
// recursive Worker call chain. Chunk SQL uses json_each and stays well below
// D1's per-invocation query and bound-parameter budgets.
const CONTENT_IMPORT_CHUNK_ROWS = 1_000;
const CONTENT_IMPORT_MAX_FILE_ROWS = 50_000;
const CONTENT_IMPORT_MAX_CHUNKS = 75;
const CONTENT_IMPORT_UPLOAD_BYTES = 700 * 1024;
const CONTENT_IMPORT_WORKER_SLOTS = 15;
const CONTENT_IMPORT_CHUNKS_PER_SLOT = 5;
const CONTENT_IMPORT_DUPLICATE_STRATEGIES = new Set(["reject", "skip", "update_draft"]);
const CONTENT_IMPORT_WRITE_GUARD_SQL = `EXISTS (
  SELECT 1 FROM content_import_chunks guarded_chunk
  JOIN content_imports guarded_job ON guarded_job.id = guarded_chunk.import_id
  WHERE guarded_chunk.id = ? AND guarded_chunk.lease_token = ?
    AND guarded_chunk.status = 'processing' AND guarded_job.id = ?
    AND guarded_job.cancel_requested = 0 AND guarded_job.status IN ('queued','processing')
)`;
const QUESTION_IMPORT_DUPLICATE_STRATEGIES = new Set(["reject", "preserve_metrics", "replace_external_metrics"]);

type UserRow = {
  id: string;
  invite_code: string;
  invited_by: string | null;
  membership_type: string;
  membership_end: string | null;
};

type CodeRow = {
  id: number;
  code_preview: string;
  grant_type: string;
  duration_days: number;
  max_uses: number;
  used_count: number;
  status: string;
  valid_from: string | null;
  valid_until: string | null;
};

type CommerceProductRow = {
  id: string;
  name: string;
  description: string;
  price_cents: number;
  currency: string;
  grant_type: "duration" | "lifetime";
  duration_days: number | null;
  public_promise: string;
  status: string;
};

type CommerceOrderRow = {
  id: string;
  order_no: string;
  user_id: string;
  product_id: string;
  product_name: string;
  amount_cents: number;
  currency: string;
  status: string;
  channel: string;
  idempotency_key: string;
  return_context_json: string;
  entitlement_grant_id: string | null;
  paid_at: string | null;
  created_at: string;
};

type Identity = {
  userId: string;
  signedIn: boolean;
  provider: "chatgpt" | "device";
  displayName: string;
  persistent: boolean;
  accountMerged?: boolean;
  bootstrapDeferred?: boolean;
  bootstrapStage?: "identity_prepared" | "device_merge_checked" | "account_merged";
  setCookie?: string[];
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
  truthVerified?: boolean;
  sourceExamType?: string;
  sourceBatch?: string;
  frequencyOccurrences?: number;
  frequencyPapers?: number;
  frequencyYears?: number[];
  frequencyUpdatedAt?: string | null;
  importanceRuleVersion?: string;
  importanceReason?: string;
  importanceOverrideReason?: string;
  scoreRateCorrect?: number;
  scoreRateAttempts?: number;
  scoreRateScope?: string;
  scoreRateSource?: string;
  scoreRateUpdatedAt?: string | null;
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
  truthVerified: boolean;
  frequencyReliable: boolean;
  frequencyOccurrences: number;
  frequencyPapers: number;
  frequencyYears: number[];
  frequencyUpdatedAt: string | null;
  importanceReliable: boolean;
  importanceRuleVersion: string;
  importanceReason: string;
  importanceOverrideReason: string;
  scoreRateReliable: boolean;
  scoreRateCorrect: number;
  scoreRateAttempts: number;
  scoreRateScope: string;
  scoreRateSource: string;
  scoreRateUpdatedAt: string | null;
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
  dataVersion: number;
  updatedAt: string;
};

type QuizTestRow = {
  id: string;
  slug: string;
  title: string;
  description: string;
  question_count: number;
  status: string;
  share_title: string;
  disclaimer: string;
};

type QuizQuestionRow = {
  id: number;
  quiz_id: string;
  question_code: string;
  stem: string;
  options_json: string;
  correct_index: number;
  explanation: string;
  category: string;
  difficulty: string;
  weight: number;
  status: string;
  review_status: string;
  sort_order: number;
  updated_at?: string;
};

type QuizResultLevelRow = {
  id: string;
  quiz_id: string;
  level_key: string;
  title: string;
  min_score: number;
  max_score: number;
  theme: string;
  description: string;
  share_text: string;
  badge_label: string;
  sort_order: number;
  status: string;
};

type QuizAttemptRow = {
  id: string;
  user_id: string;
  quiz_id: string;
  challenge_id: string;
  source_attempt_id: string;
  question_ids_json: string;
  option_orders_json: string;
  answers_json: string;
  correct_count: number | null;
  result_key: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  share_count: number;
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

function normalizeDailyMinutes(value: unknown): 10 | 30 | 45 | 60 {
  const minutes = Number(value);
  if (minutes === 10 || minutes === 45 || minutes === 60) return minutes;
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

function chinaDateKeyAfter(dateKey: string, days: number) {
  const target = new Date(`${dateKey}T12:00:00+08:00`);
  target.setUTCDate(target.getUTCDate() + Math.max(0, Math.floor(days)));
  return chinaDateKey(target);
}

function targetSecondsFor(question: Pick<ResolvedQuestion, "module" | "knowledge">) {
  if (question.module.includes("常识") || question.module.includes("政治")) return 35;
  if (question.module.includes("资料")) return 90;
  if (question.module.includes("数量")) return 120;
  if (question.knowledge.includes("图形")) return 75;
  return 60;
}

function appendCookies(headers: Headers, cookies?: string | string[]) {
  for (const cookie of Array.isArray(cookies) ? cookies : cookies ? [cookies] : []) {
    headers.append("set-cookie", cookie);
  }
}

function cookieHeaders(...cookies: Array<string | undefined>) {
  const values = cookies.filter((cookie): cookie is string => Boolean(cookie));
  return values.length ? values : undefined;
}

function json(data: unknown, status = 200, cookies?: string | string[]) {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store, private",
  });
  appendCookies(headers, cookies);
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

function allowPassiveBootstrap(request: Request) {
  const now = Date.now();
  const forwarded = request.headers.get("cf-connecting-ip")
    || request.headers.get("x-real-ip")
    || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || "unknown";
  const current = passiveBootstrapWindows.get(forwarded);
  if (!current || now - current.startedAt >= 60_000) {
    passiveBootstrapWindows.set(forwarded, { startedAt: now, count: 1 });
  } else {
    current.count += 1;
    if (current.count > 120) return false;
  }
  if (passiveBootstrapWindows.size > 2_048) {
    for (const [key, value] of passiveBootstrapWindows) {
      if (now - value.startedAt >= 60_000 || passiveBootstrapWindows.size > 1_900) {
        passiveBootstrapWindows.delete(key);
      }
      if (passiveBootstrapWindows.size <= 1_900) break;
    }
  }
  return true;
}

function allowPublicWrite(request: Request, action: string) {
  const now = Date.now();
  const client = request.headers.get("cf-connecting-ip")
    || request.headers.get("x-real-ip")
    || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || "unknown";
  const consume = (key: string, limit: number) => {
    const current = publicWriteWindows.get(key);
    if (!current || now - current.startedAt >= 60_000) {
      publicWriteWindows.set(key, { startedAt: now, count: 1 });
      return true;
    }
    current.count += 1;
    return current.count <= limit;
  };
  // The aggregate bucket prevents an attacker from multiplying the allowance
  // by cycling through every valid public action. Unknown actions never reach
  // this function because POST rejects them before identity persistence.
  if (!consume(`${client}:*`, 240)) return false;
  const limit = action === "submitPracticeAnswer" ? 120 : action === "trackEvent" ? 180 : 60;
  if (!consume(`${client}:${action}`, limit)) return false;
  if (publicWriteWindows.size > 4_096) {
    for (const [storedKey, value] of publicWriteWindows) {
      if (now - value.startedAt >= 60_000 || publicWriteWindows.size > 3_800) publicWriteWindows.delete(storedKey);
      if (publicWriteWindows.size <= 3_800) break;
    }
  }
  return true;
}

function validUserId(value: string | null): value is string {
  return Boolean(value && (/^[0-9a-f-]{36}$/i.test(value) || /^acct_[0-9a-f]{32}$/i.test(value)));
}

function validSessionToken(value: string | null): value is string {
  return Boolean(value && /^[A-Za-z0-9_-]{40,96}$/.test(value));
}

function cookieHeader(request: Request, sessionToken: string) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${USER_COOKIE}=${encodeURIComponent(sessionToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}${secure}`;
}

function anonymousCookieHeader(request: Request, sessionToken: string) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${USER_COOKIE}=${encodeURIComponent(sessionToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${ANONYMOUS_SESSION_SECONDS}${secure}`;
}

function deviceCookieHeader(request: Request, token: string) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${DEVICE_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}${secure}`;
}

function normalizeCode(value: string) {
  return value.trim().toUpperCase().replace(/\s+/g, "");
}

async function digestText(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function constantTimeStringEqual(first: string, second: string) {
  if (first.length !== second.length) return false;
  let difference = 0;
  for (let index = 0; index < first.length; index += 1) {
    difference |= first.charCodeAt(index) ^ second.charCodeAt(index);
  }
  return difference === 0;
}

async function anonymousSessionSignature(value: string) {
  const bindings = env as unknown as Record<string, string | undefined>;
  const configured = bindings.USER_SESSION_SECRET || bindings.INTERNAL_JOB_SECRET || bindings.ADMIN_TOKEN;
  // A process-local fallback is intentionally non-durable: in local preview a
  // passive visitor may receive a fresh anonymous id after an isolate restart,
  // but an unsigned/guessable id is never accepted. Production has a secret.
  // Workers forbid randomness during module initialization. Production uses
  // USER_SESSION_SECRET; this lazy fallback exists only for local development
  // and is initialized inside a request execution context.
  if (!configured && !processAnonymousSecret) processAnonymousSecret = crypto.getRandomValues(new Uint8Array(32));
  const secret = configured ? new TextEncoder().encode(configured) : processAnonymousSecret!;
  const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value))));
}

async function issueAnonymousSession(userId: string) {
  const expiresAt = Math.floor(Date.now() / 1000) + ANONYMOUS_SESSION_SECONDS;
  const value = `${ANONYMOUS_SESSION_PREFIX}.${userId}.${expiresAt}`;
  return `${value}.${await anonymousSessionSignature(value)}`;
}

async function anonymousSessionUserId(token: string | null) {
  if (!token || token.length > 180) return null;
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== ANONYMOUS_SESSION_PREFIX || !validUserId(parts[1])) return null;
  const expiresAt = Number(parts[2]);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isInteger(expiresAt) || expiresAt <= now || expiresAt > now + ANONYMOUS_SESSION_SECONDS + 60) return null;
  const value = `${parts[0]}.${parts[1]}.${parts[2]}`;
  const expected = await anonymousSessionSignature(value);
  return constantTimeStringEqual(expected, parts[3]) ? { userId: parts[1], token } : null;
}

type DeviceSession = { deviceId: string; lastAccountId: string | null; token: string; linked: boolean };

async function issueDeviceSession(deviceId: string, lastAccountId: string | null) {
  const expiresAt = Math.floor(Date.now() / 1000) + COOKIE_MAX_AGE;
  const account = lastAccountId && /^acct_[0-9a-f]{32}$/i.test(lastAccountId) ? lastAccountId : "-";
  const value = `${DEVICE_SESSION_PREFIX}.${deviceId}.${account}.${expiresAt}`;
  return `${value}.${await anonymousSessionSignature(value)}`;
}

async function deviceSessionValue(token: string | null): Promise<DeviceSession | null> {
  if (!token || token.length > 240) return null;
  const parts = token.split(".");
  if (parts.length !== 5 || !new Set([DEVICE_SESSION_PREFIX, LEGACY_DEVICE_SESSION_PREFIX]).has(parts[0])
    || !/^[0-9a-f-]{36}$/i.test(parts[1])) return null;
  const lastAccountId = parts[2] === "-" ? null : parts[2];
  if (lastAccountId && !/^acct_[0-9a-f]{32}$/i.test(lastAccountId)) return null;
  const expiresAt = Number(parts[3]);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isInteger(expiresAt) || expiresAt <= now || expiresAt > now + COOKIE_MAX_AGE + 60) return null;
  const value = `${parts[0]}.${parts[1]}.${parts[2]}.${parts[3]}`;
  const expected = await anonymousSessionSignature(value);
  return constantTimeStringEqual(expected, parts[4])
    ? { deviceId: parts[1], lastAccountId, token, linked: parts[0] === DEVICE_SESSION_PREFIX }
    : null;
}

function randomSessionToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

async function sessionUserId(token: string | null, touch = true) {
  if (!validSessionToken(token)) return null;
  const tokenHash = await digestText(`gongkao-session:${token}`);
  // A session row is not identity proof on its own. Older builds could issue a
  // token after an invite-code collision silently skipped the users insert.
  // Joining users makes those orphan sessions self-healing instead of causing
  // every later bootstrap to fail forever.
  const row = await getD1().prepare(`SELECT s.user_id FROM user_sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.revoked_at IS NULL AND datetime(s.expires_at) > CURRENT_TIMESTAMP`)
    .bind(tokenHash).first<{ user_id: string }>();
  if (!row?.user_id) return null;
  if (touch) {
    await getD1().prepare("UPDATE user_sessions SET last_seen_at = CURRENT_TIMESTAMP WHERE token_hash = ?")
      .bind(tokenHash).run();
  }
  return { userId: row.user_id, token };
}

async function issueUserSession(userId: string) {
  const token = randomSessionToken();
  const tokenHash = await digestText(`gongkao-session:${token}`);
  const expiresAt = new Date(Date.now() + USER_SESSION_SECONDS * 1000).toISOString();
  await getD1().prepare(`INSERT INTO user_sessions
    (token_hash, user_id, expires_at, last_seen_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)`)
    .bind(tokenHash, userId, expiresAt).run();
  return token;
}

async function hashCode(value: string) {
  return digestText(normalizeCode(value));
}

function membershipIsActive(user: { membership_type?: string | null; membership_end?: string | null } | null | undefined) {
  if (user?.membership_type === "lifetime") return true;
  return Boolean(user?.membership_end && Date.parse(user.membership_end) > Date.now());
}

async function userMembership(userId: string) {
  return getD1().prepare("SELECT membership_type, membership_end FROM users WHERE id = ?")
    .bind(userId).first<{ membership_type: string; membership_end: string | null }>();
}

function laterDate(first: string | null, second: string | null) {
  const firstValue = first ? Date.parse(first) : 0;
  const secondValue = second ? Date.parse(second) : 0;
  return firstValue >= secondValue ? first : second;
}

function mergeProgressJson(deviceValue: string | undefined, accountValue: string | undefined) {
  const parse = (value: string | undefined): Record<string, unknown> => {
    try {
      const parsed = JSON.parse(value ?? "{}");
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  };
  const merge = (device: unknown, account: unknown): unknown => {
    if (device && account && typeof device === "object" && typeof account === "object"
      && !Array.isArray(device) && !Array.isArray(account)) {
      const keys = new Set([...Object.keys(device as Record<string, unknown>), ...Object.keys(account as Record<string, unknown>)]);
      return Object.fromEntries(Array.from(keys).map((key) => [key, merge(
        (device as Record<string, unknown>)[key], (account as Record<string, unknown>)[key],
      )]));
    }
    if (Array.isArray(device) && Array.isArray(account)) {
      return account.length ? account : device;
    }
    return account === undefined || account === null || account === "" ? device : account;
  };
  return JSON.stringify(merge(parse(deviceValue), parse(accountValue)));
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
  if (deviceId === accountId || !validUserId(deviceId) || deviceId.startsWith("acct_")) return false;
  const db = getD1();
  const [device, account, deviceState, accountState] = await Promise.all([
    db.prepare("SELECT membership_type, membership_end FROM users WHERE id = ?").bind(deviceId).first<{ membership_type: string; membership_end: string | null }>(),
    db.prepare("SELECT membership_type, membership_end FROM users WHERE id = ?").bind(accountId).first<{ membership_type: string; membership_end: string | null }>(),
    db.prepare("SELECT progress_json FROM user_states WHERE user_id = ?").bind(deviceId).first<{ progress_json: string }>(),
    db.prepare("SELECT progress_json FROM user_states WHERE user_id = ?").bind(accountId).first<{ progress_json: string }>(),
  ]);
  if (!device) return false;
  const progress = mergeProgressJson(deviceState?.progress_json, accountState?.progress_json);
  await db.batch([
    db.prepare("UPDATE users SET membership_type = ?, membership_end = ? WHERE id = ?")
      .bind(account?.membership_type === "lifetime" || device.membership_type === "lifetime" ? "lifetime" : "duration",
        account?.membership_type === "lifetime" || device.membership_type === "lifetime"
          ? null : laterDate(account?.membership_end ?? null, device.membership_end), accountId),
    db.prepare(`INSERT INTO user_states (user_id, progress_json, version, updated_at) VALUES (?, ?, 1, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id) DO UPDATE SET progress_json = excluded.progress_json,
      version = user_states.version + 1, updated_at = CURRENT_TIMESTAMP`).bind(accountId, progress),
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
    db.prepare(`INSERT INTO user_question_progress
      (user_id, question_code, state, correct_count, wrong_count, uncertain_count, last_answer,
        last_correct, last_duration_ms, last_answered_at, next_review_at, favorite, wrong_reason,
        review_count, review_stage, updated_at)
      SELECT ?, question_code, state, correct_count, wrong_count, uncertain_count, last_answer,
        last_correct, last_duration_ms, last_answered_at, next_review_at, favorite, wrong_reason,
        review_count, review_stage, updated_at FROM user_question_progress WHERE user_id = ?
      ON CONFLICT(user_id, question_code) DO UPDATE SET
        state = CASE WHEN datetime(excluded.updated_at) >= datetime(user_question_progress.updated_at)
          THEN excluded.state ELSE user_question_progress.state END,
        correct_count = user_question_progress.correct_count + excluded.correct_count,
        wrong_count = user_question_progress.wrong_count + excluded.wrong_count,
        uncertain_count = user_question_progress.uncertain_count + excluded.uncertain_count,
        last_answer = CASE WHEN user_question_progress.last_answered_at IS NULL OR (excluded.last_answered_at IS NOT NULL AND datetime(excluded.last_answered_at) >= datetime(user_question_progress.last_answered_at))
          THEN excluded.last_answer ELSE user_question_progress.last_answer END,
        last_correct = CASE WHEN user_question_progress.last_answered_at IS NULL OR (excluded.last_answered_at IS NOT NULL AND datetime(excluded.last_answered_at) >= datetime(user_question_progress.last_answered_at))
          THEN excluded.last_correct ELSE user_question_progress.last_correct END,
        last_duration_ms = CASE WHEN user_question_progress.last_answered_at IS NULL OR (excluded.last_answered_at IS NOT NULL AND datetime(excluded.last_answered_at) >= datetime(user_question_progress.last_answered_at))
          THEN excluded.last_duration_ms ELSE user_question_progress.last_duration_ms END,
        last_answered_at = CASE WHEN user_question_progress.last_answered_at IS NULL OR (excluded.last_answered_at IS NOT NULL AND datetime(excluded.last_answered_at) >= datetime(user_question_progress.last_answered_at))
          THEN excluded.last_answered_at ELSE user_question_progress.last_answered_at END,
        next_review_at = CASE
          WHEN user_question_progress.next_review_at IS NULL THEN excluded.next_review_at
          WHEN excluded.next_review_at IS NULL THEN user_question_progress.next_review_at
          WHEN datetime(excluded.next_review_at) < datetime(user_question_progress.next_review_at) THEN excluded.next_review_at
          ELSE user_question_progress.next_review_at END,
        favorite = MAX(user_question_progress.favorite, excluded.favorite),
        wrong_reason = CASE WHEN excluded.wrong_reason <> '' THEN excluded.wrong_reason ELSE user_question_progress.wrong_reason END,
        review_count = user_question_progress.review_count + excluded.review_count,
        review_stage = MAX(user_question_progress.review_stage, excluded.review_stage),
        updated_at = CASE WHEN datetime(excluded.updated_at) >= datetime(user_question_progress.updated_at)
          THEN excluded.updated_at ELSE user_question_progress.updated_at END`).bind(accountId, deviceId),
    db.prepare(`INSERT INTO user_daily_usage (user_id, date_key, practice_count, audio_count, updated_at)
      SELECT ?, date_key, practice_count, audio_count, updated_at FROM user_daily_usage WHERE user_id = ?
      ON CONFLICT(user_id, date_key) DO UPDATE SET
        practice_count = user_daily_usage.practice_count + excluded.practice_count,
        audio_count = user_daily_usage.audio_count + excluded.audio_count,
        updated_at = CURRENT_TIMESTAMP`).bind(accountId, deviceId),
    db.prepare(`INSERT OR IGNORE INTO daily_checkins (user_id, date_key, session_id, source, completed_at)
      SELECT ?, date_key, session_id, source, completed_at FROM daily_checkins WHERE user_id = ?`).bind(accountId, deviceId),
    db.prepare("UPDATE practice_attempts SET attempt_key = 'merge:' || ? || ':' || COALESCE(attempt_key, CAST(id AS TEXT)) WHERE user_id = ?")
      .bind(deviceId, deviceId),
    db.prepare("UPDATE practice_attempts SET user_id = ? WHERE user_id = ?").bind(accountId, deviceId),
    db.prepare(`UPDATE practice_sessions SET status = 'abandoned', updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND status = 'active' AND EXISTS (
        SELECT 1 FROM practice_sessions account_session WHERE account_session.user_id = ?
          AND account_session.date_key = practice_sessions.date_key
          AND account_session.kind = practice_sessions.kind AND account_session.mode = practice_sessions.mode
          AND account_session.status = 'active')`).bind(deviceId, accountId),
    db.prepare("UPDATE practice_sessions SET user_id = ? WHERE user_id = ?").bind(accountId, deviceId),
    db.prepare(`INSERT INTO essay_attempts
      (id, user_id, question_code, date_key, stage, first_draft, self_checks_json, self_score,
        loss_reasons_json, revised_draft, rewrite_draft, elapsed_seconds, rewrite_due_at, submitted_at,
        completed_at, created_at, updated_at)
      SELECT 'merge:' || ? || ':' || id, ?, question_code, date_key, stage, first_draft, self_checks_json, self_score,
        loss_reasons_json, revised_draft, rewrite_draft, elapsed_seconds, rewrite_due_at, submitted_at,
        completed_at, created_at, updated_at FROM essay_attempts WHERE user_id = ?
      ON CONFLICT(user_id, question_code, date_key) DO UPDATE SET
        stage = CASE WHEN CASE excluded.stage WHEN 'completed' THEN 5 WHEN 'rewrite_due' THEN 4 WHEN 'revised' THEN 3 WHEN 'self_review' THEN 2 WHEN 'submitted' THEN 1 ELSE 0 END
          > CASE essay_attempts.stage WHEN 'completed' THEN 5 WHEN 'rewrite_due' THEN 4 WHEN 'revised' THEN 3 WHEN 'self_review' THEN 2 WHEN 'submitted' THEN 1 ELSE 0 END
          THEN excluded.stage ELSE essay_attempts.stage END,
        first_draft = CASE WHEN LENGTH(excluded.first_draft) > LENGTH(essay_attempts.first_draft) THEN excluded.first_draft ELSE essay_attempts.first_draft END,
        self_checks_json = CASE WHEN LENGTH(excluded.self_checks_json) > LENGTH(essay_attempts.self_checks_json) THEN excluded.self_checks_json ELSE essay_attempts.self_checks_json END,
        self_score = COALESCE(essay_attempts.self_score, excluded.self_score),
        loss_reasons_json = CASE WHEN LENGTH(excluded.loss_reasons_json) > LENGTH(essay_attempts.loss_reasons_json) THEN excluded.loss_reasons_json ELSE essay_attempts.loss_reasons_json END,
        revised_draft = CASE WHEN LENGTH(excluded.revised_draft) > LENGTH(essay_attempts.revised_draft) THEN excluded.revised_draft ELSE essay_attempts.revised_draft END,
        rewrite_draft = CASE WHEN LENGTH(excluded.rewrite_draft) > LENGTH(essay_attempts.rewrite_draft) THEN excluded.rewrite_draft ELSE essay_attempts.rewrite_draft END,
        elapsed_seconds = MAX(essay_attempts.elapsed_seconds, excluded.elapsed_seconds),
        rewrite_due_at = COALESCE(essay_attempts.rewrite_due_at, excluded.rewrite_due_at),
        submitted_at = COALESCE(essay_attempts.submitted_at, excluded.submitted_at),
        completed_at = COALESCE(essay_attempts.completed_at, excluded.completed_at),
        updated_at = CASE WHEN datetime(excluded.updated_at) > datetime(essay_attempts.updated_at) THEN excluded.updated_at ELSE essay_attempts.updated_at END`)
      .bind(deviceId, accountId, deviceId),
    db.prepare("UPDATE OR IGNORE redemptions SET user_id = ? WHERE user_id = ?").bind(accountId, deviceId),
    db.prepare("UPDATE OR IGNORE membership_ledger SET user_id = ? WHERE user_id = ?").bind(accountId, deviceId),
    db.prepare("UPDATE OR IGNORE invite_relations SET inviter_id = ? WHERE inviter_id = ?").bind(accountId, deviceId),
    db.prepare("UPDATE OR IGNORE invite_relations SET invitee_id = ? WHERE invitee_id = ?").bind(accountId, deviceId),
    db.prepare("UPDATE users SET invited_by = ? WHERE invited_by = ?").bind(accountId, deviceId),
    db.prepare("DELETE FROM essay_attempts WHERE user_id = ?").bind(deviceId),
    db.prepare("DELETE FROM user_question_progress WHERE user_id = ?").bind(deviceId),
    db.prepare("DELETE FROM user_question_banks WHERE user_id = ?").bind(deviceId),
    db.prepare("DELETE FROM user_exam_targets WHERE user_id = ?").bind(deviceId),
    db.prepare("DELETE FROM user_exam_profiles WHERE user_id = ?").bind(deviceId),
    db.prepare("DELETE FROM user_daily_usage WHERE user_id = ?").bind(deviceId),
    db.prepare("DELETE FROM daily_checkins WHERE user_id = ?").bind(deviceId),
    db.prepare("DELETE FROM user_states WHERE user_id = ?").bind(deviceId),
    db.prepare("DELETE FROM users WHERE id = ?").bind(deviceId),
  ]);
  return true;
}

async function grantWelcomeTrial(userId: string) {
  const db = getD1();
  // D1 batch is transactional. changes() couples the entitlement mutation to
  // the immediately preceding idempotency-ledger insert, so retries can never
  // extend the same trial twice.
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO membership_ledger
      (user_id, delta_days, source_type, source_id, note) VALUES (?, ?, 'trial', ?, '新用户体验')`)
      .bind(userId, TRIAL_DAYS, TRIAL_SOURCE),
    db.prepare(`UPDATE users SET membership_type = 'duration', membership_end = datetime(
      CASE WHEN membership_end IS NOT NULL AND datetime(membership_end) > CURRENT_TIMESTAMP
        THEN membership_end ELSE CURRENT_TIMESTAMP END, ?)
      WHERE id = ? AND membership_type <> 'lifetime' AND changes() = 1`)
      .bind(`+${TRIAL_DAYS} days`, userId),
  ]);
}

async function ensureIdentityRows(userId: string) {
  const db = getD1();
  const compactId = userId.replaceAll("-", "").replace("acct_", "").toUpperCase();
  const ensureState = () => db.prepare(`INSERT OR IGNORE INTO user_states (user_id, progress_json)
    SELECT id, '{}' FROM users WHERE id = ?`).bind(userId).run();
  // The deterministic first candidate keeps invite links stable while moving
  // from 32 to 64 bits of identity material. Random suffixes bound the tiny
  // remaining collision case without ever issuing a session for a missing user.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const inviteCode = attempt === 0
      ? `GK${compactId.slice(0, 16)}`
      : `GK${compactId.slice(0, 8)}${crypto.randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`;
    try {
      // The id conflict branch preserves every historical invite code and also
      // lets concurrent initialization of the same account converge. A unique
      // invite-code collision belongs to another account, throws, and retries.
      const ready = await db.prepare(`INSERT INTO users (id, invite_code) VALUES (?, ?)
        ON CONFLICT(id) DO UPDATE SET invite_code = users.invite_code
        RETURNING id`).bind(userId, inviteCode).first<{ id: string }>();
      if (ready?.id !== userId) continue;
      await ensureState();
      return;
    } catch {
      // Bounded retry below; no verification, trial or session is issued until
      // a users row for this exact identity was returned by SQLite.
    }
  }
  throw new Error("IDENTITY_USER_ROW_NOT_CREATED");
}

async function linkDeviceAccount(deviceHash: string, userId: string) {
  await getD1().prepare(`INSERT INTO device_account_links (device_hash, user_id, first_seen_at, last_seen_at)
    VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(device_hash, user_id) DO UPDATE SET last_seen_at = CURRENT_TIMESTAMP`)
    .bind(deviceHash, userId).run();
}

async function ensureUser(request: Request, options: { persist?: boolean } = {}) {
  const db = getD1();
  const shouldPersist = options.persist !== false;
  const cookieValue = readCookie(request, USER_COOKIE);
  const rawDeviceToken = readCookie(request, DEVICE_COOKIE);
  const deviceSession = await deviceSessionValue(rawDeviceToken);
  const deviceId = deviceSession?.deviceId ?? crypto.randomUUID();
  const activeSession = await sessionUserId(cookieValue, shouldPersist);
  const anonymousSession = activeSession ? null : await anonymousSessionUserId(cookieValue);
  const email = request.headers.get("oai-authenticated-user-email")?.trim().toLowerCase() ?? "";
  const signedOutAccountSession = Boolean(activeSession?.userId.startsWith("acct_") && !email);
  if (signedOutAccountSession && activeSession) {
    const tokenHash = await digestText(`gongkao-session:${activeSession.token}`);
    await db.prepare("UPDATE user_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE token_hash = ?").bind(tokenHash).run();
  }
  // A client-supplied raw UUID is never identity proof. Device data may only
  // flow into an account from an opaque database session or from the signed
  // anonymous-session envelope verified above.
  const cookieUserId = signedOutAccountSession
    ? null
    : activeSession?.userId ?? anonymousSession?.userId ?? null;
  let identity: Identity;

  if (email) {
    const hash = await digestText(`gongkao-account:${email}`);
    identity = {
      userId: `acct_${hash.slice(0, 32)}`,
      signedIn: true,
      provider: "chatgpt",
      displayName: displayNameFromHeaders(request),
      persistent: true,
    };
  } else {
    identity = {
      userId: validUserId(cookieUserId) ? cookieUserId : crypto.randomUUID(),
      signedIn: false,
      provider: "device",
      displayName: "设备体验用户",
      persistent: Boolean(activeSession && !signedOutAccountSession),
    };
  }

  const sessionSwitchedAccountId = identity.signedIn && activeSession?.userId.startsWith("acct_")
    && activeSession.userId !== identity.userId ? activeSession.userId : "";
  const deviceSwitchedAccountId = identity.signedIn && deviceSession?.lastAccountId
    && deviceSession.lastAccountId !== identity.userId ? deviceSession.lastAccountId : "";
  const switchedAccountId = sessionSwitchedAccountId || deviceSwitchedAccountId;
  const shouldLinkDeviceAccount = identity.signedIn
    && (!deviceSession?.linked || deviceSession.lastAccountId !== identity.userId);
  const deviceHash = shouldLinkDeviceAccount ? await digestText(`gongkao-device:${deviceId}`) : "";
  const deviceCookieNeeded = !deviceSession
    || (identity.signedIn && (!deviceSession.linked || deviceSession.lastAccountId !== identity.userId));
  const nextDeviceToken = deviceCookieNeeded
    ? await issueDeviceSession(deviceId, identity.signedIn ? identity.userId : deviceSession?.lastAccountId ?? null)
    : null;
  const setDeviceCookie = nextDeviceToken ? deviceCookieHeader(request, nextDeviceToken) : undefined;

  // Reading the public bootstrap must not create three durable rows per
  // cookie-less request. Keep a signed, tamper-evident device identity in an
  // HttpOnly cookie and materialize it only on the first real learning action.
  if (!shouldPersist && !identity.signedIn && !identity.persistent) {
    const mayReuseAnonymous = anonymousSession?.userId === identity.userId;
    const token = mayReuseAnonymous ? anonymousSession.token : await issueAnonymousSession(identity.userId);
    return {
      ...identity,
      setCookie: cookieHeaders(
        mayReuseAnonymous ? undefined : anonymousCookieHeader(request, token),
        setDeviceCookie,
      ),
    };
  }
  // A valid opaque session proves that the identity rows were materialized
  // before the token was issued. Reuse it for both reads and writes so a POST
  // preparation response can be retried exactly once and then reach the
  // business handler without repeating the preparation stage forever.
  if (!signedOutAccountSession && activeSession?.userId === identity.userId && !switchedAccountId) {
    if (shouldLinkDeviceAccount) await linkDeviceAccount(deviceHash, identity.userId);
    return { ...identity, persistent: true, setCookie: cookieHeaders(setDeviceCookie) };
  }

  await ensureIdentityRows(identity.userId);
  identity.persistent = true;
  if (identity.signedIn) {
    await db.prepare("UPDATE users SET verified_at = COALESCE(verified_at, CURRENT_TIMESTAMP) WHERE id = ?")
      .bind(identity.userId).run();
    if (shouldLinkDeviceAccount) await linkDeviceAccount(deviceHash, identity.userId);
  }
  if (switchedAccountId) {
    // A signed device envelope survives logout, so A -> logout -> B remains a
    // strong same-browser signal without collecting an invasive fingerprint.
    const switchStatements: D1PreparedStatement[] = [];
    if (sessionSwitchedAccountId && activeSession) {
      const switchedTokenHash = await digestText(`gongkao-session:${activeSession.token}`);
      switchStatements.push(db.prepare("UPDATE user_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE token_hash = ?")
        .bind(switchedTokenHash));
    }
    switchStatements.push(
      db.prepare(`INSERT INTO analytics_events (user_id, event_name, event_data)
        VALUES (?, 'account_switch_detected', ?)`).bind(identity.userId,
        JSON.stringify({ otherUserId: switchedAccountId, signal: "signed_device_account_switch" })),
      db.prepare(`INSERT INTO analytics_events (user_id, event_name, event_data)
        VALUES (?, 'account_switch_detected', ?)`).bind(switchedAccountId,
        JSON.stringify({ otherUserId: identity.userId, signal: "signed_device_account_switch" })),
    );
    await db.batch(switchStatements);
  }
  const deviceMergeAttempted = Boolean(identity.signedIn && validUserId(cookieUserId)
    && !cookieUserId.startsWith("acct_") && cookieUserId !== identity.userId);
  const accountMerged = deviceMergeAttempted
    ? await migrateDeviceUser(cookieUserId!, identity.userId)
    : false;
  if (identity.signedIn) await grantWelcomeTrial(identity.userId);
  const mayReuseSession = !signedOutAccountSession && activeSession?.userId === identity.userId;
  const sessionToken = mayReuseSession ? activeSession.token : await issueUserSession(identity.userId);
  const setCookie = cookieHeaders(
    mayReuseSession ? undefined : cookieHeader(request, sessionToken),
    setDeviceCookie,
  );
  // This branch initialized identity rows, may have granted the welcome trial,
  // and issued a new opaque session. It must never continue into the read-heavy
  // bootstrap in the same D1 invocation. A missing anonymous device row still
  // counts as a completed merge check and is safe to retry with the new cookie.
  return {
    ...identity,
    setCookie,
    accountMerged,
    bootstrapDeferred: true,
    bootstrapStage: accountMerged ? "account_merged" : deviceMergeAttempted ? "device_merge_checked" : "identity_prepared",
  };
}

async function seedDefaults() {
  const db = getD1();
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO products
      (id, name, description, price_cents, currency, grant_type, duration_days, public_promise, status, sort_order)
      VALUES ('gkrl-lifetime-2980', '公考日练终身会员', '包含完整真题日练、多题库组合、记忆周期复习、申论微练与学习诊断。',
        2980, 'CNY', 'lifetime', NULL, '29.8元开通终身会员', 'active', 10)`),
    db.prepare(`UPDATE products
      SET description = '包含完整真题日练、多题库组合、记忆周期复习、申论微练与学习诊断。',
          public_promise = '29.8元开通终身会员'
      WHERE id = 'gkrl-lifetime-2980'`),
    db.prepare("INSERT OR IGNORE INTO configs (key, value) VALUES ('invite_reward_days', '7')"),
    db.prepare("INSERT OR IGNORE INTO configs (key, value) VALUES ('invitee_reward_days', '3')"),
    db.prepare("INSERT OR IGNORE INTO configs (key, value) VALUES ('invite_monthly_cap', '30')"),
    db.prepare(`UPDATE configs SET value = '7', updated_at = CURRENT_TIMESTAMP
      WHERE key = 'invite_reward_days' AND value = '3'
        AND NOT EXISTS (SELECT 1 FROM configs WHERE key = 'invite_policy_v2')`),
    db.prepare("INSERT OR IGNORE INTO configs (key, value) VALUES ('invite_policy_v2', 'applied')"),
    db.prepare("UPDATE redemption_codes SET status = 'disabled' WHERE batch_name = '内测演示码'"),
    db.prepare(`INSERT OR IGNORE INTO question_banks
      (bank_code, name, exam_type, province, exam_year, subject, description, cover_color, status)
      VALUES ('gk-2027', '2027国考行测', 'national', NULL, 2027, '行测', '按国考命题结构整理，持续收录真题与专项训练内容。', 'navy', 'draft')`),
    db.prepare(`INSERT OR IGNORE INTO question_banks
      (bank_code, name, exam_type, province, exam_year, subject, description, cover_color, status)
      VALUES ('joint-provincial-2027', '2027省考联考通用', 'special', '多省', 2027, '行测', '用于省考共通模块训练，各省差异题仍放在对应省份独立题库。', 'green', 'draft')`),
    db.prepare(`INSERT OR IGNORE INTO question_banks
      (bank_code, name, exam_type, province, exam_year, subject, description, cover_color, status)
      VALUES ('gd-2027', '2027广东省考行测', 'provincial', '广东', 2027, '行测', '广东省考独立题库，题型、题量与考情单独维护。', 'orange', 'draft')`),
    db.prepare(`INSERT OR IGNORE INTO question_banks
      (bank_code, name, exam_type, province, exam_year, subject, description, cover_color, status)
      VALUES ('zj-2027', '2027浙江省考行测', 'provincial', '浙江', 2027, '行测', '浙江省考独立题库，题型、题量与考情单独维护。', 'blue', 'draft')`),
    db.prepare(`INSERT OR IGNORE INTO question_banks
      (bank_code, name, exam_type, province, exam_year, subject, description, cover_color, status)
      VALUES ('sd-2027', '2027山东省考行测', 'provincial', '山东', 2027, '行测', '山东省考独立题库，题型、题量与考情单独维护。', 'green', 'draft')`),
    db.prepare(`INSERT OR IGNORE INTO question_banks
      (bank_code, name, exam_type, province, exam_year, subject, description, cover_color, status)
      VALUES ('police-post', '公安岗专项', 'special', '全国', NULL, '综合', '面向公安岗考生的专业科目与岗位专项练习。', 'navy', 'draft')`),
    db.prepare(`INSERT OR IGNORE INTO question_banks
      (bank_code, name, exam_type, province, exam_year, subject, description, cover_color, status)
      VALUES ('law-enforcement', '行政执法专项', 'special', '全国', NULL, '综合', '聚焦行政执法类岗位高频法律与实务考点。', 'orange', 'draft')`),
    db.prepare(`INSERT OR IGNORE INTO question_banks
      (bank_code, name, exam_type, province, exam_year, subject, description, cover_color, status)
      VALUES ('public-institution', '事业单位职测', 'special', '全国', NULL, '综合', '事业单位职测与综合应用能力日练入口。', 'blue', 'draft')`),
  ]);
  await seedDefaultContentOnce();
  await seedDefaultQuizOnce();
  await db.prepare(`INSERT INTO configs (key, value, updated_at)
    VALUES ('default_system_seed_version', ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`)
    .bind(DEFAULT_SEED_VERSION).run();
}

async function ensureDefaults() {
  if (defaultsReady) return;
  if (!defaultsPromise) {
    defaultsPromise = (async () => {
      // One cold-isolate read replaces the old unconditional 15+ statement seed
      // batch. Production migrations write this marker after provisioning all
      // defaults, keeping a signed-in bootstrap inside D1 Free's query budget.
      const marker = await getD1().prepare("SELECT value FROM configs WHERE key = 'default_system_seed_version'")
        .first<{ value: string }>();
      if (marker?.value !== DEFAULT_SEED_VERSION) await seedDefaults();
      defaultsReady = true;
    })().catch((error) => {
      defaultsPromise = null;
      throw error;
    });
  }
  await defaultsPromise;
}

async function seedDefaultContentOnce() {
  const db = getD1();
  const marker = await db.prepare("SELECT value FROM configs WHERE key = 'default_content_seed_version'").first<{ value: string }>();
  if (marker) return;
  const presets = [
    { id: "data-analysis", title: "资料分析速算", subtitle: "5—10分钟一组", icon: "📊", color: "blue", subject: "行测", module: "资料分析", subTypes: [], questionCount: 5, minutes: 8, sortOrder: 10, enabled: true },
    { id: "graphic-reasoning", title: "图形推理", subtitle: "高频规律专项训练", icon: "🧩", color: "purple", subject: "行测", module: "判断推理", subTypes: ["图形推理"], questionCount: 5, minutes: 8, sortOrder: 20, enabled: true },
    { id: "idiom", title: "言语易错成语", subtitle: "易混词辨析训练", icon: "📖", color: "orange", subject: "行测", module: "言语理解", subTypes: ["选词填空"], questionCount: 5, minutes: 6, sortOrder: 30, enabled: true },
    { id: "current-affairs", title: "时政常识", subtitle: "高频真题训练", icon: "📰", color: "red", subject: "行测", module: "常识判断", subTypes: ["时政"], questionCount: 5, minutes: 5, sortOrder: 40, enabled: true },
    { id: "essay-expression", title: "申论规范表达", subtitle: "材料要点与规范表达", icon: "✍️", color: "green", subject: "申论", module: "规范表达", subTypes: [], questionCount: 1, minutes: 10, sortOrder: 50, enabled: true },
  ];
  const statements: D1PreparedStatement[] = [];
  for (const day of defaultPracticeDays) {
    statements.push(db.prepare(`INSERT OR IGNORE INTO content_items
      (content_type, content_key, title, payload_json, access_level, status, version)
      VALUES ('practice_day', ?, ?, ?, ?, 'published', 1)`)
      .bind(`day-${day.day}`, `第${day.day}天日练`, JSON.stringify({ ...day, questions: [] }), day.day === 1 ? "free" : "member"));
  }
  for (const track of defaultAudioTracks) {
    statements.push(db.prepare(`INSERT OR IGNORE INTO content_items
      (content_type, content_key, title, payload_json, access_level, status, version)
      VALUES ('audio_track', ?, ?, ?, ?, 'draft', 1)`)
      .bind(track.id, track.title, JSON.stringify(track), track.id === defaultAudioTracks[0]?.id ? "free" : "member"));
  }
  for (const preset of presets) {
    statements.push(db.prepare(`INSERT OR IGNORE INTO content_items
      (content_type, content_key, title, payload_json, access_level, status, version)
      VALUES ('drill_preset', ?, ?, ?, 'free', 'published', 1)`)
      .bind(`drill-${preset.id}`, preset.title, JSON.stringify(preset)));
  }
  statements.push(db.prepare(`INSERT OR IGNORE INTO content_items
    (content_type, content_key, title, payload_json, access_level, status, version)
    VALUES ('strategy_config', 'strategy-default', '默认日练策略', ?, 'free', 'published', 1)`)
    .bind(JSON.stringify(DEFAULT_STRATEGY)));
  statements.push(db.prepare("INSERT OR IGNORE INTO configs (key, value) VALUES ('default_content_seed_version', '1')"));
  await db.batch(statements);
}

async function seedDefaultQuizOnce() {
  const db = getD1();
  const marker = await db.prepare("SELECT value FROM configs WHERE key = 'default_quiz_seed_version'").first<{ value: string }>();
  if (marker?.value === "2") return;
  const statements: D1PreparedStatement[] = [
    db.prepare(`INSERT INTO quiz_tests
      (id, slug, title, description, question_count, status, share_title, disclaimer)
      VALUES (?, ?, '测测你有没有“局长”思维？', '随机10道办公室语境判断题，测一测你的体制内语感。', ?, 'published',
        '我测了测自己的局长思维，你也来试试？', '纯属趣味测试，不构成公务员录用、任职或晋升预测。')
      ON CONFLICT(id) DO UPDATE SET title = excluded.title, description = excluded.description,
        question_count = excluded.question_count, status = excluded.status, share_title = excluded.share_title,
        disclaimer = excluded.disclaimer, updated_at = CURRENT_TIMESTAMP`)
      .bind(DEFAULT_QUIZ_ID, DEFAULT_QUIZ_SLUG, DEFAULT_QUIZ_QUESTION_COUNT),
  ];
  DEFAULT_QUIZ_RESULTS.forEach((level, index) => {
    statements.push(db.prepare(`INSERT INTO quiz_result_levels
      (id, quiz_id, level_key, title, min_score, max_score, theme, description, share_text, badge_label, sort_order, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
      ON CONFLICT(quiz_id, level_key) DO UPDATE SET title = excluded.title, min_score = excluded.min_score,
        max_score = excluded.max_score, theme = excluded.theme, description = excluded.description,
        share_text = excluded.share_text, badge_label = excluded.badge_label, sort_order = excluded.sort_order,
        status = excluded.status, updated_at = CURRENT_TIMESTAMP`)
      .bind(`${DEFAULT_QUIZ_ID}-${level.key}`, DEFAULT_QUIZ_ID, level.key, level.title,
        level.minScore, level.maxScore, level.theme, level.description, level.shareText, level.badgeLabel, index * 10));
  });
  DEFAULT_QUIZ_QUESTIONS.forEach((question, index) => {
    statements.push(db.prepare(`INSERT OR IGNORE INTO quiz_questions
      (quiz_id, question_code, stem, options_json, correct_index, explanation, category, difficulty, weight, status, review_status, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 10, 'published', 'approved', ?)`)
      .bind(DEFAULT_QUIZ_ID, question.code, question.stem, JSON.stringify(question.options), question.correctIndex,
        question.explanation, question.category, question.difficulty, index * 10));
  });
  statements.push(db.prepare(`INSERT INTO configs (key, value, updated_at) VALUES ('default_quiz_seed_version', '2', CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`));
  await db.batch(statements);
}

async function getConfigNumber(key: string, fallback: number) {
  const row = await getD1().prepare("SELECT value FROM configs WHERE key = ?").bind(key).first<{ value: string }>();
  const value = Number(row?.value);
  return Number.isFinite(value) ? value : fallback;
}

async function loadInviteConfig() {
  const rows = await getD1().prepare(`SELECT key, value FROM configs
    WHERE key IN ('invite_reward_days', 'invitee_reward_days', 'invite_monthly_cap')`)
    .all<{ key: string; value: string }>();
  const values = new Map(rows.results.map((row) => [row.key, Number(row.value)]));
  const numberOr = (key: string, fallback: number) => Number.isFinite(values.get(key)) ? Number(values.get(key)) : fallback;
  return {
    rewardDays: numberOr("invite_reward_days", 7),
    inviteeRewardDays: numberOr("invitee_reward_days", 3),
    monthlyCap: numberOr("invite_monthly_cap", 30),
  };
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
    truthVerified: false,
    frequencyReliable: false,
    frequencyOccurrences: 0,
    frequencyPapers: 0,
    frequencyYears: [],
    frequencyUpdatedAt: null,
    importanceReliable: false,
    importanceRuleVersion: "",
    importanceReason: "",
    importanceOverrideReason: "",
    scoreRateReliable: false,
    scoreRateCorrect: 0,
    scoreRateAttempts: 0,
    scoreRateScope: "",
    scoreRateSource: "",
    scoreRateUpdatedAt: null,
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

function parseYearList(value: unknown) {
  try {
    const parsed = Array.isArray(value) ? value : JSON.parse(String(value ?? "[]"));
    if (!Array.isArray(parsed)) return [];
    return Array.from(new Set(parsed.map(Number)
      .filter((year) => Number.isInteger(year) && year >= 1990 && year <= new Date().getFullYear())))
      .sort((a, b) => b - a)
      .slice(0, 5);
  } catch {
    return [];
  }
}

function metricFields(row: Record<string, unknown>) {
  const truthVerified = Number(row.truth_verified ?? 0) === 1;
  const frequencyOccurrences = Math.max(0, Math.floor(Number(row.frequency_occurrences ?? 0)));
  const frequencyPapers = Math.max(0, Math.floor(Number(row.frequency_papers ?? 0)));
  const frequencyYears = parseYearList(row.frequency_years_json);
  const frequencyUpdatedAt = row.frequency_updated_at ? String(row.frequency_updated_at) : null;
  const frequencyReliable = truthVerified && frequencyOccurrences > 0 && frequencyPapers >= 3
    && frequencyYears.length >= 3 && Boolean(frequencyUpdatedAt);
  const coverage = frequencyPapers > 0 ? frequencyOccurrences / frequencyPapers : 0;
  const frequency = frequencyReliable ? coverage >= 0.55 ? "高频" : coverage >= 0.25 ? "中频" : "低频" : "";
  const importanceRuleVersion = String(row.importance_rule_version ?? "").trim();
  const importanceReason = String(row.importance_reason ?? "").trim();
  const importanceOverrideReason = String(row.importance_override_reason ?? "").trim();
  const rawImportance = Math.floor(Number(row.importance_stars ?? 0));
  const importanceReliable = truthVerified && rawImportance >= 1 && rawImportance <= 5
    && Boolean(importanceRuleVersion) && Boolean(importanceReason || importanceOverrideReason)
    && (Boolean(importanceOverrideReason) || frequencyReliable);
  const scoreRateCorrect = Math.max(0, Math.floor(Number(row.score_rate_correct ?? 0)));
  const scoreRateAttempts = Math.max(0, Math.floor(Number(row.score_rate_attempts ?? 0)));
  const scoreRateScope = String(row.score_rate_scope ?? "").trim();
  const scoreRateSource = String(row.score_rate_source ?? "platform").trim() || "platform";
  const scoreRateUpdatedAt = row.score_rate_updated_at ? String(row.score_rate_updated_at) : null;
  const scoreRateReliable = truthVerified && scoreRateAttempts >= 100 && scoreRateCorrect <= scoreRateAttempts
    && Boolean(scoreRateScope) && Boolean(scoreRateUpdatedAt);
  const scoreRate = scoreRateAttempts > 0 ? Math.round(scoreRateCorrect * 100 / scoreRateAttempts) : 0;
  return {
    truthVerified,
    frequency,
    frequencyReliable,
    frequencyOccurrences,
    frequencyPapers,
    frequencyYears,
    frequencyUpdatedAt,
    importanceStars: importanceReliable ? rawImportance : 0,
    importanceReliable,
    importanceRuleVersion,
    importanceReason,
    importanceOverrideReason,
    scoreRate: scoreRateReliable ? scoreRate : 0,
    scoreRateReliable,
    scoreRateCorrect,
    scoreRateAttempts,
    scoreRateScope,
    scoreRateSource,
    scoreRateUpdatedAt,
  };
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
  const truthRegion = normalizeProvince(question.region) === "全国" ? "国考" : normalizeProvince(question.region);
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
    truthVerified: question.truthVerified,
    frequencyMeta: {
      reliable: question.frequencyReliable,
      occurrences: question.frequencyOccurrences,
      paperCount: question.frequencyPapers,
      years: question.frequencyYears,
      updatedAt: question.frequencyUpdatedAt,
      scope: question.scopeLabel,
    },
    importanceMeta: {
      reliable: question.importanceReliable,
      ruleVersion: question.importanceRuleVersion,
      reason: question.importanceReason,
      overrideReason: question.importanceOverrideReason,
    },
    scoreRateMeta: {
      reliable: question.scoreRateReliable,
      correct: question.scoreRateCorrect,
      sampleSize: question.scoreRateAttempts,
      scope: question.scoreRateScope,
      source: question.scoreRateSource,
      updatedAt: question.scoreRateUpdatedAt,
    },
    suggestedSeconds: question.suggestedSeconds,
    imageUrl: question.imageUrl,
    resourceUrl: question.resourceUrl,
    truthLabel: truthRegion && question.examYear ? `${truthRegion}-${question.examYear}` : truthRegion || "真题",
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
  const normalizedScorePenalty = question.scoreRateReliable
    ? Math.min(1, scoreDistance / 40) * weights.scoreRate
    : 0.5 * weights.scoreRate;
  const normalizedFrequencyPenalty = (question.frequencyReliable
    ? question.frequency === "高频" ? 0 : question.frequency === "中频" ? 0.5 : 1
    : 0.5) * weights.frequency;
  const normalizedImportancePenalty = (question.importanceReliable ? (5 - question.importanceStars) / 4 : 0.5) * weights.importance;
  return normalizedScorePenalty + normalizedFrequencyPenalty + normalizedImportancePenalty;
}

function questionFingerprint(question: Pick<ResolvedQuestion, "stem" | "options">) {
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

async function effectivePracticeBankCodes(userId: string, selected: string[], membershipActive: boolean) {
  if (membershipActive) return selected;
  const row = await getD1().prepare(`SELECT uqb.bank_code
    FROM user_question_banks uqb
    JOIN question_banks qb ON qb.bank_code = uqb.bank_code AND qb.status = 'published'
    WHERE uqb.user_id = ? AND EXISTS (
      SELECT 1 FROM question_bank_items qbi
      JOIN questions q ON q.id = qbi.question_id
      WHERE qbi.bank_id = qb.id AND q.status = 'active'
        AND q.truth_verified = 1 AND q.review_status = 'approved'
        AND qb.subject <> '申论' AND q.subject = '行测'
    )
    ORDER BY uqb.added_at, uqb.bank_code LIMIT 1`).bind(userId).first<{ bank_code: string }>();
  return row?.bank_code ? [row.bank_code] : [];
}

const DAILY_REQUIRED_QUESTION_COUNT = 5;
const DAILY_READINESS_SCAN_LIMIT = 640;

type DailyReadiness = {
  ready: boolean;
  distinctQuestionCount: number;
  requiredQuestionCount: number;
  effectiveBankCodes: string[];
  planMinutes: number;
};

type DailyReadinessOverrides = {
  profile?: LoadedExamProfile | Promise<LoadedExamProfile>;
  selected?: string[] | Promise<string[]>;
  strategy?: Record<string, unknown> | null | Promise<Record<string, unknown> | null>;
  entitledBankCodes?: string[] | Promise<string[]>;
};

async function loadDailyReadiness(userId: string, membershipActive: boolean, requestedPlanMinutes?: unknown, overrides?: DailyReadinessOverrides): Promise<DailyReadiness> {
  const db = getD1();
  const [profile, strategy, selected] = await Promise.all([
    overrides?.profile ? Promise.resolve(overrides.profile) : loadExamProfile(userId),
    overrides?.strategy !== undefined ? Promise.resolve(overrides.strategy) : membershipActive ? loadStrategyConfig() : Promise.resolve(null),
    overrides?.selected ? Promise.resolve(overrides.selected) : selectedBankCodes(userId),
  ]);
  const planMinutes = effectiveDailyPlanMinutes(profile.dailyMinutes, requestedPlanMinutes, membershipActive);
  const requiredQuestionCount = requiredDailyQuestionCount(strategy, planMinutes, membershipActive);
  if (!profile.onboarded) {
    return { ready: false, distinctQuestionCount: 0, requiredQuestionCount, effectiveBankCodes: [], planMinutes };
  }
  // A main national/provincial bank must match one of the learner's real
  // targets and recent exam years. Special banks are auxiliary only: they can
  // enrich a valid target prescription, but can never make an unrelated or
  // special-only shelf appear ready.
  const entitledBankCodes = new Set(await (overrides?.entitledBankCodes
    ? Promise.resolve(overrides.entitledBankCodes)
    : effectivePracticeBankCodes(userId, selected, membershipActive)));
  const banks = await db.prepare(`SELECT qb.bank_code, qb.exam_type, qb.province, qb.exam_year, qb.subject
    FROM user_question_banks uqb
    JOIN question_banks qb ON qb.bank_code = uqb.bank_code
    WHERE uqb.user_id = ? AND qb.status = 'published' AND qb.subject <> '申论'
      AND EXISTS (
        SELECT 1 FROM question_bank_items qbi
        JOIN questions q ON q.id = qbi.question_id
        WHERE qbi.bank_id = qb.id AND q.status = 'active' AND q.subject = '行测'
          AND q.truth_verified = 1 AND q.review_status = 'approved'
      )
    ORDER BY uqb.added_at, uqb.bank_code LIMIT 64`)
    .bind(userId).all<{ bank_code: string; exam_type: string; province: string | null; exam_year: number | null; subject: string }>();
  const entitledRows = banks.results.filter((bank) => entitledBankCodes.has(String(bank.bank_code)));
  const targetBanks = entitledRows.filter((bank) => bankMatchesDailyTarget(bank, profile));
  const auxiliaryBanks = targetBanks.length
    ? entitledRows.filter((bank) => bank.exam_type === "special")
    : [];
  const effectiveRows = [...targetBanks, ...auxiliaryBanks];
  const effectiveBankCodes = Array.from(new Set(effectiveRows.map((row) => String(row.bank_code))));
  if (!effectiveBankCodes.length) {
    return { ready: false, distinctQuestionCount: 0, requiredQuestionCount, effectiveBankCodes, planMinutes };
  }
  const placeholders = effectiveBankCodes.map(() => "?").join(",");
  // Exact duplicates are collapsed in SQLite first; the bounded result is then
  // passed through the same NFKC/punctuation fingerprint used by daily grouping.
  // 640 is the existing candidate ceiling and prevents bootstrap from reading an
  // unbounded member library merely to decide a five-question readiness gate.
  const rows = await db.prepare(`WITH exact_content AS (
      SELECT MIN(q.id) AS id, q.stem, q.options_json
      FROM questions q
      JOIN question_bank_items qbi ON qbi.question_id = q.id
      JOIN question_banks qb ON qb.id = qbi.bank_id
      WHERE qb.bank_code IN (${placeholders}) AND qb.status = 'published' AND qb.subject <> '申论'
        AND q.status = 'active' AND q.subject = '行测'
        AND q.truth_verified = 1 AND q.review_status = 'approved'
      GROUP BY q.stem, q.options_json
      ORDER BY MIN(q.id)
      LIMIT ${DAILY_READINESS_SCAN_LIMIT}
    )
    SELECT stem, options_json FROM exact_content ORDER BY id`)
    .bind(...effectiveBankCodes).all<{ stem: string; options_json: string }>();
  const fingerprints = new Set(rows.results.map((row) => questionFingerprint({
    stem: String(row.stem),
    options: parseOptions(String(row.options_json ?? "[]")),
  })));
  const distinctQuestionCount = fingerprints.size;
  return {
    ready: distinctQuestionCount >= requiredQuestionCount,
    distinctQuestionCount,
    requiredQuestionCount,
    effectiveBankCodes,
    planMinutes,
  };
}

async function loadDailyUsage(userId: string, dateKey = chinaDateKey()) {
  const row = await getD1().prepare(`SELECT practice_count, audio_count FROM user_daily_usage
    WHERE user_id = ? AND date_key = ?`).bind(userId, dateKey)
    .first<{ practice_count: number; audio_count: number }>();
  return { practice: Number(row?.practice_count ?? 0), audio: Number(row?.audio_count ?? 0) };
}

async function grantDailyFreeAudio(userId: string, assetId: string, dateKey = chinaDateKey()) {
  const db = getD1();
  await db.batch([
    db.prepare(CLAIM_DAILY_FREE_AUDIO_SQL).bind(userId, dateKey, assetId, userId),
    db.prepare(COUNT_DAILY_FREE_AUDIO_SQL).bind(userId, dateKey),
  ]);
  const granted = await db.prepare(`SELECT asset_id FROM user_daily_audio_access
    WHERE user_id = ? AND date_key = ?`).bind(userId, dateKey).first<{ asset_id: string }>();
  return granted?.asset_id === assetId;
}

async function authorizeAudioPlayback(userId: string, payload: Record<string, unknown>) {
  const trackId = trimmed(payload.trackId, 120);
  if (!trackId) return json({ error: "节目编号不能为空", code: "AUDIO_TRACK_INVALID" }, 400);
  const membership = await userMembership(userId);
  if (membershipIsActive(membership)) return json({ ok: true, access: "premium" });

  let claimKey = "";
  if (trackId.startsWith("wrong-")) {
    const questionCode = trackId.slice("wrong-".length);
    const available = await getD1().prepare(`SELECT 1 AS available FROM user_question_progress uqp
      JOIN questions q ON q.question_code = uqp.question_code
      WHERE uqp.user_id = ? AND uqp.question_code = ? AND uqp.wrong_count > 0
        AND q.status = 'active' AND q.truth_verified = 1 AND q.review_status = 'approved'
      LIMIT 1`).bind(userId, questionCode).first<{ available: number }>();
    if (!available) return json({ error: "这道错题不在当前可朗读范围内", code: "AUDIO_TRACK_INVALID" }, 404);
    claimKey = `wrong:${questionCode}`;
  } else {
    const row = await getD1().prepare(`SELECT payload_json, access_level FROM content_items
      WHERE content_type = 'audio_track' AND content_key = ?
        AND status IN ('published', 'scheduled')
        AND (publish_at IS NULL OR datetime(publish_at) <= CURRENT_TIMESTAMP)
      LIMIT 1`).bind(trackId).first<{ payload_json: string; access_level: string }>();
    if (!row) return json({ error: "节目不存在或尚未发布", code: "AUDIO_TRACK_INVALID" }, 404);
    if (row.access_level !== "free") {
      return json({ error: "该节目需开通会员后收听", code: "PAYWALL_AUDIO" }, 403);
    }
    let managedAsset = "";
    try {
      const parsed = JSON.parse(row.payload_json) as Record<string, unknown>;
      managedAsset = managedMediaAssetId(typeof parsed.audioUrl === "string" ? parsed.audioUrl : "") ?? "";
    } catch { managedAsset = ""; }
    claimKey = managedAsset || `content:${trackId}`;
  }

  if (!await grantDailyFreeAudio(userId, claimKey)) {
    return json({ error: "今日免费试听次数已用完，开通会员可收听完整音频内容", code: "PAYWALL_AUDIO" }, 403);
  }
  return json({ ok: true, access: "daily_free", claimKey });
}

type PracticeSessionRow = {
  id: string;
  status: string;
  target_count: number;
  question_codes_json: string;
  answered_count: number;
  correct_count: number;
  review_added: number;
  elapsed_seconds: number;
};

type DailyCarry = {
  answered: number;
  correct: number;
  reviewAdded: number;
  elapsedSeconds: number;
  questionCodes: string[];
};

const EMPTY_DAILY_CARRY: DailyCarry = {
  answered: 0, correct: 0, reviewAdded: 0, elapsedSeconds: 0, questionCodes: [],
};

async function loadAbandonedDailyCarry(userId: string, dateKey: string, maxQuestions = 20): Promise<DailyCarry> {
  const rows = await getD1().prepare(ABANDONED_DAILY_CARRY_SQL).bind(userId, dateKey).all<{
      question_code: string; is_correct: number; uncertain: number; confidence: string; overtime: number; duration_ms: number;
    }>();
  return summarizeDailyCarry(rows.results, maxQuestions);
}

function safeStringArray(value: unknown, max = 100) {
  try {
    const parsed = Array.isArray(value) ? value : JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? Array.from(new Set(parsed.map(String).filter(Boolean))).slice(0, max) : [];
  } catch {
    return [];
  }
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
  const normalizedTargetEntries: Array<readonly [string, ExamTargetProfile]> = targetRows.results.flatMap((target): Array<readonly [string, ExamTargetProfile]> => {
    const province = target.exam_type === "national" ? "" : normalizeSelectableProvince(target.province);
    if (target.exam_type !== "national" && !province) return [];
    const code = target.exam_type === "national" ? "national" : `province:${province}`;
    const normalized: ExamTargetProfile = {
    code,
    label: target.exam_type === "national" ? "国考" : `${province}省考`,
    examType: target.exam_type === "national" ? "国考" as const : "省考" as const,
    province,
    examYear: target.exam_year,
    examDate: target.exam_date,
    };
    return [[code, normalized] as const];
  });
  const targets: ExamTargetProfile[] = Array.from(new Map(normalizedTargetEntries).values());
  if (row) {
    const isProvincial = row.exam_type === "省考";
    const province = isProvincial ? normalizeSelectableProvince(row.province) : "";
    const legacyTarget = (!isProvincial || province) ? {
      code: isProvincial ? `province:${province}` : "national",
      label: isProvincial ? `${province}省考` : "国考",
      examType: isProvincial ? "省考" : "国考",
      province,
      examYear: row.exam_year,
      examDate: row.exam_date,
    } satisfies ExamTargetProfile : null;
    if (legacyTarget) {
      const primaryIndex = targets.findIndex((target) => target.code === legacyTarget.code);
      if (primaryIndex === -1) targets.unshift(legacyTarget);
      else if (primaryIndex > 0) targets.unshift(...targets.splice(primaryIndex, 1));
    }
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

function bankMatchesDailyTarget(
  bank: { exam_type: string; province?: string | null; exam_year?: number | null },
  profile: LoadedExamProfile,
) {
  if (bank.exam_type === "special") return false;
  const bankYear = Number(bank.exam_year ?? 0);
  return profile.targets.some((target) => {
    const scopeMatches = bank.exam_type === "national"
      ? target.examType === "国考"
      : bank.exam_type === "provincial" && target.examType === "省考"
        && normalizeProvince(bank.province) === normalizeProvince(target.province);
    return scopeMatches && (!bankYear || (bankYear <= target.examYear && bankYear >= target.examYear - 4));
  });
}

function displayExamType(value: string) {
  return value === "national" ? "国考" : value === "provincial" ? "省考" : "专项";
}

function questionScopeLabel(examType: string, province: unknown) {
  if (examType === "national") return "国考题源";
  if (examType === "provincial") {
    const normalizedProvince = normalizeProvince(province);
    return normalizedProvince ? `${normalizedProvince}省考题源` : "省考题源";
  }
  return "通用专项";
}

function normalizeProvince(value: unknown) {
  return trimmed(value, 24)
    .replace(/特别行政区$/, "")
    .replace(/壮族自治区$|回族自治区$|维吾尔自治区$|自治区$/, "")
    .replace(/省$|市$/, "");
}

function normalizeSelectableProvince(value: unknown) {
  const province = normalizeProvince(value);
  return SELECTABLE_PROVINCES.has(province) ? province : "";
}

function inferredTargetYear(sourceYear: unknown, currentYear = new Date().getFullYear()) {
  const parsed = Math.floor(Number(sourceYear));
  const preferred = Number.isInteger(parsed) ? parsed : currentYear + 1;
  return Math.max(currentYear + 1, Math.min(currentYear + 3, preferred));
}

async function loadQuestionBanks(
  userId: string,
  membershipActiveOverride?: boolean,
  profileOverride?: LoadedExamProfile | Promise<LoadedExamProfile>,
  selectedOverride?: string[] | Promise<string[]>,
) {
  const db = getD1();
  const [selected, rows, profile, membership] = await Promise.all([
    selectedOverride ? Promise.resolve(selectedOverride) : selectedBankCodes(userId),
    db.prepare(`SELECT qb.bank_code, qb.name, qb.exam_type, qb.province, qb.exam_year, qb.subject,
      qb.description, qb.cover_color,
      COUNT(DISTINCT CASE WHEN q.subject = '行测' THEN q.question_code END) AS practice_question_count,
      COUNT(DISTINCT CASE WHEN q.subject = '申论' THEN q.question_code END) AS essay_question_count,
      COUNT(DISTINCT CASE WHEN q.subject = '申论' AND NOT EXISTS (
        SELECT 1 FROM essay_attempts ea_block
        WHERE ea_block.user_id = ? AND ea_block.question_code = q.question_code
          AND ea_block.stage IN ('scheduled', 'completed')
      ) THEN q.question_code END) AS available_essay_count,
      COUNT(DISTINCT CASE WHEN uqp.last_answered_at IS NOT NULL THEN q.question_code END) AS studied_count,
      COUNT(DISTINCT CASE WHEN uqp.state = 'mastered' THEN q.question_code END) AS mastered_count,
      COUNT(DISTINCT CASE WHEN uqp.state = 'weak' THEN q.question_code END) AS weak_count,
      COUNT(DISTINCT CASE WHEN datetime(uqp.next_review_at) <= CURRENT_TIMESTAMP THEN q.question_code END) AS due_count
      FROM question_banks qb
      LEFT JOIN question_bank_items qbi ON qbi.bank_id = qb.id
      LEFT JOIN questions q ON q.id = qbi.question_id
        AND ${QUESTION_BANK_PUBLISHABLE_ITEM_SQL}
      LEFT JOIN user_question_progress uqp ON uqp.question_code = q.question_code AND uqp.user_id = ?
      WHERE qb.status = 'published'
      GROUP BY qb.id HAVING COUNT(DISTINCT q.id) > 0
      ORDER BY qb.updated_at DESC`).bind(userId, userId).all<{
        bank_code: string; name: string; exam_type: string; province: string | null; exam_year: number | null;
        subject: string; description: string; cover_color: string; practice_question_count: number; essay_question_count: number; available_essay_count: number; studied_count: number; mastered_count: number;
        weak_count: number; due_count: number;
      }>(),
    profileOverride ? Promise.resolve(profileOverride) : loadExamProfile(userId),
    membershipActiveOverride === undefined ? userMembership(userId) : Promise.resolve(null),
  ]);
  const membershipActive = membershipActiveOverride ?? membershipIsActive(membership);
  const availableFreeBankCode = membershipActive ? "" : selected.find((code) => {
    const row = rows.results.find((candidate) => candidate.bank_code === code);
    return Boolean(row && row.subject !== "申论" && Number(row.practice_question_count) > 0);
  }) ?? "";
  return rows.results.map((row) => {
    const targetMatch = bankMatchesTargets(row, profile);
    const matchingTarget = profile.targets.find((target) => row.exam_type === "national"
      ? target.examType === "国考"
      : row.exam_type === "provincial" ? target.examType === "省考" && normalizeProvince(target.province) === normalizeProvince(row.province) : true);
    const recommended = targetMatch && (!row.exam_year || Boolean(matchingTarget
      && row.exam_year <= matchingTarget.examYear && row.exam_year >= matchingTarget.examYear - 4));
    const scopeLabel = row.exam_type === "provincial" ? `${normalizeProvince(row.province) || "未设置"}省考专属` : row.exam_type === "national" ? "国考专属" : "专项训练";
    const mismatchReason = targetMatch ? "" : row.exam_type === "provincial"
      ? `添加后会同步加入“${normalizeProvince(row.province) || "该省"}省考”报考目标。`
      : row.exam_type === "national" ? "添加后会同步加入“国考”报考目标。" : "可作为专项题库加入。";
    const added = selected.includes(row.bank_code);
    const practiceAvailable = added && (membershipActive || row.bank_code === availableFreeBankCode);
    return {
    code: row.bank_code,
    name: row.name,
    examType: displayExamType(row.exam_type),
    province: normalizeProvince(row.province) || "全国",
    examYear: row.exam_year,
    subject: row.subject,
    description: row.description,
    coverColor: row.cover_color,
    questionCount: Number(row.subject === "申论" ? row.essay_question_count : row.practice_question_count),
    availableEssayCount: Number(row.available_essay_count ?? 0),
    studiedCount: Number(row.studied_count),
    masteredCount: Number(row.mastered_count),
    weakCount: Number(row.weak_count),
    dueCount: Number(row.due_count),
    added,
    practiceAvailable,
    locked: added && !practiceAvailable,
    targetMatch,
    recommended,
    scopeLabel,
    mismatchReason,
  }; });
}

async function loadStudyInsights(userId: string, selectedOverride?: string[] | Promise<string[]>) {
  const db = getD1();
  const selectedBanksPromise = selectedOverride ? Promise.resolve(selectedOverride) : selectedBankCodes(userId);
  const appliedAttempt = "apply_status = 'applied'";
  const statsPromise = Promise.all([
    db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(is_correct), 0) AS correct,
      COALESCE(AVG(duration_ms), 0) AS avg_duration,
      COALESCE(SUM(CASE WHEN confidence IN ('hesitant', 'guessed') OR uncertain = 1 THEN 1 ELSE 0 END), 0) AS uncertain_total,
      COALESCE(SUM(overtime), 0) AS overtime_total
      FROM practice_attempts WHERE user_id = ? AND ${appliedAttempt}`).bind(userId)
      .first<{ total: number; correct: number; avg_duration: number; uncertain_total: number; overtime_total: number }>(),
    db.prepare(`SELECT module, COUNT(*) AS total, COALESCE(SUM(is_correct), 0) AS correct,
      COALESCE(AVG(duration_ms), 0) AS avg_duration FROM practice_attempts WHERE user_id = ?
        AND ${appliedAttempt} AND answered_at >= datetime('now', '-14 days')
      GROUP BY module ORDER BY total DESC LIMIT 8`).bind(userId)
      .all<{ module: string; total: number; correct: number; avg_duration: number }>(),
    db.prepare(`SELECT state, COUNT(*) AS total FROM user_question_progress WHERE user_id = ? GROUP BY state`)
      .bind(userId).all<{ state: string; total: number }>(),
    db.prepare(`SELECT date(answered_at, '+8 hours') AS day, COUNT(*) AS total, COALESCE(SUM(is_correct), 0) AS correct
      FROM practice_attempts WHERE user_id = ? AND ${appliedAttempt} AND answered_at >= datetime('now', '-6 days')
      GROUP BY date(answered_at, '+8 hours') ORDER BY day`).bind(userId)
      .all<{ day: string; total: number; correct: number }>(),
    db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(is_correct), 0) AS correct,
        COALESCE(SUM(CASE WHEN was_due = 1 AND is_correct = 1 AND confidence = 'confident' THEN 1 ELSE 0 END), 0) AS repaired_due,
        COALESCE(SUM(CASE WHEN is_correct = 0 THEN 1 ELSE 0 END), 0) AS wrong_total,
        COALESCE(SUM(CASE WHEN confidence = 'hesitant' THEN 1 ELSE 0 END), 0) AS hesitant_total,
        COALESCE(SUM(CASE WHEN confidence = 'guessed' THEN 1 ELSE 0 END), 0) AS guessed_total,
        COALESCE(SUM(overtime), 0) AS overtime_total, COALESCE(AVG(duration_ms), 0) AS avg_duration
      FROM practice_attempts WHERE user_id = ? AND ${appliedAttempt}
        AND date(answered_at, '+8 hours') = date('now', '+8 hours')`).bind(userId)
      .first<{ total: number; correct: number; repaired_due: number; wrong_total: number; hesitant_total: number; guessed_total: number; overtime_total: number; avg_duration: number }>(),
    db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(is_correct), 0) AS correct, COALESCE(AVG(duration_ms), 0) AS avg_duration
      FROM practice_attempts WHERE user_id = ? AND ${appliedAttempt}
        AND date(answered_at, '+8 hours') >= date('now', '+8 hours', '-7 days')
        AND date(answered_at, '+8 hours') < date('now', '+8 hours')`).bind(userId)
      .first<{ total: number; correct: number; avg_duration: number }>(),
    db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(is_correct), 0) AS correct,
        COUNT(DISTINCT date(answered_at, '+8 hours')) AS active_days, COALESCE(AVG(duration_ms), 0) AS avg_duration,
        COALESCE(SUM(CASE WHEN is_correct = 0 THEN 1 ELSE 0 END), 0) AS wrong_total,
        COALESCE(SUM(CASE WHEN is_correct = 0 AND EXISTS (
          SELECT 1 FROM practice_attempts prior WHERE prior.user_id = practice_attempts.user_id
            AND prior.question_code = practice_attempts.question_code AND prior.id < practice_attempts.id
            AND prior.apply_status = 'applied' AND prior.is_correct = 0
        ) THEN 1 ELSE 0 END), 0) AS repeated_wrong
      FROM practice_attempts WHERE user_id = ? AND ${appliedAttempt}
        AND date(answered_at, '+8 hours') >= date('now', '+8 hours', '-6 days')`).bind(userId)
      .first<{ total: number; correct: number; active_days: number; avg_duration: number; wrong_total: number; repeated_wrong: number }>(),
    db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(is_correct), 0) AS correct,
        COUNT(DISTINCT date(answered_at, '+8 hours')) AS active_days, COALESCE(AVG(duration_ms), 0) AS avg_duration,
        COALESCE(SUM(CASE WHEN is_correct = 0 THEN 1 ELSE 0 END), 0) AS wrong_total,
        COALESCE(SUM(CASE WHEN is_correct = 0 AND EXISTS (
          SELECT 1 FROM practice_attempts prior WHERE prior.user_id = practice_attempts.user_id
            AND prior.question_code = practice_attempts.question_code AND prior.id < practice_attempts.id
            AND prior.apply_status = 'applied' AND prior.is_correct = 0
        ) THEN 1 ELSE 0 END), 0) AS repeated_wrong
      FROM practice_attempts WHERE user_id = ? AND ${appliedAttempt}
        AND date(answered_at, '+8 hours') BETWEEN date('now', '+8 hours', '-13 days') AND date('now', '+8 hours', '-7 days')`).bind(userId)
      .first<{ total: number; correct: number; active_days: number; avg_duration: number; wrong_total: number; repeated_wrong: number }>(),
    db.prepare(`SELECT DISTINCT COALESCE(NULLIF(TRIM(q.sub_type), ''), NULLIF(TRIM(q.module), '')) AS knowledge_point
      FROM practice_attempts pa
      JOIN questions q ON q.question_code = pa.question_code
      WHERE pa.user_id = ? AND pa.apply_status = 'applied' AND ${RELIABLE_FREQUENCY_SQL}
        AND q.frequency_occurrences >= 3
        AND COALESCE(NULLIF(TRIM(q.sub_type), ''), NULLIF(TRIM(q.module), '')) IS NOT NULL
        AND date(pa.answered_at, '+8 hours') = date('now', '+8 hours')
      ORDER BY q.frequency_occurrences DESC LIMIT 6`).bind(userId).all<{ knowledge_point: string }>(),
    db.prepare(`SELECT COUNT(DISTINCT COALESCE(NULLIF(TRIM(q.sub_type), ''), NULLIF(TRIM(q.module), ''))) AS total
      FROM practice_attempts pa
      JOIN questions q ON q.question_code = pa.question_code
      WHERE pa.user_id = ? AND pa.apply_status = 'applied' AND ${RELIABLE_FREQUENCY_SQL}
        AND q.frequency_occurrences >= 3
        AND date(pa.answered_at, '+8 hours') >= date('now', '+8 hours', '-6 days')`).bind(userId).first<{ total: number }>(),
    db.prepare(`SELECT DISTINCT COALESCE(NULLIF(TRIM(q.sub_type), ''), NULLIF(TRIM(q.module), '')) AS knowledge_point
      FROM practice_attempts pa
      JOIN questions q ON q.question_code = pa.question_code
      JOIN user_question_progress uqp ON uqp.user_id = pa.user_id AND uqp.question_code = pa.question_code
      WHERE pa.user_id = ? AND pa.apply_status = 'applied' AND uqp.state = 'mastered'
        AND COALESCE(NULLIF(TRIM(q.sub_type), ''), NULLIF(TRIM(q.module), '')) IS NOT NULL
        AND date(pa.answered_at, '+8 hours') >= date('now', '+8 hours', '-6 days')
      ORDER BY knowledge_point LIMIT 5`).bind(userId).all<{ knowledge_point: string }>(),
    db.prepare(`SELECT
        COALESCE(NULLIF(TRIM(q.sub_type), ''), NULLIF(TRIM(q.module), '')) AS knowledge_point,
        MAX(q.module) AS module,
        COUNT(*) AS total,
        COALESCE(SUM(pa.is_correct), 0) AS correct,
        COALESCE(SUM(CASE WHEN pa.is_correct = 0 THEN 1 ELSE 0 END), 0) AS wrong_total,
        COALESCE(SUM(CASE WHEN pa.confidence = 'hesitant' THEN 1 ELSE 0 END), 0) AS hesitant_total,
        COALESCE(SUM(CASE WHEN pa.confidence = 'guessed' THEN 1 ELSE 0 END), 0) AS guessed_total,
        COALESCE(SUM(pa.overtime), 0) AS overtime_total,
        GROUP_CONCAT(NULLIF(TRIM(pa.wrong_reason), ''), '｜') AS wrong_reasons,
        MAX(CASE WHEN ${RELIABLE_FREQUENCY_SQL}
          THEN CASE WHEN q.frequency_occurrences * 1.0 / q.frequency_papers >= 0.55 THEN 3
            WHEN q.frequency_occurrences * 1.0 / q.frequency_papers >= 0.25 THEN 2 ELSE 1 END
          ELSE 0 END) AS frequency_rank,
        MAX(CASE WHEN ${RELIABLE_FREQUENCY_SQL} THEN q.frequency_occurrences ELSE 0 END) AS frequency_occurrences,
        MAX(CASE WHEN ${RELIABLE_FREQUENCY_SQL} THEN q.frequency_papers ELSE 0 END) AS frequency_papers,
        MAX(CASE WHEN q.truth_verified = 1 AND q.importance_stars BETWEEN 1 AND 5
          AND TRIM(q.importance_rule_version) <> ''
          AND (TRIM(q.importance_reason) <> '' OR TRIM(q.importance_override_reason) <> '')
          AND (TRIM(q.importance_override_reason) <> '' OR (${RELIABLE_FREQUENCY_SQL}))
          THEN q.importance_stars ELSE 0 END) AS importance_stars,
        CAST(ROUND(AVG(CASE WHEN q.truth_verified = 1 AND q.score_rate_attempts >= 100
          AND q.score_rate_correct <= q.score_rate_attempts AND TRIM(q.score_rate_scope) <> ''
          AND q.score_rate_updated_at IS NOT NULL AND TRIM(q.score_rate_updated_at) <> ''
          THEN q.score_rate_correct * 100.0 / q.score_rate_attempts END)) AS INTEGER) AS score_rate,
        MAX(CASE WHEN q.truth_verified = 1 AND q.score_rate_attempts >= 100
          AND q.score_rate_correct <= q.score_rate_attempts AND TRIM(q.score_rate_scope) <> ''
          AND q.score_rate_updated_at IS NOT NULL AND TRIM(q.score_rate_updated_at) <> ''
          THEN q.score_rate_attempts ELSE 0 END) AS score_rate_attempts
      FROM practice_attempts pa
      JOIN questions q ON q.question_code = pa.question_code
      WHERE pa.user_id = ? AND pa.apply_status = 'applied'
        AND date(pa.answered_at, '+8 hours') >= date('now', '+8 hours', '-6 days')
        AND COALESCE(NULLIF(TRIM(q.sub_type), ''), NULLIF(TRIM(q.module), '')) IS NOT NULL
      GROUP BY knowledge_point
      HAVING COUNT(*) >= 2
      ORDER BY (wrong_total + hesitant_total + guessed_total + overtime_total) DESC, total DESC
      LIMIT 8`).bind(userId).all<{
        knowledge_point: string; module: string; total: number; correct: number; wrong_total: number;
        hesitant_total: number; guessed_total: number; overtime_total: number; wrong_reasons: string | null;
        frequency_rank: number; frequency_occurrences: number; frequency_papers: number; importance_stars: number;
        score_rate: number | null; score_rate_attempts: number;
      }>(),
  ]);
  const [selectedBankRows, stats] = await Promise.all([selectedBanksPromise, statsPromise]);
  const selectedBanks = selectedBankRows.slice(0, 32);
  const [summary, modules, states, recent, todayStats, previousDailyStats, weeklyStats, previousWeeklyStats, todayHighFrequency, weeklyHighFrequency, masteredThisWeek, weakPointRows] = stats;
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
        AND q.truth_verified = 1 AND q.review_status = 'approved'
        AND qb.bank_code IN (${publishedBanks.map(() => "?").join(",")})
    )`);
    dueBindings.push(...publishedBanks);
  }
  const dueWindow = dueScopes.length
    ? await db.prepare(`SELECT
        COALESCE(SUM(CASE WHEN datetime(uqp.next_review_at) <= CURRENT_TIMESTAMP THEN 1 ELSE 0 END), 0) AS due_total,
        COALESCE(SUM(CASE WHEN datetime(uqp.next_review_at) <= datetime('now', '+8 hours', 'start of day', '+2 days', '-8 hours') THEN 1 ELSE 0 END), 0) AS tomorrow_total
      FROM user_question_progress uqp WHERE uqp.user_id = ? AND (${dueScopes.join(" OR ")})`)
      .bind(...dueBindings).first<{ due_total: number; tomorrow_total: number }>()
    : null;
  const dueCount = Number(dueWindow?.due_total ?? 0);
  const tomorrowDueCount = Number(dueWindow?.tomorrow_total ?? 0);
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
  const ratio = (part: number, whole: number) => whole > 0 ? Math.round(part * 100 / whole) : null;
  const todayTotal = Number(todayStats?.total ?? 0);
  const todayAccuracy = ratio(Number(todayStats?.correct ?? 0), todayTotal);
  const previousDailyTotal = Number(previousDailyStats?.total ?? 0);
  const previousDailyAccuracy = ratio(Number(previousDailyStats?.correct ?? 0), previousDailyTotal);
  const todayAvgSeconds = todayTotal ? Math.round(Number(todayStats?.avg_duration ?? 0) / 1000) : 0;
  const previousDailyAvgSeconds = previousDailyTotal ? Math.round(Number(previousDailyStats?.avg_duration ?? 0) / 1000) : null;
  const weeklyTotal = Number(weeklyStats?.total ?? 0);
  const previousWeeklyTotal = Number(previousWeeklyStats?.total ?? 0);
  const weeklyAccuracy = ratio(Number(weeklyStats?.correct ?? 0), weeklyTotal);
  const previousWeeklyAccuracy = ratio(Number(previousWeeklyStats?.correct ?? 0), previousWeeklyTotal);
  const weeklyAvgSeconds = weeklyTotal ? Math.round(Number(weeklyStats?.avg_duration ?? 0) / 1000) : 0;
  const previousWeeklyAvgSeconds = previousWeeklyTotal ? Math.round(Number(previousWeeklyStats?.avg_duration ?? 0) / 1000) : null;
  const weeklyRepeatRate = ratio(Number(weeklyStats?.repeated_wrong ?? 0), Number(weeklyStats?.wrong_total ?? 0));
  const previousWeeklyRepeatRate = ratio(Number(previousWeeklyStats?.repeated_wrong ?? 0), Number(previousWeeklyStats?.wrong_total ?? 0));
  const nextIssues = [...moduleInsights]
    .sort((a, b) => a.accuracy - b.accuracy || b.avgSeconds - a.avgSeconds)
    .slice(0, 3)
    .map((item) => `${item.module}：${item.accuracy}%正确率，平均${item.avgSeconds}秒`);
  const dominantWrongReason = (value: string | null) => {
    const counts = new Map<string, number>();
    for (const reason of String(value ?? "").split("｜").map((item) => item.trim()).filter(Boolean)) {
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? "";
  };
  const weakPoints = weakPointRows.results.map((row) => {
    const pointTotal = Number(row.total);
    const pointCorrect = Number(row.correct);
    const frequencyRank = Number(row.frequency_rank);
    return {
      point: row.knowledge_point,
      module: row.module,
      total: pointTotal,
      accuracy: pointTotal ? Math.round(pointCorrect * 100 / pointTotal) : 0,
      wrong: Number(row.wrong_total),
      hesitant: Number(row.hesitant_total),
      guessed: Number(row.guessed_total),
      overtime: Number(row.overtime_total),
      wrongReason: dominantWrongReason(row.wrong_reasons),
      frequency: frequencyRank === 3 ? "高频" : frequencyRank === 2 ? "中频" : frequencyRank === 1 ? "低频" : "",
      frequencyOccurrences: Number(row.frequency_occurrences),
      frequencyPapers: Number(row.frequency_papers),
      importanceStars: Number(row.importance_stars),
      scoreRate: row.score_rate === null ? null : Number(row.score_rate),
      scoreRateAttempts: Number(row.score_rate_attempts),
    };
  });
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
    weakPoints,
    recent: recent.results.map((row) => ({ day: row.day, total: Number(row.total), accuracy: Number(row.total) ? Math.round((Number(row.correct) / Number(row.total)) * 100) : 0 })),
    today: {
      total: todayTotal,
      correct: Number(todayStats?.correct ?? 0),
      repairedDue: Number(todayStats?.repaired_due ?? 0),
      wrong: Number(todayStats?.wrong_total ?? 0),
      hesitant: Number(todayStats?.hesitant_total ?? 0),
      guessed: Number(todayStats?.guessed_total ?? 0),
      overtime: Number(todayStats?.overtime_total ?? 0),
      avgSeconds: todayAvgSeconds,
      accuracyDelta: todayAccuracy !== null && previousDailyAccuracy !== null ? todayAccuracy - previousDailyAccuracy : null,
      avgSecondsDelta: previousDailyAvgSeconds !== null ? todayAvgSeconds - previousDailyAvgSeconds : null,
      highFrequencyPoints: todayHighFrequency.results.map((row) => row.knowledge_point),
    },
    weekly: {
      total: weeklyTotal,
      accuracy: weeklyAccuracy ?? 0,
      activeDays: Number(weeklyStats?.active_days ?? 0),
      avgSeconds: weeklyAvgSeconds,
      highFrequencyCoverage: Number(weeklyHighFrequency?.total ?? 0),
      repeatErrorRate: weeklyRepeatRate,
      accuracyDelta: weeklyAccuracy !== null && previousWeeklyAccuracy !== null ? weeklyAccuracy - previousWeeklyAccuracy : null,
      avgSecondsDelta: previousWeeklyAvgSeconds !== null ? weeklyAvgSeconds - previousWeeklyAvgSeconds : null,
      repeatErrorRateDelta: weeklyRepeatRate !== null && previousWeeklyRepeatRate !== null ? weeklyRepeatRate - previousWeeklyRepeatRate : null,
      masteredPoints: masteredThisWeek.results.map((row) => row.knowledge_point),
      nextIssues,
    },
    tomorrowPlan: {
      dueCount: tomorrowDueCount,
      focusModule: focusModule?.module ?? null,
      focusQuestionCount,
      estimatedMinutes,
      taskText: `${tomorrowDueCount ? `先完成${tomorrowDueCount}道到期复习题` : "先完成到期复习检查"}${focusModule ? `，再完成${focusQuestionCount}道${focusModule.module}专项训练` : "，再从主攻题库完成新题训练"}，预计${estimatedMinutes}分钟。`,
    },
  };
}

async function loadWrongAudioQuestions(userId: string): Promise<Question[]> {
  const db = getD1();
  const rows = await db.prepare(`SELECT question_code, next_review_at FROM user_question_progress
    WHERE user_id = ? AND wrong_count > 0 AND last_answered_at IS NOT NULL
    ORDER BY CASE WHEN datetime(next_review_at) <= CURRENT_TIMESTAMP THEN 0 ELSE 1 END,
      datetime(next_review_at), last_answered_at DESC LIMIT 20`)
    .bind(userId).all<{ question_code: string; next_review_at: string | null }>();
  const orderedCodes = rows.results.map((row) => row.question_code);
  const reviewDueByCode = new Map(rows.results.map((row) => [row.question_code, row.next_review_at]));
  if (!orderedCodes.length) return [];

  const questionMap = new Map<string, Question>();
  for (const question of starterQuestionList()) {
    if (orderedCodes.includes(question.id)) questionMap.set(question.id, {
      ...question,
      nextReviewAt: reviewDueByCode.get(question.id) ?? null,
      due: Boolean(reviewDueByCode.get(question.id) && Date.parse(String(reviewDueByCode.get(question.id))) <= Date.now()),
    } as Question);
  }
  const databaseCodes = orderedCodes.filter((code) => !questionMap.has(code));
  if (databaseCodes.length) {
    const placeholders = databaseCodes.map(() => "?").join(",");
    const databaseRows = await db.prepare(`SELECT question_code, module, sub_type, stem, options_json,
      answer, explanation, source, difficulty FROM questions
      WHERE status = 'active' AND truth_verified = 1 AND review_status = 'approved'
        AND question_code IN (${placeholders})`).bind(...databaseCodes).all<Record<string, unknown>>();
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
        nextReviewAt: reviewDueByCode.get(id) ?? null,
        due: Boolean(reviewDueByCode.get(id) && Date.parse(String(reviewDueByCode.get(id))) <= Date.now()),
      } as Question);
    }
  }
  return orderedCodes.map((code) => questionMap.get(code)).filter((question): question is Question => Boolean(question));
}

async function loadContent(membershipActive: boolean, profile?: LoadedExamProfile) {
  const rows = await getD1().prepare(`SELECT content_type, content_key, title, payload_json, access_level, version
    FROM content_items WHERE content_type <> 'job_position' AND status IN ('published', 'scheduled')
      AND (publish_at IS NULL OR datetime(publish_at) <= CURRENT_TIMESTAMP)
      AND (? = 1 OR access_level = 'free')
    ORDER BY id ASC`).bind(membershipActive ? 1 : 0)
    .all<{ content_type: string; content_key: string; payload_json: string; access_level: "free" | "member" }>();
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
      if (row.content_type === "audio_track") {
        const track = parsed as AudioTrack;
        const managedAssetId = managedMediaAssetId(track.audioUrl);
        audioMap.set(row.content_key, {
          ...track,
          // Never send a public/static or third-party audio URL to learners.
          // Historical rows fall back to the transcript/TTS path until an
          // operator uploads a managed asset and passes the release gate.
          audioUrl: managedAssetId ? mediaUrlForAsset(managedAssetId) : undefined,
          accessLevel: row.access_level,
        });
      }
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
            dataVersion: Math.max(1, Math.floor(Number(item.dataVersion ?? row.version)) || 1),
            updatedAt: trimmed(item.updatedAt, 40),
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
      label: "今日训练",
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
  const practiceDays = Array.from(dayMap.values()).sort((a, b) => a.day - b.day).map((day) => ({
    ...day,
    // 正式客观题只能经受控练习 API 下发，避免 bootstrap 预泄露答案/解析。
    questions: [],
    // 申论采分点和参考表达只能按服务端阶段解锁；CMS 日历只保留
    // 非答案型表达素材，不能成为“先看答案”的旁路。
    essay: { ...day.essay, material: "", prompt: "", reference: "", scoringPoints: [] },
  }));
  const audioTracks = Array.from(audioMap.values()).sort((a, b) => Number(a.sortOrder ?? 0) - Number(b.sortOrder ?? 0));
  const previewAudioIndex = dailyAudioPreviewIndex(chinaDateKey(), audioTracks.length);
  const previewAudioTracks = previewAudioIndex >= 0 ? audioTracks.slice(previewAudioIndex, previewAudioIndex + 1) : [];
  const examEvents = Array.from(examEventMap.values()).sort((a, b) => a.eventDate.localeCompare(b.eventDate));
  const examNotices = Array.from(examNoticeMap.values()).sort((a, b) => b.publishDate.localeCompare(a.publishDate));
  const jobPositions = Array.from(jobPositionMap.values()).sort((a, b) => a.targetLabel.localeCompare(b.targetLabel) || a.department.localeCompare(b.department));
  const common = {
    practiceDays,
    audioTracks,
    examEvents,
    examNotices,
    jobPositions,
    // 原始 CMS 载荷不直接下发。运营内容先被上方的固定交互 DTO
    // 归一化，避免把未使用字段和答案型字段一并暴露给浏览器。
    morningReads: [],
    currentAffairs: [],
    essayMicros: [],
    drillPresets: drillPresets.sort((a, b) => Number(a.sortOrder ?? 0) - Number(b.sortOrder ?? 0)),
    strategyConfig,
  };
  if (membershipActive) return { ...common, access: "premium" as const };

  const previewDays = practiceDays.map((day) => ({
    ...clone(day),
    // 申论正式作答是会员能力；即便运营把一条日历素材设为免费，
    // bootstrap 也只下发表达素材，绝不下发题干、采分点或参考答案。
    essay: { expressions: [], material: "", prompt: "", reference: "", scoringPoints: [], wordLimit: 0 },
  }));
  return {
    ...common,
    practiceDays: previewDays,
    audioTracks: previewAudioTracks,
    jobPositions: [],
    morningReads: [],
    currentAffairs: [],
    essayMicros: [],
    access: "preview" as const,
  };
}

function parseJobPosition(contentKey: string, payloadJson: string, dataVersion = 1, updatedAt = ""): PublishedJobPosition | null {
  try {
    const item = JSON.parse(payloadJson) as Record<string, unknown>;
    const targetCode = trimmed(item.targetCode, 60);
    const title = trimmed(item.title, 80);
    if (!targetCode || !title) return null;
    return {
      id: `position-${contentKey}`,
      targetCode,
      targetLabel: trimmed(item.targetLabel, 24) || (targetCode === "national" ? "国考" : targetCode.replace(/^province:/, "") + "省考"),
      examName: trimmed(item.examName, 80),
      department: trimmed(item.department, 80),
      unit: trimmed(item.unit, 80),
      title,
      code: trimmed(item.code, 40) || contentKey,
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
      dataVersion: Math.max(1, Math.floor(Number(item.dataVersion ?? dataVersion)) || 1),
      updatedAt: trimmed(item.updatedAt, 40) || updatedAt,
    };
  } catch {
    return null;
  }
}

async function searchJobPositions(userId: string, payload: Record<string, unknown>) {
  const [profile, membership] = await Promise.all([loadExamProfile(userId), userMembership(userId)]);
  const membershipActive = membershipIsActive(membership);
  const allowedTargets = new Set(profile.targets.map((target) => target.code));
  const requestedTargets = Array.isArray(payload.targetCodes)
    ? payload.targetCodes.map(String).filter((code) => allowedTargets.has(code))
    : [];
  const targetCodes = (requestedTargets.length ? requestedTargets : Array.from(allowedTargets)).slice(0, membershipActive ? 32 : 1);
  if (!targetCodes.length) return json({ positions: [], total: 0, page: 1, pageSize: 30 });
  const candidate = membershipActive && payload.candidateProfile && typeof payload.candidateProfile === "object"
    ? payload.candidateProfile as Record<string, unknown> : {};
  const keyword = membershipActive ? trimmed(payload.keyword, 80) : "";
  const pageSize = membershipActive ? Math.max(1, Math.min(50, Math.floor(Number(payload.pageSize)) || 30)) : 3;
  const page = membershipActive ? Math.max(1, Math.floor(Number(payload.page)) || 1) : 1;
  const clauses = [
    "(? = 1 OR ci.access_level = 'free')",
    `json_extract(payload_json, '$.targetCode') IN (${targetCodes.map(() => "?").join(",")})`,
  ];
  const bindings: unknown[] = [membershipActive ? 1 : 0, ...targetCodes];
  const addInclusiveFilter = (field: string, value: unknown) => {
    const normalized = trimmed(value, 80);
    if (!normalized) return;
    clauses.push(`(COALESCE(json_extract(payload_json, '$.${field}'), '') IN ('', '不限')
      OR json_extract(payload_json, '$.${field}') LIKE ?)`);
    bindings.push(`%${normalized}%`);
  };
  addInclusiveFilter("education", candidate.education);
  addInclusiveFilter("degree", candidate.degree);
  addInclusiveFilter("freshLimit", candidate.freshStatus);
  addInclusiveFilter("politicalStatus", candidate.politicalStatus);
  addInclusiveFilter("grassrootsYears", candidate.grassrootsYears);
  const major = trimmed(candidate.major, 80);
  if (major) {
    clauses.push(`(COALESCE(json_extract(payload_json, '$.majors'), '') IN ('', '不限')
      OR json_extract(payload_json, '$.majors') LIKE ? OR json_extract(payload_json, '$.majorCodes') LIKE ?)`);
    bindings.push(`%${major}%`, `%${major}%`);
  }
  if (keyword) {
    clauses.push(`(title LIKE ? OR json_extract(payload_json, '$.department') LIKE ?
      OR json_extract(payload_json, '$.unit') LIKE ? OR json_extract(payload_json, '$.region') LIKE ?
      OR json_extract(payload_json, '$.code') LIKE ?)`);
    bindings.push(...Array(5).fill(`%${keyword}%`));
  }
  const rows = await getD1().prepare(`SELECT content_key, payload_json, version, updated_at, COUNT(*) OVER() AS total_count
    FROM content_items ci WHERE content_type = 'job_position' AND status IN ('published', 'scheduled')
      AND (publish_at IS NULL OR datetime(publish_at) <= CURRENT_TIMESTAMP)
      AND ${clauses.join(" AND ")}
    ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`)
    .bind(...bindings, pageSize, (page - 1) * pageSize).all<{ content_key: string; payload_json: string; version: number; updated_at: string; total_count: number }>();
  const positions = rows.results.map((row) => parseJobPosition(row.content_key, row.payload_json, row.version, row.updated_at))
    .filter((item): item is PublishedJobPosition => Boolean(item));
  return json({
    positions,
    total: Number(rows.results[0]?.total_count ?? 0),
    page,
    pageSize,
    limited: !membershipActive,
    limits: membershipActive ? null : { targetCount: 1, resultCount: 3, personalizedFilters: false, comparison: false },
  });
}

async function bootstrap(request: Request) {
  await ensureSchema();
  await ensureDefaults();
  const identity = await ensureUser(request, { persist: false });
  if (identity.bootstrapDeferred) {
    // Identity creation, welcome-trial grant, new session issuance and every
    // device→account merge check are intentionally isolated from the full
    // response. The next request uses the opaque session cookie just issued.
    return json({
      retryBootstrap: true,
      bootstrapStage: identity.bootstrapStage ?? "identity_prepared",
      accountMerged: Boolean(identity.accountMerged),
      maxBootstrapRequests: BOOTSTRAP_MAX_REQUESTS,
    }, 200, identity.setCookie);
  }
  if (!identity.persistent && !identity.signedIn) {
    const examProfile: LoadedExamProfile = {
      onboarded: false,
      dailyMinutes: 30,
      targets: [],
      examType: "国考",
      province: "",
      examYear: new Date().getFullYear() + 1,
      examDate: null,
    };
    const [content, questionBanks] = await Promise.all([
      loadContent(false, examProfile),
      loadQuestionBanks(identity.userId, false),
    ]);
    return json({
      user: {
        id: identity.userId,
        inviteCode: `GK${identity.userId.replaceAll("-", "").slice(0, 8).toUpperCase()}`,
        membershipType: "duration",
        membershipEnd: null,
        membershipActive: false,
        signedIn: false,
        authProvider: identity.provider,
        displayName: identity.displayName,
      },
      content,
      progress: { checkins: [] },
      progressVersion: 0,
      examProfile,
      questionBanks,
      dailyReadiness: { ready: false, distinctQuestionCount: 0, requiredQuestionCount: 5, effectiveBankCodes: [], planMinutes: 10 },
      dailyPracticeCompleted: false,
      studyInsights: {
        total: 0, accuracy: 0, avgSeconds: 0, uncertainCount: 0, overtimeCount: 0, dueCount: 0,
        stateCounts: { learning: 0, weak: 0, mastered: 0 }, modules: [], weakPoints: [], recent: [],
        today: { total: 0, correct: 0, repairedDue: 0, wrong: 0, hesitant: 0, guessed: 0, overtime: 0, avgSeconds: 0, accuracyDelta: null, avgSecondsDelta: null, highFrequencyPoints: [] },
        weekly: { total: 0, accuracy: 0, activeDays: 0, avgSeconds: 0, highFrequencyCoverage: 0, repeatErrorRate: null, accuracyDelta: null, avgSecondsDelta: null, repeatErrorRateDelta: null, masteredPoints: [], nextIssues: [] },
        tomorrowPlan: { dueCount: 0, focusModule: null, focusQuestionCount: 0, estimatedMinutes: 5, taskText: "请先完成备考组合设置，再开始今日训练。" },
      },
      wrongAudioQuestions: [],
      dueEssayRewrites: [],
      todayKey: chinaDateKey(),
      ledger: [],
      inviteStats: { total: 0, rewarded: 0, pending: 0 },
      inviteConfig: { rewardDays: 7, inviteeRewardDays: 3, monthlyCap: 30 },
    }, 200, identity.setCookie);
  }
  if (identity.signedIn && await reconcileInviteReward(identity.userId)) {
    // Reward claiming can consume a dozen D1 statements. Return immediately;
    // the idempotent relation state makes the next request read-only here.
    return json({
      retryBootstrap: true,
      bootstrapStage: "invite_reconciled",
      accountMerged: false,
      maxBootstrapRequests: BOOTSTRAP_MAX_REQUESTS,
    }, 200, identity.setCookie);
  }
  const db = getD1();
  const todayKey = chinaDateKey();
  // Practice completion and the full-day check-in are intentionally separate.
  // A completed server session advances the learner to the next step, while a
  // check-in is written only when the client finishes every enabled daily step.
  const userPromise = db.prepare("SELECT id, invite_code, invited_by, membership_type, membership_end FROM users WHERE id = ?")
    .bind(identity.userId).first<UserRow>();
  const statePromise = db.prepare("SELECT progress_json, version FROM user_states WHERE user_id = ?").bind(identity.userId)
    .first<{ progress_json: string; version: number }>();
  const examProfilePromise = loadExamProfile(identity.userId);
  const selectedBanksPromise = selectedBankCodes(identity.userId);
  const membershipActivePromise = userPromise.then((row) => membershipIsActive(row));
  const effectiveBankCodesPromise = Promise.all([selectedBanksPromise, membershipActivePromise])
    .then(([selected, active]) => effectivePracticeBankCodes(identity.userId, selected, active));
  const contentPromise = Promise.all([membershipActivePromise, examProfilePromise])
    .then(([active, profile]) => loadContent(active, profile));
  const questionBanksPromise = Promise.all([membershipActivePromise, examProfilePromise, selectedBanksPromise])
    .then(([active, profile, selected]) => loadQuestionBanks(identity.userId, active, profile, selected));
  const studyInsightsPromise = loadStudyInsights(identity.userId, selectedBanksPromise);
  const dailyReadinessPromise = Promise.all([
    membershipActivePromise, statePromise, examProfilePromise, selectedBanksPromise,
    effectiveBankCodesPromise, contentPromise,
  ]).then(([active, stateRow, profile, selected, entitledBankCodes, contentValue]) => {
    let storedProgress: Record<string, unknown> = {};
    try { storedProgress = JSON.parse(stateRow?.progress_json ?? "{}"); } catch { storedProgress = {}; }
    const overrides = storedProgress.planOverrides && typeof storedProgress.planOverrides === "object"
      ? storedProgress.planOverrides as Record<string, unknown>
      : {};
    return loadDailyReadiness(identity.userId, active, overrides[todayKey], {
      profile,
      selected,
      entitledBankCodes,
      strategy: contentValue.strategyConfig ?? null,
    });
  });
  const [user, state, ledger, inviteStats, inviteConfig, examProfile, questionBanks, studyInsights, wrongAudioQuestions, dueEssayRewrites, dailyCheckins, dailyPractice, content, dailyReadiness] = await Promise.all([
    userPromise,
    statePromise,
    db.prepare(`SELECT delta_days, source_type, note, created_at
      FROM membership_ledger WHERE user_id = ? ORDER BY id DESC LIMIT 20`).bind(identity.userId).all(),
    db.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN status = 'rewarded' THEN 1 ELSE 0 END) AS rewarded,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending
      FROM invite_relations WHERE inviter_id = ?`).bind(identity.userId).first<{ total: number; rewarded: number; pending: number }>(),
    loadInviteConfig(),
    examProfilePromise,
    questionBanksPromise,
    studyInsightsPromise,
    loadWrongAudioQuestions(identity.userId),
    loadDueEssayRewrites(identity.userId),
    db.prepare("SELECT date_key FROM daily_checkins WHERE user_id = ? ORDER BY date_key")
      .bind(identity.userId).all<{ date_key: string }>(),
    db.prepare(`SELECT 1 AS completed FROM practice_sessions
      WHERE user_id = ? AND date_key = ? AND kind = 'daily' AND mode = 'mixed'
        AND status = 'completed' AND target_count >= 5 AND answered_count >= target_count
      LIMIT 1`).bind(identity.userId, todayKey).first<{ completed: number }>(),
    contentPromise,
    dailyReadinessPromise,
  ]);
  if (!user) return json({ error: "账号信息加载失败，请刷新后重试" }, 500, identity.setCookie);
  let progress: Record<string, unknown> = {};
  try { progress = JSON.parse(state?.progress_json ?? "{}"); } catch { progress = {}; }
  // 打卡只信规范化记录。旧 progress_json 可被客户端整体保存，不能继续作为
  // “真实完成”的证据；历史有效日练由 runtime/migration 按完成会话幂等回填。
  progress = { ...progress, checkins: dailyCheckins.results.map((row) => row.date_key) };
  const membershipActive = membershipIsActive(user);
  return json({
    user: {
      id: user.id,
      inviteCode: user.invite_code,
      membershipType: user.membership_type,
      membershipEnd: user.membership_end,
      membershipActive,
      signedIn: identity.signedIn,
      authProvider: identity.provider,
      displayName: identity.displayName,
    },
    content,
    progress,
    progressVersion: Number(state?.version ?? 0),
    examProfile,
    questionBanks,
    dailyReadiness,
    dailyPracticeCompleted: Boolean(dailyPractice?.completed),
    studyInsights,
    wrongAudioQuestions,
    dueEssayRewrites,
    todayKey,
    ledger: ledger.results,
    inviteStats: inviteStats ?? { total: 0, rewarded: 0, pending: 0 },
    inviteConfig,
  }, 200, identity.setCookie);
}

async function saveProgress(userId: string, payload: Record<string, unknown>) {
  const value = JSON.stringify(payload.progress ?? {});
  if (value.length > 120_000) return json({ error: "学习记录暂无法保存，请刷新后重试" }, 400);
  const expectedVersion = Number.isInteger(Number(payload.progressVersion)) ? Number(payload.progressVersion) : null;
  const db = getD1();
  if (expectedVersion !== null) {
    const saved = await db.prepare(`UPDATE user_states SET progress_json = ?, version = version + 1,
      updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND version = ?`).bind(value, userId, expectedVersion).run();
    if (!saved.meta.changes) {
      const latest = await db.prepare("SELECT progress_json, version FROM user_states WHERE user_id = ?")
        .bind(userId).first<{ progress_json: string; version: number }>();
      let progress: unknown = {};
      try { progress = JSON.parse(latest?.progress_json ?? "{}"); } catch { progress = {}; }
      return json({ error: "检测到其他设备更新，请刷新同步后重试", code: "PROGRESS_CONFLICT", progress, progressVersion: latest?.version ?? 0 }, 409);
    }
  } else {
    // Compatibility for an older client; new clients should always send the
    // version received at bootstrap so cross-device writes cannot silently win.
    await db.prepare(`UPDATE user_states SET progress_json = ?, version = version + 1,
      updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`).bind(value, userId).run();
  }
  const saved = await db.prepare("SELECT version FROM user_states WHERE user_id = ?").bind(userId).first<{ version: number }>();
  return json({ ok: true, progressVersion: Number(saved?.version ?? 0) });
}

async function saveExamProfile(userId: string, payload: Record<string, unknown>) {
  const currentYear = new Date().getFullYear();
  const allowedMinutes = new Set([10, 30, 45, 60]);
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
    const province = examType === "省考" ? normalizeSelectableProvince(item.province) : "";
    if (examType === "省考" && !province) continue;
    const examYear = Math.max(currentYear, Math.min(currentYear + 3, Math.floor(Number(item.examYear)) || currentYear + 1));
    const dateValue = trimmed(item.examDate, 10);
    const examDate = /^\d{4}-\d{2}-\d{2}$/.test(dateValue) ? dateValue : null;
    const code = examType === "国考" ? "national" : `province:${province}`;
    targetMap.set(code, { code, label: examType === "国考" ? "国考" : `${province}省考`, examType, province, examYear, examDate });
  }
  const targets = Array.from(targetMap.values());
  if (!targets.length) return json({ error: "请至少选择一个报考目标" }, 400);
  const initialBankCode = trimmed(payload.initialBankCode, 80);
  let initialBank: { bank_code: string; exam_type: string; province: string | null; exam_year: number | null; subject: string; question_count: number } | null = null;
  if (initialBankCode) {
    initialBank = await db.prepare(`SELECT qb.bank_code, qb.exam_type, qb.province, qb.exam_year, qb.subject,
      COUNT(DISTINCT CASE WHEN q.status = 'active' AND q.truth_verified = 1 AND q.review_status = 'approved' THEN q.id END) AS question_count
      FROM question_banks qb
      LEFT JOIN question_bank_items qbi ON qbi.bank_id = qb.id
      LEFT JOIN questions q ON q.id = qbi.question_id
      WHERE qb.bank_code = ? AND qb.status = 'published' GROUP BY qb.id`).bind(initialBankCode)
      .first<{ bank_code: string; exam_type: string; province: string | null; exam_year: number | null; subject: string; question_count: number }>() ?? null;
    const matchesTarget = initialBank && targets.some((target) => {
      const typeMatches = initialBank?.exam_type === "national" ? target.examType === "国考"
        : initialBank?.exam_type === "provincial" && target.examType === "省考" && normalizeProvince(initialBank.province) === normalizeProvince(target.province);
      const year = Number(initialBank?.exam_year ?? 0);
      return typeMatches && (!year || (year <= target.examYear && year >= target.examYear - 4));
    });
    if (!initialBank || !matchesTarget || !["行测", "综合"].includes(initialBank.subject) || Number(initialBank.question_count) < 5) {
      return json({ error: "所选题库当前不可用、可练真题不足5道，或与当前报考目标不匹配" }, 409);
    }
    const [membership, currentBanks] = await Promise.all([userMembership(userId), selectedBankCodes(userId)]);
    if (!membershipIsActive(membership) && !currentBanks.includes(initialBankCode) && currentBanks.length >= 1) {
      return json({ error: "免费版最多加入1个题库，开通后可组合国考与多个省考题库", code: "FREE_BANK_LIMIT" }, 403);
    }
  }
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
  const targetSignature = (items: ExamTargetProfile[]) => JSON.stringify(items.map((target) => ({
    code: target.code, examYear: target.examYear, examDate: target.examDate ?? null,
  })));
  const prescriptionChanged = dailyMinutes !== currentProfile.dailyMinutes
    || targetSignature(targets) !== targetSignature(currentProfile.targets);
  const profileWriteResults = await db.batch([
    db.prepare(`INSERT INTO user_exam_profiles (user_id, exam_type, province, exam_year, exam_date, daily_minutes, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id) DO UPDATE SET exam_type = excluded.exam_type, province = excluded.province,
      exam_year = excluded.exam_year, exam_date = excluded.exam_date, daily_minutes = excluded.daily_minutes,
      updated_at = CURRENT_TIMESTAMP`).bind(userId, primary.examType, primary.province, primary.examYear, primary.examDate, dailyMinutes),
    db.prepare("DELETE FROM user_exam_targets WHERE user_id = ?").bind(userId),
    ...targets.map((target) => db.prepare(`INSERT INTO user_exam_targets
      (user_id, target_code, exam_type, province, exam_year, exam_date, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`).bind(userId, target.code, target.examType === "国考" ? "national" : "provincial", target.province, target.examYear, target.examDate)),
    ...(initialBank ? [db.prepare("INSERT OR IGNORE INTO user_question_banks (user_id, bank_code) VALUES (?, ?)").bind(userId, initialBank.bank_code)] : []),
    ...(prescriptionChanged ? [db.prepare(`UPDATE practice_sessions SET status = 'abandoned', updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND date_key = ? AND kind = 'daily' AND mode = 'mixed' AND status = 'active'
      RETURNING id`)
      .bind(userId, chinaDateKey())] : []),
  ]);
  const abandonedResult = prescriptionChanged ? profileWriteResults.at(-1) as { results?: Array<{ id?: unknown }> } : null;
  const abandonedSessionIds = (abandonedResult?.results ?? []).map((item) => String(item.id ?? "")).filter(Boolean);
  return json({ ok: true, profile: targetProfile, selectedBanks: await selectedBankCodes(userId), abandonedSessionIds });
}

async function toggleQuestionBank(userId: string, payload: Record<string, unknown>) {
  const bankCode = trimmed(payload.bankCode, 80);
  const added = payload.added === true;
  if (!/^[a-zA-Z0-9_-]{3,80}$/.test(bankCode)) return json({ error: "题库编号无效" }, 400);
  if (bankCode === STARTER_BANK_CODE) return json({ error: "演示题库已停用，请添加已发布的真题库" }, 410);
  const db = getD1();
  let bank: { id: number; exam_type: string; province: string | null; exam_year: number | null; subject: string; question_count: number } | null = null;
  if (added) {
    bank = await db.prepare(`SELECT qb.id, qb.exam_type, qb.province, qb.exam_year, qb.subject,
      COUNT(DISTINCT CASE WHEN q.status = 'active' AND q.truth_verified = 1 AND q.review_status = 'approved'
        AND ((qb.subject = '申论' AND q.subject = '申论') OR (qb.subject <> '申论' AND q.subject = '行测')) THEN q.id END) AS question_count
      FROM question_banks qb
      LEFT JOIN question_bank_items qbi ON qbi.bank_id = qb.id
      LEFT JOIN questions q ON q.id = qbi.question_id
      WHERE qb.bank_code = ? AND qb.status = 'published' GROUP BY qb.id`)
      .bind(bankCode).first<{ id: number; exam_type: string; province: string | null; exam_year: number | null; subject: string; question_count: number }>() ?? null;
    if (!bank) return json({ error: "题库不存在或尚未发布" }, 404);
    if (added && Number(bank.question_count) < 1) return json({ error: "题库尚无可练真题，暂不能加入" }, 409);
  }
  if (added) {
    const membership = await userMembership(userId);
    if (!membershipIsActive(membership)) {
      const current = await selectedBankCodes(userId);
      if (!current.includes(bankCode) && current.length >= 1) {
        return json({ error: "免费版最多加入1个题库，开通后可组合国考与多个省考题库", code: "FREE_BANK_LIMIT" }, 403);
      }
    }
    const statements: D1PreparedStatement[] = [
      db.prepare("INSERT OR IGNORE INTO user_question_banks (user_id, bank_code) VALUES (?, ?)").bind(userId, bankCode),
    ];
    if (bank && (bank.exam_type === "national" || bank.exam_type === "provincial")) {
      const profile = await loadExamProfile(userId);
      const province = bank.exam_type === "provincial" ? normalizeSelectableProvince(bank.province) : "";
      // “多省/全国/专项”等运营范围不是一个可报名省份，不能被题库动作
      // 推导成“多省考”或“全国省考”这样的伪目标。
      if (bank.exam_type === "provincial" && !province) {
        await db.batch(statements);
        const membership = await userMembership(userId);
        return json({ ok: true, banks: await loadQuestionBanks(userId), profile: await loadExamProfile(userId),
          dailyReadiness: await loadDailyReadiness(userId, membershipIsActive(membership), payload.planMinutes), abandonedSessionIds: [] });
      }
      const targetCode = bank.exam_type === "national" ? "national" : `province:${province}`;
      const targetExists = profile.targets.some((target) => target.code === targetCode);
      if (!targetExists) {
        const examYear = inferredTargetYear(bank.exam_year);
        // Existing targets are already durable rows (or the legacy primary row
        // in user_exam_profiles). Re-inserting the full collection makes this
        // POST grow linearly and can exceed D1 Free's 50-query ceiling. Only the
        // newly inferred target belongs in this mutation; the primary profile is
        // deliberately left untouched.
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
    // D1 batch is transactional: no client can observe a removed bank while a
    // session that depends on it remains active. UPDATE ... RETURNING also gives
    // the client an authoritative list for clearing local resume/offline state.
    const [abandonedResult] = await db.batch([
      db.prepare(`UPDATE practice_sessions SET status = 'abandoned', updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ? AND status = 'active' AND json_valid(bank_codes_json)
          AND EXISTS (SELECT 1 FROM json_each(practice_sessions.bank_codes_json)
            WHERE CAST(value AS TEXT) = ?)
        RETURNING id`).bind(userId, bankCode),
      db.prepare("DELETE FROM user_question_banks WHERE user_id = ? AND bank_code = ?").bind(userId, bankCode),
    ]);
    const abandonedSessionIds = ((abandonedResult as { results?: Array<{ id?: unknown }> }).results ?? [])
      .map((row) => String(row.id ?? "")).filter(Boolean);
    const membership = await userMembership(userId);
    return json({
      ok: true,
      banks: await loadQuestionBanks(userId),
      profile: await loadExamProfile(userId),
      dailyReadiness: await loadDailyReadiness(userId, membershipIsActive(membership), payload.planMinutes),
      abandonedSessionIds,
    });
  }
  const membership = await userMembership(userId);
  return json({ ok: true, banks: await loadQuestionBanks(userId), profile: await loadExamProfile(userId),
    dailyReadiness: await loadDailyReadiness(userId, membershipIsActive(membership), payload.planMinutes), abandonedSessionIds: [] });
}

async function dbQuestionCandidates(userId: string, bankCodes: string[]) {
  if (!bankCodes.length) return [] as Array<{ question: ResolvedQuestion; progress?: QuestionProgressRow }>;
  const placeholders = bankCodes.map(() => "?").join(",");
  const rows = await getD1().prepare(`WITH candidates AS (
      SELECT q.question_code, q.module, q.sub_type, q.stem, q.options_json,
        q.answer, q.explanation, q.technique, q.difficulty, q.source, q.truth_verified_at,
        q.source_region, q.source_year, q.truth_verified,
        q.frequency, q.frequency_occurrences, q.frequency_papers, q.frequency_years_json, q.frequency_updated_at,
        q.importance_stars, q.importance_rule_version, q.importance_reason, q.importance_override_reason,
        q.score_rate, q.score_rate_correct, q.score_rate_attempts, q.score_rate_scope, q.score_rate_source, q.score_rate_updated_at,
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
      WHERE q.status = 'active' AND q.truth_verified = 1 AND q.review_status = 'approved'
        AND q.subject = '行测' AND qb.status = 'published'
        AND qb.bank_code IN (${placeholders})
    ), ranked AS (
      SELECT *, ROW_NUMBER() OVER (
        PARTITION BY bank_code
        ORDER BY priority_rank,
          CASE WHEN score_rate_attempts >= 100
            AND (score_rate_correct * 100.0 / score_rate_attempts) BETWEEN 40 AND 80 THEN 0 ELSE 1 END,
          CASE WHEN frequency_papers > 0 AND (frequency_occurrences * 1.0 / frequency_papers) >= 0.55 THEN 0
            WHEN frequency_papers > 0 AND (frequency_occurrences * 1.0 / frequency_papers) >= 0.25 THEN 1 ELSE 2 END,
          CASE WHEN importance_rule_version <> '' THEN importance_stars ELSE 0 END DESC,
          COALESCE(last_answered_at, '1970-01-01'), sort_order, question_code
      ) AS bank_rank
      FROM candidates
    )
    SELECT * FROM ranked
    WHERE bank_rank <= 40
    ORDER BY priority_rank, bank_rank, bank_code
    LIMIT 640`).bind(userId, ...bankCodes).all<Record<string, unknown>>();
  return rows.results.map((row) => {
    const metrics = metricFields(row);
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
        reviewedAt: row.truth_verified_at ? String(row.truth_verified_at) : null,
        targetCode: String(row.bank_exam_type) === "national"
          ? "national"
          : String(row.bank_exam_type) === "provincial"
            ? `province:${normalizeProvince(row.bank_province)}`
            : null,
        region: normalizeProvince(row.source_region) || normalizeProvince(row.bank_province) || "全国",
        examYear: Number.isInteger(Number(row.source_year)) ? Number(row.source_year) : null,
        ...metrics,
        suggestedSeconds: Math.max(10, Number(row.suggested_seconds ?? 60)),
        imageUrl: String(row.image_url ?? ""),
        resourceUrl: String(row.resource_url ?? ""),
      },
      progress,
    };
  });
}

async function getPracticeBatch(userId: string, payload: Record<string, unknown>) {
  const db = getD1();
  const requested = Array.isArray(payload.bankCodes) ? payload.bankCodes.map(String) : [];
  const requestedKind = trimmed(payload.sessionKind, 40).toLowerCase().replace(/[^a-z0-9:_-]/g, "");
  const dailyRequest = requestedKind === "daily";
  const dateKey = chinaDateKey();
  if (dailyRequest) {
    const completed = await db.prepare(`SELECT id, status, target_count, answered_count,
      correct_count, review_added, elapsed_seconds FROM practice_sessions
      WHERE user_id = ? AND date_key = ? AND kind = 'daily' AND mode = 'mixed'
        AND status = 'completed' AND target_count >= 5 AND answered_count >= target_count
      ORDER BY completed_at DESC LIMIT 1`).bind(userId, dateKey).first<{
        id: string; status: string; target_count: number; answered_count: number;
        correct_count: number; review_added: number; elapsed_seconds: number;
      }>();
    if (completed) {
      return json({
        questions: [], mode: "mixed", limit: 0, sessionId: completed.id, dailyCompleted: true,
        session: {
          targetCount: Number(completed.target_count), answeredCount: Number(completed.answered_count),
          correctCount: Number(completed.correct_count), reviewAdded: Number(completed.review_added),
          elapsedSeconds: Number(completed.elapsed_seconds), status: completed.status,
        },
        quotaExceeded: false,
        composition: { due: 0, weak: 0, new: 0, primary: 0, other: 0, byBank: [] },
      });
    }
  }
  const [selected, membership] = await Promise.all([selectedBankCodes(userId), userMembership(userId)]);
  const active = membershipIsActive(membership);
  // 试用期内可以体验多题库，但试用到期后服务端只放行最早加入且仍可练的一个主库。
  // 其余选库关系继续保留，续费后立即恢复，不能只靠前端“上锁”。
  const effectiveSelected = await effectivePracticeBankCodes(userId, selected, active);
  const entitlementAllowed = new Set(effectiveSelected);
  const lockedRequestedBankCodes = requested.filter((code) => selected.includes(code) && !entitlementAllowed.has(code));
  if (!active && !dailyRequest && lockedRequestedBankCodes.length) {
    return json({
      error: "该题库已随试用结束转为保留状态，开通后可继续单题库训练及多题库组合训练",
      code: "FREE_BANK_LIMIT",
      lockedRequestedBankCodes,
    }, 403);
  }
  const dailyReadiness = dailyRequest ? await loadDailyReadiness(userId, active, payload.planMinutes) : null;
  const practiceAllowedCodes = dailyReadiness?.effectiveBankCodes ?? effectiveSelected;
  const allowed = new Set(practiceAllowedCodes);
  const primaryBankCode = allowed.has(String(payload.primaryBankCode ?? "")) ? String(payload.primaryBankCode) : "";
  const requestedOrder = dailyRequest
    ? [...requested.filter((code) => allowed.has(code)), ...practiceAllowedCodes.filter((code) => !requested.includes(code))]
    : (requested.length ? requested : selected).filter((code) => allowed.has(code));
  const bankCodes = Array.from(new Set(requestedOrder)).slice(0, 32);
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
  const rawKind = requestedKind;
  const sessionKind = rawKind || `practice:${mode}:${focusModule || "mixed"}`;
  const isDiagnostic = sessionKind === "diagnostic";
  const usage = await loadDailyUsage(userId, dateKey);
  const freeRemaining = active ? null : Math.max(0, 5 - usage.practice);
  const desiredLimit = Math.max(1, Math.min(active ? 20 : isDiagnostic ? 10 : 5, Math.floor(Number(payload.limit)) || 10));
  let requestedLimit = active || isDiagnostic ? desiredLimit : Math.min(desiredLimit, freeRemaining ?? 0);
  let existingSession: PracticeSessionRow | null = null;
  const pendingAttempts = new Map<string, {
    id: number; selected_answer: number; is_correct: number; overtime: number; uncertain: number;
    state: string | null; next_review_at: string | null; review_stage: number | null;
  }>();
  const completedDiagnostic = isDiagnostic
    ? await db.prepare(`SELECT id FROM practice_sessions WHERE user_id = ? AND kind = 'diagnostic' AND status = 'completed' LIMIT 1`)
      .bind(userId).first<{ id: string }>()
    : null;
  if (completedDiagnostic) {
    return json({ questions: [], mode, limit: 0, access: active ? "premium" : "diagnostic_used", diagnosticUsed: true,
      composition: { due: 0, weak: 0, new: 0, primary: 0, other: 0, byBank: [] } });
  }
  if (payload.resetSession === true && !isDiagnostic) {
    await db.prepare(`UPDATE practice_sessions SET status = 'abandoned', updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND date_key = ? AND kind = ? AND mode = ? AND status = 'active'`)
      .bind(userId, dateKey, sessionKind, mode).run();
  } else {
    existingSession = await db.prepare(`SELECT id, status, target_count, question_codes_json,
      answered_count, correct_count, review_added, elapsed_seconds
      FROM practice_sessions WHERE user_id = ? AND date_key = ? AND kind = ? AND mode = ? AND status = 'active'
      ORDER BY created_at DESC LIMIT 1`).bind(userId, dateKey, sessionKind, mode).first<PracticeSessionRow>() ?? null;
  }
  let serverResumeCodes: string[] = [];
  if (existingSession) {
    const stored = safeStringArray(existingSession.question_codes_json, 20);
    const attempts = await db.prepare(`SELECT pa.question_code, pa.confidence, pa.id, pa.selected_answer,
      pa.is_correct, pa.overtime, pa.uncertain, uqp.state, uqp.next_review_at, uqp.review_stage
      FROM practice_attempts pa
      LEFT JOIN user_question_progress uqp ON uqp.user_id = pa.user_id AND uqp.question_code = pa.question_code
      WHERE pa.user_id = ? AND pa.practice_session_id = ? AND COALESCE(pa.apply_status, 'applied') = 'applied'`)
      .bind(userId, existingSession.id).all<{
        question_code: string; confidence: string; id: number; selected_answer: number; is_correct: number;
        overtime: number; uncertain: number; state: string | null; next_review_at: string | null; review_stage: number | null;
      }>();
    const answered = new Set(attempts.results.filter((row) => row.confidence !== "pending").map((row) => row.question_code));
    const pending = new Set(attempts.results.filter((row) => row.confidence === "pending").map((row) => row.question_code));
    for (const attempt of attempts.results) if (attempt.confidence === "pending") pendingAttempts.set(attempt.question_code, attempt);
    const remaining = stored.filter((code) => !answered.has(code));
    serverResumeCodes = active || isDiagnostic
      ? remaining
      : [...remaining.filter((code) => pending.has(code)), ...remaining.filter((code) => !pending.has(code)).slice(0, freeRemaining ?? 0)];
    requestedLimit = serverResumeCodes.length;
  }
  // 断点题号只信任当前用户的服务端 active session。客户端本地题号仅用于
  // 发起恢复意图，不能在服务端会话不存在时自行定义 daily 题量或打卡门槛。
  const resumeQuestionCodes = existingSession ? serverResumeCodes : [];
  const dailyRequirement = dailyReadiness?.requiredQuestionCount ?? DAILY_REQUIRED_QUESTION_COUNT;
  const dailyCarry = sessionKind === "daily" && !existingSession && payload.resetSession !== true
    ? await loadAbandonedDailyCarry(userId, dateKey, dailyRequirement)
    : EMPTY_DAILY_CARRY;
  const freeReplacementNeeded = Math.max(0, DAILY_REQUIRED_QUESTION_COUNT - dailyCarry.answered);
  if (sessionKind === "daily" && !existingSession && dailyCarry.answered < dailyRequirement
    && !dailyReadiness?.ready) {
    return json({
      error: "当前备考组合没有至少5道与报考目标匹配的已审核真题，请调整目标或补充对应题库",
      code: "DAILY_BANK_INSUFFICIENT",
      availableQuestionCount: dailyReadiness?.distinctQuestionCount ?? 0,
    }, 409);
  }
  if (sessionKind === "daily" && !existingSession && !active && (freeRemaining ?? 0) < freeReplacementNeeded) {
    return json({
      questions: [], mode, limit: 0, access: "preview", sessionId: null,
      freeRemaining: freeRemaining ?? 0, quotaExceeded: true,
      composition: { due: 0, weak: 0, new: 0, primary: 0, other: 0, byBank: [] },
    });
  }
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
  let dailyTargetCount = existingSession?.target_count ?? 0;
  if (sessionKind === "daily" && !existingSession && !resumeQuestionCodes.length) {
    const plan = strategy.timePlans && typeof strategy.timePlans === "object"
      ? (strategy.timePlans as Record<string, Record<string, unknown>>)[String(profile.dailyMinutes)]
      : null;
    const prescribed = dailyReadiness?.requiredQuestionCount
      ?? Math.max(5, Math.min(20, Math.floor(Number(plan?.questionCount)) || desiredLimit));
    dailyTargetCount = active ? prescribed : DAILY_REQUIRED_QUESTION_COUNT;
    requestedLimit = Math.max(0, dailyTargetCount - dailyCarry.answered);
  }
  if (requestedLimit < 1 && !(sessionKind === "daily" && !existingSession && dailyCarry.answered >= dailyTargetCount)) {
    return json({
      questions: [], mode, limit: 0, access: active ? "premium" : "preview",
      sessionId: existingSession?.id ?? null,
      freeRemaining: freeRemaining ?? null,
      quotaExceeded: !active && (freeRemaining ?? 0) <= 0,
      composition: { due: 0, weak: 0, new: 0, primary: 0, other: 0, byBank: [] },
    });
  }
  const sweetSpot: [number, number] = [Number(strategy.scoreRateSweetSpot[0]), Number(strategy.scoreRateSweetSpot[1])];
  const valueWeights = {
    frequency: Math.max(0, Math.min(100, Number(strategy.frequencyWeight ?? 25))),
    importance: Math.max(0, Math.min(100, Number(strategy.importanceWeight ?? 25))),
    scoreRate: Math.max(0, Math.min(100, Number(strategy.scoreRateWeight ?? 20))),
  };
  const bankOrder = new Map(bankCodes.map((code, index) => [code, index]));
  const carriedQuestionCodes = new Set(dailyCarry.questionCodes);
  const allSorted = candidates.filter((item) => !carriedQuestionCodes.has(item.question.id))
    .sort((a, b) => priorityFor(a.progress) - priorityFor(b.progress)
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
        && (!requestedFrequency || item.question.frequencyReliable)
        && (frequencyRank[item.question.frequency] ?? 0) >= minimumFrequencyRank
        && (!minImportanceStars || (item.question.importanceReliable && item.question.importanceStars >= minImportanceStars))
        && ((scoreRateMin === 0 && scoreRateMax === 100)
          || (item.question.scoreRateReliable && item.question.scoreRate >= scoreRateMin && item.question.scoreRate <= scoreRateMax));
    });
    chosen = [];
    takeBalanced(focusPool, requestedLimit, chosen, bankCycle);
  } else {
    const due = sorted.filter((item) => Boolean(item.progress?.next_review_at && Date.parse(item.progress.next_review_at) <= Date.now()));
    const fresh = sorted.filter((item) => !item.progress);
    const focusFresh = focusModule ? fresh.filter((item) => item.question.module.includes(focusModule) || item.question.knowledge.includes(focusModule)) : fresh;
    const selectedItems: typeof sorted = [];
    const dueTarget = due.length > 30
      ? requestedLimit
      : due.length > 10
        ? Math.ceil(requestedLimit * Math.max(0.75, strategy.dueShare))
        : Math.ceil(requestedLimit * strategy.dueShare);
    takeBalanced(due, dueTarget, selectedItems, bankCycle);
    takeBalanced(focusFresh, requestedLimit - selectedItems.length, selectedItems, bankCycle);
    takeBalanced(fresh, requestedLimit - selectedItems.length, selectedItems, bankCycle);
    takeBalanced(due, requestedLimit - selectedItems.length, selectedItems, bankCycle);
    chosen = selectedItems;
  }
  let sessionItems = chosen.slice(0, requestedLimit);
  const requiredNewDailyQuestions = sessionKind === "daily" && !existingSession
    ? Math.max(0, dailyTargetCount - dailyCarry.answered)
    : 0;
  if (sessionKind === "daily" && !existingSession && sessionItems.length < requiredNewDailyQuestions) {
    return json({
      error: "当前备考组合无法生成完整的今日任务，请补充与报考目标匹配的已审核真题库",
      code: "DAILY_BANK_INSUFFICIENT",
      availableQuestionCount: dailyCarry.answered + sessionItems.length,
    }, 409);
  }
  let sessionId = existingSession?.id ?? null;
  if (!sessionId && (sessionItems.length || (sessionKind === "daily" && dailyCarry.answered >= dailyTargetCount))) {
    sessionId = crypto.randomUUID();
    const carriedAnswered = sessionKind === "daily" ? Math.min(dailyCarry.answered, dailyTargetCount) : 0;
    const createdStatus = carriedAnswered >= dailyTargetCount ? "completed" : "active";
    const targetCount = sessionKind === "daily" ? dailyTargetCount : sessionItems.length;
    const created = await db.prepare(`INSERT OR IGNORE INTO practice_sessions
      (id, user_id, date_key, kind, mode, status, plan_minutes, target_count, bank_codes_json, question_codes_json,
       answered_count, correct_count, review_added, elapsed_seconds, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 'completed' THEN CURRENT_TIMESTAMP ELSE NULL END)`)
      .bind(
        sessionId,
        userId,
        dateKey,
        sessionKind,
        mode,
        createdStatus,
        sessionKind === "daily"
          ? (dailyReadiness?.planMinutes ?? profile.dailyMinutes)
          : Math.max(10, Math.min(60, Math.floor(Number(payload.planMinutes)) || 30)),
        targetCount,
        JSON.stringify(bankCodes),
        JSON.stringify(sessionItems.map((item) => item.question.id)),
        carriedAnswered,
        sessionKind === "daily" ? dailyCarry.correct : 0,
        sessionKind === "daily" ? dailyCarry.reviewAdded : 0,
        sessionKind === "daily" ? dailyCarry.elapsedSeconds : 0,
        createdStatus,
      ).run();
    if (!created.meta.changes) {
      const concurrent = await db.prepare(`SELECT id, question_codes_json FROM practice_sessions
        WHERE user_id = ? AND date_key = ? AND kind = ? AND mode = ? AND status = 'active'
        ORDER BY created_at DESC LIMIT 1`).bind(userId, dateKey, sessionKind, mode)
        .first<{ id: string; question_codes_json: string }>();
      if (concurrent) {
        sessionId = concurrent.id;
        const candidateMap = new Map(allSorted.map((item) => [item.question.id, item]));
        sessionItems = safeStringArray(concurrent.question_codes_json, 20)
          .map((code) => candidateMap.get(code)).filter((item): item is QuestionCandidate => Boolean(item));
      }
    }
  }
  const sessionSnapshot = sessionId ? await db.prepare(`SELECT id, status, target_count, answered_count,
      correct_count, review_added, elapsed_seconds FROM practice_sessions WHERE id = ? AND user_id = ?`)
    .bind(sessionId, userId).first<{
      id: string; status: string; target_count: number; answered_count: number; correct_count: number;
      review_added: number; elapsed_seconds: number;
    }>() : null;
  if (sessionSnapshot?.status === "completed" && sessionKind === "daily" && mode === "mixed") {
    await rewardInvite(userId);
  }
  const questions = sessionItems.map((item) => {
    const question = publicQuestion(item.question, item.progress);
    const planReason = question.due
      ? item.progress?.state === "weak" ? "错题复习到期" : "间隔复习到期"
      : item.question.bankCode === primaryBankCode
        ? "主攻考试"
        : urgentBankCodes.has(item.question.bankCode)
          ? "临近考试"
          : "兼顾题库";
    const pending = pendingAttempts.get(item.question.id);
    const pendingStage = Math.max(0, Math.floor(Number(pending?.review_stage ?? 0)));
    return {
      ...question,
      planReason,
      pendingAttempt: pending ? {
        attemptId: pending.id,
        selectedAnswer: Number(pending.selected_answer),
        correct: Boolean(pending.is_correct),
        correctAnswer: item.question.answer,
        explanation: item.question.explanation,
        technique: item.question.technique,
        state: pending.state ?? "learning",
        nextReviewAt: pending.next_review_at,
        reviewStage: pendingStage,
        reviewDays: strategy.reviewIntervals[pendingStage] ?? 1,
        needsReview: Boolean(pending.overtime || pending.uncertain || !pending.is_correct),
        uncertain: Boolean(pending.uncertain),
        overtime: Boolean(pending.overtime),
        targetSeconds: item.question.suggestedSeconds || targetSecondsFor(item.question),
      } : null,
    };
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
    sessionId,
    session: sessionSnapshot ? {
      targetCount: Number(sessionSnapshot.target_count), answeredCount: Number(sessionSnapshot.answered_count),
      correctCount: Number(sessionSnapshot.correct_count), reviewAdded: Number(sessionSnapshot.review_added),
      elapsedSeconds: Number(sessionSnapshot.elapsed_seconds), status: sessionSnapshot.status,
    } : null,
    dailyCompleted: sessionSnapshot?.status === "completed" && sessionKind === "daily",
    freeRemaining: freeRemaining ?? null,
    quotaExceeded: false,
    resumed: Boolean(existingSession || dailyCarry.answered),
    access: active ? "premium" : isDiagnostic ? "diagnostic" : "preview",
    composition: {
      due: questions.filter((item) => item.due).length,
      weak: questions.filter((item) => item.state === "weak").length,
      new: questions.filter((item) => item.state === "new").length,
      primary: questions.filter((item) => item.bankCode === primaryBankCode).length,
      other: questions.filter((item) => item.bankCode !== primaryBankCode).length,
      byBank,
      reviewDebt: {
        total: sorted.filter((item) => Boolean(item.progress?.next_review_at && Date.parse(item.progress.next_review_at) <= Date.now())).length,
        policy: sorted.filter((item) => Boolean(item.progress?.next_review_at && Date.parse(item.progress.next_review_at) <= Date.now())).length > 30
          ? "only_review"
          : sorted.filter((item) => Boolean(item.progress?.next_review_at && Date.parse(item.progress.next_review_at) <= Date.now())).length > 10
            ? "reduce_new"
            : "balanced",
      },
    },
  });
}

async function getEssayPracticeBatch(userId: string, payload: Record<string, unknown>) {
  const requested = Array.isArray(payload.bankCodes) ? payload.bankCodes.map(String) : [];
  const selected = (await selectedBankCodes(userId)).filter((code) => code !== STARTER_BANK_CODE);
  const allowed = new Set(selected);
  const bankCodes = (requested.length ? requested : selected).filter((code) => allowed.has(code)).slice(0, 32);
  if (!bankCodes.length) return json({ questions: [], mode: "essay", limit: 0, access: "preview" });
  const active = membershipIsActive(await userMembership(userId));
  if (!active) return json({ error: "申论真题微练需开通会员后使用；登录后可领取一次72小时体验", code: "PAYWALL_ESSAY" }, 403);
  const limit = Math.max(1, Math.min(active ? 10 : 2, Math.floor(Number(payload.limit)) || 3));
  const placeholders = bankCodes.map(() => "?").join(",");
  const focusModule = trimmed(payload.focusModule, 40);
  const moduleClause = focusModule ? "AND (q.module LIKE ? OR q.sub_type LIKE ?)" : "";
  const requestedQuestionCode = trimmed(payload.questionCode, 80);
  const questionClause = requestedQuestionCode ? "AND q.question_code = ?" : "";
  const requestedAttemptDateKey = /^\d{4}-\d{2}-\d{2}$/.test(String(payload.attemptDateKey ?? ""))
    ? String(payload.attemptDateKey)
    : "";
  const unfinishedClause = requestedQuestionCode ? "" : `AND NOT EXISTS (
    SELECT 1 FROM essay_attempts ea_block
    WHERE ea_block.user_id = ? AND ea_block.question_code = q.question_code
      AND ea_block.stage IN ('scheduled', 'completed')
  )`;
  const unfinishedOrder = requestedQuestionCode ? "0" : `CASE WHEN EXISTS (
    SELECT 1 FROM essay_attempts ea_active
    WHERE ea_active.user_id = ? AND ea_active.question_code = q.question_code
      AND ea_active.stage IN ('draft', 'self_check', 'self_score', 'revision')
  ) THEN 0 ELSE 1 END`;
  const bindings: unknown[] = [...bankCodes];
  if (focusModule) bindings.push(`%${focusModule}%`, `%${focusModule}%`);
  if (requestedQuestionCode) bindings.push(requestedQuestionCode);
  else bindings.push(userId, userId);
  const rows = await getD1().prepare(`SELECT q.question_code, q.module, q.sub_type, q.stem, q.material, q.prompt,
    q.word_limit, q.scoring_points_json, q.explanation, q.technique, q.source, q.source_region, q.source_year,
    q.truth_verified, q.frequency, q.frequency_occurrences, q.frequency_papers, q.frequency_years_json, q.frequency_updated_at,
    q.importance_stars, q.importance_rule_version, q.importance_reason, q.importance_override_reason,
    q.score_rate, q.score_rate_correct, q.score_rate_attempts, q.score_rate_scope, q.score_rate_source, q.score_rate_updated_at,
    q.suggested_seconds, q.image_url, q.resource_url,
    qb.bank_code, qb.name AS bank_name, qb.exam_type, qb.province
    FROM questions q
    JOIN question_bank_items qbi ON qbi.question_id = q.id
    JOIN question_banks qb ON qb.id = qbi.bank_id
    WHERE q.status = 'active' AND q.truth_verified = 1 AND q.review_status = 'approved'
      AND q.subject = '申论' AND qb.status = 'published'
      AND qb.bank_code IN (${placeholders}) ${moduleClause} ${questionClause} ${unfinishedClause}
    GROUP BY q.question_code
    ORDER BY ${unfinishedOrder}, CASE WHEN q.score_rate_attempts >= 100
        AND (q.score_rate_correct * 100.0 / q.score_rate_attempts) BETWEEN 40 AND 80 THEN 0 ELSE 1 END,
      CASE WHEN q.frequency_papers > 0 AND (q.frequency_occurrences * 1.0 / q.frequency_papers) >= 0.55 THEN 0
        WHEN q.frequency_papers > 0 AND (q.frequency_occurrences * 1.0 / q.frequency_papers) >= 0.25 THEN 1 ELSE 2 END,
      CASE WHEN q.importance_rule_version <> '' THEN q.importance_stars ELSE 0 END DESC,
      q.source_year DESC, q.question_code
    LIMIT ?`).bind(...bindings, limit).all<Record<string, unknown>>();
  const questionCodes = rows.results.map((row) => String(row.question_code));
  const attemptSnapshots = new Map<string, EssayAttemptRow>();
  if (questionCodes.length) {
    const dateClause = requestedAttemptDateKey ? "AND date_key = ?" : "";
    const attempts = await getD1().prepare(`SELECT id, question_code, date_key, stage, first_draft,
      self_checks_json, self_score, loss_reasons_json, revised_draft, rewrite_draft,
      elapsed_seconds, rewrite_due_at FROM essay_attempts
      WHERE user_id = ? AND question_code IN (${questionCodes.map(() => "?").join(",")})
        ${dateClause}
      ORDER BY updated_at DESC`).bind(userId, ...questionCodes, ...(requestedAttemptDateKey ? [requestedAttemptDateKey] : [])).all<EssayAttemptRow>();
    for (const attempt of attempts.results) if (!attemptSnapshots.has(attempt.question_code)) attemptSnapshots.set(attempt.question_code, attempt);
  }
  const questions = rows.results.map((row) => {
    const metrics = metricFields(row);
    const attempt = attemptSnapshots.get(String(row.question_code));
    const attemptStage = attempt?.stage ?? "draft";
    const attemptStageIndex = ESSAY_STAGE_ORDER.indexOf(attemptStage as (typeof ESSAY_STAGE_ORDER)[number]);
    const region = normalizeProvince(row.source_region) || normalizeProvince(row.province) || "全国";
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
      scoringPoints: attemptStageIndex >= 2 ? scoringPoints : [],
      reference: attemptStageIndex >= 3 ? String(row.explanation ?? "") : "",
      technique: attemptStageIndex >= 3 ? String(row.technique ?? "") : "",
      serverStage: attemptStage,
      serverAttempt: attempt ? publicEssayAttempt(attempt) : null,
      source: String(row.source ?? ""),
      region,
      examYear,
      truthLabel: examYear ? `${region === "全国" ? "国考" : region}-${examYear}` : region,
      ...metrics,
      frequencyMeta: {
        reliable: metrics.frequencyReliable,
        occurrences: metrics.frequencyOccurrences,
        paperCount: metrics.frequencyPapers,
        years: metrics.frequencyYears,
        updatedAt: metrics.frequencyUpdatedAt,
        scope: questionScopeLabel(String(row.exam_type), row.province),
      },
      importanceMeta: {
        reliable: metrics.importanceReliable,
        ruleVersion: metrics.importanceRuleVersion,
        reason: metrics.importanceReason,
        overrideReason: metrics.importanceOverrideReason,
      },
      scoreRateMeta: {
        reliable: metrics.scoreRateReliable,
        correct: metrics.scoreRateCorrect,
        sampleSize: metrics.scoreRateAttempts,
        scope: metrics.scoreRateScope,
        source: metrics.scoreRateSource,
        updatedAt: metrics.scoreRateUpdatedAt,
      },
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

const ESSAY_STAGE_ORDER = ["draft", "self_check", "self_score", "revision", "scheduled", "completed"] as const;

type EssayAttemptRow = {
  id: string;
  question_code: string;
  date_key: string;
  stage: string;
  first_draft: string;
  self_checks_json: string;
  self_score: number | null;
  loss_reasons_json: string;
  revised_draft: string;
  rewrite_draft: string;
  elapsed_seconds: number;
  rewrite_due_at: string | null;
};

function publicEssayAttempt(attempt: EssayAttemptRow) {
  return {
    id: attempt.id,
    dateKey: attempt.date_key,
    stage: ESSAY_STAGE_ORDER.includes(attempt.stage as (typeof ESSAY_STAGE_ORDER)[number]) ? attempt.stage : "draft",
    firstDraft: String(attempt.first_draft ?? ""),
    selfChecks: safeStringArray(attempt.self_checks_json, 20),
    selfScore: attempt.self_score === null ? null : Number(attempt.self_score),
    lossReasons: safeStringArray(attempt.loss_reasons_json, 20),
    revisedDraft: String(attempt.revised_draft ?? ""),
    rewriteDraft: String(attempt.rewrite_draft ?? ""),
    elapsedSeconds: Math.max(0, Number(attempt.elapsed_seconds ?? 0)),
    rewriteDueAt: String(attempt.rewrite_due_at ?? ""),
  };
}

async function saveEssayAttempt(userId: string, payload: Record<string, unknown>) {
  if (!membershipIsActive(await userMembership(userId))) {
    return json({ error: "申论真题微练需开通会员后使用", code: "PAYWALL_ESSAY" }, 403);
  }
  const questionCode = trimmed(payload.questionCode, 80);
  const stage = String(payload.stage ?? "draft");
  if (!ESSAY_STAGE_ORDER.includes(stage as (typeof ESSAY_STAGE_ORDER)[number])) return json({ error: "申论阶段无效" }, 400);
  const dateKey = /^\d{4}-\d{2}-\d{2}$/.test(String(payload.dateKey)) ? String(payload.dateKey) : chinaDateKey();
  const firstDraft = trimmed(payload.firstDraft, 8_000);
  const revisedDraft = trimmed(payload.revisedDraft, 8_000);
  const rewriteDraft = trimmed(payload.rewriteDraft, 8_000);
  const checks = safeStringArray(payload.selfChecks, 20).map((item) => item.slice(0, 120));
  const lossReasons = safeStringArray(payload.lossReasons, 20).map((item) => item.slice(0, 120));
  const selfScoreValue = Number(payload.selfScore);
  const selfScore = Number.isFinite(selfScoreValue) ? Math.max(0, Math.min(100, Math.round(selfScoreValue))) : null;
  const elapsedSeconds = Math.max(0, Math.min(4 * 3600, Math.floor(Number(payload.elapsedSeconds)) || 0));
  const requestedRewriteDueAt = /^\d{4}-\d{2}-\d{2}$/.test(String(payload.rewriteDueAt)) ? String(payload.rewriteDueAt) : null;
  const stageIndex = ESSAY_STAGE_ORDER.indexOf(stage as (typeof ESSAY_STAGE_ORDER)[number]);
  if (stageIndex >= 1 && firstDraft.length < 10) return json({ error: "请先完成独立作答" }, 400);
  if (stageIndex >= 2 && checks.length < 2) return json({ error: "请至少完成两项自查" }, 400);
  if (stageIndex >= 3 && selfScore === null) return json({ error: "请先完成采分自评" }, 400);
  if (stageIndex >= 4 && revisedDraft.length < 10) return json({ error: "请先完成第二版作答" }, 400);
  if (stageIndex >= 5 && rewriteDraft.length < 10) return json({ error: "请完成3天后独立重写" }, 400);
  const db = getD1();
  const available = await db.prepare(`SELECT q.question_code, q.scoring_points_json, q.explanation, q.technique FROM questions q
    JOIN question_bank_items qbi ON qbi.question_id = q.id
    JOIN question_banks qb ON qb.id = qbi.bank_id
    JOIN user_question_banks uqb ON uqb.bank_code = qb.bank_code AND uqb.user_id = ?
    WHERE q.question_code = ? AND q.subject = '申论' AND q.status = 'active'
      AND q.truth_verified = 1 AND q.review_status = 'approved' AND qb.status = 'published' LIMIT 1`)
    .bind(userId, questionCode).first<{ question_code: string; scoring_points_json: string; explanation: string; technique: string }>();
  if (!available) return json({ error: "申论真题不在已加入的有效题库中" }, 404);
  const existing = await db.prepare(`SELECT id, stage, first_draft, rewrite_due_at FROM essay_attempts
    WHERE user_id = ? AND question_code = ? AND date_key = ?`).bind(userId, questionCode, dateKey)
    .first<{ id: string; stage: string; first_draft: string; rewrite_due_at: string | null }>();
  const existingIndex = existing ? ESSAY_STAGE_ORDER.indexOf(existing.stage as (typeof ESSAY_STAGE_ORDER)[number]) : -1;
  if (!existing && dateKey !== chinaDateKey()) return json({ error: "新的申论练习必须从今天开始" }, 409);
  if (existingIndex >= 0 && stageIndex < existingIndex) return json({ error: "不能退回已完成的申论阶段" }, 409);
  const maximumNextStage = existingIndex >= 0 ? existingIndex + 1 : 1;
  if (stageIndex > maximumNextStage) return json({ error: "请按顺序完成申论训练阶段" }, 409);
  if (existingIndex >= 1 && existing?.first_draft !== firstDraft) return json({ error: "独立初稿已锁定，不能覆盖" }, 409);
  const serverRewriteDueAt = stageIndex >= 4 ? (existing?.rewrite_due_at ?? chinaDateKeyAfter(dateKey, 3)) : null;
  if (stage === "scheduled" && requestedRewriteDueAt && requestedRewriteDueAt !== serverRewriteDueAt) {
    return json({ error: `本题独立重写任务将于${serverRewriteDueAt}开放` }, 409);
  }
  if (stage === "completed") {
    const dueDate = existing?.rewrite_due_at ?? serverRewriteDueAt;
    if (!dueDate || dueDate > chinaDateKey()) return json({ error: "本题独立重写任务尚未开放" }, 409);
  }
  const id = existing?.id ?? crypto.randomUUID();
  await db.prepare(`INSERT INTO essay_attempts
    (id, user_id, question_code, date_key, stage, first_draft, self_checks_json, self_score,
      loss_reasons_json, revised_draft, rewrite_draft, elapsed_seconds, rewrite_due_at, submitted_at, completed_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      CASE WHEN ? <> 'draft' THEN CURRENT_TIMESTAMP ELSE NULL END,
      CASE WHEN ? = 'completed' THEN CURRENT_TIMESTAMP ELSE NULL END, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id, question_code, date_key) DO UPDATE SET
      stage = excluded.stage, first_draft = excluded.first_draft, self_checks_json = excluded.self_checks_json,
      self_score = excluded.self_score, loss_reasons_json = excluded.loss_reasons_json,
      revised_draft = excluded.revised_draft, rewrite_draft = excluded.rewrite_draft,
      elapsed_seconds = excluded.elapsed_seconds, rewrite_due_at = excluded.rewrite_due_at,
      submitted_at = COALESCE(essay_attempts.submitted_at, excluded.submitted_at),
      completed_at = CASE WHEN excluded.stage = 'completed' THEN CURRENT_TIMESTAMP ELSE essay_attempts.completed_at END,
      updated_at = CURRENT_TIMESTAMP`)
    .bind(id, userId, questionCode, dateKey, stage, firstDraft, JSON.stringify(checks), selfScore,
      JSON.stringify(lossReasons), revisedDraft, rewriteDraft, elapsedSeconds, serverRewriteDueAt, stage, stage).run();
  if (stage === "scheduled" || stage === "completed") {
    await db.prepare(`INSERT INTO daily_step_completions
      (user_id, date_key, step, source_ref, completed_at) VALUES (?, ?, 'essay', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, date_key, step) DO UPDATE SET source_ref = excluded.source_ref`)
      .bind(userId, chinaDateKey(), id).run();
  }
  let scoringPoints: string[] = [];
  try {
    const parsed = JSON.parse(available.scoring_points_json ?? "[]");
    if (Array.isArray(parsed)) scoringPoints = parsed.map(String).slice(0, 30);
  } catch { scoringPoints = []; }
  return json({
    ok: true,
    id,
    stage,
    rewriteDueAt: serverRewriteDueAt,
    attempt: publicEssayAttempt({
      id,
      question_code: questionCode,
      date_key: dateKey,
      stage,
      first_draft: firstDraft,
      self_checks_json: JSON.stringify(checks),
      self_score: selfScore,
      loss_reasons_json: JSON.stringify(lossReasons),
      revised_draft: revisedDraft,
      rewrite_draft: rewriteDraft,
      elapsed_seconds: elapsedSeconds,
      rewrite_due_at: serverRewriteDueAt,
    }),
    scoringPoints: stageIndex >= 2 ? scoringPoints : undefined,
    reference: stageIndex >= 3 ? available.explanation : undefined,
    technique: stageIndex >= 3 ? available.technique : undefined,
  });
}

async function loadDueEssayRewrites(userId: string) {
  const rows = await getD1().prepare(`SELECT ea.question_code, ea.date_key, ea.rewrite_due_at,
    q.module, q.source_region, q.source_year, qb.bank_code, qb.name AS bank_name
    FROM essay_attempts ea
    JOIN questions q ON q.question_code = ea.question_code
    JOIN question_bank_items qbi ON qbi.question_id = q.id
    JOIN question_banks qb ON qb.id = qbi.bank_id
    JOIN user_question_banks uqb ON uqb.user_id = ea.user_id AND uqb.bank_code = qb.bank_code
    WHERE ea.user_id = ? AND ea.stage = 'scheduled' AND date(ea.rewrite_due_at) <= date('now', '+8 hours')
      AND q.status = 'active' AND q.truth_verified = 1 AND q.review_status = 'approved' AND qb.status = 'published'
    GROUP BY ea.id ORDER BY date(ea.rewrite_due_at), ea.created_at LIMIT 10`).bind(userId).all<Record<string, unknown>>();
  return rows.results.map((row) => ({
    questionCode: String(row.question_code),
    originalDateKey: String(row.date_key),
    rewriteDueAt: String(row.rewrite_due_at),
    module: String(row.module),
    truthLabel: normalizeProvince(row.source_region) === "全国"
      ? `国考-${String(row.source_year ?? "")}`
      : `${normalizeProvince(row.source_region)}-${String(row.source_year ?? "")}`,
    bankCode: String(row.bank_code),
    bankName: String(row.bank_name),
  }));
}

async function resolveQuestion(questionCode: string, bankCode: string, includeUnavailable = false) {
  const starter = starterQuestionList().find((question) => question.id === questionCode && bankCode === STARTER_BANK_CODE);
  if (starter) return starter;
  const row = await getD1().prepare(`SELECT q.question_code, q.module, q.sub_type, q.stem, q.options_json, q.answer,
    q.explanation, q.technique, q.difficulty, q.source, q.truth_verified_at, q.source_region, q.source_year,
    q.truth_verified, q.frequency, q.frequency_occurrences, q.frequency_papers, q.frequency_years_json, q.frequency_updated_at,
    q.importance_stars, q.importance_rule_version, q.importance_reason, q.importance_override_reason,
    q.score_rate, q.score_rate_correct, q.score_rate_attempts, q.score_rate_scope, q.score_rate_source, q.score_rate_updated_at,
    q.suggested_seconds, q.image_url, q.resource_url,
    qb.bank_code, qb.name AS bank_name,
    qb.exam_type AS bank_exam_type, qb.province AS bank_province
    FROM questions q JOIN question_bank_items qbi ON qbi.question_id = q.id
    JOIN question_banks qb ON qb.id = qbi.bank_id
    WHERE q.question_code = ? AND qb.bank_code = ?
      AND (? = 1 OR (q.status = 'active' AND q.truth_verified = 1
        AND q.review_status = 'approved' AND qb.status = 'published')) LIMIT 1`)
    .bind(questionCode, bankCode, includeUnavailable ? 1 : 0).first<Record<string, unknown>>();
  if (!row) return null;
  const metrics = metricFields(row);
  return {
    id: String(row.question_code), module: String(row.module), stem: String(row.stem), options: parseOptions(String(row.options_json ?? "[]")),
    answer: answerIndex(row.answer ? String(row.answer) : null), explanation: String(row.explanation ?? ""),
    knowledge: String(row.sub_type ?? row.module), technique: String(row.technique ?? ""), source: String(row.source ?? "题库导入"),
    difficulty: String(row.difficulty ?? "中等"), bankCode: String(row.bank_code), bankName: String(row.bank_name),
    scopeLabel: questionScopeLabel(String(row.bank_exam_type), row.bank_province),
    reviewedAt: row.truth_verified_at ? String(row.truth_verified_at) : null,
    targetCode: String(row.bank_exam_type) === "national"
      ? "national"
      : String(row.bank_exam_type) === "provincial"
        ? `province:${normalizeProvince(row.bank_province)}`
        : null,
    region: normalizeProvince(row.source_region) || normalizeProvince(row.bank_province) || "全国",
    examYear: Number.isInteger(Number(row.source_year)) ? Number(row.source_year) : null,
    ...metrics,
    suggestedSeconds: Math.max(10, Number(row.suggested_seconds ?? 60)),
    imageUrl: String(row.image_url ?? ""),
    resourceUrl: String(row.resource_url ?? ""),
  } satisfies ResolvedQuestion;
}

async function submitContentReport(userId: string, payload: Record<string, unknown>) {
  const db = getD1();
  const questionCode = trimmed(payload.questionCode, 80);
  const bankCode = trimmed(payload.bankCode, 80);
  const reasonCode = trimmed(payload.reasonCode, 40);
  const detail = trimmed(payload.detail, 500);
  if (!questionCode || !bankCode || !CONTENT_REPORT_REASONS.has(reasonCode)) {
    return json({ error: "请选择有效的报错原因", code: "CONTENT_REPORT_INVALID" }, 400);
  }
  if (reasonCode === "other" && detail.length < 2) {
    return json({ error: "选择“其他问题”时，请补充说明", code: "CONTENT_REPORT_DETAIL_REQUIRED" }, 400);
  }

  let reportableQuestion = bankCode === STARTER_BANK_CODE
    ? starterQuestionList().find((question) => question.id === questionCode) ?? null
    : null;
  if (!reportableQuestion) {
    const allowed = await db.prepare(`SELECT q.question_code, q.module, q.source, qb.bank_code, qb.name AS bank_name
      FROM questions q
      JOIN question_bank_items qbi ON qbi.question_id = q.id
      JOIN question_banks qb ON qb.id = qbi.bank_id
      JOIN user_question_banks uqb ON uqb.bank_code = qb.bank_code AND uqb.user_id = ?
      WHERE q.question_code = ? AND qb.bank_code = ? AND q.status = 'active'
        AND q.truth_verified = 1 AND q.review_status = 'approved' AND qb.status = 'published'
      LIMIT 1`).bind(userId, questionCode, bankCode).first<Record<string, unknown>>();
    if (allowed) {
      reportableQuestion = {
        id: String(allowed.question_code),
        module: String(allowed.module ?? ""),
        source: String(allowed.source ?? ""),
        bankCode: String(allowed.bank_code),
        bankName: String(allowed.bank_name ?? ""),
      } as ResolvedQuestion;
    }
  }
  if (!reportableQuestion) {
    return json({ error: "当前题目不属于已加入且可练的题库", code: "CONTENT_REPORT_NOT_REPORTABLE" }, 403);
  }

  const existing = await db.prepare(`SELECT id FROM content_reports
    WHERE user_id = ? AND content_type = 'question' AND content_key = ? AND reason_code = ? AND status = 'pending'
    LIMIT 1`).bind(userId, questionCode, reasonCode).first<{ id: number }>();
  if (existing) return json({ ok: true, duplicate: true, id: existing.id });

  const recent = await db.prepare(`SELECT COUNT(*) AS count FROM content_reports
    WHERE user_id = ? AND created_at >= datetime('now','-24 hours')`).bind(userId).first<{ count: number }>();
  if (Number(recent?.count ?? 0) >= CONTENT_REPORT_DAILY_LIMIT) {
    const response = json({ error: "今日内容反馈次数已达上限，请明日再试", code: "CONTENT_REPORT_RATE_LIMIT" }, 429);
    response.headers.set("retry-after", "86400");
    return response;
  }

  const contextJson = JSON.stringify({
    bankCode,
    bankName: reportableQuestion.bankName,
    module: reportableQuestion.module,
    source: reportableQuestion.source,
  });
  await db.prepare(`INSERT OR IGNORE INTO content_reports
    (user_id, content_type, content_key, reason_code, detail, context_json, status, updated_at)
    SELECT ?, 'question', ?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP
    WHERE (SELECT COUNT(*) FROM content_reports WHERE user_id = ?
      AND created_at >= datetime('now','-24 hours')) < ?`)
    .bind(userId, questionCode, reasonCode, detail, contextJson, userId, CONTENT_REPORT_DAILY_LIMIT).run();
  const report = await db.prepare(`SELECT id FROM content_reports
    WHERE user_id = ? AND content_type = 'question' AND content_key = ? AND reason_code = ? AND status = 'pending'
    LIMIT 1`).bind(userId, questionCode, reasonCode).first<{ id: number }>();
  if (!report) {
    const response = json({ error: "今日内容反馈次数已达上限，请明日再试", code: "CONTENT_REPORT_RATE_LIMIT" }, 429);
    response.headers.set("retry-after", "86400");
    return response;
  }
  return json({ ok: true, duplicate: false, id: report.id });
}

async function submitPracticeAnswer(userId: string, payload: Record<string, unknown>, signedIn: boolean) {
  const questionCode = trimmed(payload.questionCode, 80);
  const bankCode = trimmed(payload.bankCode, 80);
  const selectedAnswer = Math.floor(Number(payload.selectedAnswer));
  const uncertain = payload.uncertain === true;
  const durationMs = Math.max(0, Math.min(30 * 60_000, Math.floor(Number(payload.durationMs)) || 0));
  const practiceSessionId = trimmed(payload.practiceSessionId ?? payload.sessionId, 80);
  if (!practiceSessionId) return json({ error: "本次训练记录缺失，请重新进入" }, 409);
  // One question can be applied only once in a server-issued session. Client
  // attempt ids are deliberately ignored so changing them cannot farm quota,
  // progress, check-ins or invite rewards.
  const attemptKey = `${practiceSessionId}:${questionCode}`;
  let question = await resolveQuestion(questionCode, bankCode);
  const db = getD1();
  const duplicate = await db.prepare(`SELECT id, question_code, selected_answer, is_correct, overtime, confidence, uncertain, apply_status
    FROM practice_attempts WHERE user_id = ? AND attempt_key = ?`).bind(userId, attemptKey)
    .first<{ id: number; question_code: string; selected_answer: number | null; is_correct: number; overtime: number; confidence: string; uncertain: number; apply_status: string }>();
  if (duplicate) {
    if (duplicate.apply_status !== "applied") {
      // A current D1 batch cannot persist a partial attempt, but this safely
      // clears a legacy interrupted row created before transactional apply.
      await db.prepare("DELETE FROM practice_attempts WHERE id = ? AND user_id = ? AND apply_status <> 'applied'")
        .bind(duplicate.id, userId).run();
    } else {
    if (!question) question = await resolveQuestion(questionCode, bankCode, true);
    if (!question) return json({ error: "原答题记录对应的题目已不存在，请刷新练习", code: "PRACTICE_SESSION_INVALIDATED" }, 409);
    if (duplicate.question_code !== questionCode || Number(duplicate.selected_answer) !== selectedAnswer) {
      return json({ error: "检测到作答请求冲突，请刷新页面后重试" }, 409);
    }
    const current = await db.prepare(`SELECT state, next_review_at, review_stage FROM user_question_progress
      WHERE user_id = ? AND question_code = ?`).bind(userId, questionCode)
      .first<{ state: string; next_review_at: string | null; review_stage: number }>();
    const duplicateStrategy = await loadStrategyConfig();
    const duplicateStage = Number(current?.review_stage ?? 0);
    await reconcileInviteReward(userId);
    return json({
      ok: true,
      duplicate: true,
      correct: Boolean(duplicate.is_correct),
      correctAnswer: question.answer,
      explanation: question.explanation,
      technique: question.technique,
      state: current?.state ?? "learning",
      nextReviewAt: current?.next_review_at ?? null,
      reviewStage: duplicateStage,
      reviewDays: duplicateStrategy.reviewIntervals[duplicateStage] ?? 1,
      needsReview: !duplicate.is_correct || Boolean(duplicate.overtime) || Boolean(duplicate.uncertain),
      confidence: duplicate.confidence,
      attemptId: duplicate.id,
      overtime: Boolean(duplicate.overtime),
      targetSeconds: question.suggestedSeconds || targetSecondsFor(question),
    });
    }
  }

  let session: { id: string; status: string; kind: string; date_key: string; question_codes_json: string } | null = null;
  if (practiceSessionId) {
    session = await db.prepare(`SELECT id, status, kind, date_key, question_codes_json FROM practice_sessions
      WHERE id = ? AND user_id = ? AND status = 'active'`).bind(practiceSessionId, userId)
      .first<{ id: string; status: string; kind: string; date_key: string; question_codes_json: string }>() ?? null;
  }
  const dateKey = chinaDateKey();
  const membership = await userMembership(userId);
  const active = membershipIsActive(membership);
  const selectedCodes = await selectedBankCodes(userId);
  const effectiveBankCodes = await effectivePracticeBankCodes(userId, selectedCodes, active);
  const sessionPolicy = practiceSessionSubmissionPolicy({
    session: session ? {
      status: session.status,
      dateKey: session.date_key,
      questionCodes: session.question_codes_json,
    } : null,
    today: dateKey,
    questionCode,
    bankCode,
    effectiveBankCodes,
  });
  if (!sessionPolicy.allowed) {
    if (session) {
      await db.prepare(`UPDATE practice_sessions SET status = 'abandoned', updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND user_id = ? AND status = 'active'`).bind(session.id, userId).run();
    }
    const entitlementChanged = sessionPolicy.code === "PRACTICE_SESSION_ENTITLEMENT_CHANGED";
    return json({
      error: entitlementChanged
        ? "因会员状态或备考组合发生变化，本组练习已结束；已完成记录已保存，请重新开始训练"
        : "本组练习已过期或题库内容已更新，请重新开始训练",
      code: entitlementChanged ? "PRACTICE_SESSION_ENTITLEMENT_CHANGED" : "PRACTICE_SESSION_INVALIDATED",
    }, entitlementChanged ? 403 : 409);
  }
  if (!question) {
    if (session) {
      await db.prepare(`UPDATE practice_sessions SET status = 'abandoned', updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND user_id = ? AND status = 'active'`).bind(session.id, userId).run();
    }
    return json({ error: "题库内容已更新，请重新生成本组练习", code: "PRACTICE_SESSION_INVALIDATED" }, 409);
  }
  if (selectedAnswer < 0 || selectedAnswer >= question.options.length || question.answer < 0) {
    return json({ error: "提交的作答信息无效，请重新选择答案" }, 400);
  }
  const diagnosticSession = session?.kind === "diagnostic";
  if (!signedIn && !diagnosticSession) {
    return json({ error: "首次能力诊断可免登录完成；正式日练请登录后继续", code: "VERIFIED_ACCOUNT_REQUIRED" }, 403);
  }

  const correct = selectedAnswer === question.answer;
  const targetSeconds = question.suggestedSeconds || targetSecondsFor(question);
  const overtime = durationMs > targetSeconds * 1000;
  const confidence = correct ? "pending" : "hesitant";
  await db.prepare(`INSERT OR IGNORE INTO user_daily_usage (user_id, date_key, practice_count)
    VALUES (?, ?, 0)`).bind(userId, dateKey).run();

  const previous = await db.prepare(`SELECT state, correct_count, wrong_count, uncertain_count, review_count, review_stage,
    next_review_at, last_answered_at
    FROM user_question_progress WHERE user_id = ? AND question_code = ?`).bind(userId, questionCode)
    .first<{ state: string; correct_count: number; wrong_count: number; uncertain_count: number; review_count: number;
      review_stage: number; next_review_at: string | null; last_answered_at: string | null }>();
  const strategy = await loadStrategyConfig();
  const needsReview = !correct || uncertain || overtime;
  const isDue = Boolean(previous?.next_review_at && Date.parse(previous.next_review_at) <= Date.now());
  const finalStage = Math.max(0, strategy.reviewIntervals.length - 1);
  const previousStage = Math.max(0, Math.min(finalStage, Number(previous?.review_stage ?? 0)));
  const initialReviewStage = needsReview
    ? 0
    : previous
      ? isDue ? Math.min(finalStage, previousStage + 1) : previousStage
      : 0;
  const initialReviewDays = strategy.reviewIntervals[initialReviewStage] ?? 1;
  const initialState = needsReview ? "weak" : initialReviewStage >= 2 ? "mastered" : "learning";
  const initialNextReviewAt = reviewAtAfterChinaDays(initialReviewDays);
  const intervalDates = strategy.reviewIntervals.map((days) => reviewAtAfterChinaDays(days));
  const intervalCase = intervalDates.map((_, index) => `WHEN ${index} THEN ?`).join(" ");
  const scoreScopeLabel = new Set(["全国", "国考"]).has(normalizeProvince(question.region))
    ? "国考" : normalizeProvince(question.region);
  const usageStatement = diagnosticSession
    ? db.prepare(`UPDATE user_daily_usage SET updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ? AND date_key = ? AND EXISTS (
          SELECT 1 FROM practice_attempts WHERE user_id = ? AND attempt_key = ? AND apply_status = 'applying')`)
      .bind(userId, dateKey, userId, attemptKey)
    : active
    ? db.prepare(`UPDATE user_daily_usage SET practice_count = practice_count + 1, updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ? AND date_key = ? AND EXISTS (
          SELECT 1 FROM practice_attempts WHERE user_id = ? AND attempt_key = ? AND apply_status = 'applying')`)
      .bind(userId, dateKey, userId, attemptKey)
    : db.prepare(`UPDATE user_daily_usage SET practice_count = practice_count + 1, updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ? AND date_key = ? AND practice_count < 5 AND EXISTS (
          SELECT 1 FROM practice_attempts WHERE user_id = ? AND attempt_key = ? AND apply_status = 'applying')`)
      .bind(userId, dateKey, userId, attemptKey);
  const statements: D1PreparedStatement[] = [
    db.prepare(`INSERT OR IGNORE INTO practice_attempts
      (attempt_key, practice_session_id, user_id, question_code, bank_code, module, selected_answer,
        is_correct, uncertain, confidence, wrong_reason, overtime, was_due, apply_status, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, 0, 'processing', ?)`)
      .bind(attemptKey, session?.id ?? null, userId, questionCode, bankCode, question.module, selectedAnswer,
        correct ? 1 : 0, uncertain ? 1 : 0, confidence, overtime ? 1 : 0, durationMs),
    db.prepare(`UPDATE practice_attempts SET apply_status = 'applying'
      WHERE user_id = ? AND attempt_key = ? AND apply_status = 'processing' AND changes() = 1`)
      .bind(userId, attemptKey),
    usageStatement,
    db.prepare(`UPDATE practice_attempts SET apply_status = 'quota_rejected'
      WHERE user_id = ? AND attempt_key = ? AND apply_status = 'applying' AND changes() = 0`)
      .bind(userId, attemptKey),
    db.prepare(`INSERT INTO user_question_progress
      (user_id, question_code, state, correct_count, wrong_count, uncertain_count, last_answer, last_correct,
       last_duration_ms, last_answered_at, next_review_at, review_count, review_stage, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?, CURRENT_TIMESTAMP
      WHERE EXISTS (SELECT 1 FROM practice_attempts
        WHERE user_id = ? AND attempt_key = ? AND apply_status = 'applying')
      ON CONFLICT(user_id, question_code) DO UPDATE SET
      state = CASE
        WHEN excluded.state = 'weak' THEN 'weak'
        WHEN datetime(user_question_progress.next_review_at) <= CURRENT_TIMESTAMP
          AND MIN(?, user_question_progress.review_stage + 1) >= 2 THEN 'mastered'
        WHEN user_question_progress.review_stage >= 2 THEN 'mastered'
        ELSE 'learning' END,
      correct_count = user_question_progress.correct_count + excluded.correct_count,
      wrong_count = user_question_progress.wrong_count + excluded.wrong_count,
      uncertain_count = user_question_progress.uncertain_count + excluded.uncertain_count,
      last_answer = excluded.last_answer,
      last_correct = excluded.last_correct, last_duration_ms = excluded.last_duration_ms,
      last_answered_at = CURRENT_TIMESTAMP,
      next_review_at = CASE
        WHEN excluded.state = 'weak' THEN excluded.next_review_at
        WHEN user_question_progress.next_review_at IS NOT NULL
          AND datetime(user_question_progress.next_review_at) > CURRENT_TIMESTAMP THEN user_question_progress.next_review_at
        ELSE CASE MIN(?, user_question_progress.review_stage + 1) ${intervalCase} ELSE excluded.next_review_at END
      END,
      review_count = user_question_progress.review_count
        + CASE WHEN datetime(user_question_progress.next_review_at) <= CURRENT_TIMESTAMP THEN 1 ELSE 0 END,
      review_stage = CASE
        WHEN excluded.state = 'weak' THEN 0
        WHEN datetime(user_question_progress.next_review_at) <= CURRENT_TIMESTAMP
          THEN MIN(?, user_question_progress.review_stage + 1)
        ELSE user_question_progress.review_stage END,
      updated_at = CURRENT_TIMESTAMP`)
      .bind(userId, questionCode, initialState, correct ? 1 : 0, correct ? 0 : 1, uncertain ? 1 : 0,
        selectedAnswer, correct ? 1 : 0, durationMs, initialNextReviewAt, isDue ? 1 : 0, initialReviewStage,
        userId, attemptKey, finalStage, finalStage, ...intervalDates, finalStage),
    db.prepare(platformScoreRateIncrementSql(eligibleFirstAttemptSql("metric_attempt", "metric_user", "applying")))
      .bind(correct ? 1 : 0, correct ? 1 : 0,
        `同${scoreScopeLabel}目标用户·有效首答`, questionCode, userId, attemptKey),
  ];
  if (session && confidence !== "pending") {
    statements.push(db.prepare(`UPDATE practice_sessions SET
        answered_count = answered_count + 1,
        correct_count = correct_count + ?,
        review_added = review_added + ?,
        elapsed_seconds = elapsed_seconds + ?,
        status = CASE WHEN answered_count + 1 >= target_count THEN 'completed' ELSE status END,
        completed_at = CASE WHEN answered_count + 1 >= target_count THEN CURRENT_TIMESTAMP ELSE completed_at END,
        updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND user_id = ? AND status = 'active'
          AND EXISTS (SELECT 1 FROM practice_attempts
            WHERE user_id = ? AND attempt_key = ? AND apply_status = 'applying')`)
      .bind(correct ? 1 : 0, needsReview ? 1 : 0, Math.round(durationMs / 1000), session.id, userId, userId, attemptKey));
  }
  statements.push(
    db.prepare(`UPDATE practice_attempts SET was_due = ?, apply_status = 'applied'
      WHERE user_id = ? AND attempt_key = ? AND apply_status = 'applying'`)
      .bind(isDue ? 1 : 0, userId, attemptKey),
    db.prepare(`DELETE FROM practice_attempts
      WHERE user_id = ? AND attempt_key = ? AND apply_status = 'quota_rejected'`)
      .bind(userId, attemptKey),
  );
  await db.batch(statements);
  const appliedAttempt = await db.prepare(`SELECT id FROM practice_attempts
    WHERE user_id = ? AND attempt_key = ? AND apply_status = 'applied'`)
    .bind(userId, attemptKey).first<{ id: number }>();
  if (!appliedAttempt) return json({ error: "今日免费练习已完成，明日可继续", code: "FREE_DAILY_LIMIT", freeRemaining: 0 }, 429);
  const attemptId = Number(appliedAttempt.id);
  const finalProgress = await db.prepare(`SELECT state, next_review_at, review_stage FROM user_question_progress
    WHERE user_id = ? AND question_code = ?`).bind(userId, questionCode)
    .first<{ state: string; next_review_at: string | null; review_stage: number }>();
  const reviewStage = Math.max(0, Math.floor(Number(finalProgress?.review_stage ?? initialReviewStage)));
  const reviewDays = strategy.reviewIntervals[reviewStage] ?? 1;
  const state = finalProgress?.state ?? initialState;
  const nextReviewAt = finalProgress?.next_review_at ?? initialNextReviewAt;
  if (session && confidence !== "pending") {
    const completed = await db.prepare(`SELECT status, kind, mode, target_count, answered_count
      FROM practice_sessions WHERE id = ? AND user_id = ?`).bind(session.id, userId)
      .first<{ status: string; kind: string; mode: string; target_count: number; answered_count: number }>();
    if (completed?.status === "completed" && completed.kind === "daily" && completed.mode === "mixed"
      && completed.target_count >= 5 && completed.answered_count >= 5) await rewardInvite(userId);
  }
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
    attemptId,
    attemptKey,
    sessionId: session?.id ?? null,
    freeRemaining: active ? null : Math.max(0, 5 - (await loadDailyUsage(userId, dateKey)).practice),
    overtime,
    targetSeconds,
  });
}

async function updateQuestionMeta(userId: string, payload: Record<string, unknown>, signedIn: boolean) {
  const questionCode = trimmed(payload.questionCode, 80);
  if (!questionCode) return json({ error: "题目编号不能为空" }, 400);
  const db = getD1();
  const attemptId = Math.max(0, Math.floor(Number(payload.attemptId)) || 0);
  if (!signedIn) {
    const diagnosticAttempt = attemptId ? await db.prepare(`SELECT 1 AS allowed FROM practice_attempts pa
      JOIN practice_sessions ps ON ps.id = pa.practice_session_id AND ps.user_id = pa.user_id
      WHERE pa.id = ? AND pa.user_id = ? AND pa.question_code = ? AND ps.kind = 'diagnostic' LIMIT 1`)
      .bind(attemptId, userId, questionCode).first<{ allowed: number }>() : null;
    if (!diagnosticAttempt) return json({ error: "正式学习记录请登录后保存", code: "VERIFIED_ACCOUNT_REQUIRED" }, 403);
  }
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
      ? await db.prepare(`SELECT uncertain, confidence, practice_session_id, is_correct, overtime, duration_ms
        FROM practice_attempts WHERE id = ? AND user_id = ? AND question_code = ?`)
        .bind(attemptId, userId, questionCode).first<{
          uncertain: number; confidence: string; practice_session_id: string | null; is_correct: number; overtime: number; duration_ms: number;
        }>()
      : null;
    if (!attemptId || !attempt) return json({ error: "答题记录不存在，无法确认掌握状态" }, 404);
    nextReviewAt = confidence === "confident" ? null : reviewAtAfterChinaDays(1);
    const increment = confidence !== "confident" && !attempt.uncertain ? 1 : 0;
    const needsReview = !attempt.is_correct || confidence !== "confident" || Boolean(attempt.overtime);
    const finalizeStatements: D1PreparedStatement[] = [
      db.prepare(`UPDATE practice_attempts SET confidence = ?, uncertain = ?
        WHERE id = ? AND user_id = ? AND question_code = ? AND confidence = 'pending' AND apply_status = 'applied'`)
        .bind(confidence, confidence === "confident" ? Number(attempt.uncertain ?? 0) : 1, attemptId, userId, questionCode),
      db.prepare(`UPDATE user_question_progress SET
        state = CASE WHEN ? = 'confident' THEN state ELSE 'weak' END,
        review_stage = CASE WHEN ? = 'confident' THEN review_stage ELSE 0 END,
        uncertain_count = uncertain_count + ?,
        next_review_at = CASE WHEN ? = 'confident' THEN next_review_at ELSE ? END,
        wrong_reason = CASE WHEN ? = 'guessed' THEN '蒙对了' ELSE wrong_reason END,
        updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ? AND question_code = ? AND changes() = 1`)
        .bind(confidence, confidence, increment, confidence, nextReviewAt, confidence, userId, questionCode),
    ];
    if (attempt.practice_session_id) {
      finalizeStatements.push(db.prepare(`UPDATE practice_sessions SET
          answered_count = answered_count + 1,
          correct_count = correct_count + ?,
          review_added = review_added + ?,
          elapsed_seconds = elapsed_seconds + ?,
          status = CASE WHEN answered_count + 1 >= target_count THEN 'completed' ELSE status END,
          completed_at = CASE WHEN answered_count + 1 >= target_count THEN CURRENT_TIMESTAMP ELSE completed_at END,
          updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND user_id = ? AND status = 'active' AND changes() = 1`)
        .bind(attempt.is_correct ? 1 : 0, needsReview ? 1 : 0, Math.round(Number(attempt.duration_ms ?? 0) / 1000),
          attempt.practice_session_id, userId));
    }
    const finalized = await db.batch(finalizeStatements);
    const applied = Number(finalized[0]?.meta?.changes ?? 0) > 0;
    if (!applied) {
      const [current, currentAttempt] = await Promise.all([
        db.prepare(`SELECT state, next_review_at FROM user_question_progress
          WHERE user_id = ? AND question_code = ?`).bind(userId, questionCode)
          .first<{ state: string; next_review_at: string | null }>(),
        db.prepare(`SELECT confidence, is_correct, overtime, uncertain FROM practice_attempts
          WHERE id = ? AND user_id = ? AND question_code = ?`).bind(attemptId, userId, questionCode)
          .first<{ confidence: string; is_correct: number; overtime: number; uncertain: number }>(),
      ]);
      const serverConfidence = allowedConfidence.has(currentAttempt?.confidence ?? "") ? String(currentAttempt?.confidence) : confidence;
      return json({
        ok: true,
        duplicate: true,
        state: current?.state ?? "learning",
        nextReviewAt: current?.next_review_at ?? null,
        confidence: serverConfidence,
        needsReview: !currentAttempt?.is_correct || Boolean(currentAttempt?.overtime) || Boolean(currentAttempt?.uncertain)
          || serverConfidence !== "confident",
      });
    }
    if (confidence !== "confident") state = "weak";
    if (attempt.practice_session_id) {
      const completed = await db.prepare(`SELECT status, kind, mode, target_count, answered_count
        FROM practice_sessions WHERE id = ? AND user_id = ?`).bind(attempt.practice_session_id, userId)
        .first<{ status: string; kind: string; mode: string; target_count: number; answered_count: number }>();
      if (completed?.status === "completed" && completed.kind === "daily" && completed.mode === "mixed"
        && completed.target_count >= 5 && completed.answered_count >= 5) await rewardInvite(userId);
    }
  }
  const [current, savedAttempt] = await Promise.all([
    db.prepare(`SELECT state, next_review_at FROM user_question_progress
      WHERE user_id = ? AND question_code = ?`).bind(userId, questionCode).first<{ state: string; next_review_at: string | null }>(),
    attemptId ? db.prepare(`SELECT confidence, is_correct, overtime, uncertain FROM practice_attempts
      WHERE id = ? AND user_id = ? AND question_code = ?`).bind(attemptId, userId, questionCode)
      .first<{ confidence: string; is_correct: number; overtime: number; uncertain: number }>() : Promise.resolve(null),
  ]);
  const serverConfidence = savedAttempt && allowedConfidence.has(savedAttempt.confidence) ? savedAttempt.confidence : null;
  return json({
    ok: true,
    duplicate: false,
    state: state ?? current?.state ?? "learning",
    nextReviewAt: nextReviewAt ?? current?.next_review_at ?? null,
    confidence: serverConfidence,
    needsReview: savedAttempt ? !savedAttempt.is_correct || Boolean(savedAttempt.overtime) || Boolean(savedAttempt.uncertain)
      || serverConfidence !== "confident" : undefined,
  });
}

async function recordDailyStep(userId: string, payload: Record<string, unknown>) {
  const today = chinaDateKey();
  const requestedDate = trimmed(payload.dateKey, 10) || today;
  const step = trimmed(payload.step, 20);
  if (requestedDate !== today) return json({ error: "只能记录当天学习步骤", code: "DAILY_STEP_DATE_INVALID" }, 400);
  if (!new Set(["morning", "essay"]).has(step)) return json({ error: "学习步骤无效", code: "DAILY_STEP_INVALID" }, 400);
  const db = getD1();
  let sourceRef = step;
  if (step === "essay") {
    const attempt = await db.prepare(`SELECT id FROM essay_attempts
      WHERE user_id = ? AND (
        (date_key = ? AND stage IN ('scheduled', 'completed'))
        OR (stage = 'completed' AND date(updated_at, '+8 hours') = date('now', '+8 hours'))
      ) ORDER BY updated_at DESC LIMIT 1`).bind(userId, today).first<{ id: string }>();
    if (!attempt) return json({ error: "完成申论第二版作答或到期重写后，才能记录本步骤", code: "DAILY_ESSAY_INCOMPLETE" }, 409);
    sourceRef = attempt.id;
  }
  await db.prepare(`INSERT INTO daily_step_completions
    (user_id, date_key, step, source_ref, completed_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id, date_key, step) DO UPDATE SET source_ref = excluded.source_ref`)
    .bind(userId, today, step, sourceRef).run();
  return json({ ok: true, dateKey: today, step });
}

function serverContentDayIndex(dateKey: string, count: number) {
  if (count <= 1) return 0;
  const dayNumber = Math.floor(new Date(`${dateKey}T00:00:00+08:00`).getTime() / 86_400_000);
  return Math.abs(dayNumber) % count;
}

async function requiredDailyStepNames(userId: string, today: string) {
  const [membership, profile, state] = await Promise.all([
    userMembership(userId),
    loadExamProfile(userId),
    getD1().prepare("SELECT progress_json FROM user_states WHERE user_id = ?").bind(userId)
      .first<{ progress_json: string }>(),
  ]);
  let progress: Record<string, unknown> = {};
  try { progress = JSON.parse(state?.progress_json ?? "{}"); } catch { progress = {}; }
  const overrides = progress.planOverrides && typeof progress.planOverrides === "object"
    ? progress.planOverrides as Record<string, unknown>
    : {};
  const active = membershipIsActive(membership);
  const planMinutes = effectiveDailyPlanMinutes(profile.dailyMinutes, overrides[today], active);
  const [content, banks, dueRewrites] = await Promise.all([
    loadContent(active, profile),
    loadQuestionBanks(userId, active),
    loadDueEssayRewrites(userId),
  ]);
  const planConfig = content.strategyConfig?.timePlans && typeof content.strategyConfig.timePlans === "object"
    ? (content.strategyConfig.timePlans as Record<string, Record<string, unknown>>)[String(planMinutes)]
    : null;
  const fallback = (DEFAULT_STRATEGY.timePlans as Record<number, { morning: number; essay: number }>)[planMinutes as 10 | 30 | 45 | 60];
  const morningMinutes = Math.max(0, Math.floor(Number(planConfig?.morning ?? fallback?.morning ?? 0)));
  const essayMinutes = Math.max(0, Math.floor(Number(planConfig?.essay ?? fallback?.essay ?? 0)));
  const days = content.practiceDays ?? [];
  const selectedDay = days.find((day) => day.date === today)
    ?? days[serverContentDayIndex(today, days.length)]
    ?? days[0];
  const hasMorning = Boolean(selectedDay && (selectedDay.morning.lead.trim() || selectedDay.morning.paragraphs.length));
  const hasEssay = banks.some((bank) => bank.subject === "申论" && bank.added && bank.practiceAvailable
    && Number(bank.availableEssayCount ?? 0) > 0) || dueRewrites.length > 0;
  return [
    ...(morningMinutes > 0 && hasMorning ? ["morning"] : []),
    "practice",
    ...(essayMinutes > 0 && hasEssay ? ["essay"] : []),
  ];
}

async function recordDailyCheckin(userId: string, payload: Record<string, unknown>) {
  const today = chinaDateKey();
  const requestedDate = trimmed(payload.dateKey, 10) || today;
  if (requestedDate !== today) return json({ error: "只能记录当天完成的日练", code: "CHECKIN_DATE_INVALID" }, 400);
  const db = getD1();
  const session = await db.prepare(`SELECT id FROM practice_sessions
    WHERE user_id = ? AND date_key = ? AND kind = 'daily' AND mode = 'mixed'
      AND status = 'completed' AND target_count >= 5 AND answered_count >= target_count
    ORDER BY completed_at DESC LIMIT 1`).bind(userId, today).first<{ id: string }>();
  if (!session) {
    return json({ error: "完成今日规定任务后才能打卡；未完成的训练不计入打卡", code: "DAILY_PRACTICE_INCOMPLETE" }, 409);
  }
  const requiredSteps = await requiredDailyStepNames(userId, today);
  const completedRows = await db.prepare(`SELECT step FROM daily_step_completions
    WHERE user_id = ? AND date_key = ?`).bind(userId, today).all<{ step: string }>();
  const completedSteps = new Set(["practice", ...completedRows.results.map((row) => row.step)]);
  const missingSteps = requiredSteps.filter((step) => !completedSteps.has(step));
  if (missingSteps.length) {
    return json({ error: `请先完成今日${missingSteps.map((step) => step === "morning" ? "晨读" : step === "essay" ? "申论" : "行测").join("、")}`, code: "DAILY_STEPS_INCOMPLETE", missingSteps }, 409);
  }
  await db.prepare(`INSERT OR IGNORE INTO daily_checkins
    (user_id, date_key, session_id, source, completed_at) VALUES (?, ?, ?, 'daily_practice', CURRENT_TIMESTAMP)`)
    .bind(userId, today, session.id).run();
  return json({ ok: true, dateKey: today, duplicate: false });
}

async function getPracticeSessionSummary(userId: string, payload: Record<string, unknown>) {
  const sessionId = trimmed(payload.practiceSessionId, 80);
  if (!sessionId) return json({ error: "训练记录不能为空" }, 400);
  const db = getD1();
  const session = await db.prepare("SELECT id, date_key, kind, mode FROM practice_sessions WHERE id = ? AND user_id = ?")
    .bind(sessionId, userId).first<{ id: string; date_key: string; kind: string; mode: string }>();
  if (!session) return json({ error: "未找到本次训练记录" }, 404);
  const wholeDaily = session.kind === "daily" && session.mode === "mixed";
  const attemptScope = wholeDaily
    ? `FROM (
        SELECT pa.*, ROW_NUMBER() OVER (PARTITION BY pa.question_code ORDER BY pa.id DESC) AS metric_rank
        FROM practice_attempts pa
        JOIN practice_sessions ps ON ps.id = pa.practice_session_id AND ps.user_id = pa.user_id
        WHERE pa.user_id = ? AND ps.date_key = ? AND ps.kind = 'daily' AND ps.mode = 'mixed'
          AND pa.apply_status = 'applied'
      ) scoped WHERE scoped.metric_rank = 1`
    : `FROM practice_attempts scoped
      WHERE scoped.user_id = ? AND scoped.practice_session_id = ? AND scoped.apply_status = 'applied'`;
  const scopeBindings = wholeDaily ? [userId, session.date_key] : [userId, sessionId];
  const pointAttemptScope = wholeDaily
    ? `FROM practice_attempts pa
      JOIN practice_sessions ps ON ps.id = pa.practice_session_id AND ps.user_id = pa.user_id
      LEFT JOIN questions q ON q.question_code = pa.question_code
      WHERE pa.user_id = ? AND ps.date_key = ? AND ps.kind = 'daily' AND ps.mode = 'mixed'
        AND pa.apply_status = 'applied'`
    : `FROM practice_attempts pa
      LEFT JOIN questions q ON q.question_code = pa.question_code
      WHERE pa.user_id = ? AND pa.practice_session_id = ? AND pa.apply_status = 'applied'`;
  const [stats, modules, points] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(is_correct), 0) AS correct,
      COALESCE(SUM(CASE WHEN is_correct = 0 THEN 1 ELSE 0 END), 0) AS wrong,
      COALESCE(SUM(CASE WHEN confidence = 'hesitant' AND is_correct = 1 THEN 1 ELSE 0 END), 0) AS hesitant,
      COALESCE(SUM(CASE WHEN confidence = 'guessed' THEN 1 ELSE 0 END), 0) AS guessed,
      COALESCE(SUM(overtime), 0) AS overtime,
      COALESCE(SUM(CASE WHEN was_due = 1 AND is_correct = 1 AND confidence = 'confident' THEN 1 ELSE 0 END), 0) AS repaired_due
      ${attemptScope}`)
      .bind(...scopeBindings).first<Record<string, unknown>>(),
    db.prepare(`SELECT module, COUNT(*) AS total, COALESCE(SUM(is_correct), 0) AS correct
      ${attemptScope}
      GROUP BY module ORDER BY (1.0 * COALESCE(SUM(is_correct), 0) / COUNT(*)) ASC, total DESC LIMIT 5`)
      .bind(...scopeBindings).all<{ module: string; total: number; correct: number }>(),
    db.prepare(`SELECT
        COALESCE(NULLIF(TRIM(q.sub_type), ''), NULLIF(TRIM(pa.module), '')) AS knowledge_point,
        COUNT(*) AS total,
        COALESCE(SUM(pa.is_correct), 0) AS correct,
        COALESCE(SUM(CASE WHEN pa.is_correct = 0 THEN 1 ELSE 0 END), 0) AS wrong,
        COALESCE(SUM(CASE WHEN pa.confidence IN ('hesitant', 'guessed') THEN 1 ELSE 0 END), 0) AS uncertain,
        COALESCE(SUM(CASE WHEN pa.was_due = 1 AND pa.is_correct = 1 AND pa.confidence = 'confident' THEN 1 ELSE 0 END), 0) AS repaired_due
      ${pointAttemptScope}
      AND COALESCE(NULLIF(TRIM(q.sub_type), ''), NULLIF(TRIM(pa.module), '')) IS NOT NULL
      GROUP BY knowledge_point
      ORDER BY (wrong + uncertain) DESC, total DESC LIMIT 4`)
      .bind(...scopeBindings).all<{ knowledge_point: string; total: number; correct: number; wrong: number; uncertain: number; repaired_due: number }>(),
  ]);
  return json({
    wrong: Number(stats?.wrong ?? 0),
    hesitant: Number(stats?.hesitant ?? 0),
    guessed: Number(stats?.guessed ?? 0),
    overtime: Number(stats?.overtime ?? 0),
    repairedDue: Number(stats?.repaired_due ?? 0),
    weakModules: modules.results.map((row) => ({
      module: row.module,
      total: Number(row.total),
      accuracy: Number(row.total) ? Math.round(Number(row.correct) * 100 / Number(row.total)) : 0,
    })),
    points: points.results.map((row) => ({
      point: row.knowledge_point,
      total: Number(row.total),
      correct: Number(row.correct),
      wrong: Number(row.wrong),
      uncertain: Number(row.uncertain),
      repairedDue: Number(row.repaired_due),
    })),
  });
}

async function bindInvite(userId: string, payload: Record<string, unknown>) {
  const inviteCode = String(payload.inviteCode ?? "").trim().toUpperCase();
  if (!inviteCode) return json({ error: "邀请码不能为空" }, 400);
  const db = getD1();
  const invitee = await db.prepare("SELECT verified_at FROM users WHERE id = ?").bind(userId).first<{ verified_at: string | null }>();
  if (!invitee?.verified_at) return json({ error: "请先登录并完成账号验证后再绑定邀请关系", code: "VERIFIED_ACCOUNT_REQUIRED" }, 403);
  const inviter = await db.prepare("SELECT id, verified_at FROM users WHERE invite_code = ?").bind(inviteCode)
    .first<{ id: string; verified_at: string | null }>();
  if (!inviter) return json({ error: "邀请码无效" }, 404);
  if (!inviter.verified_at) return json({ error: "该邀请码暂不可用" }, 409);
  if (inviter.id === userId) return json({ error: "不能邀请自己" }, 400);
  const existing = await db.prepare("SELECT inviter_id, status FROM invite_relations WHERE invitee_id = ?").bind(userId).first<{ inviter_id: string; status: string }>();
  if (existing) return json({ ok: true, status: existing.status, message: "已绑定邀请关系" });
  const [sameBrowserSwitch, inviterDailyBindings] = await Promise.all([
    db.prepare(`SELECT 1 AS detected WHERE EXISTS (
      SELECT 1 FROM analytics_events WHERE event_name = 'account_switch_detected' AND (
        (user_id = ? AND json_extract(event_data, '$.otherUserId') = ?)
        OR (user_id = ? AND json_extract(event_data, '$.otherUserId') = ?)
      )
    ) OR EXISTS (
      SELECT 1 FROM device_account_links invitee_device
      JOIN device_account_links inviter_device
        ON inviter_device.device_hash = invitee_device.device_hash
      WHERE invitee_device.user_id = ? AND inviter_device.user_id = ?
    ) LIMIT 1`).bind(userId, inviter.id, inviter.id, userId, userId, inviter.id).first<{ detected: number }>(),
    db.prepare(`SELECT COUNT(*) AS count FROM invite_relations
      WHERE inviter_id = ? AND datetime(bound_at) >= datetime('now', '-1 day')`)
      .bind(inviter.id).first<{ count: number }>(),
  ]);
  if (sameBrowserSwitch) {
    return json({ error: "当前邀请不符合活动规则，无法获得时长奖励", code: "INVITE_SAME_DEVICE_RISK" }, 409);
  }
  if (Number(inviterDailyBindings?.count ?? 0) >= 10) {
    return json({ error: "该邀请码今日绑定次数已达上限，请24小时后再试", code: "INVITE_RATE_RISK" }, 429);
  }
  // Friendly checks above keep normal errors clear; this INSERT is the
  // authoritative rolling-24-hour and same-browser gate. D1 serializes the
  // write, so concurrent requests cannot all observe slot 10 as available.
  const [bound] = await db.batch([
    db.prepare(`INSERT OR IGNORE INTO invite_relations
      (invitee_id, inviter_id, verified_at, risk_status)
      SELECT ?, ?, CURRENT_TIMESTAMP, 'clear'
      WHERE NOT EXISTS (
        SELECT 1 FROM analytics_events ae
        WHERE ae.event_name = 'account_switch_detected' AND (
          (ae.user_id = ? AND json_extract(ae.event_data, '$.otherUserId') = ?)
          OR (ae.user_id = ? AND json_extract(ae.event_data, '$.otherUserId') = ?)
        )
      ) AND NOT EXISTS (
        SELECT 1 FROM device_account_links invitee_device
        JOIN device_account_links inviter_device
          ON inviter_device.device_hash = invitee_device.device_hash
        WHERE invitee_device.user_id = ? AND inviter_device.user_id = ?
      ) AND (
        SELECT COUNT(*) FROM invite_relations ir
        WHERE ir.inviter_id = ? AND datetime(ir.bound_at) >= datetime('now', '-1 day')
      ) < 10`)
      .bind(userId, inviter.id, userId, inviter.id, inviter.id, userId, userId, inviter.id, inviter.id),
    db.prepare(`UPDATE users SET invited_by = ?
      WHERE id = ? AND invited_by IS NULL AND EXISTS (
        SELECT 1 FROM invite_relations WHERE invitee_id = ? AND inviter_id = ?
      )`).bind(inviter.id, userId, userId, inviter.id),
  ]);
  if (Number(bound.meta?.changes ?? 0) === 0) {
    const [current, currentRisk, currentRate] = await Promise.all([
      db.prepare("SELECT inviter_id, status FROM invite_relations WHERE invitee_id = ?").bind(userId)
        .first<{ inviter_id: string; status: string }>(),
      db.prepare(`SELECT 1 AS detected WHERE EXISTS (
        SELECT 1 FROM analytics_events WHERE event_name = 'account_switch_detected' AND (
          (user_id = ? AND json_extract(event_data, '$.otherUserId') = ?)
          OR (user_id = ? AND json_extract(event_data, '$.otherUserId') = ?)
        )
      ) OR EXISTS (
        SELECT 1 FROM device_account_links invitee_device
        JOIN device_account_links inviter_device
          ON inviter_device.device_hash = invitee_device.device_hash
        WHERE invitee_device.user_id = ? AND inviter_device.user_id = ?
      ) LIMIT 1`).bind(userId, inviter.id, inviter.id, userId, userId, inviter.id).first<{ detected: number }>(),
      db.prepare(`SELECT COUNT(*) AS count FROM invite_relations
        WHERE inviter_id = ? AND datetime(bound_at) >= datetime('now', '-1 day')`)
        .bind(inviter.id).first<{ count: number }>(),
    ]);
    if (current) return json({ ok: true, status: current.status, message: "已绑定邀请关系" });
    if (currentRisk) {
      return json({ error: "当前邀请不符合活动规则，无法获得时长奖励", code: "INVITE_SAME_DEVICE_RISK" }, 409);
    }
    if (Number(currentRate?.count ?? 0) >= 10) {
      return json({ error: "该邀请码今日绑定次数已达上限，请24小时后再试", code: "INVITE_RATE_RISK" }, 429);
    }
    return json({ error: "邀请关系绑定失败，请刷新后重试", code: "INVITE_BIND_CONFLICT" }, 409);
  }
  return json({ ok: true, status: "pending", message: "邀请关系已绑定；完成首次规定日练后，受邀人增加3天使用时长，邀请人增加7天使用时长" });
}

async function rewardInvite(inviteeId: string) {
  const db = getD1();
  const relation = await db.prepare(`SELECT ir.inviter_id, ir.status, ir.risk_status,
    invitee.verified_at AS invitee_verified, inviter.verified_at AS inviter_verified
    FROM invite_relations ir
    JOIN users invitee ON invitee.id = ir.invitee_id
    JOIN users inviter ON inviter.id = ir.inviter_id
    WHERE ir.invitee_id = ?`).bind(inviteeId).first<{
      inviter_id: string; status: string; risk_status: string; invitee_verified: string | null; inviter_verified: string | null;
    }>();
  if (!relation || relation.status !== "pending" || relation.risk_status !== "clear"
    || !relation.invitee_verified || !relation.inviter_verified) return;
  const inviterRewardDays = Math.max(0, await getConfigNumber("invite_reward_days", 7));
  const inviteeRewardDays = Math.max(0, await getConfigNumber("invitee_reward_days", 3));
  const monthlyCap = Math.max(0, await getConfigNumber("invite_monthly_cap", 30));
  const source = `invite:${inviteeId}`;
  // 风控复查、有效日练认领、双方台账和会员时长在同一 D1 事务中完成。
  // 这样即使用户先绑定、再在同一浏览器切换账号，也不能绕过奖励前风控。
  await db.batch([
    db.prepare(`UPDATE invite_relations SET risk_status = 'blocked_same_browser'
      WHERE invitee_id = ? AND status = 'pending' AND risk_status = 'clear' AND (
        EXISTS (
          SELECT 1 FROM analytics_events ae WHERE ae.event_name = 'account_switch_detected' AND (
            (ae.user_id = invite_relations.invitee_id
              AND json_extract(ae.event_data, '$.otherUserId') = invite_relations.inviter_id)
            OR (ae.user_id = invite_relations.inviter_id
              AND json_extract(ae.event_data, '$.otherUserId') = invite_relations.invitee_id)
          )
        ) OR EXISTS (
          SELECT 1 FROM device_account_links invitee_device
          JOIN device_account_links inviter_device
            ON inviter_device.device_hash = invitee_device.device_hash
          WHERE invitee_device.user_id = invite_relations.invitee_id
            AND inviter_device.user_id = invite_relations.inviter_id
        )
      )`).bind(inviteeId),
    db.prepare(`UPDATE invite_relations SET status = 'rewarded',
      first_valid_practice_at = COALESCE(first_valid_practice_at, (
        SELECT MIN(ps.completed_at) FROM practice_sessions ps
        WHERE ps.user_id = invite_relations.invitee_id AND ps.status = 'completed'
          AND ps.kind = 'daily' AND ps.mode = 'mixed' AND ps.target_count >= 5 AND ps.answered_count >= 5
          AND ps.completed_at IS NOT NULL AND datetime(ps.completed_at) >= datetime(invite_relations.bound_at)
      )),
      rewarded_at = CURRENT_TIMESTAMP, inviter_grant_id = ?, invitee_grant_id = ?
      WHERE invitee_id = ? AND status = 'pending' AND risk_status = 'clear' AND EXISTS (
        SELECT 1 FROM practice_sessions ps WHERE ps.user_id = invite_relations.invitee_id
          AND ps.status = 'completed' AND ps.kind = 'daily' AND ps.mode = 'mixed'
          AND ps.target_count >= 5 AND ps.answered_count >= 5 AND ps.completed_at IS NOT NULL
          AND datetime(ps.completed_at) >= datetime(invite_relations.bound_at)
      )`)
      .bind(`${source}:inviter`, `${source}:invitee`, inviteeId),
    db.prepare(`INSERT OR IGNORE INTO membership_ledger
      (user_id, delta_days, source_type, source_id, note)
      SELECT ?, ?, 'invitee_reward', ?, '完成首次有效日练奖励'
      WHERE ? > 0 AND EXISTS (
        SELECT 1 FROM invite_relations WHERE invitee_id = ? AND status = 'rewarded')`)
      .bind(inviteeId, inviteeRewardDays, source, inviteeRewardDays, inviteeId),
    db.prepare(`UPDATE users SET membership_type = 'duration', membership_end = datetime(
      CASE WHEN membership_end IS NOT NULL AND datetime(membership_end) > CURRENT_TIMESTAMP
        THEN membership_end ELSE CURRENT_TIMESTAMP END, ?)
      WHERE id = ? AND membership_type <> 'lifetime' AND changes() = 1`)
      .bind(`+${inviteeRewardDays} days`, inviteeId),
    db.prepare(`INSERT OR IGNORE INTO membership_ledger
      (user_id, delta_days, source_type, source_id, note)
      SELECT ?, MIN(?, MAX(0, ? - COALESCE((
        SELECT SUM(delta_days) FROM membership_ledger
        WHERE user_id = ? AND source_type = 'invite_reward'
          AND datetime(created_at) >= datetime('now', '+8 hours', 'start of month', '-8 hours')
      ), 0))), 'invite_reward', ?, '受邀好友完成首次规定日练奖励'
      WHERE MIN(?, MAX(0, ? - COALESCE((
        SELECT SUM(delta_days) FROM membership_ledger
        WHERE user_id = ? AND source_type = 'invite_reward'
          AND datetime(created_at) >= datetime('now', '+8 hours', 'start of month', '-8 hours')
      ), 0))) > 0 AND EXISTS (
        SELECT 1 FROM invite_relations WHERE invitee_id = ? AND inviter_id = ?
          AND status = 'rewarded' AND risk_status = 'clear'
      )`)
      .bind(relation.inviter_id, inviterRewardDays, monthlyCap, relation.inviter_id, source,
        inviterRewardDays, monthlyCap, relation.inviter_id, inviteeId, relation.inviter_id),
    db.prepare(`UPDATE users SET membership_type = 'duration', membership_end = datetime(
      CASE WHEN membership_end IS NOT NULL AND datetime(membership_end) > CURRENT_TIMESTAMP
        THEN membership_end ELSE CURRENT_TIMESTAMP END,
      printf('+%d days', (SELECT delta_days FROM membership_ledger
        WHERE user_id = ? AND source_type = 'invite_reward' AND source_id = ?)))
      WHERE id = ? AND membership_type <> 'lifetime' AND changes() = 1`)
      .bind(relation.inviter_id, source, relation.inviter_id),
  ]);
}

async function reconcileInviteReward(inviteeId: string) {
  const eligible = await getD1().prepare(`SELECT 1 AS eligible
    FROM invite_relations ir
    WHERE ir.invitee_id = ? AND ir.status = 'pending' AND ir.risk_status = 'clear'
      AND EXISTS (
        SELECT 1 FROM practice_sessions ps
        WHERE ps.user_id = ir.invitee_id AND ps.status = 'completed'
          AND ps.kind = 'daily' AND ps.mode = 'mixed'
          AND ps.target_count >= 5 AND ps.answered_count >= 5
          AND ps.completed_at IS NOT NULL AND datetime(ps.completed_at) >= datetime(ir.bound_at)
      ) LIMIT 1`).bind(inviteeId).first<{ eligible: number }>();
  if (!eligible) return false;
  await rewardInvite(inviteeId);
  return true;
}

async function redeem(userId: string, payload: Record<string, unknown>) {
  const code = normalizeCode(String(payload.code ?? ""));
  if (!code) return json({ error: "请输入兑换码" }, 400);
  const db = getD1();
  const codeHash = await hashCode(code);
  const row = await db.prepare(`SELECT id, code_preview, grant_type, duration_days, max_uses, used_count, status, valid_from, valid_until
    FROM redemption_codes WHERE code_hash = ?`).bind(codeHash).first<CodeRow>();
  if (!row) return json({ error: "兑换码不存在" }, 404);
  const grantType = row.grant_type === "lifetime" ? "lifetime" : "duration";
  const existing = await db.prepare("SELECT id, status FROM redemptions WHERE code_id = ? AND user_id = ?")
    .bind(row.id, userId).first<{ id: number; status: string }>();
  // A success response may have been lost after commit. Retrying that same
  // redemption remains a success even if an operator later disables the batch
  // or its validity window closes.
  if (existing?.status === "completed") {
    const membership = await userMembership(userId);
    return json({
      ok: true,
      idempotent: true,
      grantType,
      days: grantType === "lifetime" ? null : Number(row.duration_days),
      membershipType: membership?.membership_type ?? grantType,
      membershipEnd: membership?.membership_end ?? null,
    });
  }

  const now = new Date();
  if (row.status !== "active") return json({ error: "兑换码已停用" }, 400);
  if (row.valid_from && Date.parse(row.valid_from) > now.getTime()) return json({ error: "兑换码尚未生效" }, 400);
  if (row.valid_until && Date.parse(row.valid_until) < now.getTime()) return json({ error: "兑换码已过期" }, 400);
  const sourceId = `redeem:${row.id}:${userId}`;
  const configuredDays = Math.floor(Number(row.duration_days));
  if (grantType === "duration" && !new Set([7, 30, 365]).has(configuredDays)) {
    return json({ error: "兑换码权益配置异常，请联系客服处理", code: "REDEMPTION_GRANT_INVALID" }, 409);
  }
  // Claim, idempotency ledger, membership mutation, completion and capacity
  // accounting are one D1 transaction. Cleanup only targets legacy pending
  // rows that never acquired a redeem ledger and have outlived a 15-minute
  // deployment drain window; a still-running old request can never lose its
  // fresh capacity claim to a new-version request.
  const results = await db.batch([
    db.prepare(`DELETE FROM redemptions
      WHERE code_id = ? AND status = 'pending'
        AND datetime(redeemed_at) <= datetime('now', '-15 minutes') AND NOT EXISTS (
        SELECT 1 FROM membership_ledger ml
        WHERE ml.user_id = redemptions.user_id AND ml.source_type = 'redeem'
          AND ml.source_id = 'redeem:' || redemptions.code_id || ':' || redemptions.user_id
      )`).bind(row.id),
    db.prepare(`INSERT OR IGNORE INTO redemptions (code_id, user_id, status)
      SELECT c.id, ?, 'pending' FROM redemption_codes c
      WHERE c.id = ? AND c.status = 'active'
        AND (c.valid_from IS NULL OR datetime(c.valid_from) <= CURRENT_TIMESTAMP)
        AND (c.valid_until IS NULL OR datetime(c.valid_until) >= CURRENT_TIMESTAMP)
        AND (SELECT COUNT(*) FROM redemptions r WHERE r.code_id = c.id) < c.max_uses`)
      .bind(userId, row.id),
    db.prepare(`INSERT OR IGNORE INTO membership_ledger
      (user_id, delta_days, source_type, source_id, note)
      SELECT ?, ?, 'redeem', ?, ? WHERE EXISTS (
        SELECT 1 FROM redemptions WHERE code_id = ? AND user_id = ? AND status = 'pending'
      )`).bind(userId, grantType === "lifetime" ? 0 : configuredDays, sourceId,
        grantType === "lifetime" ? "兑换终身会员" : `兑换 ${configuredDays} 天会员`, row.id, userId),
    grantType === "lifetime"
      ? db.prepare("UPDATE users SET membership_type = 'lifetime', membership_end = NULL WHERE id = ? AND changes() = 1")
        .bind(userId)
      : db.prepare(`UPDATE users SET membership_type = 'duration', membership_end = datetime(
          CASE WHEN membership_end IS NOT NULL AND datetime(membership_end) > CURRENT_TIMESTAMP
            THEN membership_end ELSE CURRENT_TIMESTAMP END, ?)
          WHERE id = ? AND membership_type <> 'lifetime' AND changes() = 1`)
        .bind(`+${configuredDays} days`, userId),
    db.prepare(`UPDATE redemptions SET status = 'completed', completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP)
      WHERE code_id = ? AND user_id = ? AND status = 'pending' AND EXISTS (
        SELECT 1 FROM membership_ledger ml
        WHERE ml.user_id = ? AND ml.source_type = 'redeem' AND ml.source_id = ?
      )`).bind(row.id, userId, userId, sourceId),
    db.prepare(`UPDATE redemption_codes SET used_count = (
      SELECT COUNT(*) FROM redemptions WHERE code_id = ? AND status = 'completed'
    ) WHERE id = ?`).bind(row.id, row.id),
  ]);
  const redemption = await db.prepare("SELECT id, status FROM redemptions WHERE code_id = ? AND user_id = ?")
    .bind(row.id, userId).first<{ id: number; status: string }>();
  if (!redemption || redemption.status !== "completed") {
    const currentCode = await db.prepare(`SELECT status, valid_from, valid_until FROM redemption_codes WHERE id = ?`)
      .bind(row.id).first<{ status: string; valid_from: string | null; valid_until: string | null }>();
    const currentTime = Date.now();
    if (!currentCode || currentCode.status !== "active") return json({ error: "兑换码已停用" }, 400);
    if (currentCode.valid_from && Date.parse(currentCode.valid_from) > currentTime) return json({ error: "兑换码尚未生效" }, 400);
    if (currentCode.valid_until && Date.parse(currentCode.valid_until) < currentTime) return json({ error: "兑换码已过期" }, 400);
    return json({ error: "兑换码使用次数已达上限" }, 409);
  }
  const membership = await userMembership(userId);
  return json({
    ok: true,
    idempotent: Number(results[2]?.meta?.changes ?? 0) === 0,
    grantType,
    days: grantType === "lifetime" ? null : configuredDays,
    membershipType: membership?.membership_type ?? grantType,
    membershipEnd: membership?.membership_end ?? null,
  });
}

function commerceTestMode(request: Request) {
  const hostname = new URL(request.url).hostname.toLowerCase();
  const local = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname.endsWith(".local");
  const configured = String((env as unknown as { PAYMENT_TEST_MODE?: string }).PAYMENT_TEST_MODE ?? "").trim().toLowerCase();
  return local || configured === "1" || configured === "true" || configured === "enabled";
}

function safeReturnContext(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  return {
    reason: trimmed(source.reason, 40),
    tab: trimmed(source.tab, 20),
    bankCode: trimmed(source.bankCode, 80),
    sessionKind: trimmed(source.sessionKind, 80),
  };
}

function publicProduct(row: CommerceProductRow) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    priceCents: Number(row.price_cents),
    currency: row.currency,
    grantType: row.grant_type,
    durationDays: row.duration_days === null ? null : Number(row.duration_days),
    publicPromise: row.public_promise,
  };
}

function publicOrder(row: CommerceOrderRow) {
  let returnContext = {};
  try { returnContext = JSON.parse(row.return_context_json || "{}"); } catch { returnContext = {}; }
  return {
    id: row.id,
    orderNo: row.order_no,
    productId: row.product_id,
    productName: row.product_name,
    amountCents: Number(row.amount_cents),
    currency: row.currency,
    status: row.status,
    channel: row.channel,
    returnContext,
    paidAt: row.paid_at,
    createdAt: row.created_at,
  };
}

async function getCommerceProducts(request: Request, userId: string) {
  const [productsResult, membership] = await Promise.all([
    getD1().prepare(`SELECT id, name, description, price_cents, currency, grant_type,
      duration_days, public_promise, status FROM products
      WHERE status = 'active' ORDER BY sort_order ASC, created_at ASC`).all<CommerceProductRow>(),
    userMembership(userId),
  ]);
  const testMode = commerceTestMode(request);
  return json({
    products: productsResult.results.map(publicProduct),
    checkoutMode: testMode ? "test" : "unavailable",
    testMode,
    membershipActive: membershipIsActive(membership),
    membershipType: membership?.membership_type ?? "duration",
    notice: testMode
      ? "测试支付模式：只验证订单与权益链路，不会发生真实扣款。"
      : "当前采用公众号购买兑换码的方式开通会员；获得兑换码后可在本应用内激活。",
  });
}

async function createTestOrder(request: Request, userId: string, payload: Record<string, unknown>) {
  if (!commerceTestMode(request)) {
    return json({
      error: "当前采用兑换码激活方式，暂不支持在本页面直接付款",
      code: "PAYMENT_NOT_CONFIGURED",
      testMode: false,
    }, 503);
  }
  const productId = trimmed(payload.productId, 80);
  const idempotencyKey = trimmed(payload.idempotencyKey, 120);
  if (!/^[a-zA-Z0-9:_-]{12,120}$/.test(idempotencyKey)) return json({ error: "订单信息无效，请刷新后重试" }, 400);
  const db = getD1();
  const membership = await userMembership(userId);
  if (membership?.membership_type === "lifetime") {
    return json({ error: "当前账号已是终身会员，无需重复购买", code: "ALREADY_ENTITLED" }, 409);
  }
  const product = await db.prepare(`SELECT id, name, description, price_cents, currency, grant_type,
    duration_days, public_promise, status FROM products WHERE id = ? AND status = 'active'`)
    .bind(productId).first<CommerceProductRow>();
  if (!product) return json({ error: "商品不存在或已下架" }, 404);
  if (product.grant_type !== "lifetime" && !(product.grant_type === "duration" && Number(product.duration_days) > 0)) {
    return json({ error: "商品权益配置无效" }, 409);
  }
  const existing = await db.prepare(`SELECT id, order_no, user_id, product_id, product_name, amount_cents,
    currency, status, channel, idempotency_key, return_context_json, entitlement_grant_id, paid_at, created_at
    FROM orders WHERE user_id = ? AND idempotency_key = ?`).bind(userId, idempotencyKey).first<CommerceOrderRow>();
  if (existing) return json({ order: publicOrder(existing), testMode: true, idempotent: true });

  const orderId = `ord_${crypto.randomUUID()}`;
  const orderNo = `GK${Date.now().toString(36).toUpperCase()}${crypto.randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`;
  const returnContextJson = JSON.stringify(safeReturnContext(payload.returnContext));
  await db.prepare(`INSERT OR IGNORE INTO orders
    (id, order_no, user_id, product_id, product_name, amount_cents, currency, status, channel, idempotency_key, return_context_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'awaiting_test_payment', 'test', ?, ?)`)
    .bind(orderId, orderNo, userId, product.id, product.name, Number(product.price_cents), product.currency, idempotencyKey, returnContextJson).run();
  const order = await db.prepare(`SELECT id, order_no, user_id, product_id, product_name, amount_cents,
    currency, status, channel, idempotency_key, return_context_json, entitlement_grant_id, paid_at, created_at
    FROM orders WHERE user_id = ? AND idempotency_key = ?`).bind(userId, idempotencyKey).first<CommerceOrderRow>();
  if (!order) return json({ error: "测试订单创建失败，请重试" }, 500);
  const created = order?.id === orderId;
  if (created) {
    await db.prepare("INSERT INTO analytics_events (user_id, event_name, event_data) VALUES (?, 'test_order_created', ?)")
      .bind(userId, JSON.stringify({ orderId, productId, amountCents: Number(product.price_cents), testMode: true })).run().catch(() => undefined);
  }
  return json({
    order: order ? publicOrder(order) : null,
    product: publicProduct(product),
    testMode: true,
    idempotent: !created,
    notice: "测试订单已创建，不代表已付款，也不会发生真实扣款。",
  }, created ? 201 : 200);
}

async function completeTestPayment(request: Request, userId: string, payload: Record<string, unknown>) {
  if (!commerceTestMode(request)) {
    return json({ error: "测试支付完成接口仅在本地开发或显式 PAYMENT_TEST_MODE 环境开放", code: "TEST_PAYMENT_DISABLED" }, 403);
  }
  const orderId = trimmed(payload.orderId, 80);
  const callbackId = trimmed(payload.callbackId, 120);
  if (!/^ord_[0-9a-f-]{36}$/i.test(orderId) || !/^[a-zA-Z0-9:_-]{12,120}$/.test(callbackId)) {
    return json({ error: "测试订单或回调幂等键无效" }, 400);
  }
  const db = getD1();
  const order = await db.prepare(`SELECT o.id, o.order_no, o.user_id, o.product_id, o.product_name, o.amount_cents,
    o.currency, o.status, o.channel, o.idempotency_key, o.return_context_json, o.entitlement_grant_id, o.paid_at, o.created_at,
    p.grant_type, p.duration_days
    FROM orders o JOIN products p ON p.id = o.product_id WHERE o.id = ? AND o.user_id = ?`)
    .bind(orderId, userId).first<CommerceOrderRow & { grant_type: "duration" | "lifetime"; duration_days: number | null }>();
  if (!order) return json({ error: "测试订单不存在" }, 404);
  if (order.channel !== "test") return json({ error: "非测试订单不能使用此接口" }, 409);
  if (order.status === "paid") {
    const paidTransaction = await db.prepare(`SELECT 1 AS owned FROM payment_transactions
      WHERE order_id = ? AND provider = 'test' AND callback_id = ? AND status = 'processed'`)
      .bind(order.id, callbackId).first<{ owned: number }>();
    if (!paidTransaction) {
      return json({ error: "该测试回调未归属于当前订单", code: "PAYMENT_CALLBACK_CONFLICT" }, 409);
    }
    const membership = await userMembership(userId);
    return json({ order: publicOrder(order), membershipType: membership?.membership_type, membershipEnd: membership?.membership_end, idempotent: true, testMode: true });
  }
  if (order.status !== "awaiting_test_payment" && order.status !== "created") return json({ error: "订单当前状态不能完成测试支付" }, 409);
  const configuredDurationDays = Math.floor(Number(order.duration_days));
  if (order.grant_type === "duration" && (!Number.isFinite(configuredDurationDays) || configuredDurationDays <= 0)) {
    return json({ error: "订单对应的时长权益配置无效" }, 409);
  }
  const existingCallback = await db.prepare(`SELECT order_id FROM payment_transactions
    WHERE provider = 'test' AND callback_id = ?`).bind(callbackId).first<{ order_id: string }>();
  if (existingCallback && existingCallback.order_id !== order.id) {
    return json({ error: "该测试回调幂等键已用于其他订单", code: "PAYMENT_CALLBACK_CONFLICT" }, 409);
  }
  const durationDays = order.grant_type === "duration" ? configuredDurationDays : 0;
  const grantId = `grant_${order.id}`;
  const transactionId = `ptx_${order.id}`;
  const providerTransactionId = `test_${order.order_no}`;
  const rawPayloadJson = JSON.stringify({ explicitTest: true, callbackId, orderNo: order.order_no });
  const statements: D1PreparedStatement[] = [
    db.prepare(`INSERT OR IGNORE INTO payment_transactions
      (id, order_id, provider, provider_transaction_id, callback_id, event_type, amount_cents, currency, status, raw_payload_json)
      VALUES (?, ?, 'test', ?, ?, 'test_payment_completed', ?, ?, 'received', ?)`)
      .bind(transactionId, order.id, providerTransactionId, callbackId, Number(order.amount_cents), order.currency, rawPayloadJson),
    db.prepare(`INSERT OR IGNORE INTO entitlement_grants
      (id, user_id, product_id, order_id, grant_type, duration_days, source_type, source_id, status)
      SELECT ?, ?, ?, ?, ?, ?, 'order', ?, 'active' WHERE EXISTS (
        SELECT 1 FROM payment_transactions
        WHERE id = ? AND order_id = ? AND provider = 'test' AND callback_id = ?
      )`)
      .bind(grantId, userId, order.product_id, order.id, order.grant_type, durationDays, order.id,
        transactionId, order.id, callbackId),
  ];
  if (order.grant_type === "duration") {
    statements.push(db.prepare(`INSERT OR IGNORE INTO membership_ledger
      (user_id, delta_days, source_type, source_id, note)
      SELECT ?, ?, 'order', ?, ? WHERE EXISTS (
        SELECT 1 FROM entitlement_grants eg
        JOIN payment_transactions pt ON pt.order_id = eg.order_id
        WHERE eg.id = ? AND eg.user_id = ? AND eg.status = 'active'
          AND pt.id = ? AND pt.provider = 'test' AND pt.callback_id = ?
      )`).bind(userId, durationDays, order.id, `${order.product_name}测试订单权益`,
        grantId, userId, transactionId, callbackId));
    statements.push(db.prepare(`UPDATE users SET membership_type = 'duration', membership_end = datetime(
      CASE WHEN membership_end IS NOT NULL AND datetime(membership_end) > CURRENT_TIMESTAMP
        THEN membership_end ELSE CURRENT_TIMESTAMP END, ?)
      WHERE id = ? AND membership_type <> 'lifetime' AND changes() = 1`)
      .bind(`+${durationDays} days`, userId));
  } else {
    statements.push(db.prepare("UPDATE users SET membership_type = 'lifetime', membership_end = NULL WHERE id = ? AND changes() = 1")
      .bind(userId));
  }
  statements.push(
    db.prepare(`UPDATE orders SET status = 'paid', entitlement_grant_id = ?, paid_at = COALESCE(paid_at, CURRENT_TIMESTAMP),
      updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND user_id = ? AND status IN ('created', 'awaiting_test_payment')
        AND EXISTS (
          SELECT 1 FROM payment_transactions WHERE id = ? AND order_id = ?
            AND provider = 'test' AND callback_id = ?
        ) AND EXISTS (
          SELECT 1 FROM entitlement_grants WHERE id = ? AND user_id = ?
            AND order_id = ? AND status = 'active'
        )`)
      .bind(grantId, order.id, userId, transactionId, order.id, callbackId,
        grantId, userId, order.id),
    db.prepare(`UPDATE payment_transactions SET status = 'processed', processed_at = COALESCE(processed_at, CURRENT_TIMESTAMP)
      WHERE id = ? AND order_id = ? AND provider = 'test' AND callback_id = ?`)
      .bind(transactionId, order.id, callbackId),
  );
  const results = await db.batch(statements);
  const [callbackOwner, paidOrder, membership] = await Promise.all([
    db.prepare(`SELECT order_id FROM payment_transactions
      WHERE provider = 'test' AND callback_id = ?`).bind(callbackId).first<{ order_id: string }>(),
    db.prepare(`SELECT id, order_no, user_id, product_id, product_name, amount_cents,
      currency, status, channel, idempotency_key, return_context_json, entitlement_grant_id, paid_at, created_at
      FROM orders WHERE id = ?`).bind(order.id).first<CommerceOrderRow>(),
    userMembership(userId),
  ]);
  if (!callbackOwner || callbackOwner.order_id !== order.id) {
    return json({ error: "该测试回调未归属于当前订单", code: "PAYMENT_CALLBACK_CONFLICT" }, 409);
  }
  if (!paidOrder || paidOrder.status !== "paid" || paidOrder.entitlement_grant_id !== grantId) {
    return json({ error: "测试支付未能完成权益发放，请重试", code: "PAYMENT_ENTITLEMENT_NOT_GRANTED" }, 409);
  }
  const idempotent = Number(results[1]?.meta?.changes ?? 0) === 0;
  if (!idempotent) {
    await Promise.all([
      db.prepare("INSERT INTO analytics_events (user_id, event_name, event_data) VALUES (?, 'test_payment_completed', ?)")
        .bind(userId, JSON.stringify({ orderId: order.id, productId: order.product_id, amountCents: Number(order.amount_cents), testMode: true })).run(),
      db.prepare("INSERT INTO analytics_events (user_id, event_name, event_data) VALUES (?, 'entitlement_granted', ?)")
        .bind(userId, JSON.stringify({ orderId: order.id, grantType: order.grant_type, durationDays, source: "test_order" })).run(),
    ]).catch(() => undefined);
  }
  return json({
    order: paidOrder ? publicOrder(paidOrder) : null,
    membershipType: membership?.membership_type ?? order.grant_type,
    membershipEnd: membership?.membership_end ?? null,
    idempotent,
    testMode: true,
    notice: "测试支付已完成且权益已发放；本次操作不会产生真实扣款。",
  });
}

async function trackEvent(userId: string, payload: Record<string, unknown>) {
  const eventName = String(payload.eventName ?? "");
  if (!EVENT_NAMES.has(eventName)) return json({ error: "未知统计事件" }, 400);
  const eventData = JSON.stringify(payload.eventData ?? {});
  if (eventData.length > 2_000) return json({ error: "事件数据过大" }, 400);
  await getD1().prepare("INSERT INTO analytics_events (user_id, event_name, event_data) VALUES (?, ?, ?)").bind(userId, eventName, eventData).run();
  return json({ ok: true }, 201);
}

function parseStringArrayJson(value: unknown, fallback: string[] = []) {
  try {
    const parsed = Array.isArray(value) ? value : JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : fallback;
  } catch {
    return fallback;
  }
}

function parseNumberArray(value: unknown, fallback: number[] = []) {
  try {
    const parsed = Array.isArray(value) ? value : JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parsed.map(Number).filter((item) => Number.isInteger(item)) : fallback;
  } catch {
    return fallback;
  }
}

function parseJsonObject(value: unknown) {
  try {
    const parsed = JSON.parse(String(value ?? "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function publicQuiz(quiz: QuizTestRow, questionCount: number) {
  return {
    id: quiz.id,
    slug: quiz.slug,
    title: quiz.title,
    description: quiz.description,
    questionCount: Number(quiz.question_count || questionCount || DEFAULT_QUIZ_QUESTION_COUNT),
    availableQuestionCount: questionCount,
    shareTitle: quiz.share_title || "我测了测自己的局长思维，你也来试试？",
    disclaimer: quiz.disclaimer || "纯属趣味测试，不构成公务员录用、任职或晋升预测。",
  };
}

function quizOptionList(row: Pick<QuizQuestionRow, "options_json">) {
  const options = parseStringArrayJson(row.options_json).slice(0, 6);
  return options.length >= 2 ? options : ["认真处理", "先放一放", "假装没看见"];
}

function randomInt(max: number) {
  if (max <= 1) return 0;
  const bucket = new Uint32Array(1);
  crypto.getRandomValues(bucket);
  return bucket[0] % max;
}

function shuffledIndexes(length: number) {
  const items = Array.from({ length }, (_, index) => index);
  for (let index = items.length - 1; index > 0; index -= 1) {
    const target = randomInt(index + 1);
    [items[index], items[target]] = [items[target], items[index]];
  }
  return items;
}

function chooseQuizQuestions(rows: QuizQuestionRow[], count: number) {
  const picked: QuizQuestionRow[] = [];
  const byDifficulty = new Map<string, QuizQuestionRow[]>();
  for (const row of rows) {
    const key = String(row.difficulty || "medium").toLowerCase();
    const list = byDifficulty.get(key) ?? [];
    list.push(row);
    byDifficulty.set(key, list);
  }
  const take = (difficulty: string, amount: number) => {
    const pool = [...(byDifficulty.get(difficulty) ?? [])].sort(() => randomInt(3) - 1);
    for (const item of pool) {
      if (picked.length >= count || picked.filter((row) => row.category === item.category).length >= 2) continue;
      if (!picked.some((row) => row.question_code === item.question_code)) picked.push(item);
      if (picked.length >= amount) break;
    }
  };
  take("easy", Math.min(3, count));
  take("medium", Math.min(7, count));
  take("hard", count);
  const rest = [...rows].sort(() => randomInt(3) - 1);
  for (const item of rest) {
    if (picked.length >= count) break;
    if (!picked.some((row) => row.question_code === item.question_code)) picked.push(item);
  }
  return picked.slice(0, count);
}

function publicQuizQuestion(row: QuizQuestionRow, optionOrder: number[], selectedIndex?: number) {
  const options = quizOptionList(row);
  const order = optionOrder.length === options.length ? optionOrder : options.map((_, index) => index);
  return {
    id: row.question_code,
    stem: row.stem,
    category: row.category,
    difficulty: row.difficulty,
    options: order.map((index) => options[index] ?? ""),
    selectedIndex: Number.isInteger(selectedIndex) ? selectedIndex : null,
  };
}

async function activeQuiz(slugValue: unknown = DEFAULT_QUIZ_SLUG) {
  const slug = trimmed(slugValue, 80) || DEFAULT_QUIZ_SLUG;
  const db = getD1();
  const quiz = await db.prepare(`SELECT id, slug, title, description, question_count, status, share_title, disclaimer
    FROM quiz_tests WHERE slug = ? AND status = 'published' LIMIT 1`).bind(slug).first<QuizTestRow>()
    ?? await db.prepare(`SELECT id, slug, title, description, question_count, status, share_title, disclaimer
      FROM quiz_tests WHERE id = ? AND status = 'published' LIMIT 1`).bind(DEFAULT_QUIZ_ID).first<QuizTestRow>();
  if (!quiz) return null;
  const count = await db.prepare(`SELECT COUNT(*) AS count FROM quiz_questions
    WHERE quiz_id = ? AND status = 'published' AND review_status = 'approved'`)
    .bind(quiz.id).first<{ count: number }>();
  return { quiz, questionCount: Number(count?.count ?? 0) };
}

function publicQuizResult(level: QuizResultLevelRow | null, correctCount: number) {
  const fallback = DEFAULT_QUIZ_RESULTS.find((item) => correctCount >= item.minScore && correctCount <= item.maxScore)
    ?? DEFAULT_QUIZ_RESULTS.at(-1)!;
  return {
    key: level?.level_key ?? fallback.key,
    title: level?.title ?? fallback.title,
    theme: level?.theme ?? fallback.theme,
    badgeLabel: level?.badge_label ?? fallback.badgeLabel,
    description: level?.description ?? fallback.description,
    shareText: level?.share_text ?? fallback.shareText,
    minScore: Number(level?.min_score ?? fallback.minScore),
    maxScore: Number(level?.max_score ?? fallback.maxScore),
  };
}

async function getQuiz(userId: string, payload: Record<string, unknown>) {
  const active = await activeQuiz(payload.slug);
  if (!active) return json({ error: "趣味测试暂未发布" }, 404);
  let challenge: Record<string, unknown> | null = null;
  const challengeId = trimmed(payload.challengeId, 80);
  if (challengeId) {
    const source = await getD1().prepare(`SELECT qa.id, qa.correct_count, qa.result_key, qa.completed_at, qa.quiz_id,
      COALESCE(qrl.title, '') AS result_title, COALESCE(qrl.theme, '') AS result_theme
      FROM quiz_attempts qa
      LEFT JOIN quiz_result_levels qrl ON qrl.quiz_id = qa.quiz_id AND qrl.level_key = qa.result_key
      WHERE qa.id = ? AND qa.quiz_id = ? AND qa.status = 'completed' LIMIT 1`)
      .bind(challengeId, active.quiz.id).first<Record<string, unknown>>();
    if (source) {
      challenge = {
        attemptId: source.id,
        correctCount: Number(source.correct_count ?? 0),
        resultTitle: String(source.result_title || "好友的测试结果"),
        resultTheme: String(source.result_theme || "blue"),
        completedAt: source.completed_at,
      };
      await getD1().prepare("INSERT INTO analytics_events (user_id, event_name, event_data) VALUES (?, 'quiz_challenge_open', ?)")
        .bind(userId, JSON.stringify({ quizId: active.quiz.id, challengeId })).run().catch(() => undefined);
    }
  }
  return json({ quiz: publicQuiz(active.quiz, active.questionCount), challenge });
}

async function startQuizAttempt(userId: string, payload: Record<string, unknown>) {
  const active = await activeQuiz(payload.slug);
  if (!active) return json({ error: "趣味测试暂未发布" }, 404);
  const quiz = active.quiz;
  const count = Math.max(1, Math.min(20, Number(quiz.question_count || DEFAULT_QUIZ_QUESTION_COUNT)));
  if (active.questionCount < Math.min(count, DEFAULT_QUIZ_QUESTION_COUNT)) {
    return json({ error: "当前测试题目数量不足，请稍后再试", code: "QUIZ_NOT_READY" }, 409);
  }
  const db = getD1();
  const sourceAttemptId = trimmed(payload.challengeId, 80);
  let questionIds: string[] = [];
  let optionOrders: Record<string, number[]> = {};
  if (sourceAttemptId) {
    const source = await db.prepare(`SELECT question_ids_json, option_orders_json FROM quiz_attempts
      WHERE id = ? AND quiz_id = ? AND status = 'completed' LIMIT 1`).bind(sourceAttemptId, quiz.id).first<QuizAttemptRow>();
    if (source) {
      questionIds = parseStringArrayJson(source.question_ids_json).slice(0, count);
      optionOrders = parseJsonObject(source.option_orders_json) as Record<string, number[]>;
    }
  }
  if (!questionIds.length) {
    const rows = await db.prepare(`SELECT id, quiz_id, question_code, stem, options_json, correct_index, explanation,
      category, difficulty, weight, status, review_status, sort_order, updated_at
      FROM quiz_questions WHERE quiz_id = ? AND status = 'published' AND review_status = 'approved'
      ORDER BY sort_order, id LIMIT 300`).bind(quiz.id).all<QuizQuestionRow>();
    const picked = chooseQuizQuestions(rows.results, count);
    questionIds = picked.map((row) => row.question_code);
    optionOrders = Object.fromEntries(picked.map((row) => [row.question_code, shuffledIndexes(quizOptionList(row).length)]));
  }
  if (questionIds.length < count) return json({ error: "可用题目不足，暂时无法开始测试" }, 409);
  const placeholders = questionIds.map(() => "?").join(",");
  const questions = await db.prepare(`SELECT id, quiz_id, question_code, stem, options_json, correct_index, explanation,
    category, difficulty, weight, status, review_status, sort_order, updated_at
    FROM quiz_questions WHERE quiz_id = ? AND question_code IN (${placeholders})`)
    .bind(quiz.id, ...questionIds).all<QuizQuestionRow>();
  const byCode = new Map(questions.results.map((row) => [row.question_code, row]));
  const orderedQuestions = questionIds.map((id) => byCode.get(id)).filter((row): row is QuizQuestionRow => Boolean(row));
  if (orderedQuestions.length < count) return json({ error: "测试题目已更新，请重新开始" }, 409);
  const attemptId = `quiz_${crypto.randomUUID()}`;
  await db.prepare(`INSERT INTO quiz_attempts
    (id, user_id, quiz_id, challenge_id, source_attempt_id, question_ids_json, option_orders_json, answers_json, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, '{}', 'active')`)
    .bind(attemptId, userId, quiz.id, sourceAttemptId, sourceAttemptId, JSON.stringify(questionIds),
      JSON.stringify(optionOrders)).run();
  await db.prepare("INSERT INTO analytics_events (user_id, event_name, event_data) VALUES (?, 'quiz_start', ?)")
    .bind(userId, JSON.stringify({ quizId: quiz.id, attemptId, challengeId: sourceAttemptId || "" })).run().catch(() => undefined);
  return json({
    attempt: {
      id: attemptId,
      quiz: publicQuiz(quiz, active.questionCount),
      challengeId: sourceAttemptId || "",
      questions: orderedQuestions.map((row) => publicQuizQuestion(row, parseNumberArray(optionOrders[row.question_code]))),
      answered: {},
    },
  }, 201);
}

async function submitQuizAnswer(userId: string, payload: Record<string, unknown>) {
  const attemptId = trimmed(payload.attemptId, 80);
  const questionCode = trimmed(payload.questionId, 80);
  const selectedIndex = Math.floor(Number(payload.selectedIndex));
  if (!attemptId || !questionCode || !Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex > 5) {
    return json({ error: "测试答案参数无效" }, 400);
  }
  const db = getD1();
  const attempt = await db.prepare("SELECT * FROM quiz_attempts WHERE id = ? AND user_id = ? LIMIT 1")
    .bind(attemptId, userId).first<QuizAttemptRow>();
  if (!attempt) return json({ error: "测试记录不存在" }, 404);
  if (attempt.status === "completed") return json({ error: "本次测试已结算，不能继续改答案" }, 409);
  const questionIds = parseStringArrayJson(attempt.question_ids_json);
  if (!questionIds.includes(questionCode)) return json({ error: "题目不属于本次测试" }, 400);
  const optionOrders = parseJsonObject(attempt.option_orders_json) as Record<string, number[]>;
  const order = parseNumberArray(optionOrders[questionCode]);
  if (!order.length || selectedIndex >= order.length) return json({ error: "选项不属于本题" }, 400);
  const answers = parseJsonObject(attempt.answers_json);
  answers[questionCode] = selectedIndex;
  await db.prepare("UPDATE quiz_attempts SET answers_json = ? WHERE id = ? AND user_id = ? AND status = 'active'")
    .bind(JSON.stringify(answers), attemptId, userId).run();
  await db.prepare("INSERT INTO analytics_events (user_id, event_name, event_data) VALUES (?, 'quiz_answer', ?)")
    .bind(userId, JSON.stringify({ quizId: attempt.quiz_id, attemptId, questionId: questionCode, answeredCount: Object.keys(answers).length })).run().catch(() => undefined);
  return json({ ok: true, answeredCount: Object.keys(answers).length });
}

async function completeQuizAttempt(userId: string, payload: Record<string, unknown>) {
  const attemptId = trimmed(payload.attemptId, 80);
  if (!attemptId) return json({ error: "测试记录无效" }, 400);
  const db = getD1();
  const attempt = await db.prepare("SELECT * FROM quiz_attempts WHERE id = ? AND user_id = ? LIMIT 1")
    .bind(attemptId, userId).first<QuizAttemptRow>();
  if (!attempt) return json({ error: "测试记录不存在" }, 404);
  const questionIds = parseStringArrayJson(attempt.question_ids_json);
  const optionOrders = parseJsonObject(attempt.option_orders_json) as Record<string, number[]>;
  const answers = parseJsonObject(attempt.answers_json);
  if (questionIds.length === 0) return json({ error: "本次测试没有题目" }, 409);
  if (Object.keys(answers).length < questionIds.length) return json({ error: "请先完成全部题目" }, 409);
  const placeholders = questionIds.map(() => "?").join(",");
  const rows = await db.prepare(`SELECT id, quiz_id, question_code, stem, options_json, correct_index, explanation,
    category, difficulty, weight, status, review_status, sort_order, updated_at
    FROM quiz_questions WHERE quiz_id = ? AND question_code IN (${placeholders})`)
    .bind(attempt.quiz_id, ...questionIds).all<QuizQuestionRow>();
  const byCode = new Map(rows.results.map((row) => [row.question_code, row]));
  let correctCount = 0;
  const review = questionIds.map((questionId, index) => {
    const row = byCode.get(questionId);
    if (!row) return null;
    const options = quizOptionList(row);
    const order = parseNumberArray(optionOrders[questionId]);
    const selectedDisplayIndex = Math.floor(Number(answers[questionId]));
    const selectedOriginalIndex = order[selectedDisplayIndex] ?? -1;
    const correct = selectedOriginalIndex === Number(row.correct_index);
    if (correct) correctCount += 1;
    return {
      number: index + 1,
      id: row.question_code,
      stem: row.stem,
      selectedIndex: selectedDisplayIndex,
      selectedOption: options[selectedOriginalIndex] ?? "",
      correctIndex: order.indexOf(Number(row.correct_index)),
      correctOption: options[Number(row.correct_index)] ?? "",
      correct,
      explanation: row.explanation,
      category: row.category,
    };
  }).filter((item): item is NonNullable<typeof item> => Boolean(item));
  const level = await db.prepare(`SELECT id, quiz_id, level_key, title, min_score, max_score, theme, description,
    share_text, badge_label, sort_order, status FROM quiz_result_levels
    WHERE quiz_id = ? AND status = 'active' AND ? BETWEEN min_score AND max_score
    ORDER BY sort_order LIMIT 1`).bind(attempt.quiz_id, correctCount).first<QuizResultLevelRow>();
  const result = publicQuizResult(level, correctCount);
  if (attempt.status !== "completed") {
    await db.prepare(`UPDATE quiz_attempts SET correct_count = ?, result_key = ?, status = 'completed',
      completed_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ? AND status = 'active'`)
      .bind(correctCount, result.key, attemptId, userId).run();
  }
  const quiz = await db.prepare("SELECT id, slug, title, description, question_count, status, share_title, disclaimer FROM quiz_tests WHERE id = ?")
    .bind(attempt.quiz_id).first<QuizTestRow>();
  await db.prepare("INSERT INTO analytics_events (user_id, event_name, event_data) VALUES (?, 'quiz_complete', ?)")
    .bind(userId, JSON.stringify({ quizId: attempt.quiz_id, attemptId, correctCount, resultKey: result.key })).run().catch(() => undefined);
  const notableWrong = review.find((item) => !item.correct && item.selectedOption);
  return json({
    attemptId,
    quiz: quiz ? publicQuiz(quiz, questionIds.length) : null,
    correctCount,
    total: questionIds.length,
    scorePercent: Math.round((correctCount / Math.max(1, questionIds.length)) * 100),
    result,
    notableChoice: notableWrong ? `本次最离谱选择：${notableWrong.selectedOption}` : "本次高光：10道离谱选项，没有一个能动摇你。",
    review,
  });
}

async function recordQuizShare(userId: string, payload: Record<string, unknown>) {
  const attemptId = trimmed(payload.attemptId, 80);
  const eventName = new Set(["share_panel", "native_share", "copy_link", "poster_view"]).has(String(payload.eventName))
    ? String(payload.eventName)
    : "share_panel";
  const eventData = JSON.stringify(payload.eventData ?? {});
  const db = getD1();
  const attempt = attemptId ? await db.prepare("SELECT id, quiz_id FROM quiz_attempts WHERE id = ? LIMIT 1")
    .bind(attemptId).first<{ id: string; quiz_id: string }>() : null;
  const quizId = attempt?.quiz_id ?? DEFAULT_QUIZ_ID;
  await db.batch([
    db.prepare(`INSERT INTO quiz_share_events (user_id, quiz_id, attempt_id, challenge_id, event_name, event_data)
      VALUES (?, ?, ?, ?, ?, ?)`).bind(userId, quizId, attemptId, attemptId, eventName, eventData.length > 2000 ? "{}" : eventData),
    db.prepare("INSERT INTO analytics_events (user_id, event_name, event_data) VALUES (?, 'quiz_share', ?)")
      .bind(userId, JSON.stringify({ quizId, attemptId, eventName })),
    ...(attempt ? [db.prepare("UPDATE quiz_attempts SET share_count = share_count + 1 WHERE id = ?").bind(attemptId)] : []),
  ]);
  return json({ ok: true });
}

function normalizeQuizQuestionInput(raw: Record<string, unknown>, index = 0) {
  const code = trimmed(raw.questionCode ?? raw.code ?? raw["题目编码"], 80) || `jz-custom-${crypto.randomUUID().slice(0, 8)}`;
  const stem = trimmed(raw.stem ?? raw.question ?? raw["题干"], 500);
  const options = Array.isArray(raw.options)
    ? raw.options.map((item) => trimmed(item, 160)).filter(Boolean).slice(0, 6)
    : [
      trimmed(raw.optionA ?? raw.A ?? raw["A"], 160),
      trimmed(raw.optionB ?? raw.B ?? raw["B"], 160),
      trimmed(raw.optionC ?? raw.C ?? raw["C"], 160),
      trimmed(raw.optionD ?? raw.D ?? raw["D"], 160),
    ].filter(Boolean);
  const answerRaw = String(raw.correctAnswer ?? raw.answer ?? raw["正确答案"] ?? raw.correctIndex ?? "A").trim().toUpperCase();
  const correctIndex = /^[A-F]$/.test(answerRaw) ? answerRaw.charCodeAt(0) - 65 : Math.floor(Number(answerRaw));
  const status = String(raw.status ?? raw["状态"] ?? "draft") === "published" ? "published" : "draft";
  const reviewStatus = String(raw.reviewStatus ?? raw["审核状态"] ?? "pending_review") === "approved" ? "approved" : "pending_review";
  return {
    code,
    stem,
    options,
    correctIndex: Number.isInteger(correctIndex) && correctIndex >= 0 && correctIndex < options.length ? correctIndex : 0,
    explanation: trimmed(raw.explanation ?? raw["解析"], 800),
    category: trimmed(raw.category ?? raw["分类"], 40) || "办公室语言",
    difficulty: new Set(["easy", "medium", "hard"]).has(String(raw.difficulty ?? raw["难度"])) ? String(raw.difficulty ?? raw["难度"]) : "medium",
    weight: Math.max(1, Math.min(100, Math.floor(Number(raw.weight ?? raw["权重"] ?? 10)) || 10)),
    status,
    reviewStatus,
    sortOrder: Math.max(0, Math.floor(Number(raw.sortOrder ?? raw["排序"] ?? index * 10)) || 0),
  };
}

async function adminListQuizzes(payload: Record<string, unknown>) {
  if (!canAdmin(payload, "content.read")) return adminForbidden("content.read");
  const db = getD1();
  const quizId = trimmed(payload.quizId, 80) || DEFAULT_QUIZ_ID;
  const [tests, questions, levels, stats, shares] = await Promise.all([
    db.prepare("SELECT * FROM quiz_tests ORDER BY updated_at DESC LIMIT 20").all<Record<string, unknown>>(),
    db.prepare(`SELECT * FROM quiz_questions WHERE quiz_id = ?
      ORDER BY CASE review_status WHEN 'pending_review' THEN 0 WHEN 'rejected' THEN 1 ELSE 2 END, sort_order, id LIMIT 500`)
      .bind(quizId).all<Record<string, unknown>>(),
    db.prepare("SELECT * FROM quiz_result_levels WHERE quiz_id = ? ORDER BY min_score, sort_order").bind(quizId).all<Record<string, unknown>>(),
    db.prepare(`SELECT
      COUNT(*) AS attempts,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
      AVG(CASE WHEN status = 'completed' THEN correct_count ELSE NULL END) AS avg_score,
      SUM(CASE WHEN result_key = 'director' THEN 1 ELSE 0 END) AS director_count
      FROM quiz_attempts WHERE quiz_id = ?`).bind(quizId).first<Record<string, unknown>>(),
    db.prepare("SELECT COUNT(*) AS shares FROM quiz_share_events WHERE quiz_id = ?").bind(quizId).first<Record<string, unknown>>(),
  ]);
  return json({
    tests: tests.results,
    questions: questions.results.map((row) => ({ ...row, options: parseStringArrayJson(row.options_json) })),
    levels: levels.results,
    summary: {
      totalQuestions: questions.results.length,
      publishedQuestions: questions.results.filter((row) => row.status === "published" && row.review_status === "approved").length,
      attempts: Number(stats?.attempts ?? 0),
      completed: Number(stats?.completed ?? 0),
      avgScore: Number(stats?.avg_score ?? 0).toFixed(1),
      directorCount: Number(stats?.director_count ?? 0),
      shares: Number(shares?.shares ?? 0),
    },
  });
}

async function adminUpdateQuiz(payload: Record<string, unknown>) {
  if (!canAdmin(payload, "content.write")) return adminForbidden("content.write");
  const quizId = trimmed(payload.quizId, 80) || DEFAULT_QUIZ_ID;
  const title = trimmed(payload.title, 80);
  const description = trimmed(payload.description, 240);
  const questionCount = Math.max(5, Math.min(20, Math.floor(Number(payload.questionCount ?? DEFAULT_QUIZ_QUESTION_COUNT)) || DEFAULT_QUIZ_QUESTION_COUNT));
  const status = payload.status === "published" ? "published" : "draft";
  const shareTitle = trimmed(payload.shareTitle, 120);
  const disclaimer = trimmed(payload.disclaimer, 160);
  if (!title) return json({ error: "测试标题不能为空" }, 400);
  await getD1().prepare(`UPDATE quiz_tests SET title = ?, description = ?, question_count = ?, status = ?,
    share_title = ?, disclaimer = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .bind(title, description, questionCount, status, shareTitle, disclaimer, quizId).run();
  return json({ ok: true, id: quizId });
}

async function adminCreateQuiz(payload: Record<string, unknown>) {
  if (!canAdmin(payload, "content.write")) return adminForbidden("content.write");
  const title = trimmed(payload.title, 80);
  const slug = trimmed(payload.slug, 80).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  const questionCount = Math.max(5, Math.min(20, Math.floor(Number(payload.questionCount ?? DEFAULT_QUIZ_QUESTION_COUNT)) || DEFAULT_QUIZ_QUESTION_COUNT));
  if (!title || !slug) return json({ error: "测试标题和英文标识不能为空" }, 400);
  const quizId = `quiz-${slug}`;
  try {
    await getD1().prepare(`INSERT INTO quiz_tests
      (id, slug, title, description, question_count, status, share_title, disclaimer)
      VALUES (?, ?, ?, ?, ?, 'draft', ?, ?)`)
      .bind(
        quizId,
        slug,
        title,
        trimmed(payload.description, 240),
        questionCount,
        trimmed(payload.shareTitle, 120) || `我完成了“${title}”，你也来试试？`,
        trimmed(payload.disclaimer, 160) || "本测试仅供学习交流与娱乐，不构成招录、任职或职业判断。",
      ).run();
  } catch (error) {
    if (String(error).toLowerCase().includes("unique")) return json({ error: "这个英文标识已存在，请换一个" }, 409);
    throw error;
  }
  return json({ ok: true, id: quizId, slug });
}

async function adminUpsertQuizQuestion(payload: Record<string, unknown>) {
  if (!canAdmin(payload, "content.write")) return adminForbidden("content.write");
  const quizId = trimmed(payload.quizId, 80) || DEFAULT_QUIZ_ID;
  const question = normalizeQuizQuestionInput(payload);
  if (!question.stem || question.options.length < 2) return json({ error: "题干和至少2个选项必填" }, 400);
  await getD1().prepare(`INSERT INTO quiz_questions
    (quiz_id, question_code, stem, options_json, correct_index, explanation, category, difficulty, weight, status, review_status, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(question_code) DO UPDATE SET
      quiz_id = excluded.quiz_id, stem = excluded.stem, options_json = excluded.options_json,
      correct_index = excluded.correct_index, explanation = excluded.explanation, category = excluded.category,
      difficulty = excluded.difficulty, weight = excluded.weight, status = excluded.status,
      review_status = excluded.review_status, sort_order = excluded.sort_order, updated_at = CURRENT_TIMESTAMP`)
    .bind(quizId, question.code, question.stem, JSON.stringify(question.options), question.correctIndex,
      question.explanation, question.category, question.difficulty, question.weight, question.status,
      question.reviewStatus, question.sortOrder).run();
  return json({ ok: true, id: question.code });
}

async function adminBulkUpsertQuizQuestions(payload: Record<string, unknown>) {
  if (!canAdmin(payload, "content.write")) return adminForbidden("content.write");
  const quizId = trimmed(payload.quizId, 80) || DEFAULT_QUIZ_ID;
  const rows = Array.isArray(payload.rows) ? payload.rows.slice(0, 200) : [];
  if (!rows.length) return json({ error: "没有可导入的题目行" }, 400);
  const statements: D1PreparedStatement[] = [];
  const errors: Array<{ row: number; message: string }> = [];
  rows.forEach((raw, index) => {
    const question = normalizeQuizQuestionInput(raw && typeof raw === "object" ? raw as Record<string, unknown> : {}, index);
    if (!question.stem || question.options.length < 2) {
      errors.push({ row: index + 2, message: "题干和至少2个选项必填" });
      return;
    }
    statements.push(getD1().prepare(`INSERT INTO quiz_questions
      (quiz_id, question_code, stem, options_json, correct_index, explanation, category, difficulty, weight, status, review_status, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(question_code) DO UPDATE SET
        quiz_id = excluded.quiz_id, stem = excluded.stem, options_json = excluded.options_json,
        correct_index = excluded.correct_index, explanation = excluded.explanation, category = excluded.category,
        difficulty = excluded.difficulty, weight = excluded.weight, status = excluded.status,
        review_status = excluded.review_status, sort_order = excluded.sort_order, updated_at = CURRENT_TIMESTAMP`)
      .bind(quizId, question.code, question.stem, JSON.stringify(question.options), question.correctIndex,
        question.explanation, question.category, question.difficulty, question.weight, question.status,
        question.reviewStatus, question.sortOrder));
  });
  if (statements.length) await getD1().batch(statements);
  return json({ ok: true, importedRows: statements.length, failedRows: errors.length, errors: errors.slice(0, 20) });
}

async function adminSetQuizQuestionStatus(payload: Record<string, unknown>) {
  if (!canAdmin(payload, "content.write")) return adminForbidden("content.write");
  const questionCode = trimmed(payload.questionCode, 80);
  const status = payload.status === "published" ? "published" : payload.status === "archived" ? "archived" : "draft";
  const reviewStatus = payload.reviewStatus === "approved" ? "approved" : payload.reviewStatus === "rejected" ? "rejected" : "pending_review";
  if (!questionCode) return json({ error: "题目编码无效" }, 400);
  await getD1().prepare("UPDATE quiz_questions SET status = ?, review_status = ?, updated_at = CURRENT_TIMESTAMP WHERE question_code = ?")
    .bind(status, reviewStatus, questionCode).run();
  return json({ ok: true, id: questionCode });
}

async function adminUpsertQuizResult(payload: Record<string, unknown>) {
  if (!canAdmin(payload, "content.write")) return adminForbidden("content.write");
  const quizId = trimmed(payload.quizId, 80) || DEFAULT_QUIZ_ID;
  const levelKey = trimmed(payload.levelKey, 40);
  const title = trimmed(payload.title, 60);
  const minScore = Math.max(0, Math.min(20, Math.floor(Number(payload.minScore))));
  const maxScore = Math.max(minScore, Math.min(20, Math.floor(Number(payload.maxScore))));
  if (!levelKey || !title) return json({ error: "结果标识和标题不能为空" }, 400);
  await getD1().prepare(`INSERT INTO quiz_result_levels
    (id, quiz_id, level_key, title, min_score, max_score, theme, description, share_text, badge_label, sort_order, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(quiz_id, level_key) DO UPDATE SET title = excluded.title, min_score = excluded.min_score,
      max_score = excluded.max_score, theme = excluded.theme, description = excluded.description,
      share_text = excluded.share_text, badge_label = excluded.badge_label, sort_order = excluded.sort_order,
      status = excluded.status, updated_at = CURRENT_TIMESTAMP`)
    .bind(`${quizId}-${levelKey}`, quizId, levelKey, title, minScore, maxScore,
      trimmed(payload.theme, 24) || "blue", trimmed(payload.description, 500), trimmed(payload.shareText, 160),
      trimmed(payload.badgeLabel, 60), Math.floor(Number(payload.sortOrder ?? minScore * 10)) || 0,
      payload.status === "disabled" ? "disabled" : "active").run();
  return json({ ok: true, id: `${quizId}-${levelKey}` });
}

type EssayPaperRow = {
  id: number; bank_code: string; name: string; exam_type: string; province: string | null;
  exam_year: number | null; paper_type: string; source_url: string; resource_url: string;
  library_status: string; updated_at: string;
};

type EssayMaterialRow = {
  id: number; bank_id: number; label: string; title: string; content: string; sort_order: number; status: string;
};

type EssayLibraryQuestionRow = {
  id: number; bank_id: number; question_code: string; question_number: string; prompt: string;
  score: number | null; word_limit: number | null; sub_type: string; sort_order: number; status: string;
};

type EssayAnswerRow = {
  id: number; question_id: number; source_id: number; source_name: string; source_active: number;
  source_title: string; display_mode: string; content: string; excerpt: string; source_url: string;
  copyright_status: string; publication_status: string; sort_order: number;
  original_published_at: string | null; updated_at: string;
};

function essayPaperConditions(payload: Record<string, unknown>, publicOnly: boolean, alias = "qb") {
  const conditions = [`${alias}.library_enabled = 1`];
  const binds: unknown[] = [];
  if (publicOnly) {
    conditions.push(`${alias}.library_status = 'published'`);
    conditions.push(`${alias}.exam_year BETWEEN 2000 AND 2200`);
  }
  const examType = trimmed(payload.examType, 40);
  const region = trimmed(payload.region, 40);
  const paperType = trimmed(payload.paperType, 60);
  const examYear = Math.floor(Number(payload.examYear));
  const paperCode = trimmed(payload.paperCode, 80);
  const paperId = Math.floor(Number(payload.paperId));
  if (examType) { conditions.push(`${alias}.exam_type = ?`); binds.push(examType); }
  if (region) { conditions.push(`COALESCE(${alias}.province, '') = ?`); binds.push(region); }
  if (paperType) { conditions.push(`${alias}.paper_type = ?`); binds.push(paperType); }
  if (Number.isInteger(examYear) && examYear >= 2000 && examYear <= 2200) {
    conditions.push(`${alias}.exam_year = ?`);
    binds.push(examYear);
  }
  if (paperCode) { conditions.push(`${alias}.bank_code = ?`); binds.push(paperCode); }
  if (Number.isInteger(paperId) && paperId > 0) { conditions.push(`${alias}.id = ?`); binds.push(paperId); }
  return { sql: conditions.join(" AND "), binds };
}

async function copyrightContactEmail() {
  const row = await getD1().prepare("SELECT value FROM configs WHERE key = 'copyright_contact_email'")
    .first<{ value: string }>();
  const value = String(row?.value ?? "").trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : "";
}

async function getEssayReferenceLibrary(payload: Record<string, unknown>) {
  const db = getD1();
  const contactEmail = await copyrightContactEmail();
  if (payload.settingsOnly === true || String(payload.settingsOnly ?? "") === "true") {
    return json({ contactEmail });
  }
  const paperIdProvided = payload.paperId !== undefined && payload.paperId !== null && String(payload.paperId).trim() !== "";
  const requestedPaperId = Number(payload.paperId);
  if (paperIdProvided && (!Number.isSafeInteger(requestedPaperId) || requestedPaperId <= 0)) {
    return json({ error: "试卷编号无效", code: "INVALID_ESSAY_PAPER_ID" }, 400);
  }
  const filter = essayPaperConditions(payload, true);
  const detailRequested = paperIdProvided || Boolean(trimmed(payload.paperCode, 80));
  if (!detailRequested) {
    const requestedPageSize = Number(payload.pageSize ?? 20);
    const requestedPage = Number(payload.page ?? 1);
    const pageSize = Number.isFinite(requestedPageSize) ? Math.max(1, Math.min(50, Math.floor(requestedPageSize) || 20)) : 20;
    const page = Number.isFinite(requestedPage) ? Math.max(1, Math.floor(requestedPage) || 1) : 1;
    const offset = (page - 1) * pageSize;
    const [catalog, totalRow] = await Promise.all([
      db.prepare(`SELECT qb.id, qb.bank_code, qb.name, qb.exam_type, qb.province, qb.exam_year,
        qb.paper_type, qb.source_url, qb.resource_url, qb.updated_at,
        (SELECT COUNT(*) FROM question_bank_items qbi JOIN questions q ON q.id = qbi.question_id
          WHERE qbi.bank_id = qb.id AND q.status = 'active') AS question_count,
        (SELECT COUNT(DISTINCT a.source_id) FROM question_bank_items qbi
          JOIN essay_reference_answers a ON a.question_id = qbi.question_id
          JOIN essay_answer_sources s ON s.id = a.source_id
          WHERE qbi.bank_id = qb.id AND a.publication_status = 'published' AND s.status = 'active'
            AND (trim(a.source_url) = '' OR a.source_url LIKE 'https://%')
            AND (
              (a.display_mode = 'full' AND a.copyright_status IN ('original','authorized') AND trim(a.content) <> '')
              OR (a.display_mode = 'excerpt' AND a.copyright_status IN ('original','authorized','fair_quote')
                AND trim(a.excerpt) <> '' AND (a.copyright_status <> 'fair_quote'
                  OR (a.source_url LIKE 'https://%' AND length(trim(a.excerpt)) <= 1200)))
              OR (a.display_mode = 'link_only' AND a.copyright_status IN ('original','authorized','link_only')
                AND a.source_url LIKE 'https://%')
            )) AS source_count
        FROM question_banks qb WHERE ${filter.sql}
        ORDER BY qb.exam_year DESC, qb.id DESC LIMIT ? OFFSET ?`).bind(...filter.binds, pageSize, offset)
        .all<EssayPaperRow & { question_count: number; source_count: number }>(),
      db.prepare(`SELECT COUNT(*) AS count FROM question_banks qb WHERE ${filter.sql}`)
        .bind(...filter.binds).first<{ count: number }>(),
    ]);
    return json({
      contactEmail,
      page,
      pageSize,
      total: Number(totalRow?.count ?? 0),
      papers: catalog.results.map((row) => ({
        id: String(row.id),
        code: row.bank_code,
        title: row.name,
        examType: row.exam_type,
        region: row.province ?? "",
        examYear: Number(row.exam_year),
        paperType: row.paper_type,
        sourceUrl: validOptionalHttpsUrl(row.source_url) ? row.source_url : "",
        resourceUrl: validEssayResourceUrl(row.resource_url) ? row.resource_url : "",
        updatedAt: row.updated_at,
        questionCount: Number(row.question_count ?? 0),
        sourceCount: Number(row.source_count ?? 0),
      })),
    });
  }

  const [paperResult, materialResult, questionResult, mappingResult, answerResult] = await Promise.all([
    db.prepare(`SELECT qb.id, qb.bank_code, qb.name, qb.exam_type, qb.province, qb.exam_year,
      qb.paper_type, qb.source_url, qb.resource_url, qb.library_status, qb.updated_at
      FROM question_banks qb WHERE ${filter.sql}
      ORDER BY qb.exam_year DESC, qb.id DESC LIMIT 200`).bind(...filter.binds).all<EssayPaperRow>(),
    db.prepare(`SELECT m.id, m.bank_id, m.label, m.title, m.content, m.sort_order, m.status
      FROM essay_library_materials m JOIN question_banks qb ON qb.id = m.bank_id
      WHERE m.status = 'active' AND ${filter.sql}
      ORDER BY m.bank_id, m.sort_order, m.id`).bind(...filter.binds).all<EssayMaterialRow>(),
    db.prepare(`SELECT q.id, qbi.bank_id, q.question_code, qbi.question_number,
      COALESCE(NULLIF(q.prompt, ''), q.stem) AS prompt, qbi.score, q.word_limit, q.sub_type,
      qbi.sort_order, q.status
      FROM question_bank_items qbi
      JOIN question_banks qb ON qb.id = qbi.bank_id
      JOIN questions q ON q.id = qbi.question_id
      WHERE q.status = 'active' AND ${filter.sql}
      ORDER BY qbi.bank_id, qbi.sort_order, q.id`).bind(...filter.binds).all<EssayLibraryQuestionRow>(),
    db.prepare(`SELECT qm.question_id, qm.material_id, qm.sort_order
      FROM essay_library_question_materials qm
      JOIN essay_library_materials m ON m.id = qm.material_id AND m.status = 'active'
      JOIN question_banks qb ON qb.id = m.bank_id
      WHERE ${filter.sql}
      ORDER BY qm.question_id, qm.sort_order`).bind(...filter.binds)
      .all<{ question_id: number; material_id: number; sort_order: number }>(),
    db.prepare(`SELECT a.id, a.question_id, a.source_id, s.name AS source_name,
      CASE WHEN s.status = 'active' THEN 1 ELSE 0 END AS source_active,
      a.source_title, a.display_mode, a.content, a.excerpt, a.source_url,
      a.copyright_status, a.publication_status, a.sort_order, a.original_published_at, a.updated_at
      FROM essay_reference_answers a
      JOIN essay_answer_sources s ON s.id = a.source_id
      WHERE a.publication_status = 'published' AND s.status = 'active'
        AND EXISTS (
          SELECT 1 FROM question_bank_items qbi
          JOIN question_banks qb ON qb.id = qbi.bank_id
          WHERE qbi.question_id = a.question_id AND ${filter.sql}
        )
      ORDER BY a.question_id, a.sort_order, s.sort_order, a.id`).bind(...filter.binds).all<EssayAnswerRow>(),
  ]);

  const materialIdsByQuestion = new Map<number, number[]>();
  for (const row of mappingResult.results) {
    const current = materialIdsByQuestion.get(Number(row.question_id)) ?? [];
    current.push(Number(row.material_id));
    materialIdsByQuestion.set(Number(row.question_id), current);
  }

  const sourcesByQuestion = new Map<number, ReturnType<typeof sanitizePublicEssayAnswer>[]>();
  for (const row of answerResult.results) {
    const candidate = {
      id: row.id,
      sourceName: row.source_name,
      sourceActive: Number(row.source_active) === 1,
      displayMode: row.display_mode,
      copyrightStatus: row.copyright_status,
      publicationStatus: row.publication_status,
      content: row.content,
      excerpt: row.excerpt,
      sourceUrl: row.source_url,
      sortOrder: row.sort_order,
    };
    if (!isEssayAnswerPubliclyVisible(candidate)) continue;
    const current = sourcesByQuestion.get(Number(row.question_id)) ?? [];
    current.push(sanitizePublicEssayAnswer(candidate));
    sourcesByQuestion.set(Number(row.question_id), current);
  }

  const materialsByPaper = new Map<number, Array<Record<string, unknown>>>();
  for (const row of materialResult.results) {
    const current = materialsByPaper.get(Number(row.bank_id)) ?? [];
    current.push({ id: String(row.id), label: row.label, title: row.title, content: row.content, sortOrder: Number(row.sort_order) });
    materialsByPaper.set(Number(row.bank_id), current);
  }

  const questionsByPaper = new Map<number, Array<Record<string, unknown>>>();
  for (const row of questionResult.results) {
    const current = questionsByPaper.get(Number(row.bank_id)) ?? [];
    current.push({
      id: String(row.id),
      code: row.question_code,
      number: row.question_number || String(current.length + 1),
      prompt: row.prompt,
      ...(row.score === null ? {} : { score: Number(row.score) }),
      ...(row.word_limit === null ? {} : { wordLimit: Number(row.word_limit) }),
      questionType: row.sub_type,
      materialIds: (materialIdsByQuestion.get(Number(row.id)) ?? []).map(String),
      sources: sourcesByQuestion.get(Number(row.id)) ?? [],
    });
    questionsByPaper.set(Number(row.bank_id), current);
  }

  return json({
    contactEmail,
    papers: paperResult.results.map((row) => ({
      id: String(row.id),
      code: row.bank_code,
      title: row.name,
      examType: row.exam_type,
      region: row.province ?? "",
      examYear: Number(row.exam_year),
      paperType: row.paper_type,
      sourceUrl: validOptionalHttpsUrl(row.source_url) ? row.source_url : "",
      resourceUrl: validEssayResourceUrl(row.resource_url) ? row.resource_url : "",
      updatedAt: row.updated_at,
      materials: materialsByPaper.get(Number(row.id)) ?? [],
      questions: questionsByPaper.get(Number(row.id)) ?? [],
    })),
  });
}

async function adminGetEssayReferenceLibrary(payload: Record<string, unknown>) {
  if (!canAdmin(payload, "content.read")) return adminForbidden("content.read");
  const db = getD1();
  const [papers, materials, questions, mappings, sources, answers, contactEmail] = await Promise.all([
    db.prepare(`SELECT id, bank_code, name, exam_type, province, exam_year, paper_type, source_url,
      resource_url, library_status, updated_at FROM question_banks WHERE library_enabled = 1
      ORDER BY exam_year DESC, id DESC LIMIT 500`).all(),
    db.prepare(`SELECT id, bank_id, label, title, content, sort_order, status, updated_at
      FROM essay_library_materials ORDER BY bank_id, sort_order, id`).all(),
    db.prepare(`SELECT q.id, qbi.bank_id, q.question_code, qbi.question_number,
      COALESCE(NULLIF(q.prompt, ''), q.stem) AS prompt, qbi.score, q.word_limit, q.sub_type,
      qbi.sort_order, q.status, q.truth_verified, q.review_status, q.version, q.updated_at
      FROM question_bank_items qbi JOIN question_banks qb ON qb.id = qbi.bank_id
      JOIN questions q ON q.id = qbi.question_id WHERE qb.library_enabled = 1
      ORDER BY qbi.bank_id, qbi.sort_order, q.id`).all(),
    db.prepare(`SELECT qm.question_id, qm.material_id, qm.sort_order FROM essay_library_question_materials qm
      ORDER BY qm.question_id, qm.sort_order`).all(),
    db.prepare(`SELECT id, source_key, name, homepage_url, status, sort_order, updated_at
      FROM essay_answer_sources ORDER BY sort_order, id`).all(),
    db.prepare(`SELECT id, question_id, source_id, source_title, display_mode, content, excerpt, source_url,
      copyright_status, publication_status, sort_order, original_published_at, collected_at, published_at, updated_at
      FROM essay_reference_answers ORDER BY question_id, sort_order, id`).all(),
    copyrightContactEmail(),
  ]);
  return json({
    contactEmail,
    papers: papers.results,
    materials: materials.results,
    questions: questions.results,
    questionMaterials: mappings.results,
    sources: sources.results,
    answers: answers.results,
  });
}

function validEssayResourceUrl(value: string) {
  if (!value) return true;
  try { return new URL(value).protocol === "https:"; } catch { return false; }
}

function validOptionalHttpsUrl(value: string) {
  if (!value) return true;
  try { return new URL(value).protocol === "https:"; } catch { return false; }
}

function essaySlug(value: unknown, fallback = "") {
  const normalized = String(value ?? fallback).normalize("NFKC").trim().toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return /^[a-z0-9][a-z0-9_-]{1,79}$/.test(normalized) ? normalized : "";
}

function uniquePositiveIds(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))].slice(0, 100);
}

function positiveSafeInteger(value: unknown) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

async function requireEssayPaper(bankId: number) {
  return getD1().prepare(`SELECT id, bank_code, name, exam_type, province, exam_year, paper_type, source_url
    FROM question_banks WHERE id = ? AND library_enabled = 1`).bind(bankId).first<{
      id: number; bank_code: string; name: string; exam_type: string; province: string | null;
      exam_year: number | null; paper_type: string; source_url: string;
    }>();
}

async function adminUpsertEssayPaper(payload: Record<string, unknown>) {
  if (!canAdmin(payload, "content.write")) return adminForbidden("content.write");
  const id = positiveSafeInteger(payload.id);
  const code = essaySlug(payload.code ?? payload.bankCode);
  const title = trimmed(payload.title ?? payload.name, 160);
  const examType = trimmed(payload.examType, 40);
  const region = trimmed(payload.region ?? payload.province, 40);
  const paperType = trimmed(payload.paperType, 60);
  const sourceUrl = trimmed(payload.sourceUrl, 1000);
  const resourceUrl = trimmed(payload.resourceUrl, 1000);
  const examYear = Math.floor(Number(payload.examYear));
  if (!code || !title || !examType || !Number.isInteger(examYear) || examYear < 2000 || examYear > 2200) {
    return json({ error: "请完整填写试卷编码、标题、考试类型和年份" }, 400);
  }
  if (!validOptionalHttpsUrl(sourceUrl) || !validEssayResourceUrl(resourceUrl)) {
    return json({ error: "来源地址和资料地址必须使用公开可访问的 HTTPS 链接" }, 400);
  }
  const db = getD1();
  const collision = await db.prepare(`SELECT id, library_enabled FROM question_banks
    WHERE bank_code = ? AND id <> ? LIMIT 1`).bind(code, id > 0 ? id : 0)
    .first<{ id: number; library_enabled: number }>();
  if (collision) return json({ error: "试卷编码已被使用，请更换编码" }, 409);
  if (id > 0) {
    const updated = await db.prepare(`UPDATE question_banks SET bank_code = ?, name = ?, exam_type = ?, province = ?,
      exam_year = ?, subject = '申论', paper_type = ?, source_url = ?, resource_url = ?,
      library_status = 'draft', status = 'draft', updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND library_enabled = 1`)
      .bind(code, title, examType, region || null, examYear, paperType, sourceUrl, resourceUrl, id).run();
    if (!updated.meta.changes) return json({ error: "申论资料库试卷不存在" }, 404);
    return json({ ok: true, id, code });
  }
  await db.prepare(`INSERT INTO question_banks
    (bank_code, name, exam_type, province, exam_year, subject, description, cover_color,
      paper_type, source_url, resource_url, library_enabled, library_status, status)
    VALUES (?, ?, ?, ?, ?, '申论', '', 'blue', ?, ?, ?, 1, 'draft', 'draft')`)
    .bind(code, title, examType, region || null, examYear, paperType, sourceUrl, resourceUrl).run();
  const created = await db.prepare("SELECT id FROM question_banks WHERE bank_code = ?")
    .bind(code).first<{ id: number }>();
  return json({ ok: true, id: Number(created?.id), code }, 201);
}

async function adminSetEssayPaperStatus(payload: Record<string, unknown>) {
  if (!canAdmin(payload, "content.publish")) return adminForbidden("content.publish");
  const id = positiveSafeInteger(payload.id ?? payload.paperId);
  const status = String(payload.status ?? "");
  if (!(id > 0) || !["draft", "published", "archived"].includes(status)) {
    return json({ error: "试卷状态无效" }, 400);
  }
  if (status === "published") {
    const db = getD1();
    const [readiness, questions, answers, contactEmail] = await Promise.all([
      db.prepare(`SELECT
        (SELECT COUNT(*) FROM question_bank_items qbi JOIN questions q ON q.id = qbi.question_id
          WHERE qbi.bank_id = ? AND q.status = 'active') AS question_count,
        (SELECT COUNT(*) FROM essay_library_materials WHERE bank_id = ? AND status = 'active') AS material_count,
        (SELECT exam_year FROM question_banks WHERE id = ? AND library_enabled = 1) AS exam_year`)
        .bind(id, id, id).first<{ question_count: number; material_count: number; exam_year: number | null }>(),
      db.prepare(`SELECT q.id, qbi.question_number, q.truth_verified, q.review_status,
        (SELECT COUNT(*) FROM question_bank_items other_qbi JOIN question_banks other_qb ON other_qb.id = other_qbi.bank_id
          WHERE other_qbi.question_id = q.id AND other_qb.library_enabled = 1) AS library_link_count
        FROM question_bank_items qbi
        JOIN questions q ON q.id = qbi.question_id WHERE qbi.bank_id = ? AND q.status = 'active'
        ORDER BY qbi.sort_order, q.id`).bind(id).all<{
          id: number; question_number: string; truth_verified: number; review_status: string; library_link_count: number;
        }>(),
      db.prepare(`SELECT a.question_id, a.id, s.name AS source_name,
        CASE WHEN s.status = 'active' THEN 1 ELSE 0 END AS source_active,
        a.display_mode, a.content, a.excerpt, a.source_url, a.copyright_status, a.publication_status, a.sort_order
        FROM question_bank_items qbi JOIN essay_reference_answers a ON a.question_id = qbi.question_id
        JOIN essay_answer_sources s ON s.id = a.source_id WHERE qbi.bank_id = ?`).bind(id).all<EssayAnswerRow>(),
      copyrightContactEmail(),
    ]);
    if (Number(readiness?.question_count ?? 0) < 1 || Number(readiness?.material_count ?? 0) < 1) {
      return json({ error: "发布前至少需要配置一则材料和一道题目", code: "ESSAY_PAPER_INCOMPLETE" }, 409);
    }
    if (!Number.isInteger(Number(readiness?.exam_year)) || Number(readiness?.exam_year) < 2000 || Number(readiness?.exam_year) > 2200) {
      return json({ error: "发布前必须配置有效考试年份", code: "ESSAY_PAPER_YEAR_INVALID" }, 409);
    }
    if (!contactEmail) {
      return json({ error: "发布前请先配置版权联系邮箱", code: "COPYRIGHT_CONTACT_REQUIRED" }, 409);
    }
    const unverifiedQuestions = questions.results
      .filter((row) => Number(row.truth_verified) !== 1 || row.review_status !== "approved")
      .map((row, index) => row.question_number || String(index + 1));
    if (unverifiedQuestions.length) {
      return json({
        error: `还有 ${unverifiedQuestions.length} 道题未完成真题审核`,
        code: "ESSAY_QUESTIONS_NOT_VERIFIED",
        unverifiedQuestions,
      }, 409);
    }
    const reusedQuestions = questions.results
      .filter((row) => Number(row.library_link_count) !== 1)
      .map((row, index) => row.question_number || String(index + 1));
    if (reusedQuestions.length) {
      return json({
        error: "资料库题目不能跨试卷复用，请拆分为独立题目",
        code: "ESSAY_QUESTION_CROSS_PAPER_REUSE",
        reusedQuestions,
      }, 409);
    }
    const answerReadyQuestionIds = new Set(answers.results.filter((row) => isEssayAnswerPubliclyVisible({
      id: row.id,
      sourceName: row.source_name,
      sourceActive: Number(row.source_active) === 1,
      displayMode: row.display_mode,
      copyrightStatus: row.copyright_status,
      publicationStatus: row.publication_status,
      content: row.content,
      excerpt: row.excerpt,
      sourceUrl: row.source_url,
      sortOrder: row.sort_order,
    })).map((row) => Number(row.question_id)));
    const missingQuestions = questions.results
      .filter((row) => !answerReadyQuestionIds.has(Number(row.id)))
      .map((row, index) => row.question_number || String(index + 1));
    if (missingQuestions.length) {
      return json({
        error: `还有 ${missingQuestions.length} 道题没有可公开的参考答案`,
        code: "ESSAY_PAPER_ANSWER_GAP",
        missingQuestions,
      }, 409);
    }
  }
  const updated = await getD1().prepare(`UPDATE question_banks SET library_status = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND library_enabled = 1`).bind(status, id).run();
  if (!updated.meta.changes) return json({ error: "申论资料库试卷不存在" }, 404);
  return json({ ok: true, id, status });
}

async function adminUpsertEssayMaterial(payload: Record<string, unknown>) {
  if (!canAdmin(payload, "content.write")) return adminForbidden("content.write");
  const id = positiveSafeInteger(payload.id);
  const bankId = positiveSafeInteger(payload.paperId ?? payload.bankId);
  const label = trimmed(payload.label, 40);
  const title = trimmed(payload.title, 160);
  const content = trimmed(payload.content, 100_000);
  const sortOrder = Math.max(0, Math.min(100_000, Math.floor(Number(payload.sortOrder ?? 0)) || 0));
  if (!(bankId > 0) || !label || !content) return json({ error: "请选择试卷并填写材料编号和正文" }, 400);
  if (!(await requireEssayPaper(bankId))) return json({ error: "申论资料库试卷不存在" }, 404);
  const db = getD1();
  if (id > 0) {
    const updated = await db.prepare(`UPDATE essay_library_materials SET label = ?, title = ?, content = ?,
      sort_order = ?, status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND bank_id = ?`)
      .bind(label, title, content, sortOrder, id, bankId).run();
    if (!updated.meta.changes) return json({ error: "材料不存在" }, 404);
    await db.prepare(`UPDATE question_banks SET library_status = 'draft', updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND library_enabled = 1`).bind(bankId).run();
    return json({ ok: true, id });
  }
  const duplicate = await db.prepare("SELECT id FROM essay_library_materials WHERE bank_id = ? AND label = ?")
    .bind(bankId, label).first<{ id: number }>();
  if (duplicate) return json({ error: "该试卷已存在相同材料编号" }, 409);
  await db.prepare(`INSERT INTO essay_library_materials (bank_id, label, title, content, sort_order, status)
    VALUES (?, ?, ?, ?, ?, 'active')`).bind(bankId, label, title, content, sortOrder).run();
  const created = await db.prepare("SELECT id FROM essay_library_materials WHERE bank_id = ? AND label = ?")
    .bind(bankId, label).first<{ id: number }>();
  await db.prepare(`UPDATE question_banks SET library_status = 'draft', updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND library_enabled = 1`).bind(bankId).run();
  return json({ ok: true, id: Number(created?.id) }, 201);
}

async function adminDeleteEssayMaterial(payload: Record<string, unknown>) {
  if (!canAdmin(payload, "content.write")) return adminForbidden("content.write");
  const id = positiveSafeInteger(payload.id);
  if (!(id > 0)) return json({ error: "材料编号无效" }, 400);
  const db = getD1();
  const material = await db.prepare("SELECT id, bank_id FROM essay_library_materials WHERE id = ?")
    .bind(id).first<{ id: number; bank_id: number }>();
  if (!material) return json({ error: "材料不存在" }, 404);
  const updated = await db.prepare(`UPDATE essay_library_materials SET status = 'disabled',
    updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status <> 'disabled'`).bind(id).run();
  if (!updated.meta.changes) return json({ error: "材料不存在或已停用" }, 404);
  await db.prepare(`UPDATE question_banks SET library_status = 'draft', updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND library_enabled = 1`).bind(material.bank_id).run();
  return json({ ok: true, id, status: "disabled" });
}

async function adminUpsertEssayLibraryQuestion(payload: Record<string, unknown>) {
  if (!canAdmin(payload, "content.write")) return adminForbidden("content.write");
  const bankId = positiveSafeInteger(payload.paperId ?? payload.bankId);
  const requestedId = positiveSafeInteger(payload.id ?? payload.questionId);
  const number = trimmed(payload.number ?? payload.questionNumber, 24);
  const prompt = trimmed(payload.prompt, 30_000);
  const questionType = trimmed(payload.questionType, 80);
  const scoreNumber = Number(payload.score);
  const score = Number.isFinite(scoreNumber) ? Math.max(0, Math.min(200, Math.floor(scoreNumber))) : null;
  const wordLimitNumber = Number(payload.wordLimit);
  const wordLimit = Number.isFinite(wordLimitNumber) && wordLimitNumber > 0 ? Math.min(20_000, Math.floor(wordLimitNumber)) : null;
  const sortOrder = Math.max(0, Math.min(100_000, Math.floor(Number(payload.sortOrder ?? 0)) || 0));
  const materialIds = uniquePositiveIds(payload.materialIds);
  const paper = await requireEssayPaper(bankId);
  if (!paper) return json({ error: "申论资料库试卷不存在" }, 404);
  const questionCode = essaySlug(payload.code ?? payload.questionCode,
    `${paper.bank_code}-${number || sortOrder || "q"}`);
  if (!questionCode || !number || !prompt) return json({ error: "题目编码、题号和题干不能为空" }, 400);
  const db = getD1();
  if (materialIds.length) {
    const placeholders = materialIds.map(() => "?").join(",");
    const valid = await db.prepare(`SELECT COUNT(*) AS count FROM essay_library_materials
      WHERE bank_id = ? AND status = 'active' AND id IN (${placeholders})`).bind(bankId, ...materialIds)
      .first<{ count: number }>();
    if (Number(valid?.count ?? 0) !== materialIds.length) return json({ error: "题目关联了不属于本试卷的材料" }, 400);
  }
  let questionId = requestedId;
  if (questionId > 0) {
    const linked = await db.prepare(`SELECT q.id,
      (SELECT COUNT(*) FROM question_bank_items all_qbi JOIN question_banks all_qb ON all_qb.id = all_qbi.bank_id
        WHERE all_qbi.question_id = q.id AND all_qb.library_enabled = 1) AS library_link_count
      FROM questions q JOIN question_bank_items qbi ON qbi.question_id = q.id
      WHERE q.id = ? AND qbi.bank_id = ?`).bind(questionId, bankId)
      .first<{ id: number; library_link_count: number }>();
    if (!linked) return json({ error: "题目不存在或不属于该试卷" }, 404);
    if (Number(linked.library_link_count) !== 1) {
      return json({ error: "资料库题目不能跨试卷复用，请先拆分为独立题目", code: "ESSAY_QUESTION_CROSS_PAPER_REUSE" }, 409);
    }
    const codeCollision = await db.prepare("SELECT id FROM questions WHERE question_code = ? AND id <> ?")
      .bind(questionCode, questionId).first<{ id: number }>();
    if (codeCollision) return json({ error: "题目编码已被使用" }, 409);
    await db.prepare(`UPDATE questions SET question_code = ?, subject = '申论', module = '真题资料库',
      sub_type = ?, stem = ?, prompt = ?, word_limit = ?, source_exam_type = ?, source_region = ?,
      source_year = ?, source_batch = ?, source = ?, truth_verified = 0, truth_verified_at = NULL,
      review_status = 'pending_review', reviewed_by = NULL, reviewed_at = NULL,
      review_note = '', status = 'active', version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bind(questionCode, questionType, prompt, prompt, wordLimit, paper.exam_type, paper.province ?? "",
        paper.exam_year, paper.paper_type, paper.name, questionId).run();
  } else {
    const existing = await db.prepare("SELECT id FROM questions WHERE question_code = ?")
      .bind(questionCode).first<{ id: number }>();
    if (existing) return json({ error: "题目编码已被使用；资料库题目不能跨试卷复用" }, 409);
    else {
      await db.prepare(`INSERT INTO questions
        (question_code, subject, module, sub_type, stem, prompt, word_limit, source, source_exam_type,
          source_region, source_year, source_batch, truth_verified, review_status, status)
        VALUES (?, '申论', '真题资料库', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'pending_review', 'active')`)
        .bind(questionCode, questionType, prompt, prompt, wordLimit, paper.name, paper.exam_type, paper.province ?? "",
          paper.exam_year, paper.paper_type).run();
      const created = await db.prepare("SELECT id FROM questions WHERE question_code = ?")
        .bind(questionCode).first<{ id: number }>();
      questionId = Number(created?.id);
    }
  }
  if (!(questionId > 0)) return json({ error: "题目保存失败" }, 500);
  await db.batch([
    db.prepare(`INSERT INTO question_bank_items (bank_id, question_id, question_number, score, sort_order)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(bank_id, question_id) DO UPDATE SET question_number = excluded.question_number,
        score = excluded.score, sort_order = excluded.sort_order`).bind(bankId, questionId, number, score, sortOrder),
    db.prepare("DELETE FROM essay_library_question_materials WHERE question_id = ?").bind(questionId),
    ...materialIds.map((materialId, index) => db.prepare(`INSERT INTO essay_library_question_materials
      (question_id, material_id, sort_order) VALUES (?, ?, ?)`)
      .bind(questionId, materialId, index)),
    db.prepare(`UPDATE question_banks SET library_status = 'draft', updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND library_enabled = 1`).bind(bankId),
  ]);
  return json({ ok: true, id: questionId, code: questionCode });
}

async function adminReviewEssayLibraryQuestion(payload: Record<string, unknown>) {
  if (!canAdmin(payload, "question.review")) return adminForbidden("question.review");
  const admin = adminFromPayload(payload);
  if (!admin || admin.role === "question_editor") return adminForbidden("question.review");
  const id = positiveSafeInteger(payload.id ?? payload.questionId);
  const expectedVersion = positiveSafeInteger(payload.expectedVersion);
  const decision = payload.decision === "approve" ? "approve" : payload.decision === "reject" ? "reject" : "";
  const reviewNote = trimmed(payload.reviewNote, 1_000);
  if (!id || !expectedVersion || !decision) return json({ error: "题目、版本或审核决定无效" }, 400);
  if (decision === "reject" && !reviewNote) return json({ error: "驳回时必须填写原因" }, 400);

  const db = getD1();
  const question = await db.prepare(`SELECT q.id, q.question_code, q.status, q.review_status, q.version,
    COALESCE(NULLIF(q.prompt, ''), q.stem) AS prompt, qb.id AS bank_id, qb.name AS paper_name,
    qb.exam_year, qb.source_url,
    (SELECT COUNT(*) FROM question_bank_items all_qbi
      JOIN question_banks all_qb ON all_qb.id = all_qbi.bank_id
      WHERE all_qbi.question_id = q.id AND all_qb.library_enabled = 1) AS library_link_count
    FROM questions q
    JOIN question_bank_items qbi ON qbi.question_id = q.id
    JOIN question_banks qb ON qb.id = qbi.bank_id AND qb.library_enabled = 1
    WHERE q.id = ? LIMIT 1`).bind(id).first<{
      id: number; question_code: string; status: string; review_status: string; version: number;
      prompt: string; bank_id: number; paper_name: string; exam_year: number | null; source_url: string;
      library_link_count: number;
    }>();
  if (!question) return json({ error: "申论资料库题目不存在" }, 404);
  if (Number(question.version) !== expectedVersion || question.review_status !== "pending_review") {
    return json({ error: "题目已被编辑或审核，请刷新后重试", code: "QUESTION_REVIEW_VERSION_MISMATCH",
      currentVersion: Number(question.version) }, 409);
  }
  if (Number(question.library_link_count) !== 1) {
    return json({ error: "资料库题目不能跨试卷复用，请先拆分为独立题目", code: "ESSAY_QUESTION_CROSS_PAPER_REUSE" }, 409);
  }
  if (decision === "approve") {
    if (question.status !== "active" || !trimmed(question.prompt, 30_000)) {
      return json({ error: "题干为空或题目已停用，不能通过审核" }, 409);
    }
    if (!Number.isInteger(Number(question.exam_year)) || Number(question.exam_year) < 2000 || Number(question.exam_year) > 2200) {
      return json({ error: "试卷年份无效，不能通过真题审核" }, 409);
    }
    if (!question.source_url || !validOptionalHttpsUrl(question.source_url)) {
      return json({ error: "请先为试卷配置可追溯的 HTTPS 来源链接，再通过真题审核" }, 409);
    }
  }

  const reviewStatus = decision === "approve" ? "approved" : "rejected";
  const nextVersion = expectedVersion + 1;
  const results = await db.batch([
    db.prepare(`UPDATE questions SET source = ?, truth_verified = ?,
      truth_verified_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE NULL END,
      review_status = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP, review_note = ?,
      version = version + 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND version = ? AND review_status = 'pending_review' AND status = 'active'`)
      .bind(question.paper_name, decision === "approve" ? 1 : 0, decision === "approve" ? 1 : 0,
        reviewStatus, admin.id, reviewNote, id, expectedVersion),
    draftEssayLibraryPapersForQuestion(db, { questionId: id, version: nextVersion, reviewStatus }),
  ]);
  if (!results[0]?.meta.changes) {
    return json({ error: "题目已被编辑或审核，请刷新后重试", code: "QUESTION_REVIEW_VERSION_MISMATCH" }, 409);
  }
  return json({ ok: true, id, paperId: Number(question.bank_id), version: nextVersion,
    reviewStatus, truthVerified: decision === "approve" });
}

async function adminUpsertEssayAnswerSource(payload: Record<string, unknown>) {
  if (!canAdmin(payload, "content.write")) return adminForbidden("content.write");
  const id = positiveSafeInteger(payload.id);
  const sourceKey = essaySlug(payload.sourceKey ?? payload.key);
  const name = trimmed(payload.name, 100);
  const homepageUrl = trimmed(payload.homepageUrl, 1000);
  const sortOrder = Math.max(0, Math.min(100_000, Math.floor(Number(payload.sortOrder ?? 0)) || 0));
  if (!sourceKey || !name || !validOptionalHttpsUrl(homepageUrl)) return json({ error: "请填写有效的来源标识、名称和 HTTPS 主页" }, 400);
  const status = payload.status === "disabled" ? "disabled" : "active";
  const db = getD1();
  const collision = await db.prepare("SELECT id FROM essay_answer_sources WHERE source_key = ? AND id <> ?")
    .bind(sourceKey, id > 0 ? id : 0).first<{ id: number }>();
  if (collision) return json({ error: "来源标识已存在" }, 409);
  if (id > 0) {
    const updated = await db.prepare(`UPDATE essay_answer_sources SET source_key = ?, name = ?, homepage_url = ?,
      status = ?, sort_order = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bind(sourceKey, name, homepageUrl, status, sortOrder, id).run();
    if (!updated.meta.changes) return json({ error: "答案来源不存在" }, 404);
    await db.prepare(`UPDATE question_banks SET library_status = 'draft', updated_at = CURRENT_TIMESTAMP
      WHERE library_enabled = 1 AND EXISTS (
        SELECT 1 FROM question_bank_items qbi JOIN essay_reference_answers a ON a.question_id = qbi.question_id
        WHERE qbi.bank_id = question_banks.id AND a.source_id = ?
      )`).bind(id).run();
    return json({ ok: true, id });
  }
  await db.prepare(`INSERT INTO essay_answer_sources (source_key, name, homepage_url, status, sort_order)
    VALUES (?, ?, ?, ?, ?)`).bind(sourceKey, name, homepageUrl, status, sortOrder).run();
  const created = await db.prepare("SELECT id FROM essay_answer_sources WHERE source_key = ?")
    .bind(sourceKey).first<{ id: number }>();
  return json({ ok: true, id: Number(created?.id) }, 201);
}

async function adminSetEssayAnswerSourceStatus(payload: Record<string, unknown>) {
  if (!canAdmin(payload, "content.write")) return adminForbidden("content.write");
  const id = positiveSafeInteger(payload.id ?? payload.sourceId);
  const status = payload.status === "active" ? "active" : payload.status === "disabled" ? "disabled" : "";
  if (!(id > 0) || !status) return json({ error: "来源状态无效" }, 400);
  const updated = await getD1().prepare("UPDATE essay_answer_sources SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(status, id).run();
  if (!updated.meta.changes) return json({ error: "答案来源不存在" }, 404);
  await getD1().prepare(`UPDATE question_banks SET library_status = 'draft', updated_at = CURRENT_TIMESTAMP
    WHERE library_enabled = 1 AND EXISTS (
      SELECT 1 FROM question_bank_items qbi JOIN essay_reference_answers a ON a.question_id = qbi.question_id
      WHERE qbi.bank_id = question_banks.id AND a.source_id = ?
    )`).bind(id).run();
  return json({ ok: true, id, status });
}

async function readEssayAnswerForPublication(id: number) {
  return getD1().prepare(`SELECT a.id, a.display_mode, a.content, a.excerpt, a.source_url,
    a.copyright_status, a.publication_status, s.status AS source_status
    FROM essay_reference_answers a JOIN essay_answer_sources s ON s.id = a.source_id WHERE a.id = ?`)
    .bind(id).first<{
      id: number; display_mode: string; content: string; excerpt: string; source_url: string;
      copyright_status: string; publication_status: string; source_status: string;
    }>();
}

function essayPublicationErrors(row: {
  display_mode: string; content: string; excerpt: string; source_url: string;
  copyright_status: string; source_status: string;
}) {
  const errors = validateEssayAnswerPublication({
    displayMode: row.display_mode,
    copyrightStatus: row.copyright_status,
    content: row.content,
    excerpt: row.excerpt,
    sourceUrl: row.source_url,
  });
  if (row.source_status !== "active") errors.push("SOURCE_DISABLED");
  return [...new Set(errors)];
}

async function adminUpsertEssayReferenceAnswer(payload: Record<string, unknown>) {
  if (!canAdmin(payload, "content.write")) return adminForbidden("content.write");
  const admin = adminFromPayload(payload);
  if (!admin) return adminForbidden("content.write");
  const id = positiveSafeInteger(payload.id);
  const questionId = positiveSafeInteger(payload.questionId);
  const sourceId = positiveSafeInteger(payload.sourceId);
  const sourceTitle = trimmed(payload.sourceTitle, 300);
  const displayMode = String(payload.displayMode ?? "");
  const content = trimmed(payload.content, 100_000);
  const excerpt = trimmed(payload.excerpt, 8_000);
  const sourceUrl = trimmed(payload.sourceUrl, 1000);
  const copyrightStatus = String(payload.copyrightStatus ?? "pending_verification");
  const publicationStatus = ["draft", "published", "archived"].includes(String(payload.publicationStatus))
    ? String(payload.publicationStatus) : "draft";
  const sortOrder = Math.max(0, Math.min(100_000, Math.floor(Number(payload.sortOrder ?? 0)) || 0));
  const originalPublishedAt = trimmed(payload.originalPublishedAt, 40) || null;
  if (!(questionId > 0) || !(sourceId > 0)
    || !["full", "excerpt", "link_only"].includes(displayMode)
    || !["original", "authorized", "fair_quote", "link_only", "pending_verification"].includes(copyrightStatus)) {
    return json({ error: "答案关联或版权配置无效" }, 400);
  }
  if (publicationStatus === "published" && !hasAdminPermission(admin, "content.publish")) {
    return adminForbidden("content.publish");
  }
  const db = getD1();
  const source = await db.prepare("SELECT id, status FROM essay_answer_sources WHERE id = ?")
    .bind(sourceId).first<{ id: number; status: string }>();
  const question = await db.prepare(`SELECT q.id FROM questions q WHERE q.id = ? AND EXISTS (
    SELECT 1 FROM question_bank_items qbi JOIN question_banks qb ON qb.id = qbi.bank_id
    WHERE qbi.question_id = q.id AND qb.library_enabled = 1)`)
    .bind(questionId).first<{ id: number }>();
  if (!source || !question) return json({ error: "题目或答案来源不存在" }, 404);
  if (publicationStatus === "published") {
    const errors = essayPublicationErrors({
      display_mode: displayMode, content, excerpt, source_url: sourceUrl,
      copyright_status: copyrightStatus, source_status: source.status,
    });
    if (errors.length) return json({ error: "答案未通过版权发布门禁", code: "ESSAY_ANSWER_NOT_PUBLISHABLE", reasons: errors }, 409);
  }
  if (id > 0) {
    const previous = await db.prepare("SELECT question_id FROM essay_reference_answers WHERE id = ?")
      .bind(id).first<{ question_id: number }>();
    if (!previous) return json({ error: "参考答案不存在" }, 404);
    const updated = await db.prepare(`UPDATE essay_reference_answers SET question_id = ?, source_id = ?, source_title = ?,
      display_mode = ?, content = ?, excerpt = ?, source_url = ?, copyright_status = ?, publication_status = ?,
      sort_order = ?, original_published_at = ?, updated_by = ?,
      published_at = CASE WHEN ? = 'published' THEN COALESCE(published_at, CURRENT_TIMESTAMP) ELSE published_at END,
      updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bind(questionId, sourceId, sourceTitle, displayMode, content, excerpt, sourceUrl, copyrightStatus,
        publicationStatus, sortOrder, originalPublishedAt, admin.id, publicationStatus, id).run();
    if (!updated.meta.changes) return json({ error: "参考答案不存在" }, 404);
    for (const affectedQuestionId of new Set([Number(previous.question_id), questionId])) {
      await db.prepare(`UPDATE question_banks SET library_status = 'draft', updated_at = CURRENT_TIMESTAMP
        WHERE library_enabled = 1 AND EXISTS (
          SELECT 1 FROM question_bank_items qbi
          WHERE qbi.bank_id = question_banks.id AND qbi.question_id = ?
        )`).bind(affectedQuestionId).run();
    }
    return json({ ok: true, id, publicationStatus });
  }
  const duplicate = await db.prepare("SELECT id FROM essay_reference_answers WHERE question_id = ? AND source_id = ?")
    .bind(questionId, sourceId).first<{ id: number }>();
  if (duplicate) return json({ error: "该题已收录此来源答案，请编辑已有记录" }, 409);
  await db.prepare(`INSERT INTO essay_reference_answers
    (question_id, source_id, source_title, display_mode, content, excerpt, source_url, copyright_status,
      publication_status, sort_order, original_published_at, created_by, updated_by, published_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 'published' THEN CURRENT_TIMESTAMP ELSE NULL END)`)
    .bind(questionId, sourceId, sourceTitle, displayMode, content, excerpt, sourceUrl, copyrightStatus,
      publicationStatus, sortOrder, originalPublishedAt, admin.id, admin.id, publicationStatus).run();
  const created = await db.prepare("SELECT id FROM essay_reference_answers WHERE question_id = ? AND source_id = ?")
    .bind(questionId, sourceId).first<{ id: number }>();
  await db.prepare(`UPDATE question_banks SET library_status = 'draft', updated_at = CURRENT_TIMESTAMP
    WHERE library_enabled = 1 AND EXISTS (
      SELECT 1 FROM question_bank_items qbi
      WHERE qbi.bank_id = question_banks.id AND qbi.question_id = ?
    )`).bind(questionId).run();
  return json({ ok: true, id: Number(created?.id), publicationStatus }, 201);
}

async function adminSetEssayReferenceAnswerStatus(payload: Record<string, unknown>) {
  if (!canAdmin(payload, "content.publish")) return adminForbidden("content.publish");
  const id = positiveSafeInteger(payload.id);
  const status = String(payload.status ?? payload.publicationStatus ?? "");
  if (!(id > 0) || !["draft", "published", "archived"].includes(status)) return json({ error: "答案状态无效" }, 400);
  const answer = await readEssayAnswerForPublication(id);
  if (!answer) return json({ error: "参考答案不存在" }, 404);
  if (status === "published") {
    const errors = essayPublicationErrors(answer);
    if (errors.length) return json({ error: "答案未通过版权发布门禁", code: "ESSAY_ANSWER_NOT_PUBLISHABLE", reasons: errors }, 409);
  }
  await getD1().prepare(`UPDATE essay_reference_answers SET publication_status = ?,
    published_at = CASE WHEN ? = 'published' THEN COALESCE(published_at, CURRENT_TIMESTAMP) ELSE published_at END,
    updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(status, status, id).run();
  await getD1().prepare(`UPDATE question_banks SET library_status = 'draft', updated_at = CURRENT_TIMESTAMP
    WHERE library_enabled = 1 AND EXISTS (
      SELECT 1 FROM question_bank_items qbi
      WHERE qbi.bank_id = question_banks.id AND qbi.question_id = (
        SELECT question_id FROM essay_reference_answers WHERE id = ?
      )
    )`).bind(id).run();
  return json({ ok: true, id, status });
}

async function adminUpdateEssayLibrarySettings(payload: Record<string, unknown>) {
  if (!canAdmin(payload, "content.publish")) return adminForbidden("content.publish");
  const contactEmail = trimmed(payload.contactEmail, 254).toLowerCase();
  if (contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
    return json({ error: "版权联系邮箱格式无效" }, 400);
  }
  if (!contactEmail) {
    const published = await getD1().prepare(`SELECT COUNT(*) AS count FROM question_banks
      WHERE library_enabled = 1 AND library_status = 'published'`).first<{ count: number }>();
    if (Number(published?.count ?? 0) > 0) {
      return json({ error: "已有公开试卷时不能清空版权联系邮箱；请先配置新邮箱或撤回全部试卷",
        code: "COPYRIGHT_CONTACT_REQUIRED" }, 409);
    }
  }
  await getD1().prepare(`INSERT INTO configs (key, value, updated_at)
    VALUES ('copyright_contact_email', ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).bind(contactEmail).run();
  return json({ ok: true, contactEmail });
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

function safeUploadedMediaType(declaredType: string, bytes: Uint8Array) {
  const type = declaredType.toLowerCase().split(";")[0].trim();
  const ascii = (start: number, length: number) => String.fromCharCode(...bytes.slice(start, start + length));
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const isPng = bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value);
  const isGif = ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a";
  const isWebp = ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP";
  const isWav = ascii(0, 4) === "RIFF" && ascii(8, 4) === "WAVE";
  const isOgg = ascii(0, 4) === "OggS";
  const isMp3 = ascii(0, 3) === "ID3" || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
  const isAac = bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0;
  const isMp4Audio = bytes.length >= 12 && ascii(4, 4) === "ftyp";
  const isPdf = ascii(0, 5) === "%PDF-";
  if (type === "image/jpeg" && isJpeg) return "image/jpeg";
  if (type === "image/png" && isPng) return "image/png";
  if (type === "image/gif" && isGif) return "image/gif";
  if (type === "image/webp" && isWebp) return "image/webp";
  if (new Set(["audio/wav", "audio/x-wav"]).has(type) && isWav) return "audio/wav";
  if (new Set(["audio/mpeg", "audio/mp3"]).has(type) && isMp3) return "audio/mpeg";
  if (new Set(["audio/aac", "audio/x-aac"]).has(type) && isAac) return "audio/aac";
  if (new Set(["audio/mp4", "audio/m4a", "audio/x-m4a"]).has(type) && isMp4Audio) return "audio/mp4";
  if (new Set(["audio/ogg", "application/ogg"]).has(type) && isOgg) return "audio/ogg";
  if (type === "application/pdf" && isPdf) return "application/pdf";
  return "";
}

async function adminUploadMedia(request: Request, admin: AdminIdentity) {
  const form = await request.formData();
  if (!hasAdminPermission(admin, "media.upload")) return adminForbidden("media.upload");
  const value = form.get("file");
  if (!(value instanceof File)) return json({ error: "请选择要上传的文件" }, 400);
  if (value.size < 1 || value.size > 25 * 1024 * 1024) return json({ error: "文件大小需在1B—25MB之间" }, 400);
  const bytes = await value.arrayBuffer();
  const contentType = safeUploadedMediaType(value.type, new Uint8Array(bytes));
  // Uploading a file is not a publication decision. Every new object starts
  // private/member-only. A free preview is opened only when a versioned free
  // content item is approved by a reviewer below.
  const accessLevel = "member" as const;
  if (!contentType) return json({ error: "文件类型或内容不安全；仅支持真实的 JPG/PNG/GIF/WebP、MP3/M4A/WAV/AAC/Ogg 和 PDF", code: "UNSAFE_MEDIA_TYPE" }, 415);
  const id = crypto.randomUUID();
  const safeName = value.name.normalize("NFKC").replace(/[^\p{L}\p{N}._-]+/gu, "-").slice(-120) || "asset";
  const objectKey = `${chinaDateKey().replaceAll("-", "/")}/${id}-${safeName}`;
  const checksum = await digestBytes(bytes);
  const bucket = getMediaBucket();
  let storage = "r2";
  let fallbackData: string | null = null;
  if (bucket) {
    await bucket.put(objectKey, bytes, { httpMetadata: { contentType } });
  } else {
    if (value.size > 2 * 1024 * 1024) {
      return json({ error: "本地预览未绑定媒体存储，仅允许2MB以内文件；发布环境会自动使用R2存储。" }, 503);
    }
    storage = "d1-fallback";
    fallbackData = bytesToBase64(new Uint8Array(bytes));
  }
  await getD1().prepare(`INSERT INTO media_assets
    (id, object_key, file_name, content_type, byte_size, checksum, storage, fallback_data, access_level, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`)
    .bind(id, objectKey, value.name.slice(0, 180), contentType, value.size,
      checksum, storage, fallbackData, accessLevel).run();
  return json({
    ok: true,
    asset: { id, fileName: value.name, contentType, byteSize: value.size, storage, accessLevel, url: `/api/app?media=${id}` },
  }, 201);
}

async function adminSetMediaAccess(payload: Record<string, unknown>) {
  const admin = adminFromPayload(payload);
  if (!admin) return adminForbidden("media.upload");
  const id = trimmed(payload.id, 64);
  const accessLevel = payload.accessLevel === "free" ? "free" : payload.accessLevel === "member" ? "member" : "";
  if (!/^[0-9a-f-]{36}$/i.test(id) || !accessLevel) return json({ error: "媒体或访问权益无效" }, 400);
  const db = getD1();
  const current = await db.prepare("SELECT id, access_level FROM media_assets WHERE id = ? AND status = 'active'")
    .bind(id).first<{ id: string; access_level: "free" | "member" }>();
  if (!current) return json({ error: "媒体不存在或已停用" }, 404);
  if (current.access_level === accessLevel) return json({ ok: true, id, accessLevel, duplicate: true });

  if (accessLevel === "free") {
    // Never mutate a private asset while its content is merely pending. The
    // only member→free transition is inside adminReviewContent's atomic batch,
    // alongside the exact reviewed content version becoming published.
    return json({
      error: "会员媒体不能单独设为免费；请关联免费内容并完成审核发布",
      code: "MEDIA_REVIEW_REQUIRED",
    }, 409);
  } else {
    if (!hasAdminPermission(admin, "media.upload")) return adminForbidden("media.upload");
    const mediaUrl = mediaUrlForAsset(id);
    const publishedFreeReference = await db.prepare(`SELECT id FROM content_items
      WHERE access_level = 'free' AND status IN ('published','scheduled')
        AND instr(payload_json, json_quote(?)) > 0 LIMIT 1`).bind(mediaUrl).first<{ id: number }>();
    if (publishedFreeReference) {
      return json({
        error: "该媒体仍被已发布的免费/试听内容引用，请先下架或替换引用内容",
        code: "MEDIA_IN_USE_BY_FREE_CONTENT",
      }, 409);
    }
  }
  const updated = await db.prepare(`UPDATE media_assets SET access_level = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'active' AND access_level = ?`).bind(accessLevel, id, current.access_level).run();
  if (!updated.meta.changes) return json({ error: "媒体不存在或已停用" }, 404);
  return json({ ok: true, id, accessLevel });
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

async function serveMedia(assetId: string, request: Request, setCookie?: string | string[], publiclyCacheable = false) {
  if (!/^[0-9a-f-]{36}$/i.test(assetId)) return json({ error: "媒体不存在" }, 404);
  const row = await getD1().prepare(`SELECT object_key, file_name, content_type, byte_size, storage, fallback_data
    FROM media_assets WHERE id = ? AND status = 'active'`).bind(assetId).first<{
      object_key: string; file_name: string; content_type: string; byte_size: number; storage: string; fallback_data: string | null;
    }>();
  if (!row) return json({ error: "媒体不存在" }, 404);
  const headers = new Headers({
    "content-type": row.content_type,
    // A member response is never a transferable credential. Only a reviewed,
    // published free preview may enter a shared HTTP cache, and then only for a
    // short window so an operator can still revoke it promptly.
    "cache-control": publiclyCacheable ? "public, max-age=60, must-revalidate" : "private, no-store",
    "content-disposition": `${row.content_type === "application/pdf" ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(row.file_name)}`,
    "accept-ranges": "bytes",
    "x-content-type-options": "nosniff",
  });
  appendCookies(headers, setCookie);
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

async function serveAuthorizedMedia(assetId: string, request: Request) {
  const mediaUrl = mediaUrlForAsset(assetId);
  const entitlement = await getD1().prepare(`SELECT ma.id, ma.access_level,
      EXISTS (
        SELECT 1 FROM content_items ci
        WHERE ci.access_level = 'free' AND ci.status IN ('published','scheduled')
          AND (ci.publish_at IS NULL OR datetime(ci.publish_at) <= CURRENT_TIMESTAMP)
          AND instr(ci.payload_json, json_quote(?)) > 0
      ) AS published_free_reference,
      EXISTS (
        SELECT 1 FROM content_items ci
        WHERE ci.content_type = 'audio_track' AND ci.access_level = 'free'
          AND ci.status IN ('published','scheduled')
          AND (ci.publish_at IS NULL OR datetime(ci.publish_at) <= CURRENT_TIMESTAMP)
          AND instr(ci.payload_json, json_quote(?)) > 0
      ) AS published_free_audio_reference
    FROM media_assets ma WHERE ma.id = ? AND ma.status = 'active'`)
    .bind(mediaUrl, mediaUrl, assetId).first<{
      id: string; access_level: "free" | "member";
      published_free_reference: number; published_free_audio_reference: number;
    }>();
  if (!entitlement) return json({ error: "媒体不存在" }, 404);
  const publiclyFree = entitlement.access_level === "free" && Boolean(entitlement.published_free_reference);
  const quotaControlledAudio = publiclyFree && Boolean(entitlement.published_free_audio_reference);
  if (publiclyFree && !quotaControlledAudio) return serveMedia(assetId, request, undefined, true);

  const identity = await ensureUser(request, { persist: false });
  if (identity.bootstrapDeferred) {
    const response = json({ error: "账号信息更新中，请稍后重试播放", code: "IDENTITY_PREPARATION_REQUIRED" }, 409, identity.setCookie);
    response.headers.set("retry-after", "1");
    return response;
  }
  const membership = await userMembership(identity.userId);
  let allowed = membershipIsActive(membership);
  if (!allowed) {
    const admin = await getAdminIdentity(getD1(), request, false);
    allowed = Boolean(admin);
  }
  if (!allowed && quotaControlledAudio) {
    if (!identity.signedIn) {
      return json({ error: "登录后每天可试听1条音频内容", code: "VERIFIED_ACCOUNT_REQUIRED" }, 403, identity.setCookie);
    }
    allowed = await grantDailyFreeAudio(identity.userId, assetId);
    if (!allowed) {
      return json({ error: "今日免费试听次数已用完，开通会员后可收听完整内容", code: "PAYWALL_AUDIO_DAILY" }, 403, identity.setCookie);
    }
  }
  if (!allowed) {
    return json({ error: "该内容需开通会员后收听", code: "PAYWALL_MEDIA" }, 403, identity.setCookie);
  }
  return serveMedia(assetId, request, identity.setCookie, false);
}

async function adminList(payload: Record<string, unknown>) {
  if (!isAdmin(payload)) return json({ error: "管理员口令错误" }, 401);
  const db = getD1();
  const [codes, redemptions, content, mediaAssets, questionBanks, questionImports, eventCounts, activeUsers, rewardDays, monthlyCap] = await Promise.all([
    db.prepare(`SELECT id, code_preview, batch_name, grant_type, duration_days, channel, max_uses, used_count, status, valid_until, created_at
      FROM redemption_codes ORDER BY id DESC LIMIT 100`).all(),
    db.prepare(`SELECT r.redeemed_at, r.user_id, c.code_preview, c.grant_type, c.duration_days
      FROM redemptions r JOIN redemption_codes c ON c.id = r.code_id ORDER BY r.id DESC LIMIT 100`).all(),
    db.prepare(`SELECT ci.id, ci.content_type, ci.content_key, ci.title, ci.payload_json, ci.access_level, ci.status,
      ci.publish_at, ci.version, ci.updated_at,
      (SELECT COUNT(*) FROM content_item_versions civ WHERE civ.content_id = ci.id) AS version_count
      FROM content_items ci ORDER BY ci.id DESC LIMIT 500`).all(),
    db.prepare(`SELECT id, file_name, content_type, byte_size, storage, access_level, status, created_at,
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
      WHERE user_id <> 'system' AND created_at >= datetime('now', '-7 days') GROUP BY event_name ORDER BY count DESC`).all(),
    db.prepare(`SELECT COUNT(DISTINCT user_id) AS count FROM analytics_events
      WHERE user_id <> 'system' AND created_at >= datetime('now', '-7 days')`).first<{ count: number }>(),
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
  const grantType = payload.grantType === "lifetime" ? "lifetime" : "duration";
  const durationDays = grantType === "lifetime" ? 0 : Math.floor(Number(payload.durationDays));
  const count = Math.floor(Number(payload.count));
  const maxUses = Math.max(1, Math.floor(Number(payload.maxUses ?? 1)));
  const batchName = String(payload.batchName ?? "新建批次").trim().slice(0, 40) || "新建批次";
  const channel = trimmed(payload.channel, 40) || "manual";
  let validUntil: string | null = null;
  if (payload.validUntil) {
    const rawValue = String(payload.validUntil).trim();
    // HTML date inputs represent a China-local calendar day. A selected
    // “截止日期” remains valid through 23:59:59 on that day, not only midnight.
    const value = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(rawValue)
      ? `${rawValue}T23:59:59.999+08:00`
      : rawValue);
    if (!Number.isFinite(value)) return json({ error: "兑换截止日期无效" }, 400);
    validUntil = new Date(value).toISOString();
  }
  if (grantType === "duration" && !new Set([7, 30, 365]).has(durationDays)) {
    return json({ error: "时长兑换码仅支持 7、30 或 365 天" }, 400);
  }
  if (!Number.isFinite(count) || count < 1 || count > 200) return json({ error: "每批生成数量需在 1—200 个之间" }, 400);
  const db = getD1();
  // One JSON-backed statement inserts the whole export atomically, keeping a
  // 200-code request well below D1's per-invocation query budget. A hash
  // collision aborts the entire statement, so no unexported partial batch can
  // be left behind; the bounded retry regenerates every plaintext code.
  const maxInsertAttempts = 3;
  for (let attempt = 0; attempt < maxInsertAttempts; attempt += 1) {
    const plainCodes: string[] = [];
    const uniqueCodes = new Set<string>();
    while (plainCodes.length < count) {
      const code = randomCode();
      if (uniqueCodes.has(code)) continue;
      uniqueCodes.add(code);
      plainCodes.push(code);
    }
    const generatedJson = JSON.stringify(await Promise.all(plainCodes.map(async (code) => ({
      codeHash: await hashCode(code),
      codePreview: maskCode(code),
    }))));
    try {
      await db.prepare(`INSERT INTO redemption_codes
        (code_hash, code_preview, batch_name, grant_type, duration_days, channel, max_uses, valid_until)
        SELECT json_extract(generated.value, '$.codeHash'),
          json_extract(generated.value, '$.codePreview'), ?, ?, ?, ?, ?, ?
        FROM json_each(?) AS generated`)
        .bind(batchName, grantType, durationDays, channel, maxUses, validUntil, generatedJson).run();
      return json({ ok: true, grantType, durationDays: grantType === "lifetime" ? null : durationDays, codes: plainCodes });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const hashCollision = /UNIQUE constraint failed:\s*redemption_codes\.code_hash/i.test(message);
      if (!hashCollision) throw error;
    }
  }
  return json({ error: "兑换码生成发生冲突，请重试", code: "REDEMPTION_CODE_COLLISION" }, 409);
}

async function adminDisableCode(payload: Record<string, unknown>) {
  if (!isAdmin(payload)) return json({ error: "管理员口令错误" }, 401);
  await getD1().prepare("UPDATE redemption_codes SET status = 'disabled' WHERE id = ?").bind(Number(payload.id)).run();
  return json({ ok: true });
}

async function adminUpdateConfig(payload: Record<string, unknown>) {
  if (!isAdmin(payload)) return json({ error: "管理员口令错误" }, 401);
  const rewardDays = Math.max(0, Math.min(365, Math.floor(Number(payload.rewardDays))));
  const inviteeRewardDays = Math.max(0, Math.min(365, Math.floor(Number(payload.inviteeRewardDays ?? 3))));
  const monthlyCap = Math.max(0, Math.min(3650, Math.floor(Number(payload.monthlyCap))));
  const db = getD1();
  await db.batch([
    db.prepare(`INSERT INTO configs (key, value, updated_at) VALUES ('invite_reward_days', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).bind(String(rewardDays)),
    db.prepare(`INSERT INTO configs (key, value, updated_at) VALUES ('invite_monthly_cap', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).bind(String(monthlyCap)),
    db.prepare(`INSERT INTO configs (key, value, updated_at) VALUES ('invitee_reward_days', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).bind(String(inviteeRewardDays)),
  ]);
  return json({ ok: true });
}

function publishabilityError(contentType: string, contentKey: string, payload: Record<string, unknown>) {
  const issues = validatePublishableContent(contentType, payload);
  return issues.length ? json({
    error: `${contentKey} 缺少可核验的发布信息：${issues.join("；")}`,
    code: "CONTENT_SOURCE_INCOMPLETE",
    issues,
  }, 409) : null;
}

type ContentMediaValidation = {
  invalid: Response | null;
  promotableAssetIds: string[];
  referencedAssetIds: string[];
};

function collectManagedMediaAssetIds(value: unknown, found = new Set<string>(), depth = 0) {
  if (depth > 8 || value === null || value === undefined) return found;
  if (typeof value === "string") {
    const assetId = managedMediaAssetId(value);
    if (assetId) found.add(assetId);
    return found;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectManagedMediaAssetIds(item, found, depth + 1);
    return found;
  }
  if (typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) {
      collectManagedMediaAssetIds(child, found, depth + 1);
    }
  }
  return found;
}

async function validateContentMediaAssets(
  contentType: string,
  contentKey: string,
  accessLevel: "free" | "member",
  content: Record<string, unknown>,
  allowReviewedFreePromotion = false,
): Promise<ContentMediaValidation> {
  const rawAudioUrl = trimmed(content.audioUrl, 800);
  const audioAssetId = managedMediaAssetId(rawAudioUrl);
  const referencedAssetIds = Array.from(collectManagedMediaAssetIds(content));
  if (referencedAssetIds.length > 40) {
    return {
      invalid: json({ error: `${contentKey} 单条内容最多引用40个媒体文件`, code: "MEDIA_REFERENCE_LIMIT" }, 409),
      promotableAssetIds: [],
      referencedAssetIds: [],
    };
  }
  if (audioAssetId && !referencedAssetIds.includes(audioAssetId)) referencedAssetIds.push(audioAssetId);
  const rows = referencedAssetIds.length ? await getD1().prepare(`SELECT id, status, content_type, access_level
    FROM media_assets WHERE id IN (${referencedAssetIds.map(() => "?").join(",")})`)
    .bind(...referencedAssetIds).all<{
      id: string; status: string; content_type: string; access_level: "free" | "member";
    }>() : { results: [] as Array<{ id: string; status: string; content_type: string; access_level: "free" | "member" }> };
  const assetById = new Map(rows.results.map((row) => [row.id, row]));
  const audioAsset = audioAssetId ? assetById.get(audioAssetId) ?? null : null;
  const policy = audioReferencePolicy(contentType, accessLevel, content, audioAsset ? {
    id: audioAsset.id,
    status: audioAsset.status,
    contentType: audioAsset.content_type,
    accessLevel: audioAsset.access_level,
  } : null);
  if (!policy.ok) {
    const messages: Record<typeof policy.code, string> = {
      AUDIO_ASSET_REQUIRED: "音频节目必须上传受管媒体文件",
      MANAGED_MEDIA_REQUIRED: "音频只能引用站内受鉴权媒体，不能使用公开目录或第三方直链",
      MEDIA_ASSET_MISSING: "引用的媒体不存在或已停用",
      AUDIO_ASSET_TYPE_INVALID: "音频字段引用的文件不是受支持的音频类型",
      MEDIA_ACCESS_MISMATCH: "内容权益与媒体权益不一致，请上传同权益媒体或重新走免费审核",
    };
    return {
      invalid: json({
        error: `${contentKey} 无法发布：${messages[policy.code]}`,
        code: policy.code,
      }, 409),
      promotableAssetIds: [],
      referencedAssetIds: [],
    };
  }
  const promotableAssetIds: string[] = [];
  for (const assetId of referencedAssetIds) {
    const referenced = assetById.get(assetId);
    if (!referenced || referenced.status !== "active") {
      return {
        invalid: json({ error: `${contentKey} 引用的媒体不存在或已停用`, code: "MEDIA_ASSET_MISSING" }, 409),
        promotableAssetIds: [],
        referencedAssetIds: [],
      };
    }
    if (referenced.access_level === accessLevel) continue;
    if (accessLevel === "free" && referenced.access_level === "member") {
      promotableAssetIds.push(assetId);
      continue;
    }
    return {
      invalid: json({ error: `${contentKey} 的内容权益与引用媒体权益不一致`, code: "MEDIA_ACCESS_MISMATCH" }, 409),
      promotableAssetIds: [],
      referencedAssetIds: [],
    };
  }
  if (promotableAssetIds.length && !allowReviewedFreePromotion) {
    return {
      invalid: json({
        error: `${contentKey} 引用的会员媒体尚未通过免费/试听审核`,
        code: "MEDIA_ACCESS_REVIEW_REQUIRED",
      }, 409),
      promotableAssetIds: [],
      referencedAssetIds: [],
    };
  }
  return {
    invalid: null,
    promotableAssetIds: Array.from(new Set(promotableAssetIds)),
    referencedAssetIds,
  };
}

async function adminUpsertContentBatch(payload: Record<string, unknown>) {
  if (!isAdmin(payload)) return json({ error: "管理员口令错误" }, 401);
  // This action is the single-record editor. Multi-row work must use the
  // durable content-import workflow so an HTTP error can never leave a silent
  // partially-saved batch or exceed D1's per-invocation query budget.
  if (!Array.isArray(payload.items) || payload.items.length !== 1) {
    return json({ error: "手工编辑每次只能保存1条；批量内容请使用可续传的文件导入任务", code: "DURABLE_IMPORT_REQUIRED" }, 400);
  }
  const db = getD1();
  const admin = adminFromPayload(payload)!;
  const saved: Array<{ id: number; contentKey: string; version: number }> = [];
  for (const raw of payload.items) {
    const item = raw as Record<string, unknown>;
    const contentType = String(item.contentType ?? "");
    const contentKey = String(item.contentKey ?? "").trim();
    const title = String(item.title ?? "").trim().slice(0, 120);
    const accessLevel = item.accessLevel === "free" ? "free" : "member";
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
    if (new Set(["pending_review", "published", "scheduled"]).has(status)) {
      const invalid = publishabilityError(contentType, contentKey, item.payload as Record<string, unknown>);
      if (invalid) return invalid;
    }
    const mediaValidation = await validateContentMediaAssets(
      contentType,
      contentKey,
      accessLevel,
      item.payload as Record<string, unknown>,
      !new Set(["published", "scheduled"]).has(status),
    );
    if (mediaValidation.invalid) return mediaValidation.invalid;
    const existing = await db.prepare(`SELECT id, content_type, content_key, title, payload_json, access_level, status,
      publish_at, version FROM content_items WHERE content_key = ?`).bind(contentKey).first<Record<string, unknown>>();
    if (existing) {
      const existingType = String(existing.content_type);
      if (existingType !== contentType) {
        return json({
          error: `${contentKey} 已属于另一业务类型，内容标识和业务类型创建后不可修改；请复制为新内容`,
          code: "CONTENT_IDENTITY_CONFLICT",
        }, 409);
      }
      // Authorize against persisted truth as well as the request. Otherwise a
      // content editor could claim a radar draft (or the reverse) by supplying
      // a different contentType for an existing globally-unique key.
      const existingRadarContent = new Set(["exam_event", "exam_notice", "job_position"]).has(existingType);
      const existingWritePermission: AdminPermission = existingRadarContent ? "radar.write" : "content.write";
      if (!hasAdminPermission(admin, existingWritePermission) && admin.role !== "super_admin") {
        return adminForbidden(existingWritePermission);
      }
      if (new Set(["published", "scheduled"]).has(String(existing.status))
        && admin.role !== "reviewer" && admin.role !== "super_admin") {
        return json({ error: `${contentKey} 已发布；请复制为新草稿并提交审核，避免绕过审核直接改动线上内容` }, 409);
      }
      const currentVersion = Math.max(1, Number(existing.version ?? 1));
      const expectedVersion = Math.floor(Number(item.expectedVersion));
      if (!Number.isInteger(expectedVersion) || expectedVersion < 1 || expectedVersion !== currentVersion) {
        return json({
          error: `${contentKey} 已被其他管理员更新，请刷新后重试`,
          code: "CONTENT_VERSION_CONFLICT",
          currentVersion,
        }, 409);
      }
      const nextVersion = currentVersion + 1;
      const batchResults = await db.batch([
        db.prepare(`INSERT OR IGNORE INTO content_item_versions
          (content_id, version, content_type, content_key, title, payload_json, access_level, status, publish_at, change_type)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'snapshot')`)
          .bind(Number(existing.id), currentVersion, existingType, String(existing.content_key),
            String(existing.title), String(existing.payload_json), String(existing.access_level ?? "member"), String(existing.status), existing.publish_at ?? null),
        db.prepare(`UPDATE content_items SET title = ?, payload_json = ?, access_level = ?, status = ?,
            publish_at = ?, review_note = CASE WHEN ? = 'pending_review' THEN '' ELSE review_note END,
            submitted_by = CASE WHEN ? = 'pending_review' THEN ? ELSE submitted_by END,
            submitted_at = CASE WHEN ? = 'pending_review' THEN CURRENT_TIMESTAMP ELSE submitted_at END,
            reviewed_by = CASE WHEN ? IN ('published','scheduled','archived','rejected') THEN ? ELSE reviewed_by END,
            reviewed_at = CASE WHEN ? IN ('published','scheduled','archived','rejected') THEN CURRENT_TIMESTAMP ELSE reviewed_at END,
            version = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND version = ?`)
          .bind(title, payloadJson, accessLevel, status, publishAt, status, status, admin.id, status,
            status, admin.id, status, nextVersion, Number(existing.id), expectedVersion),
        db.prepare(`INSERT OR REPLACE INTO content_item_versions
          (content_id, version, content_type, content_key, title, payload_json, access_level, status, publish_at, change_type)
          SELECT id, version, content_type, content_key, title, payload_json, access_level, status, publish_at, 'update'
          FROM content_items WHERE id = ? AND version = ?`)
          .bind(Number(existing.id), nextVersion),
      ]);
      const updated = batchResults[1];
      if (!updated.meta.changes) {
        return json({ error: `${contentKey} 已被其他管理员更新，请刷新后重试`, code: "CONTENT_VERSION_CONFLICT" }, 409);
      }
      saved.push({ id: Number(existing.id), contentKey, version: nextVersion });
    } else {
      await db.batch([
        db.prepare(`INSERT INTO content_items
          (content_type, content_key, title, payload_json, access_level, status, publish_at, version,
            submitted_by, submitted_at, reviewed_by, reviewed_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 1,
            CASE WHEN ? = 'pending_review' THEN ? ELSE NULL END,
            CASE WHEN ? = 'pending_review' THEN CURRENT_TIMESTAMP ELSE NULL END,
            CASE WHEN ? IN ('published','scheduled','archived','rejected') THEN ? ELSE NULL END,
            CASE WHEN ? IN ('published','scheduled','archived','rejected') THEN CURRENT_TIMESTAMP ELSE NULL END,
            CURRENT_TIMESTAMP)`)
          .bind(contentType, contentKey, title, payloadJson, accessLevel, status, publishAt,
            status, admin.id, status, status, admin.id, status),
        db.prepare(`INSERT INTO content_item_versions
          (content_id, version, content_type, content_key, title, payload_json, access_level, status, publish_at, change_type)
          SELECT id, 1, content_type, content_key, title, payload_json, access_level, status, publish_at, 'create'
          FROM content_items WHERE content_key = ? AND version = 1`)
          .bind(contentKey),
      ]);
      const created = await db.prepare("SELECT id FROM content_items WHERE content_key = ?")
        .bind(contentKey).first<{ id: number }>();
      if (!created) throw new Error("CONTENT_CREATE_COMMIT_MISSING");
      const id = Number(created.id);
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
  const current = await db.prepare(`SELECT id, content_type, content_key, title, payload_json, access_level, status,
    publish_at, version FROM content_items WHERE id = ?`).bind(id).first<Record<string, unknown>>();
  if (!current) return json({ error: "内容不存在" }, 404);
  const currentVersion = Math.max(1, Number(current.version ?? 1));
  const expectedVersion = Math.floor(Number(payload.expectedVersion));
  if (!Number.isInteger(expectedVersion) || expectedVersion !== currentVersion) {
    return json({ error: "内容已被其他管理员更新，请刷新后重试", code: "CONTENT_VERSION_CONFLICT", currentVersion }, 409);
  }
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
      && String(current.status) !== "pending_review"
      && !(status === "published" && String(current.status) === "archived")) {
      return json({ error: "内容尚未提交审核，不能直接发布或驳回" }, 409);
    }
  } else {
    const writePermission: AdminPermission = radarContent ? "radar.write" : "content.write";
    if (!hasAdminPermission(admin, writePermission)) return adminForbidden(writePermission);
  }
  const nextVersion = currentVersion + 1;
  let publishAt = current.publish_at ? String(current.publish_at) : null;
  if (payload.publishAt) {
    const requestedPublishAt = Date.parse(String(payload.publishAt));
    if (!Number.isFinite(requestedPublishAt)) return json({ error: "发布时间无效" }, 400);
    publishAt = new Date(requestedPublishAt).toISOString();
  }
  if (status === "published") publishAt = null;
  if (status === "scheduled" && (!publishAt || Date.parse(publishAt) <= Date.now())) return json({ error: "请先设置未来的发布时间" }, 400);
  if (new Set(["pending_review", "published", "scheduled"]).has(status)) {
    let contentPayload: Record<string, unknown> = {};
    try { contentPayload = JSON.parse(String(current.payload_json)) as Record<string, unknown>; } catch { contentPayload = {}; }
    const invalid = publishabilityError(String(current.content_type), String(current.content_key), contentPayload);
    if (invalid) return invalid;
    const mediaValidation = await validateContentMediaAssets(
      String(current.content_type),
      String(current.content_key),
      current.access_level === "free" ? "free" : "member",
      contentPayload,
      status === "pending_review",
    );
    if (mediaValidation.invalid) return mediaValidation.invalid;
  }
  const batchResults = await db.batch([
    db.prepare(`INSERT OR IGNORE INTO content_item_versions
      (content_id, version, content_type, content_key, title, payload_json, access_level, status, publish_at, change_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'snapshot')`)
      .bind(id, currentVersion, String(current.content_type), String(current.content_key),
        String(current.title), String(current.payload_json), String(current.access_level ?? "member"), String(current.status), current.publish_at ?? null),
    db.prepare(`UPDATE content_items SET status = ?, publish_at = ?, review_note = ?,
        submitted_by = CASE WHEN ? = 'pending_review' THEN ? ELSE submitted_by END,
        submitted_at = CASE WHEN ? = 'pending_review' THEN CURRENT_TIMESTAMP ELSE submitted_at END,
        reviewed_by = CASE WHEN ? IN ('published','scheduled','archived','rejected') THEN ? ELSE reviewed_by END,
        reviewed_at = CASE WHEN ? IN ('published','scheduled','archived','rejected') THEN CURRENT_TIMESTAMP ELSE reviewed_at END,
        version = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND version = ?`)
        .bind(status, publishAt, trimmed(payload.reviewNote, 1000), status, admin.id, status,
          status, admin.id, status, nextVersion, id, expectedVersion),
    db.prepare(`INSERT OR REPLACE INTO content_item_versions
      (content_id, version, content_type, content_key, title, payload_json, access_level, status, publish_at, change_type)
      SELECT id, version, content_type, content_key, title, payload_json, access_level, status, publish_at, 'status'
      FROM content_items WHERE id = ? AND version = ?`)
      .bind(id, nextVersion),
  ]);
  const updated = batchResults[1];
  if (!updated.meta.changes) return json({ error: "内容已被其他管理员更新，请刷新后重试", code: "CONTENT_VERSION_CONFLICT" }, 409);
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
    payload_json, access_level, status, publish_at, change_type, created_at
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
  const currentVersion = Math.max(1, Number(current.version ?? 1));
  const expectedVersion = Math.floor(Number(payload.expectedVersion));
  if (!Number.isInteger(expectedVersion) || expectedVersion !== currentVersion) {
    return json({ error: "内容已被其他管理员更新，请刷新后重试", code: "CONTENT_VERSION_CONFLICT", currentVersion }, 409);
  }
  if (String(snapshot.content_type) !== String(current.content_type)
    || String(snapshot.content_key) !== String(current.content_key)) {
    return json({ error: "历史版本的内容身份与当前记录不一致，禁止跨类型回滚", code: "CONTENT_IDENTITY_CONFLICT" }, 409);
  }
  let restoredPayload: Record<string, unknown> = {};
  try { restoredPayload = JSON.parse(String(snapshot.payload_json)) as Record<string, unknown>; } catch { restoredPayload = {}; }
  if (new Set(["pending_review", "published", "scheduled"]).has(String(snapshot.status))) {
    const invalid = publishabilityError(String(current.content_type), String(current.content_key), restoredPayload);
    if (invalid) return invalid;
  }
  const restoredStatus = String(snapshot.status);
  const mediaValidation = await validateContentMediaAssets(
    String(current.content_type),
    String(current.content_key),
    snapshot.access_level === "free" ? "free" : "member",
    restoredPayload,
    !new Set(["published", "scheduled"]).has(restoredStatus),
  );
  if (mediaValidation.invalid) return mediaValidation.invalid;
  const nextVersion = currentVersion + 1;
  const batchResults = await db.batch([
    db.prepare(`INSERT OR IGNORE INTO content_item_versions
      (content_id, version, content_type, content_key, title, payload_json, access_level, status, publish_at, change_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'snapshot')`)
      .bind(contentId, currentVersion, String(current.content_type), String(current.content_key),
        String(current.title), String(current.payload_json), String(current.access_level ?? "member"), String(current.status), current.publish_at ?? null),
    db.prepare(`UPDATE content_items SET title = ?, payload_json = ?, access_level = ?, status = ?,
      publish_at = ?, version = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND version = ?`)
      .bind(String(snapshot.title), String(snapshot.payload_json), String(snapshot.access_level ?? "member"), String(snapshot.status),
        snapshot.publish_at ?? null, nextVersion, contentId, expectedVersion),
    db.prepare(`INSERT OR REPLACE INTO content_item_versions
      (content_id, version, content_type, content_key, title, payload_json, access_level, status, publish_at, change_type)
      SELECT id, version, content_type, content_key, title, payload_json, access_level, status, publish_at, 'rollback'
      FROM content_items WHERE id = ? AND version = ?`)
      .bind(contentId, nextVersion),
  ]);
  const updated = batchResults[1];
  if (!updated.meta.changes) return json({ error: "内容已被其他管理员更新，请刷新后重试", code: "CONTENT_VERSION_CONFLICT" }, 409);
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
  const duplicateTitle = title || `${String(source.title)}（副本）`;
  await db.batch([
    db.prepare(`INSERT INTO content_items
      (content_type, content_key, title, payload_json, access_level, status, publish_at, version, updated_at)
      VALUES (?, ?, ?, ?, 'member', 'draft', NULL, 1, CURRENT_TIMESTAMP)`)
      .bind(String(source.content_type), newKey, duplicateTitle, String(source.payload_json)),
    db.prepare(`INSERT INTO content_item_versions
      (content_id, version, content_type, content_key, title, payload_json, access_level, status, publish_at, change_type)
      SELECT id, 1, content_type, content_key, title, payload_json, access_level, status, publish_at, 'duplicate'
      FROM content_items WHERE content_key = ? AND version = 1`)
      .bind(newKey),
  ]);
  const created = await db.prepare("SELECT id FROM content_items WHERE content_key = ?")
    .bind(newKey).first<{ id: number }>();
  if (!created) throw new Error("CONTENT_DUPLICATE_COMMIT_MISSING");
  const newId = Number(created.id);
  return json({ ok: true, id: newId, contentKey: newKey, version: 1 });
}

function trimmed(value: unknown, maxLength: number) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function abandonActiveSessionsByBankCode(db: ReturnType<typeof getD1>, bankCode: string) {
  return db.prepare(`UPDATE practice_sessions SET status = 'abandoned', updated_at = CURRENT_TIMESTAMP
    WHERE status = 'active' AND json_valid(bank_codes_json)
      AND EXISTS (SELECT 1 FROM json_each(practice_sessions.bank_codes_json)
        WHERE json_each.value = ?)`)
    .bind(bankCode);
}

type QuestionPostStateGuard = { questionId: number; version: number; reviewStatus?: string; status?: string };

function questionPostStateGuard(guard: QuestionPostStateGuard) {
  const clauses = ["changed.id = ?", "changed.version = ?"];
  const binds: unknown[] = [guard.questionId, guard.version];
  if (guard.reviewStatus) { clauses.push("changed.review_status = ?"); binds.push(guard.reviewStatus); }
  if (guard.status) { clauses.push("changed.status = ?"); binds.push(guard.status); }
  return { sql: `EXISTS (SELECT 1 FROM questions changed WHERE ${clauses.join(" AND ")})`, binds };
}

function abandonActiveSessionsByQuestionCode(
  db: ReturnType<typeof getD1>,
  questionCode: string,
  postState: QuestionPostStateGuard,
) {
  const guard = questionPostStateGuard(postState);
  return db.prepare(`UPDATE practice_sessions SET status = 'abandoned', updated_at = CURRENT_TIMESTAMP
    WHERE status = 'active' AND json_valid(question_codes_json)
      AND EXISTS (SELECT 1 FROM json_each(practice_sessions.question_codes_json)
        WHERE json_each.value = ?)
      AND ${guard.sql}`)
    .bind(questionCode, ...guard.binds);
}

function draftInvalidPublishedBanksForQuestion(db: ReturnType<typeof getD1>, postState: QuestionPostStateGuard) {
  const guard = questionPostStateGuard(postState);
  return db.prepare(`UPDATE question_banks AS qb SET status = 'draft', updated_at = CURRENT_TIMESTAMP
    WHERE qb.status = 'published'
      AND ${guard.sql}
      AND EXISTS (SELECT 1 FROM question_bank_items affected
        WHERE affected.bank_id = qb.id AND affected.question_id = ?)
      AND (
        NOT EXISTS (SELECT 1 FROM question_bank_items qbi JOIN questions q ON q.id = qbi.question_id
          WHERE qbi.bank_id = qb.id AND q.status = 'active')
        OR EXISTS (SELECT 1 FROM question_bank_items qbi JOIN questions q ON q.id = qbi.question_id
          WHERE qbi.bank_id = qb.id AND q.status = 'active'
            AND NOT ${QUESTION_BANK_PUBLISHABLE_ITEM_SQL})
      )`).bind(...guard.binds, postState.questionId);
}

function abandonActiveSessionsForDraftedQuestionBanks(db: ReturnType<typeof getD1>, postState: QuestionPostStateGuard) {
  const guard = questionPostStateGuard(postState);
  return db.prepare(`UPDATE practice_sessions SET status = 'abandoned', updated_at = CURRENT_TIMESTAMP
    WHERE status = 'active' AND json_valid(bank_codes_json)
      AND ${guard.sql}
      AND EXISTS (
        SELECT 1 FROM json_each(practice_sessions.bank_codes_json) selected
        JOIN question_banks qb ON qb.bank_code = selected.value AND qb.status = 'draft'
        JOIN question_bank_items qbi ON qbi.bank_id = qb.id AND qbi.question_id = ?
      )`).bind(...guard.binds, postState.questionId);
}

function draftEssayLibraryPapersForQuestion(db: ReturnType<typeof getD1>, postState: QuestionPostStateGuard) {
  const guard = questionPostStateGuard(postState);
  return db.prepare(`UPDATE question_banks AS qb SET library_status = 'draft', updated_at = CURRENT_TIMESTAMP
    WHERE qb.library_enabled = 1 AND qb.library_status <> 'draft'
      AND ${guard.sql}
      AND EXISTS (SELECT 1 FROM question_bank_items qbi
        WHERE qbi.bank_id = qb.id AND qbi.question_id = ?)`)
    .bind(...guard.binds, postState.questionId);
}

async function adminUpsertQuestionBank(payload: Record<string, unknown>) {
  if (!canAdmin(payload, "question.write")) return adminForbidden("question.write");
  const requestedBankCode = trimmed(payload.bankCode, 60).toUpperCase();
  let bankCode = requestedBankCode;
  const name = trimmed(payload.name, 80);
  const examType = trimmed(payload.examType, 20);
  const province = normalizeProvince(payload.province) || null;
  const subject = trimmed(payload.subject, 10);
  const description = trimmed(payload.description, 500);
  const coverColor = new Set(["blue", "orange", "green", "purple"]).has(String(payload.coverColor)) ? String(payload.coverColor) : "blue";
  const status = payload.status === "published" ? "published" : "draft";
  const bankIdValue = Math.floor(Number(payload.bankId));
  const bankId = Number.isFinite(bankIdValue) && bankIdValue > 0 ? bankIdValue : null;
  const yearValue = Number(payload.examYear);
  const examYear = Number.isInteger(yearValue) && yearValue >= 2020 && yearValue <= 2100 ? yearValue : null;
  const db = getD1();
  const existingBank = bankId ? await db.prepare(`SELECT b.id, b.bank_code, b.status, b.exam_type, b.province,
      b.exam_year, b.subject,
      (SELECT COUNT(*) FROM question_bank_items qbi WHERE qbi.bank_id = b.id) AS question_count,
      (SELECT COUNT(*) FROM question_imports qi WHERE qi.bank_id = b.id) AS import_count,
      (SELECT COUNT(*) FROM user_question_banks uqb WHERE uqb.bank_code = b.bank_code) AS selection_count,
      (SELECT COUNT(*) FROM practice_sessions ps WHERE ps.status = 'active' AND EXISTS (
        SELECT 1 FROM json_each(ps.bank_codes_json) selected WHERE selected.value = b.bank_code
      )) AS active_session_count
      FROM question_banks b WHERE b.id = ?`)
    .bind(bankId).first<{
      id: number; bank_code: string; status: string; exam_type: string; province: string | null;
      exam_year: number | null; subject: string; question_count: number; import_count: number;
      selection_count: number; active_session_count: number;
    }>() : null;
  if (bankId && !existingBank) return json({ error: "要编辑的题库不存在" }, 404);
  if (existingBank) {
    // Legacy seed codes are lowercase. Once a bank exists its code is an
    // immutable identity, so an edit keeps the exact stored code instead of
    // uppercasing the form value and falsely reporting an identity change.
    bankCode = existingBank.bank_code;
    const identityPolicy = inspectQuestionBankIdentityChange({
      bankCode: existingBank.bank_code,
      examType: existingBank.exam_type,
      province: existingBank.province,
      examYear: existingBank.exam_year,
      subject: existingBank.subject,
      status: existingBank.status,
      questionCount: existingBank.question_count,
      importCount: existingBank.import_count,
      selectionCount: existingBank.selection_count,
      activeSessionCount: existingBank.active_session_count,
    }, { bankCode, examType, province, examYear, subject });
    if (identityPolicy.locked) {
      return json({
        error: identityPolicy.codeChanged
          ? "题库编码创建后永久不可修改；请复制为新题库后再调整范围"
          : `题库${identityPolicy.lockedFields.join("、")}已锁定（${identityPolicy.lockReasons.join("、")}）；请复制为新题库后再调整范围`,
        code: "QUESTION_BANK_IDENTITY_LOCKED",
        lockedFields: identityPolicy.lockedFields,
        lockReasons: identityPolicy.lockReasons,
      }, 409);
    }
  }
  if (!existingBank && !/^[A-Z0-9][A-Z0-9_-]{2,59}$/.test(bankCode)) return json({ error: "题库编码需使用3—60位大写字母、数字、横线或下划线" }, 400);
  if (!name) return json({ error: "请输入题库名称" }, 400);
  if (!new Set(["national", "provincial", "special"]).has(examType)) return json({ error: "考试类型无效" }, 400);
  if (examType === "provincial" && !province) return json({ error: "省考题库必须填写省份" }, 400);
  if (!new Set(["行测", "申论", "综合"]).has(subject)) return json({ error: "题库科目无效" }, 400);
  if (status === "published") {
    if (!bankId) return json({ error: "请先保存题库并导入已审核真题，再发布" }, 409);
    const quality = await db.prepare(`SELECT
      COUNT(DISTINCT CASE WHEN q.status = 'active' THEN q.id END) AS total,
      COUNT(DISTINCT CASE WHEN q.status = 'active' AND NOT ${QUESTION_BANK_PUBLISHABLE_ITEM_SQL} THEN q.id END) AS invalid,
      (SELECT COUNT(*) FROM question_imports active_import WHERE active_import.bank_id = qb.id
        AND active_import.status IN ('uploading','queued','processing','cancelling')) AS active_imports
      FROM question_banks qb
      LEFT JOIN question_bank_items qbi ON qbi.bank_id = qb.id
      LEFT JOIN questions q ON q.id = qbi.question_id
      WHERE qb.id = ?`)
      .bind(bankId).first<{ total: number; invalid: number; active_imports: number }>();
    if (Number(quality?.total ?? 0) < 1) return json({ error: "题库至少包含1道可练真题后才能发布" }, 409);
    if (Number(quality?.invalid ?? 0) > 0) return json({ error: `有${quality?.invalid}道题缺少真题来源、地区年份、解析或审核，不能发布` }, 409);
    if (Number(quality?.active_imports ?? 0) > 0) return json({ error: "题库仍有上传或处理中的导入任务，完成审核后才能发布" }, 409);
  }
  if (bankId) {
    const updateStatement = db.prepare(`UPDATE question_banks AS qb SET name = ?, exam_type = ?, province = ?,
      exam_year = ?, subject = ?, description = ?, cover_color = ?, status = ?,
      library_status = CASE WHEN library_enabled = 1 THEN 'draft' ELSE library_status END,
      updated_at = CURRENT_TIMESTAMP
      WHERE qb.id = ? AND (? <> 'published' OR ${QUESTION_BANK_CAN_PUBLISH_SQL})`)
      .bind(name, examType, province, examYear, subject, description, coverColor, status, bankId, status);
    const statements = [updateStatement];
    if (existingBank?.status === "published" && status === "draft") {
      statements.push(abandonActiveSessionsByBankCode(db, existingBank.bank_code));
    }
    const [updated] = await db.batch(statements);
    if (!updated.meta.changes) {
      if (status === "published") return json({ error: "发布条件刚刚发生变化，请刷新题库质量与导入状态后重试" }, 409);
      return json({ error: "要编辑的题库不存在" }, 404);
    }
  } else {
    const duplicate = await db.prepare("SELECT id FROM question_banks WHERE bank_code = ?").bind(bankCode).first<{ id: number }>();
    if (duplicate) return json({ error: "题库编码已被其他题库使用" }, 409);
    await db.prepare(`INSERT INTO question_banks
      (bank_code, name, exam_type, province, exam_year, subject, description, cover_color, status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`)
      .bind(bankCode, name, examType, province, examYear, subject, description, coverColor, status).run();
  }
  const bank = await db.prepare("SELECT id FROM question_banks WHERE bank_code = ?").bind(bankCode).first<{ id: number }>();
  return json({ ok: true, id: bank?.id, bankCode });
}

async function adminSetQuestionBankStatus(payload: Record<string, unknown>) {
  if (!canAdmin(payload, "question.write")) return adminForbidden("question.write");
  const id = Math.floor(Number(payload.id));
  const status = payload.status === "published" ? "published" : "draft";
  if (!Number.isFinite(id) || id < 1) return json({ error: "题库不存在" }, 400);
  const db = getD1();
  const bank = await db.prepare("SELECT bank_code, status FROM question_banks WHERE id = ?")
    .bind(id).first<{ bank_code: string; status: string }>();
  if (!bank) return json({ error: "题库不存在" }, 404);
  if (bank.status === status && status !== "published") return json({ ok: true, status, unchanged: true });
  if (status === "published") {
    const quality = await db.prepare(`SELECT
      COUNT(DISTINCT CASE WHEN q.status = 'active' THEN q.id END) AS total,
      COUNT(DISTINCT CASE WHEN q.status = 'active' AND NOT ${QUESTION_BANK_PUBLISHABLE_ITEM_SQL} THEN q.id END) AS invalid,
      (SELECT COUNT(*) FROM question_imports active_import WHERE active_import.bank_id = qb.id
        AND active_import.status IN ('uploading','queued','processing','cancelling')) AS active_imports
      FROM question_banks qb
      LEFT JOIN question_bank_items qbi ON qbi.bank_id = qb.id
      LEFT JOIN questions q ON q.id = qbi.question_id
      WHERE qb.id = ?`)
      .bind(id).first<{ total: number; invalid: number; active_imports: number }>();
    if (Number(quality?.total ?? 0) < 1) return json({ error: "题库至少包含1道可练真题后才能发布" }, 409);
    if (Number(quality?.invalid ?? 0) > 0) return json({ error: `有${quality?.invalid}道题未通过真题质量校验` }, 409);
    if (Number(quality?.active_imports ?? 0) > 0) return json({ error: "题库仍有上传或处理中的导入任务，完成审核后才能发布" }, 409);
  }
  const statements = [
    status === "published"
      ? db.prepare(`UPDATE question_banks AS qb SET status = 'published', updated_at = CURRENT_TIMESTAMP
          WHERE qb.id = ? AND ${QUESTION_BANK_CAN_PUBLISH_SQL}`).bind(id)
      : db.prepare("UPDATE question_banks SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(status, id),
  ];
  if (status === "draft") statements.push(abandonActiveSessionsByBankCode(db, bank.bank_code));
  const [updated, abandoned] = await db.batch(statements);
  if (!updated.meta.changes) return json({ error: status === "published"
    ? "发布条件刚刚发生变化，请刷新题库质量与导入状态后重试"
    : "题库状态未更新" }, 409);
  return json({ ok: true, status, abandonedSessions: Number(abandoned?.meta.changes ?? 0) });
}

function adminQuestionSnapshot(row: Record<string, unknown>) {
  return {
    questionCode: String(row.question_code ?? ""),
    subject: String(row.subject ?? ""),
    module: String(row.module ?? ""),
    subType: String(row.sub_type ?? ""),
    stem: String(row.stem ?? ""),
    options: parseOptions(String(row.options_json ?? "[]")),
    answer: row.answer == null ? null : String(row.answer),
    explanation: String(row.explanation ?? ""),
    technique: String(row.technique ?? ""),
    material: String(row.material ?? ""),
    prompt: String(row.prompt ?? ""),
    wordLimit: Number.isInteger(Number(row.word_limit)) && Number(row.word_limit) > 0 ? Number(row.word_limit) : null,
    scoringPoints: safeStringArray(row.scoring_points_json, 30),
    difficulty: String(row.difficulty ?? "中等"),
    source: String(row.source ?? ""),
    sourceExamType: String(row.source_exam_type ?? ""),
    sourceBatch: String(row.source_batch ?? ""),
    region: String(row.source_region ?? ""),
    examYear: Number.isInteger(Number(row.source_year)) ? Number(row.source_year) : null,
    truthVerified: Number(row.truth_verified ?? 0) === 1,
    reviewStatus: String(row.review_status ?? "pending_review"),
    frequency: String(row.frequency ?? ""),
    frequencyOccurrences: Math.max(0, Math.floor(Number(row.frequency_occurrences ?? 0))),
    frequencyPapers: Math.max(0, Math.floor(Number(row.frequency_papers ?? 0))),
    frequencyYears: parseYearList(row.frequency_years_json),
    frequencyUpdatedAt: row.frequency_updated_at ? String(row.frequency_updated_at) : null,
    importanceStars: Math.max(0, Math.floor(Number(row.importance_stars ?? 0))),
    importanceRuleVersion: String(row.importance_rule_version ?? ""),
    importanceReason: String(row.importance_reason ?? ""),
    importanceOverrideReason: String(row.importance_override_reason ?? ""),
    scoreRate: Math.max(0, Math.min(100, Math.round(Number(row.score_rate ?? 0)))),
    scoreRateCorrect: Math.max(0, Math.floor(Number(row.score_rate_correct ?? 0))),
    scoreRateAttempts: Math.max(0, Math.floor(Number(row.score_rate_attempts ?? 0))),
    scoreRateScope: String(row.score_rate_scope ?? ""),
    scoreRateSource: String(row.score_rate_source ?? "platform") || "platform",
    scoreRateUpdatedAt: row.score_rate_updated_at ? String(row.score_rate_updated_at) : null,
    suggestedSeconds: Math.max(10, Math.floor(Number(row.suggested_seconds ?? 60))),
    imageUrl: String(row.image_url ?? ""),
    resourceUrl: String(row.resource_url ?? ""),
    status: String(row.status ?? "active"),
  };
}

const ADMIN_QUESTION_SELECT = `q.id, q.question_code, q.subject, q.module, q.sub_type, q.stem, q.options_json,
  q.answer, q.explanation, q.technique, q.material, q.prompt, q.word_limit, q.scoring_points_json,
  q.difficulty, q.source, q.source_exam_type, q.source_region, q.source_year, q.source_batch,
  q.truth_verified, q.review_status, q.review_note, q.reviewed_by, q.reviewed_at,
  q.frequency, q.frequency_occurrences, q.frequency_papers, q.frequency_years_json, q.frequency_updated_at,
  q.importance_stars, q.importance_rule_version, q.importance_reason, q.importance_override_reason,
  q.score_rate, q.score_rate_correct, q.score_rate_attempts, q.score_rate_scope,
  q.score_rate_source, q.score_rate_updated_at, q.suggested_seconds, q.image_url, q.resource_url,
  q.status, q.version, q.updated_at`;

function adminQuestionSearchShape(row: Record<string, unknown>) {
  return {
    id: Number(row.id),
    version: Number(row.version ?? 1),
    ...adminQuestionSnapshot(row),
    reviewNote: String(row.review_note ?? ""),
    reviewedBy: row.reviewed_by == null ? null : Number(row.reviewed_by),
    reviewedAt: row.reviewed_at ? String(row.reviewed_at) : null,
    updatedAt: String(row.updated_at ?? ""),
    bankNames: String(row.bank_names ?? ""),
    bankId: row.bank_id == null ? null : Number(row.bank_id),
  };
}

async function adminSearchQuestions(payload: Record<string, unknown>) {
  if (!canAdmin(payload, "question.read")) return adminForbidden("question.read");
  const db = getD1();
  const query = trimmed(payload.query ?? payload.keyword, 100);
  const bankId = Math.floor(Number(payload.bankId));
  const limit = Math.max(1, Math.min(100, Math.floor(Number(payload.limit)) || 50));
  const conditions = ["1=1"];
  const binds: unknown[] = [];
  if (query) {
    conditions.push("(q.question_code LIKE ? OR q.stem LIKE ? OR q.source LIKE ? OR q.module LIKE ? OR q.sub_type LIKE ?)");
    const like = `%${query}%`;
    binds.push(like, like, like, like, like);
  }
  if (Number.isInteger(bankId) && bankId > 0) {
    conditions.push("EXISTS (SELECT 1 FROM question_bank_items scoped WHERE scoped.question_id = q.id AND scoped.bank_id = ?)");
    binds.push(bankId);
  }
  const rows = await db.prepare(`SELECT ${ADMIN_QUESTION_SELECT},
    (SELECT GROUP_CONCAT(DISTINCT qb.name) FROM question_bank_items qbi
      JOIN question_banks qb ON qb.id = qbi.bank_id WHERE qbi.question_id = q.id) AS bank_names,
    (SELECT MIN(qbi.bank_id) FROM question_bank_items qbi WHERE qbi.question_id = q.id) AS bank_id
    FROM questions q WHERE ${conditions.join(" AND ")}
    ORDER BY CASE q.status WHEN 'active' THEN 0 ELSE 1 END, q.id DESC LIMIT ?`)
    .bind(...binds, limit).all<Record<string, unknown>>();
  return json({ ok: true, questions: rows.results.map(adminQuestionSearchShape) });
}

function sameNumberList(left: unknown, right: number[]) {
  const normalized = Array.isArray(left) ? left.map(Number).filter(Number.isInteger) : [];
  return JSON.stringify(normalized) === JSON.stringify(right);
}

function safeAdminAssetUrl(value: unknown) {
  const url = trimmed(value, 500);
  return !url || /^(https?:\/\/|\/api\/app\?media=)/i.test(url) ? url : null;
}

async function adminUpsertQuestion(payload: Record<string, unknown>) {
  if (!canAdmin(payload, "question.write")) return adminForbidden("question.write");
  const admin = adminFromPayload(payload);
  const id = Math.floor(Number(payload.id));
  const expectedVersion = Math.floor(Number(payload.expectedVersion));
  if (!Number.isInteger(id) || id < 1) return json({ error: "要编辑的题目不存在" }, 400);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    return json({ error: "缺少题目版本，请刷新后再编辑" }, 409);
  }
  const input = payload.question && typeof payload.question === "object" && !Array.isArray(payload.question)
    ? payload.question as Record<string, unknown> : payload;
  const db = getD1();
  const current = await db.prepare(`SELECT ${ADMIN_QUESTION_SELECT} FROM questions q WHERE q.id = ?`)
    .bind(id).first<Record<string, unknown>>();
  if (!current) return json({ error: "要编辑的题目不存在" }, 404);
  if (Number(current.version ?? 1) !== expectedVersion) {
    return json({ error: `题目已被其他管理员更新（当前v${String(current.version)}），请刷新后重试`,
      code: "QUESTION_VERSION_CONFLICT", currentVersion: Number(current.version ?? 1) }, 409);
  }
  const currentSnapshot = adminQuestionSnapshot(current);
  const incomingQuestionCode = trimmed(input.questionCode ?? currentSnapshot.questionCode, 80).toUpperCase();
  if (incomingQuestionCode !== currentSnapshot.questionCode) {
    return json({ error: "题目编号创建后不可修改；如来源确需更换题号，请新建题目" }, 409);
  }

  const subject = trimmed(input.subject ?? currentSnapshot.subject, 10);
  const moduleName = trimmed(input.module ?? currentSnapshot.module, 40);
  const subType = trimmed(input.subType ?? currentSnapshot.subType, 40);
  const stem = trimmed(input.stem ?? currentSnapshot.stem, 12_000);
  const explanation = trimmed(input.explanation ?? currentSnapshot.explanation, 8_000);
  const technique = trimmed(input.technique ?? currentSnapshot.technique, 4_000);
  const material = trimmed(input.material ?? currentSnapshot.material, 12_000);
  const prompt = trimmed(input.prompt ?? currentSnapshot.prompt, 2_000);
  const source = trimmed(input.source ?? currentSnapshot.source, 120);
  const sourceExamType = trimmed(input.sourceExamType ?? currentSnapshot.sourceExamType, 40);
  const sourceBatch = trimmed(input.sourceBatch ?? currentSnapshot.sourceBatch, 80);
  const region = trimmed(input.region ?? currentSnapshot.region, 24).replace(/[·•]/g, "-");
  const examYear = Math.floor(Number(input.examYear ?? currentSnapshot.examYear));
  const options = Array.isArray(input.options)
    ? input.options.map((value) => trimmed(value, 2_000)).filter(Boolean).slice(0, 8)
    : currentSnapshot.options;
  const answer = trimmed(input.answer ?? currentSnapshot.answer, 8).toUpperCase() || null;
  const scoringPoints = Array.isArray(input.scoringPoints)
    ? input.scoringPoints.map((value) => trimmed(value, 500)).filter(Boolean).slice(0, 30)
    : currentSnapshot.scoringPoints;
  const wordInput = input.wordLimit ?? currentSnapshot.wordLimit;
  const wordLimit = wordInput == null || wordInput === "" ? null : Math.floor(Number(wordInput));
  const difficulty = trimmed(input.difficulty ?? currentSnapshot.difficulty, 10);
  const suggestedSeconds = Math.floor(Number(input.suggestedSeconds ?? currentSnapshot.suggestedSeconds));
  const imageUrl = safeAdminAssetUrl(input.imageUrl ?? currentSnapshot.imageUrl);
  const resourceUrl = safeAdminAssetUrl(input.resourceUrl ?? currentSnapshot.resourceUrl);
  if (!new Set(["行测", "申论"]).has(subject)) return json({ error: "科目只能是行测或申论" }, 400);
  if (!new Set(["national", "provincial", "special"]).has(sourceExamType)) return json({ error: "来源考试类型只能是national、provincial或special" }, 400);
  if (!moduleName || !stem || !source || !sourceBatch || !region) return json({ error: "模块、题干、来源、来源批次和地区均不能为空" }, 400);
  if (!Number.isInteger(examYear) || examYear < 1990 || examYear > new Date().getFullYear()) return json({ error: "真题年份无效" }, 400);
  if (!explanation) return json({ error: "解析/参考答案不能为空" }, 400);
  if (subject === "行测" && (options.length < 2 || !answer || !/^[A-H]$/.test(answer)
    || answer.charCodeAt(0) - 65 >= options.length)) return json({ error: "行测题的选项或正确答案不完整" }, 400);
  if (subject === "申论" && !prompt) return json({ error: "申论题必须填写作答任务" }, 400);
  if (wordLimit !== null && (!Number.isInteger(wordLimit) || wordLimit < 1 || wordLimit > 5_000)) return json({ error: "字数限制需为1—5000的整数" }, 400);
  if (!new Set(["简单", "中等", "较难"]).has(difficulty)) return json({ error: "难度取值无效" }, 400);
  if (!Number.isInteger(suggestedSeconds) || suggestedSeconds < 10 || suggestedSeconds > 3_600) return json({ error: "建议用时需为10—3600秒" }, 400);
  if (imageUrl === null || resourceUrl === null) return json({ error: "图片或资源地址仅支持HTTPS、HTTP或站内媒体地址" }, 400);

  const frequencyFieldsPresent = ["frequency", "frequencyOccurrences", "frequencyPapers", "frequencyYears", "frequencyUpdatedAt"]
    .some((key) => Object.prototype.hasOwnProperty.call(input, key));
  if (frequencyFieldsPresent) {
    const sameFrequency = String(input.frequency ?? currentSnapshot.frequency) === currentSnapshot.frequency
      && Number(input.frequencyOccurrences ?? currentSnapshot.frequencyOccurrences) === currentSnapshot.frequencyOccurrences
      && Number(input.frequencyPapers ?? currentSnapshot.frequencyPapers) === currentSnapshot.frequencyPapers
      && (!Object.prototype.hasOwnProperty.call(input, "frequencyYears") || sameNumberList(input.frequencyYears, currentSnapshot.frequencyYears))
      && String(input.frequencyUpdatedAt ?? currentSnapshot.frequencyUpdatedAt ?? "") === String(currentSnapshot.frequencyUpdatedAt ?? "");
    if (!sameFrequency) return json({ error: "考频由已审核真题试卷样本自动计算，不能在单题编辑中手工修改" }, 409);
  }

  let importanceStars = currentSnapshot.importanceStars;
  let importanceRuleVersion = currentSnapshot.importanceRuleVersion;
  let importanceReason = currentSnapshot.importanceReason;
  let importanceOverrideReason = currentSnapshot.importanceOverrideReason;
  if (Object.prototype.hasOwnProperty.call(input, "importanceStars")) {
    const proposedStars = Math.floor(Number(input.importanceStars));
    if (proposedStars !== currentSnapshot.importanceStars) {
      const overrideReason = trimmed(input.importanceOverrideReason, 500);
      if (!Number.isInteger(proposedStars) || proposedStars < 1 || proposedStars > 5) return json({ error: "人工调整的重要星级必须为1—5星" }, 400);
      if (overrideReason.length < 5) return json({ error: "人工调整重要星级时，必须填写至少5个字的覆盖理由" }, 400);
      importanceStars = proposedStars;
      importanceRuleVersion = "manual-v1";
      importanceReason = currentSnapshot.importanceReason || "管理员基于真题价值人工复核";
      importanceOverrideReason = overrideReason;
    }
  }
  if (Object.prototype.hasOwnProperty.call(input, "importanceOverrideReason")
    && trimmed(input.importanceOverrideReason, 500) !== currentSnapshot.importanceOverrideReason
    && importanceStars === currentSnapshot.importanceStars) {
    const proposedOverride = trimmed(input.importanceOverrideReason, 500);
    if (!proposedOverride && currentSnapshot.importanceOverrideReason) {
      return json({ error: "已有人工星级的覆盖理由不能直接清空；如需恢复系统计算，请重新运行题库指标计算" }, 409);
    }
    if (proposedOverride && (importanceStars < 1 || importanceStars > 5)) {
      return json({ error: "填写人工覆盖理由前，请先选择1—5星的重要星级" }, 400);
    }
    if (proposedOverride && proposedOverride.length < 5) return json({ error: "重要星级人工覆盖理由至少填写5个字" }, 400);
    if (proposedOverride) {
      importanceRuleVersion = "manual-v1";
      importanceReason = currentSnapshot.importanceReason || "管理员基于真题价值人工复核";
      importanceOverrideReason = proposedOverride;
    }
  }

  let scoreRate = currentSnapshot.scoreRate;
  let scoreRateCorrect = currentSnapshot.scoreRateCorrect;
  let scoreRateAttempts = currentSnapshot.scoreRateAttempts;
  let scoreRateScope = currentSnapshot.scoreRateScope;
  let scoreRateSource = currentSnapshot.scoreRateSource;
  let scoreRateUpdatedAt = currentSnapshot.scoreRateUpdatedAt;
  const scoreKeys = ["scoreRate", "scoreRateCorrect", "scoreRateAttempts", "scoreRateScope", "scoreRateSource", "scoreRateUpdatedAt"];
  const scoreFieldsPresent = scoreKeys.some((key) => Object.prototype.hasOwnProperty.call(input, key));
  if (scoreFieldsPresent) {
    const proposedSource = trimmed(input.scoreRateSource ?? currentSnapshot.scoreRateSource, 500) || "platform";
    const proposedCorrect = Math.max(0, Math.floor(Number(input.scoreRateCorrect ?? currentSnapshot.scoreRateCorrect)));
    const proposedAttempts = Math.max(0, Math.floor(Number(input.scoreRateAttempts ?? currentSnapshot.scoreRateAttempts)));
    const proposedRate = Math.round(Number(input.scoreRate ?? currentSnapshot.scoreRate));
    const proposedScope = trimmed(input.scoreRateScope ?? currentSnapshot.scoreRateScope, 120);
    const proposedUpdatedAt = trimmed(input.scoreRateUpdatedAt ?? currentSnapshot.scoreRateUpdatedAt, 40);
    const unchanged = proposedSource === currentSnapshot.scoreRateSource && proposedCorrect === currentSnapshot.scoreRateCorrect
      && proposedAttempts === currentSnapshot.scoreRateAttempts && proposedRate === currentSnapshot.scoreRate
      && proposedScope === currentSnapshot.scoreRateScope
      && proposedUpdatedAt === String(currentSnapshot.scoreRateUpdatedAt ?? "");
    if (!unchanged && proposedSource === "platform") {
      return json({ error: "平台拿分率只能由真实首答记录自动生成，不能在后台手工修改" }, 409);
    }
    if (!unchanged) {
      let sourceIsValid = false;
      try { sourceIsValid = new URL(proposedSource).protocol === "https:"; } catch { sourceIsValid = false; }
      const observedAt = Date.parse(proposedUpdatedAt);
      const calculatedRate = proposedAttempts > 0 ? Math.round(proposedCorrect * 100 / proposedAttempts) : 0;
      if (!sourceIsValid || proposedAttempts < 1 || proposedCorrect > proposedAttempts || !proposedScope
        || !Number.isFinite(observedAt) || observedAt > Date.now() || proposedRate !== calculatedRate) {
        return json({ error: "外部拿分率必须同时提供有效样本、统计范围、HTTPS来源和不晚于今天的统计日期，百分比由样本自动计算" }, 400);
      }
      scoreRate = calculatedRate;
      scoreRateCorrect = proposedCorrect;
      scoreRateAttempts = proposedAttempts;
      scoreRateScope = proposedScope;
      scoreRateSource = proposedSource;
      scoreRateUpdatedAt = new Date(observedAt).toISOString();
    }
  }

  const nextSnapshot = {
    questionCode: currentSnapshot.questionCode, subject, module: moduleName, subType, stem, options, answer,
    explanation, technique, material, prompt, wordLimit, scoringPoints, difficulty, source, sourceExamType,
    sourceBatch, region, examYear, truthVerified: false, reviewStatus: "pending_review",
    frequency: currentSnapshot.frequency, frequencyOccurrences: currentSnapshot.frequencyOccurrences,
    frequencyPapers: currentSnapshot.frequencyPapers, frequencyYears: currentSnapshot.frequencyYears,
    frequencyUpdatedAt: currentSnapshot.frequencyUpdatedAt, importanceStars, importanceRuleVersion,
    importanceReason, importanceOverrideReason, scoreRate, scoreRateCorrect, scoreRateAttempts, scoreRateScope,
    scoreRateSource, scoreRateUpdatedAt, suggestedSeconds, imageUrl, resourceUrl, status: currentSnapshot.status,
  };
  const comparable = (snapshot: Record<string, unknown>) => Object.fromEntries(Object.entries(snapshot)
    .filter(([key]) => !new Set(["truthVerified", "reviewStatus", "status"]).has(key)));
  if (JSON.stringify(comparable(currentSnapshot)) === JSON.stringify(comparable(nextSnapshot))) {
    return json({ ok: true, id, version: expectedVersion, unchanged: true, reviewStatus: currentSnapshot.reviewStatus });
  }

  await db.prepare(`INSERT OR IGNORE INTO question_versions
    (question_id, version, question_code, snapshot_json, change_type, admin_user_id, review_status)
    VALUES (?, ?, ?, ?, 'baseline', ?, ?)`)
    .bind(id, expectedVersion, currentSnapshot.questionCode, JSON.stringify(currentSnapshot), admin?.id ?? null, currentSnapshot.reviewStatus).run();
  const updateStatement = db.prepare(`UPDATE questions SET subject = ?, module = ?, sub_type = ?, stem = ?, options_json = ?,
    answer = ?, explanation = ?, technique = ?, material = ?, prompt = ?, word_limit = ?, scoring_points_json = ?,
    difficulty = ?, source = ?, source_exam_type = ?, source_region = ?, source_year = ?, source_batch = ?,
    truth_verified = 0, truth_verified_at = NULL, review_status = 'pending_review', reviewed_by = NULL,
    reviewed_at = NULL, review_note = '', importance_stars = ?, importance_rule_version = ?, importance_reason = ?,
    importance_override_reason = ?, score_rate = ?, score_rate_correct = ?, score_rate_attempts = ?, score_rate_scope = ?,
    score_rate_source = ?, score_rate_updated_at = ?, suggested_seconds = ?, image_url = ?, resource_url = ?,
    version = version + 1, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND version = ? AND ${QUESTION_NOT_LOCKED_BY_IMPORT_SQL}`)
    .bind(subject, moduleName, subType, stem, JSON.stringify(options), answer, explanation, technique, material, prompt,
      wordLimit, JSON.stringify(scoringPoints), difficulty, source, sourceExamType, region, examYear, sourceBatch,
      importanceStars, importanceRuleVersion, importanceReason, importanceOverrideReason, scoreRate, scoreRateCorrect,
      scoreRateAttempts, scoreRateScope, scoreRateSource, scoreRateUpdatedAt, suggestedSeconds, imageUrl, resourceUrl,
      id, expectedVersion);
  const nextVersion = expectedVersion + 1;
  const [updated] = await db.batch([
    updateStatement,
    abandonActiveSessionsByQuestionCode(db, currentSnapshot.questionCode,
      { questionId: id, version: nextVersion, reviewStatus: "pending_review" }),
    draftInvalidPublishedBanksForQuestion(db,
      { questionId: id, version: nextVersion, reviewStatus: "pending_review" }),
    abandonActiveSessionsForDraftedQuestionBanks(db,
      { questionId: id, version: nextVersion, reviewStatus: "pending_review" }),
    draftEssayLibraryPapersForQuestion(db,
      { questionId: id, version: nextVersion, reviewStatus: "pending_review" }),
    db.prepare(`INSERT OR IGNORE INTO question_versions
      (question_id, version, question_code, snapshot_json, change_type, from_version, admin_user_id, review_status)
      SELECT id, version, question_code, ?, 'edit', ?, ?, 'pending_review'
      FROM questions WHERE id = ? AND version = ?`)
      .bind(JSON.stringify(nextSnapshot), expectedVersion, admin?.id ?? null, id, nextVersion),
  ]);
  if (!updated.meta.changes) {
    const latest = await db.prepare("SELECT version FROM questions WHERE id = ?").bind(id).first<{ version: number }>();
    return json({ error: `题目已被其他管理员更新（当前v${String(latest?.version ?? "?")}），请刷新后重试`,
      code: "QUESTION_VERSION_CONFLICT", currentVersion: latest?.version ?? null }, 409);
  }
  return json({ ok: true, id, questionCode: currentSnapshot.questionCode, version: nextVersion,
    reviewStatus: "pending_review", truthVerified: false });
}

async function adminSetQuestionStatus(payload: Record<string, unknown>) {
  if (!canAdmin(payload, "question.write")) return adminForbidden("question.write");
  const admin = adminFromPayload(payload);
  const id = Math.floor(Number(payload.id));
  const expectedVersion = Math.floor(Number(payload.expectedVersion));
  const status = payload.status === "active" ? "active" : payload.status === "disabled" ? "disabled" : "";
  if (!Number.isInteger(id) || id < 1 || !status) return json({ error: "题目或目标状态无效" }, 400);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) return json({ error: "缺少题目版本，请刷新后重试" }, 409);
  const db = getD1();
  const current = await db.prepare(`SELECT ${ADMIN_QUESTION_SELECT} FROM questions q WHERE q.id = ?`)
    .bind(id).first<Record<string, unknown>>();
  if (!current) return json({ error: "题目不存在" }, 404);
  if (Number(current.version ?? 1) !== expectedVersion) {
    return json({ error: `题目已被其他管理员更新（当前v${String(current.version)}），请刷新后重试`,
      code: "QUESTION_VERSION_CONFLICT", currentVersion: Number(current.version ?? 1) }, 409);
  }
  const currentSnapshot = adminQuestionSnapshot(current);
  if (currentSnapshot.status === status) return json({ ok: true, id, status, version: expectedVersion, unchanged: true });
  await db.prepare(`INSERT OR IGNORE INTO question_versions
    (question_id, version, question_code, snapshot_json, change_type, admin_user_id, review_status)
    VALUES (?, ?, ?, ?, 'baseline', ?, ?)`)
    .bind(id, expectedVersion, currentSnapshot.questionCode, JSON.stringify(currentSnapshot), admin?.id ?? null, currentSnapshot.reviewStatus).run();
  const nextVersion = expectedVersion + 1;
  const nextSnapshot = { ...currentSnapshot, status };
  const statements = [
    db.prepare(`UPDATE questions SET status = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND version = ? AND ${QUESTION_NOT_LOCKED_BY_IMPORT_SQL}`).bind(status, id, expectedVersion),
  ];
  const statusPostState = { questionId: id, version: nextVersion, status };
  if (status === "disabled") statements.push(abandonActiveSessionsByQuestionCode(db, currentSnapshot.questionCode, statusPostState));
  statements.push(draftInvalidPublishedBanksForQuestion(db, statusPostState));
  statements.push(abandonActiveSessionsForDraftedQuestionBanks(db, statusPostState));
  statements.push(draftEssayLibraryPapersForQuestion(db, statusPostState));
  statements.push(db.prepare(`INSERT OR IGNORE INTO question_versions
    (question_id, version, question_code, snapshot_json, change_type, from_version, admin_user_id, review_status)
    SELECT id, version, question_code, ?, 'status', ?, ?, ? FROM questions WHERE id = ? AND version = ?`)
    .bind(JSON.stringify(nextSnapshot), expectedVersion, admin?.id ?? null, currentSnapshot.reviewStatus, id, nextVersion));
  const [updated] = await db.batch(statements);
  if (!updated.meta.changes) return json({ error: "题目版本已变化，请刷新后重试", code: "QUESTION_VERSION_CONFLICT" }, 409);
  return json({ ok: true, id, questionCode: currentSnapshot.questionCode, status, version: nextVersion });
}

type ContentImportRow = {
  rowIndex: number;
  contentKey: string;
  title: string;
  accessLevel: "free" | "member";
  payload: Record<string, unknown>;
};

type ContentImportError = {
  rowIndex: number;
  contentKey: string;
  kind: "validation" | "duplicate" | "conflict";
  message: string;
  rawJson: string;
};

function validHttpsUrl(value: unknown) {
  const candidate = trimmed(value, 500);
  if (!candidate) return false;
  try { return new URL(candidate).protocol === "https:"; } catch { return false; }
}

function validateContentImportRow(raw: unknown, contentType: string): { row?: ContentImportRow; error?: ContentImportError } {
  const input = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const rowIndex = Math.floor(Number(input.rowIndex));
  const contentKey = trimmed(input.contentKey, 80).toLowerCase();
  const title = trimmed(input.title, 120);
  const accessLevel = input.accessLevel === "free" ? "free" : "member";
  const payloadValue = input.payload;
  const fail = (message: string): { error: ContentImportError } => ({ error: {
    rowIndex: Number.isInteger(rowIndex) && rowIndex > 0 ? rowIndex : 0,
    contentKey,
    kind: "validation",
    message,
    rawJson: JSON.stringify(input).slice(0, 1_500),
  } });
  if (!Number.isInteger(rowIndex) || rowIndex < 1) return fail("源文件行号无效");
  if (!/^[a-z0-9][a-z0-9_-]{2,80}$/i.test(contentKey)) return fail("内容标识格式错误");
  if (!title) return fail("内容标题不能为空");
  if (!payloadValue || typeof payloadValue !== "object" || Array.isArray(payloadValue)) return fail("内容必须是结构化对象");
  // The canonical payload always carries the display title. Manual editing
  // already does this; importing now follows the same release-gate contract.
  const rowPayload = { ...(payloadValue as Record<string, unknown>), title };
  const payloadJson = JSON.stringify(rowPayload);
  if (payloadJson.length > 120_000) return fail("单条内容超过120KB限制");
  if (contentType === "job_position") {
    const required = [
      ["targetCode", "考试目标编码"], ["examName", "考试名称"], ["department", "招录机关/部门"],
      ["title", "职位名称"], ["code", "职位代码"], ["region", "工作地区"],
    ] as const;
    for (const [field, label] of required) if (!trimmed(rowPayload[field], 500)) return fail(`${label}不能为空`);
    const recruitCount = Number(rowPayload.recruitCount);
    if (!Number.isInteger(recruitCount) || recruitCount < 1 || recruitCount > 9_999) return fail("招录人数必须是1—9999的整数");
    const sourceUrl = trimmed(rowPayload.sourceUrl, 500);
    if (!validHttpsUrl(sourceUrl)) return fail("职位来源链接必须是可追溯的HTTPS地址");
    const dataVersion = Number(rowPayload.dataVersion);
    if (!Number.isInteger(dataVersion) || dataVersion < 1) return fail("职位数据版本必须是正整数");
    const updatedAt = trimmed(rowPayload.updatedAt, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(updatedAt) || updatedAt > chinaDateKey()) return fail("职位数据更新时间无效或晚于今天");
  }
  const publishIssues = validatePublishableContent(contentType, rowPayload);
  if (publishIssues.length) return fail(`未通过发布门禁：${publishIssues.join("；")}`);
  return { row: { rowIndex, contentKey, title, accessLevel, payload: rowPayload } };
}

async function persistContentImportErrors(importId: number, chunkIndex: number, errors: ContentImportError[]) {
  if (!errors.length) return;
  const encoded = JSON.stringify(errors);
  const db = getD1();
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO content_import_errors
      (import_id, chunk_index, row_index, content_key, kind, message, raw_json)
      SELECT ?, ?, CAST(json_extract(value, '$.rowIndex') AS INTEGER),
        COALESCE(json_extract(value, '$.contentKey'), ''), COALESCE(json_extract(value, '$.kind'), 'validation'),
        COALESCE(json_extract(value, '$.message'), '未知错误'), COALESCE(json_extract(value, '$.rawJson'), '{}')
      FROM json_each(?)`).bind(importId, chunkIndex, encoded),
    db.prepare(`INSERT OR IGNORE INTO content_import_row_results
      (import_id, row_index, chunk_index, status, content_key, message)
      SELECT ?, CAST(json_extract(value, '$.rowIndex') AS INTEGER), ?, 'failed',
        COALESCE(json_extract(value, '$.contentKey'), ''), COALESCE(json_extract(value, '$.message'), '未知错误')
      FROM json_each(?)`).bind(importId, chunkIndex, encoded),
  ]);
}

async function persistContentImportSkipped(importId: number, chunkIndex: number, rows: ContentImportError[]) {
  if (!rows.length) return;
  const encoded = JSON.stringify(rows);
  const db = getD1();
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO content_import_errors
      (import_id, chunk_index, row_index, content_key, kind, message, raw_json)
      SELECT ?, ?, CAST(json_extract(value, '$.rowIndex') AS INTEGER),
        COALESCE(json_extract(value, '$.contentKey'), ''), 'duplicate',
        COALESCE(json_extract(value, '$.message'), '按重复策略跳过'), COALESCE(json_extract(value, '$.rawJson'), '{}')
      FROM json_each(?)`).bind(importId, chunkIndex, encoded),
    db.prepare(`INSERT OR IGNORE INTO content_import_row_results
      (import_id, row_index, chunk_index, status, content_key, message)
      SELECT ?, CAST(json_extract(value, '$.rowIndex') AS INTEGER), ?, 'skipped',
        COALESCE(json_extract(value, '$.contentKey'), ''), COALESCE(json_extract(value, '$.message'), '按重复策略跳过')
      FROM json_each(?)`).bind(importId, chunkIndex, encoded),
  ]);
}

async function refreshContentImportProgress(importId: number) {
  const db = getD1();
  const summary = await db.prepare(`SELECT COUNT(*) AS processed_rows,
    COALESCE(SUM(CASE WHEN status = 'imported' THEN 1 ELSE 0 END), 0) AS imported_rows,
    COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed_rows
    FROM content_import_row_results WHERE import_id = ?`).bind(importId)
    .first<{ processed_rows: number; imported_rows: number; failed_rows: number }>();
  const chunks = await db.prepare(`SELECT COUNT(*) AS processed_chunks,
    COALESCE(SUM(duplicate_rows), 0) AS duplicate_rows,
    COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS system_failed_chunks,
    COALESCE(SUM(CASE WHEN status IN ('queued','processing') THEN 1 ELSE 0 END), 0) AS pending_chunks,
    COALESCE(SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END), 0) AS cancelled_chunks
    FROM content_import_chunks WHERE import_id = ? AND status IN ('completed','failed','cancelled','queued','processing')`)
    .bind(importId).first<Record<string, unknown>>();
  const job = await db.prepare("SELECT total_rows, total_chunks, cancel_requested FROM content_imports WHERE id = ?")
    .bind(importId).first<{ total_rows: number; total_chunks: number; cancel_requested: number }>();
  if (!job) return null;
  const processedRows = Number(summary?.processed_rows ?? 0);
  const importedRows = Number(summary?.imported_rows ?? 0);
  const failedRows = Number(summary?.failed_rows ?? 0);
  const pendingChunks = Number(chunks?.pending_chunks ?? 0);
  const systemFailedChunks = Number(chunks?.system_failed_chunks ?? 0);
  const cancelledChunks = Number(chunks?.cancelled_chunks ?? 0);
  const terminal = pendingChunks === 0;
  const status = Number(job.cancel_requested) === 1 && terminal
    ? "cancelled"
    : systemFailedChunks > 0 ? "failed"
      : terminal && processedRows >= Number(job.total_rows)
        ? failedRows > 0 ? "completed_with_errors" : "completed"
        : "processing";
  await db.prepare(`UPDATE content_imports SET processed_rows = ?, imported_rows = ?, failed_rows = ?,
    duplicate_rows = ?, processed_chunks = ?, status = ?, last_heartbeat_at = CURRENT_TIMESTAMP,
    completed_at = CASE WHEN ? IN ('completed','completed_with_errors','cancelled') THEN CURRENT_TIMESTAMP ELSE completed_at END,
    next_retry_at = CASE WHEN ? IN ('completed','completed_with_errors','cancelled','failed') THEN NULL ELSE next_retry_at END,
    updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .bind(processedRows, importedRows, failedRows, Number(chunks?.duplicate_rows ?? 0),
      Math.max(0, Number(job.total_chunks) - pendingChunks), status, status, status, importId).run();
  return { status, processedRows, importedRows, failedRows, pendingChunks, systemFailedChunks, cancelledChunks };
}

async function adminStartContentImport(payload: Record<string, unknown>) {
  const contentType = trimmed(payload.contentType, 40);
  const permission: AdminPermission = new Set(["exam_event", "exam_notice", "job_position"]).has(contentType) ? "radar.write" : "content.write";
  if (!canAdmin(payload, permission)) return adminForbidden(permission);
  if (!CONTENT_TYPES.has(contentType)) return json({ error: "不支持的内容导入类型" }, 400);
  const fileName = trimmed(payload.fileName, 160);
  const fileSize = Math.max(0, Math.floor(Number(payload.fileSize ?? 0)));
  const fileHash = trimmed(payload.fileHash, 64).toLowerCase();
  const totalRows = Math.max(0, Math.floor(Number(payload.totalRows ?? 0)));
  const totalChunks = Math.max(0, Math.floor(Number(payload.totalChunks ?? 0)));
  const sourceName = trimmed(payload.sourceName, 160);
  const sourceUrl = trimmed(payload.sourceUrl, 500);
  const sourcePublishedAt = trimmed(payload.sourcePublishedAt, 10) || null;
  const dataVersion = trimmed(payload.dataVersion, 80);
  const duplicateStrategy = trimmed(payload.duplicateStrategy, 30) || "reject";
  const metadata = payload.metadata && typeof payload.metadata === "object" && !Array.isArray(payload.metadata)
    ? payload.metadata as Record<string, unknown> : {};
  if (!/\.(xlsx|xls|csv)$/i.test(fileName)) return json({ error: "仅支持XLSX、XLS或CSV文件" }, 400);
  if (fileSize < 1 || fileSize > 30 * 1024 * 1024) return json({ error: "单个内容文件需在30MB以内" }, 400);
  if (!/^[a-f0-9]{64}$/.test(fileHash)) return json({ error: "文件指纹无效，请重新选择文件" }, 400);
  if (totalRows < 1 || totalRows > CONTENT_IMPORT_MAX_FILE_ROWS) return json({ error: "单个文件最多50000行" }, 400);
  if (totalChunks < 1 || totalChunks > CONTENT_IMPORT_MAX_CHUNKS || totalChunks > totalRows) {
    return json({ error: `文件最多拆成${CONTENT_IMPORT_MAX_CHUNKS}个持久化分块；内容过长时请按地区或部门拆分` }, 400);
  }
  if (!sourceName || !dataVersion || !validHttpsUrl(sourceUrl)) {
    return json({ error: "请填写数据来源名称、数据版本和可追溯的HTTPS官方来源" }, 400);
  }
  if (!CONTENT_IMPORT_DUPLICATE_STRATEGIES.has(duplicateStrategy)) {
    return json({ error: "请选择明确的重复处理策略：拒绝、跳过或仅更新草稿" }, 400);
  }
  if (sourcePublishedAt && (!/^\d{4}-\d{2}-\d{2}$/.test(sourcePublishedAt)
    || sourcePublishedAt > chinaDateKey())) {
    return json({ error: "来源发布日期需为不晚于今天的YYYY-MM-DD" }, 400);
  }
  const admin = adminFromPayload(payload);
  const db = getD1();
  const resumable = await db.prepare(`SELECT id, uploaded_rows, uploaded_chunks FROM content_imports
    WHERE content_type = ? AND file_hash = ? AND total_rows = ? AND total_chunks = ?
      AND source_name = ? AND source_url = ? AND data_version = ? AND status = 'uploading'
      AND duplicate_strategy = ?
      AND (created_by = ? OR (created_by IS NULL AND ? IS NULL))
    ORDER BY id DESC LIMIT 1`).bind(contentType, fileHash, totalRows, totalChunks, sourceName, sourceUrl,
      dataVersion, duplicateStrategy, admin?.id ?? null, admin?.id ?? null).first<Record<string, unknown>>();
  if (resumable) {
    return json({ ok: true, importId: Number(resumable.id), chunkSize: CONTENT_IMPORT_CHUNK_ROWS,
      totalChunks, status: "uploading", resumed: true, uploadedRows: Number(resumable.uploaded_rows ?? 0),
      uploadedChunks: Number(resumable.uploaded_chunks ?? 0) });
  }
  const inserted = await db.prepare(`INSERT INTO content_imports
    (content_type, file_name, file_size, file_hash, source_name, source_url, source_published_at,
      data_version, duplicate_strategy, metadata_json, total_rows, total_chunks, status, review_status,
      created_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploading', 'draft', ?, CURRENT_TIMESTAMP)`)
    .bind(contentType, fileName, fileSize, fileHash, sourceName, sourceUrl, sourcePublishedAt,
      dataVersion, duplicateStrategy, JSON.stringify(metadata).slice(0, 10_000), totalRows, totalChunks,
      admin?.id ?? null).run();
  return json({ ok: true, importId: Number(inserted.meta.last_row_id), chunkSize: CONTENT_IMPORT_CHUNK_ROWS,
    totalChunks, status: "uploading" });
}

async function adminUploadContentImportChunk(payload: Record<string, unknown>) {
  const importId = Math.floor(Number(payload.importId));
  const chunkIndex = Math.floor(Number(payload.chunkIndex));
  const rowOffset = Math.max(0, Math.floor(Number(payload.rowOffset ?? 0)));
  const fileHash = trimmed(payload.fileHash, 64).toLowerCase();
  const payloadHash = trimmed(payload.payloadHash, 64).toLowerCase();
  if (!Number.isInteger(importId) || importId < 1 || !Number.isInteger(chunkIndex) || chunkIndex < 0) {
    return json({ error: "内容导入分块无效" }, 400);
  }
  if (!Array.isArray(payload.rows) || payload.rows.length < 1 || payload.rows.length > CONTENT_IMPORT_CHUNK_ROWS) {
    return json({ error: `每个分块需包含1—${CONTENT_IMPORT_CHUNK_ROWS}行` }, 400);
  }
  if (!payload.rows.every((row, index) => row && typeof row === "object" && !Array.isArray(row)
    && Number((row as Record<string, unknown>).rowIndex) === rowOffset + index + 2)) {
    return json({ error: "分块行号必须与源文件顺序连续，首个数据行从第2行开始" }, 400);
  }
  const rowsJson = JSON.stringify(payload.rows);
  if (new TextEncoder().encode(rowsJson).byteLength > CONTENT_IMPORT_UPLOAD_BYTES) return json({ error: "分块超过700KB，请减小客户端分块" }, 413);
  if (!/^[a-f0-9]{64}$/.test(payloadHash) || await sha256Text(rowsJson) !== payloadHash) return json({ error: "分块指纹校验失败" }, 409);
  const db = getD1();
  const job = await db.prepare(`SELECT id, content_type, file_hash, total_rows, total_chunks, status
    FROM content_imports WHERE id = ?`).bind(importId).first<Record<string, unknown>>();
  if (!job) return json({ error: "内容导入任务不存在" }, 404);
  const permission: AdminPermission = new Set(["exam_event", "exam_notice", "job_position"]).has(String(job.content_type)) ? "radar.write" : "content.write";
  if (!canAdmin(payload, permission)) return adminForbidden(permission);
  if (String(job.file_hash) !== fileHash) return json({ error: "文件与任务指纹不一致" }, 409);
  if (String(job.status) !== "uploading") return json({ error: "任务已封存，不能继续上传分块" }, 409);
  if (chunkIndex >= Number(job.total_chunks) || rowOffset + payload.rows.length > Number(job.total_rows)) return json({ error: "分块范围超出任务声明" }, 400);
  const existing = await db.prepare(`SELECT payload_hash, row_offset, row_count FROM content_import_chunks
    WHERE import_id = ? AND chunk_index = ?`).bind(importId, chunkIndex)
    .first<{ payload_hash: string; row_offset: number; row_count: number }>();
  if (existing && (existing.payload_hash !== payloadHash || Number(existing.row_offset) !== rowOffset
    || Number(existing.row_count) !== payload.rows.length)) {
    return json({ error: "同一分块序号已上传不同内容；请取消后重新导入" }, 409);
  }
  if (!existing) {
    await db.batch([
      db.prepare(`INSERT INTO content_import_chunks
        (import_id, chunk_index, row_offset, row_count, payload_hash, rows_json, status, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'queued', CURRENT_TIMESTAMP)`)
        .bind(importId, chunkIndex, rowOffset, payload.rows.length, payloadHash, rowsJson),
      db.prepare(`INSERT OR IGNORE INTO content_import_keys (import_id, row_index, content_key)
        SELECT ?, CAST(json_extract(value, '$.rowIndex') AS INTEGER), lower(trim(json_extract(value, '$.contentKey')))
        FROM json_each(?) WHERE CAST(json_extract(value, '$.rowIndex') AS INTEGER) > 0
          AND trim(COALESCE(json_extract(value, '$.contentKey'), '')) <> ''`)
        .bind(importId, rowsJson),
    ]);
  }
  const totals = await db.prepare(`SELECT COUNT(*) AS chunks, COALESCE(SUM(row_count), 0) AS rows
    FROM content_import_chunks WHERE import_id = ?`).bind(importId).first<{ chunks: number; rows: number }>();
  await db.prepare(`UPDATE content_imports SET uploaded_chunks = ?, uploaded_rows = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .bind(Number(totals?.chunks ?? 0), Number(totals?.rows ?? 0), importId).run();
  return json({ ok: true, importId, chunkIndex, uploadedChunks: Number(totals?.chunks ?? 0), uploadedRows: Number(totals?.rows ?? 0) });
}

async function processContentImportChunk(importId: number, chunkIndex: number) {
  const db = getD1();
  const chunk = await db.prepare(`SELECT cic.id, cic.import_id, cic.chunk_index, cic.row_offset, cic.row_count,
      cic.rows_json, cic.status, cic.lease_until, ci.content_type, ci.cancel_requested, ci.created_by,
      ci.source_name, ci.source_url, ci.source_published_at, ci.data_version, ci.duplicate_strategy, ci.metadata_json
    FROM content_import_chunks cic JOIN content_imports ci ON ci.id = cic.import_id
    WHERE cic.import_id = ? AND cic.chunk_index = ?`).bind(importId, chunkIndex).first<Record<string, unknown>>();
  if (!chunk || new Set(["completed", "cancelled"]).has(String(chunk.status))) return;
  if (Number(chunk.cancel_requested) === 1) {
    await db.prepare(`UPDATE content_import_chunks SET status = 'cancelled', lease_token = NULL, lease_until = NULL,
      rows_json = '[]', updated_at = CURRENT_TIMESTAMP, completed_at = CURRENT_TIMESTAMP WHERE id = ? AND status <> 'completed'`)
      .bind(Number(chunk.id)).run();
    await refreshContentImportProgress(importId);
    return;
  }
  const leaseToken = crypto.randomUUID();
  const claimed = await db.prepare(`UPDATE content_import_chunks SET status = 'processing', attempts = attempts + 1,
    lease_token = ?, lease_until = datetime('now','+2 minutes'), updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND (status = 'queued' OR (status = 'processing' AND datetime(lease_until) <= CURRENT_TIMESTAMP))`)
    .bind(leaseToken, Number(chunk.id)).run();
  if (!claimed.meta.changes) return;
  try {
    const contentType = String(chunk.content_type);
    const rawRows = JSON.parse(String(chunk.rows_json)) as unknown[];
    if (!Array.isArray(rawRows) || rawRows.length !== Number(chunk.row_count)) throw new Error("持久化分块行数与声明不一致");
    // A Worker can be evicted after the atomic content/version/result batch
    // commits but before the chunk status is marked completed. Excluding rows
    // that already have a durable result makes lease recovery idempotent: an
    // update is never applied twice and no duplicate content version is made.
    const completed = await db.prepare(`SELECT row_index FROM content_import_row_results
      WHERE import_id = ? AND chunk_index = ?`).bind(importId, chunkIndex).all<{ row_index: number }>();
    const completedRows = new Set(completed.results.map((item) => Number(item.row_index)));
    const reservations = await db.prepare(`SELECT cik.row_index, cik.content_key FROM content_import_keys cik
      JOIN json_each(?) incoming ON cik.row_index = CAST(json_extract(incoming.value, '$.rowIndex') AS INTEGER)
      WHERE cik.import_id = ?`).bind(String(chunk.rows_json), importId).all<{ row_index: number; content_key: string }>();
    const reservationMap = new Map(reservations.results.map((item) => [Number(item.row_index), String(item.content_key)]));
    const valid: ContentImportRow[] = [];
    const errors: ContentImportError[] = [];
    const skipped: ContentImportError[] = [];
    const duplicateStrategy = String(chunk.duplicate_strategy ?? "reject");
    for (const raw of rawRows) {
      const durableRowIndex = Number(raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, unknown>).rowIndex : 0);
      if (completedRows.has(durableRowIndex)) continue;
      const validated = validateContentImportRow(raw, contentType);
      if (validated.error) { errors.push(validated.error); continue; }
      const row = validated.row!;
      if (reservationMap.get(row.rowIndex) !== row.contentKey) {
        const duplicate = { rowIndex: row.rowIndex, contentKey: row.contentKey, kind: "duplicate" as const,
          message: "同一文件内内容标识重复，仅保留首次出现的行", rawJson: JSON.stringify(raw).slice(0, 1_500) };
        if (duplicateStrategy === "skip") skipped.push(duplicate); else errors.push(duplicate);
        continue;
      }
      valid.push(row);
    }
    await persistContentImportErrors(importId, chunkIndex, errors);
    await persistContentImportSkipped(importId, chunkIndex, skipped);
    const accepted: Array<Record<string, unknown>> = [];
    if (valid.length) {
      const validJson = JSON.stringify(valid);
      const existing = await db.prepare(`SELECT ci.id, ci.content_type, ci.content_key, ci.title, ci.payload_json,
        ci.access_level, ci.status, ci.publish_at, ci.version
        FROM content_items ci JOIN json_each(?) incoming
          ON ci.content_key = json_extract(incoming.value, '$.contentKey')`)
        .bind(validJson).all<Record<string, unknown>>();
      const existingMap = new Map(existing.results.map((item) => [String(item.content_key), item]));
      for (const row of valid) {
        const current = existingMap.get(row.contentKey);
        if (current && String(current.content_type) !== contentType) {
          errors.push({ rowIndex: row.rowIndex, contentKey: row.contentKey, kind: "conflict",
            message: "内容标识已属于其他业务类型；内容身份创建后不可修改", rawJson: JSON.stringify(row).slice(0, 1_500) });
          continue;
        }
        if (current && duplicateStrategy === "reject") {
          errors.push({ rowIndex: row.rowIndex, contentKey: row.contentKey, kind: "duplicate",
            message: "内容标识已存在；本任务选择了“拒绝重复”策略", rawJson: JSON.stringify(row).slice(0, 1_500) });
          continue;
        }
        if (current && duplicateStrategy === "skip") {
          skipped.push({ rowIndex: row.rowIndex, contentKey: row.contentKey, kind: "duplicate",
            message: "内容标识已存在；已按“跳过重复”策略保留现有内容", rawJson: JSON.stringify(row).slice(0, 1_500) });
          continue;
        }
        if (current && !new Set(["draft", "rejected"]).has(String(current.status))) {
          errors.push({ rowIndex: row.rowIndex, contentKey: row.contentKey, kind: "conflict",
            message: `现有内容处于${String(current.status)}状态，批量导入不得绕过版本审核覆盖；请复制为新内容或先完成当前流程`,
            rawJson: JSON.stringify(row).slice(0, 1_500) });
          continue;
        }
        const expectedVersion = current ? Math.max(1, Number(current.version ?? 1)) : 0;
        const payloadWithProvenance = {
          ...row.payload,
          importSource: {
            importId,
            dataVersion: String(chunk.data_version ?? ""),
          },
        };
        accepted.push({ importId, rowIndex: row.rowIndex, contentKey: row.contentKey, title: row.title,
          accessLevel: row.accessLevel, payloadJson: JSON.stringify(payloadWithProvenance), mode: current ? "update" : "create",
          expectedVersion, nextVersion: current ? expectedVersion + 1 : 1 });
      }
      // The first persistence pass already stored validation/duplicate rows;
      // persist only conflict rows added during existing-content checks.
      await persistContentImportErrors(importId, chunkIndex,
        errors.filter((item) => item.kind === "conflict" || item.kind === "duplicate"));
      await persistContentImportSkipped(importId, chunkIndex, skipped);
    }
    if (accepted.length) {
      const acceptedJson = JSON.stringify(accepted);
      if (new TextEncoder().encode(acceptedJson).byteLength > CONTENT_IMPORT_UPLOAD_BYTES + 64 * 1024) {
        throw new Error("规范化内容分块超过绑定上限，请减小客户端分块");
      }
      await db.batch([
        db.prepare(`INSERT OR IGNORE INTO content_item_versions
          (content_id, version, content_type, content_key, title, payload_json, access_level, status, publish_at, change_type)
          SELECT ci.id, ci.version, ci.content_type, ci.content_key, ci.title, ci.payload_json,
            ci.access_level, ci.status, ci.publish_at, 'snapshot'
          FROM json_each(?) incoming JOIN content_items ci
            ON ci.content_key = json_extract(incoming.value, '$.contentKey')
          WHERE json_extract(incoming.value, '$.mode') = 'update'
            AND ci.version = CAST(json_extract(incoming.value, '$.expectedVersion') AS INTEGER)
            AND NOT EXISTS (SELECT 1 FROM content_import_row_results cir
              WHERE cir.import_id = CAST(json_extract(incoming.value, '$.importId') AS INTEGER)
                AND cir.row_index = CAST(json_extract(incoming.value, '$.rowIndex') AS INTEGER))
            AND ${CONTENT_IMPORT_WRITE_GUARD_SQL}`)
          .bind(acceptedJson, Number(chunk.id), leaseToken, importId),
        db.prepare(`INSERT OR IGNORE INTO content_items
          (content_type, content_key, title, payload_json, access_level, status, publish_at, version,
            review_note, submitted_by, submitted_at, reviewed_by, reviewed_at, updated_at)
          SELECT ?, json_extract(incoming.value, '$.contentKey'), json_extract(incoming.value, '$.title'),
            json_extract(incoming.value, '$.payloadJson'), json_extract(incoming.value, '$.accessLevel'),
            'draft', NULL, 1, '', NULL, NULL, NULL, NULL, CURRENT_TIMESTAMP
          FROM json_each(?) incoming WHERE json_extract(incoming.value, '$.mode') = 'create'
            AND NOT EXISTS (SELECT 1 FROM content_import_row_results cir
              WHERE cir.import_id = CAST(json_extract(incoming.value, '$.importId') AS INTEGER)
                AND cir.row_index = CAST(json_extract(incoming.value, '$.rowIndex') AS INTEGER))
            AND ${CONTENT_IMPORT_WRITE_GUARD_SQL}`)
          .bind(contentType, acceptedJson, Number(chunk.id), leaseToken, importId),
        db.prepare(`UPDATE content_items AS target SET
            title = json_extract(incoming.value, '$.title'),
            payload_json = json_extract(incoming.value, '$.payloadJson'),
            access_level = json_extract(incoming.value, '$.accessLevel'), status = 'draft', publish_at = NULL,
            review_note = '', submitted_by = NULL, submitted_at = NULL, reviewed_by = NULL, reviewed_at = NULL,
            version = target.version + 1, updated_at = CURRENT_TIMESTAMP
          FROM json_each(?) incoming
          WHERE json_extract(incoming.value, '$.mode') = 'update'
            AND target.content_key = json_extract(incoming.value, '$.contentKey')
            AND target.content_type = ? AND target.status IN ('draft','rejected')
            AND target.version = CAST(json_extract(incoming.value, '$.expectedVersion') AS INTEGER)
            AND NOT EXISTS (SELECT 1 FROM content_import_row_results cir
              WHERE cir.import_id = CAST(json_extract(incoming.value, '$.importId') AS INTEGER)
                AND cir.row_index = CAST(json_extract(incoming.value, '$.rowIndex') AS INTEGER))
            AND ${CONTENT_IMPORT_WRITE_GUARD_SQL}`)
          .bind(acceptedJson, contentType, Number(chunk.id), leaseToken, importId),
        db.prepare(`INSERT OR IGNORE INTO content_item_versions
          (content_id, version, content_type, content_key, title, payload_json, access_level, status, publish_at, change_type)
          SELECT ci.id, ci.version, ci.content_type, ci.content_key, ci.title, ci.payload_json,
            ci.access_level, ci.status, ci.publish_at,
            CASE json_extract(incoming.value, '$.mode') WHEN 'create' THEN 'import_create' ELSE 'import' END
          FROM json_each(?) incoming JOIN content_items ci
            ON ci.content_key = json_extract(incoming.value, '$.contentKey')
          WHERE ci.content_type = ? AND ci.status = 'draft'
            AND ci.version = CAST(json_extract(incoming.value, '$.nextVersion') AS INTEGER)
            AND ci.title = json_extract(incoming.value, '$.title')
            AND ci.payload_json = json_extract(incoming.value, '$.payloadJson')
            AND NOT EXISTS (SELECT 1 FROM content_import_row_results cir
              WHERE cir.import_id = CAST(json_extract(incoming.value, '$.importId') AS INTEGER)
                AND cir.row_index = CAST(json_extract(incoming.value, '$.rowIndex') AS INTEGER))
            AND ${CONTENT_IMPORT_WRITE_GUARD_SQL}`)
          .bind(acceptedJson, contentType, Number(chunk.id), leaseToken, importId),
        db.prepare(`INSERT OR IGNORE INTO content_import_row_results
          (import_id, row_index, chunk_index, status, content_key, content_version)
          SELECT ?, CAST(json_extract(incoming.value, '$.rowIndex') AS INTEGER), ?, 'imported',
            ci.content_key, ci.version
          FROM json_each(?) incoming JOIN content_items ci
            ON ci.content_key = json_extract(incoming.value, '$.contentKey')
          WHERE ci.content_type = ? AND ci.status = 'draft'
            AND ci.version = CAST(json_extract(incoming.value, '$.nextVersion') AS INTEGER)
            AND ci.title = json_extract(incoming.value, '$.title')
            AND ci.payload_json = json_extract(incoming.value, '$.payloadJson')
            AND ${CONTENT_IMPORT_WRITE_GUARD_SQL}`)
          .bind(importId, chunkIndex, acceptedJson, contentType, Number(chunk.id), leaseToken, importId),
      ]);
      const persisted = await db.prepare(`SELECT row_index FROM content_import_row_results
        WHERE import_id = ? AND chunk_index = ?`).bind(importId, chunkIndex).all<{ row_index: number }>();
      const persistedRows = new Set(persisted.results.map((item) => Number(item.row_index)));
      const versionConflicts = accepted.filter((item) => !persistedRows.has(Number(item.rowIndex))).map((item) => ({
        rowIndex: Number(item.rowIndex), contentKey: String(item.contentKey), kind: "conflict" as const,
        message: "处理期间内容版本发生变化，本行未覆盖新版本；请刷新后重新导入",
        rawJson: JSON.stringify(item).slice(0, 1_500),
      }));
      await persistContentImportErrors(importId, chunkIndex, versionConflicts);
    }
    const counts = await db.prepare(`SELECT COUNT(*) AS processed,
      COALESCE(SUM(CASE WHEN status = 'imported' THEN 1 ELSE 0 END), 0) AS imported,
      COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
      (SELECT COUNT(*) FROM content_import_errors cie WHERE cie.import_id = ? AND cie.chunk_index = ? AND cie.kind = 'duplicate') AS duplicates
      FROM content_import_row_results WHERE import_id = ? AND chunk_index = ?`)
      .bind(importId, chunkIndex, importId, chunkIndex).first<Record<string, unknown>>();
    if (Number(counts?.processed ?? 0) !== Number(chunk.row_count)) throw new Error("分块行级结果不完整，可安全重试");
    await db.prepare(`UPDATE content_import_chunks SET status = 'completed', imported_rows = ?, failed_rows = ?,
      duplicate_rows = ?, error_summary = '', lease_token = NULL, lease_until = NULL,
      rows_json = '[]', updated_at = CURRENT_TIMESTAMP, completed_at = CURRENT_TIMESTAMP WHERE id = ? AND lease_token = ?`)
      .bind(Number(counts?.imported ?? 0), Number(counts?.failed ?? 0), Number(counts?.duplicates ?? 0),
        Number(chunk.id), leaseToken).run();
    await refreshContentImportProgress(importId);
  } catch (error) {
    const message = (error instanceof Error ? error.message : "后台内容分块处理失败").slice(0, 1_000);
    await db.batch([
      // Cancellation and failure share this catch path. Seal cancellation first,
      // while the exact chunk lease still proves that this Worker owns the
      // transition. Keeping the token for one statement gives the following
      // job update a durable, transaction-local ownership marker.
      db.prepare(`UPDATE content_import_chunks SET status = 'cancelled', error_summary = '',
        lease_until = NULL, rows_json = '[]', updated_at = CURRENT_TIMESTAMP,
        completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP)
        WHERE id = ? AND import_id = ? AND status = 'processing' AND lease_token = ?
          AND EXISTS (SELECT 1 FROM content_imports cancelling_job WHERE cancelling_job.id = ?
            AND (cancelling_job.cancel_requested = 1 OR cancelling_job.status = 'cancelling'))`)
        .bind(Number(chunk.id), importId, leaseToken, importId),
      db.prepare(`UPDATE content_imports SET status = 'cancelled', error_summary = '', next_retry_at = NULL,
        last_heartbeat_at = CURRENT_TIMESTAMP, completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP),
        updated_at = CURRENT_TIMESTAMP WHERE id = ?
          AND (cancel_requested = 1 OR status = 'cancelling')
          AND EXISTS (SELECT 1 FROM content_import_chunks owned_chunk
            WHERE owned_chunk.id = ? AND owned_chunk.import_id = ?
              AND owned_chunk.status = 'cancelled' AND owned_chunk.lease_token = ?)`)
        .bind(importId, Number(chunk.id), importId, leaseToken),
      db.prepare(`UPDATE content_import_chunks SET status = 'cancelled', error_summary = '',
        lease_token = NULL, lease_until = NULL, rows_json = '[]',
        updated_at = CURRENT_TIMESTAMP, completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP)
        WHERE import_id = ? AND status IN ('queued','processing','cancelled')
          AND EXISTS (SELECT 1 FROM content_imports cancelled_job
            WHERE cancelled_job.id = ? AND cancelled_job.status = 'cancelled')`)
        .bind(importId, importId),
      // If cancellation did not claim the lease, fail only an active job whose
      // exact processing lease is still ours. A stale Worker can therefore
      // change neither the replacement chunk nor the parent job.
      db.prepare(`UPDATE content_import_chunks SET status = 'failed', error_summary = ?,
        lease_until = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND import_id = ? AND status = 'processing' AND lease_token = ?
          AND EXISTS (SELECT 1 FROM content_imports active_job WHERE active_job.id = ?
            AND active_job.cancel_requested = 0 AND active_job.status IN ('queued','processing'))`)
        .bind(message, Number(chunk.id), importId, leaseToken, importId),
      db.prepare(`UPDATE content_imports SET status = 'failed', error_summary = ?, next_retry_at = NULL,
        last_heartbeat_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?
          AND cancel_requested = 0 AND status IN ('queued','processing')
          AND EXISTS (SELECT 1 FROM content_import_chunks owned_chunk
            WHERE owned_chunk.id = ? AND owned_chunk.import_id = ?
              AND owned_chunk.status = 'failed' AND owned_chunk.lease_token = ?)`)
        .bind(`分块${chunkIndex + 1}：${message}`, importId, Number(chunk.id), importId, leaseToken),
      db.prepare(`UPDATE content_import_chunks SET lease_token = NULL, lease_until = NULL,
        updated_at = CURRENT_TIMESTAMP WHERE id = ? AND import_id = ?
          AND status = 'failed' AND lease_token = ?
          AND EXISTS (SELECT 1 FROM content_imports failed_job
            WHERE failed_job.id = ? AND failed_job.cancel_requested = 0 AND failed_job.status = 'failed')`)
        .bind(Number(chunk.id), importId, leaseToken, importId),
    ]);
  }
}

async function adminFinishContentImport(request: Request, payload: Record<string, unknown>) {
  const importId = Math.floor(Number(payload.importId));
  const db = getD1();
  const job = await db.prepare(`SELECT id, content_type, total_rows, total_chunks, uploaded_rows, uploaded_chunks, status
    FROM content_imports WHERE id = ?`).bind(importId).first<Record<string, unknown>>();
  if (!job) return json({ error: "内容导入任务不存在" }, 404);
  const permission: AdminPermission = new Set(["exam_event", "exam_notice", "job_position"]).has(String(job.content_type)) ? "radar.write" : "content.write";
  if (!canAdmin(payload, permission)) return adminForbidden(permission);
  if (String(job.status) !== "uploading") return json({ error: "任务已经封存或处理" }, 409);
  const integrity = await db.prepare(`WITH ordered AS (
      SELECT chunk_index, row_offset, row_count,
        ROW_NUMBER() OVER (ORDER BY chunk_index) - 1 AS expected_index,
        COALESCE(SUM(row_count) OVER (
          ORDER BY chunk_index ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
        ), 0) AS expected_offset
      FROM content_import_chunks WHERE import_id = ?
    )
    SELECT COUNT(*) AS chunks, COALESCE(SUM(row_count), 0) AS rows,
      COALESCE(SUM(CASE WHEN chunk_index <> expected_index THEN 1 ELSE 0 END), 0) AS bad_indexes,
      COALESCE(SUM(CASE WHEN row_offset <> expected_offset OR row_count < 1 THEN 1 ELSE 0 END), 0) AS bad_ranges,
      COALESCE(MAX(row_offset + row_count), 0) AS final_offset
    FROM ordered`)
    .bind(importId).first<Record<string, unknown>>();
  if (Number(integrity?.chunks ?? 0) !== Number(job.total_chunks)
    || Number(integrity?.rows ?? 0) !== Number(job.total_rows)
    || Number(integrity?.bad_indexes ?? 0) !== 0 || Number(integrity?.bad_ranges ?? 0) !== 0
    || Number(integrity?.final_offset ?? -1) !== Number(job.total_rows)) {
    return json({ error: "文件分块序号或行区间不连续（存在缺口/重叠），不能封存" }, 409);
  }
  await db.prepare(`UPDATE content_imports SET status = 'queued', sealed_at = CURRENT_TIMESTAMP,
    started_at = COALESCE(started_at, CURRENT_TIMESTAMP), last_heartbeat_at = CURRENT_TIMESTAMP,
    dispatch_attempts = 0, next_retry_at = CURRENT_TIMESTAMP,
    updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'uploading'`).bind(importId).run();
  const origin = new URL(request.url).origin;
  const schedule = () => requestContentImportFanout(importId, Number(job.total_chunks), origin);
  const backgroundScheduled = scheduleRequestTask(request, schedule) || await schedule();
  await db.prepare(`UPDATE content_imports SET dispatch_attempts = dispatch_attempts + 1,
    next_retry_at = datetime('now', ?), updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('queued','processing')`)
    .bind(backgroundScheduled ? "+1 minute" : "+15 seconds", importId).run();
  return json({ ok: true, importId, status: "queued", backgroundScheduled });
}

async function adminGetContentImport(request: Request, payload: Record<string, unknown>) {
  const importId = Math.floor(Number(payload.importId));
  const db = getD1();
  let job = await db.prepare("SELECT * FROM content_imports WHERE id = ?").bind(importId).first<Record<string, unknown>>();
  if (!job) return json({ error: "内容导入任务不存在" }, 404);
  const permission: AdminPermission = new Set(["exam_event", "exam_notice", "job_position"]).has(String(job.content_type)) ? "radar.read" : "content.read";
  if (!canAdmin(payload, permission)) return adminForbidden(permission);
  await db.prepare(`UPDATE content_import_chunks SET status = 'queued', lease_token = NULL, lease_until = NULL,
    updated_at = CURRENT_TIMESTAMP WHERE import_id = ? AND status = 'processing'
      AND datetime(lease_until) <= CURRENT_TIMESTAMP`).bind(importId).run();
  const progress = await refreshContentImportProgress(importId);
  job = await db.prepare("SELECT * FROM content_imports WHERE id = ?").bind(importId).first<Record<string, unknown>>();
  if (job && new Set(["queued", "processing"]).has(String(job.status)) && Number(progress?.pendingChunks ?? 0) > 0) {
    scheduleRequestTask(request, () => requestContentImportFanout(importId, Number(job?.total_chunks ?? 0), new URL(request.url).origin));
  }
  const chunks = await db.prepare(`SELECT chunk_index, row_offset, row_count, status, attempts, imported_rows,
    failed_rows, duplicate_rows, error_summary, updated_at, completed_at
    FROM content_import_chunks WHERE import_id = ? ORDER BY chunk_index`).bind(importId).all();
  return json({ ok: true, import: job, chunks: chunks.results });
}

async function adminCancelContentImport(payload: Record<string, unknown>) {
  const importId = Math.floor(Number(payload.importId));
  const db = getD1();
  const job = await db.prepare("SELECT content_type, status FROM content_imports WHERE id = ?").bind(importId).first<Record<string, unknown>>();
  if (!job) return json({ error: "内容导入任务不存在" }, 404);
  const permission: AdminPermission = new Set(["exam_event", "exam_notice", "job_position"]).has(String(job.content_type)) ? "radar.write" : "content.write";
  if (!canAdmin(payload, permission)) return adminForbidden(permission);
  if (new Set(["completed", "completed_with_errors", "cancelled"]).has(String(job.status))) return json({ error: "任务已经结束" }, 409);
  await db.batch([
    db.prepare(`UPDATE content_imports SET cancel_requested = 1, status = 'cancelling', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(importId),
    db.prepare(`UPDATE content_import_chunks SET status = 'cancelled', completed_at = CURRENT_TIMESTAMP,
      rows_json = '[]', updated_at = CURRENT_TIMESTAMP WHERE import_id = ? AND status = 'queued'`).bind(importId),
  ]);
  await refreshContentImportProgress(importId);
  return json({ ok: true, importId, status: "cancelling" });
}

async function adminRetryContentImport(request: Request, payload: Record<string, unknown>) {
  const importId = Math.floor(Number(payload.importId));
  const db = getD1();
  const job = await db.prepare("SELECT content_type, total_chunks, status FROM content_imports WHERE id = ?")
    .bind(importId).first<Record<string, unknown>>();
  if (!job) return json({ error: "内容导入任务不存在" }, 404);
  const permission: AdminPermission = new Set(["exam_event", "exam_notice", "job_position"]).has(String(job.content_type)) ? "radar.write" : "content.write";
  if (!canAdmin(payload, permission)) return adminForbidden(permission);
  if (String(job.status) !== "failed") return json({ error: "只有系统处理失败的任务可以安全重试；数据校验错误请修正文件后新建任务" }, 409);
  const reset = await db.prepare(`UPDATE content_import_chunks SET status = 'queued', error_summary = '',
    lease_token = NULL, lease_until = NULL, completed_at = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE import_id = ? AND (status = 'failed' OR (status = 'processing' AND datetime(lease_until) <= CURRENT_TIMESTAMP))`)
    .bind(importId).run();
  if (!reset.meta.changes) return json({ error: "没有可安全重试的失败分块" }, 409);
  await db.prepare(`UPDATE content_imports SET status = 'queued', cancel_requested = 0, error_summary = '',
    completed_at = NULL, next_retry_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(importId).run();
  const origin = new URL(request.url).origin;
  const schedule = () => requestContentImportFanout(importId, Number(job.total_chunks), origin);
  const backgroundScheduled = scheduleRequestTask(request, schedule) || await schedule();
  await db.prepare(`UPDATE content_imports SET dispatch_attempts = dispatch_attempts + 1,
    next_retry_at = datetime('now', ?), updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('queued','processing')`)
    .bind(backgroundScheduled ? "+1 minute" : "+15 seconds", importId).run();
  return json({ ok: true, importId, status: "queued", backgroundScheduled });
}

async function adminDownloadContentImportErrors(payload: Record<string, unknown>) {
  const importId = Math.floor(Number(payload.importId));
  const offset = Math.max(0, Math.floor(Number(payload.offset ?? 0)));
  const db = getD1();
  const job = await db.prepare("SELECT content_type, file_name FROM content_imports WHERE id = ?")
    .bind(importId).first<{ content_type: string; file_name: string }>();
  if (!job) return json({ error: "内容导入任务不存在" }, 404);
  const permission: AdminPermission = new Set(["exam_event", "exam_notice", "job_position"]).has(job.content_type) ? "radar.read" : "content.read";
  if (!canAdmin(payload, permission)) return adminForbidden(permission);
  const limit = 1_000;
  const [rows, total] = await Promise.all([
    db.prepare(`SELECT row_index, content_key, kind, message FROM content_import_errors
      WHERE import_id = ? ORDER BY row_index LIMIT ? OFFSET ?`).bind(importId, limit, offset).all<Record<string, unknown>>(),
    db.prepare("SELECT COUNT(*) AS count FROM content_import_errors WHERE import_id = ?").bind(importId).first<{ count: number }>(),
  ]);
  const header = offset === 0 ? ["行号,内容标识,错误类型,错误原因"] : [];
  const content = [...header, ...rows.results.map((item) => [item.row_index, item.content_key, item.kind, item.message]
    .map(csvCell).join(","))].join("\r\n");
  const nextOffset = offset + rows.results.length < Number(total?.count ?? 0) ? offset + rows.results.length : null;
  return json({ ok: true, fileName: `${job.file_name.replace(/\.[^.]+$/, "").slice(0, 120)}-内容导入错误.csv`,
    contentType: "text/csv;charset=utf-8", content: `${offset === 0 ? "\uFEFF" : "\r\n"}${content}`,
    nextOffset, total: Number(total?.count ?? 0) });
}

async function loadContentImportWorkflow(importId: number) {
  return getD1().prepare(`SELECT id, content_type, data_version, status, review_status, imported_rows,
    submitted_by, duplicate_strategy FROM content_imports WHERE id = ?`).bind(importId)
    .first<Record<string, unknown>>();
}

async function contentImportCurrentRowCount(importId: number, statuses: string[]) {
  const placeholders = statuses.map(() => "?").join(",");
  return getD1().prepare(`SELECT COUNT(*) AS total,
    COALESCE(SUM(CASE WHEN ci.id IS NOT NULL AND ci.version = cir.content_version
      AND ci.status IN (${placeholders})
      AND CAST(json_extract(ci.payload_json, '$.importSource.importId') AS INTEGER) = cir.import_id
      THEN 1 ELSE 0 END), 0) AS eligible
    FROM content_import_row_results cir LEFT JOIN content_items ci
      ON ci.content_key = cir.content_key
    WHERE cir.import_id = ? AND cir.status = 'imported'`)
    .bind(...statuses, importId).first<{ total: number; eligible: number }>();
}

async function adminSubmitContentImportReview(payload: Record<string, unknown>) {
  const importId = Math.floor(Number(payload.importId));
  const job = await loadContentImportWorkflow(importId);
  if (!job) return json({ error: "内容导入任务不存在" }, 404);
  const permission: AdminPermission = new Set(["exam_event", "exam_notice", "job_position"]).has(String(job.content_type))
    ? "radar.write" : "content.write";
  if (!canAdmin(payload, permission)) return adminForbidden(permission);
  if (!new Set(["completed", "completed_with_errors"]).has(String(job.status))) {
    return json({ error: "导入尚未完成，不能提交批次审核" }, 409);
  }
  if (!new Set(["draft", "rejected"]).has(String(job.review_status))) {
    return json({ error: "该批次当前状态不能重复提交审核" }, 409);
  }
  const counts = await contentImportCurrentRowCount(importId, ["draft", "rejected"]);
  const total = Number(counts?.total ?? 0);
  if (total < 1 || Number(counts?.eligible ?? 0) !== total) {
    return json({ error: "批次中的部分内容已被单独修改，不能整批提交；请刷新并处理版本冲突", code: "CONTENT_IMPORT_VERSION_CONFLICT" }, 409);
  }
  const admin = adminFromPayload(payload)!;
  const db = getD1();
  const results = await db.batch([
    db.prepare(`UPDATE content_imports SET review_status = 'submitting', updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status IN ('completed','completed_with_errors') AND review_status IN ('draft','rejected')
        AND imported_rows > 0
        AND imported_rows = (SELECT COUNT(*) FROM content_import_row_results cir
          WHERE cir.import_id = content_imports.id AND cir.status = 'imported')
        AND imported_rows = (SELECT COUNT(*) FROM content_import_row_results cir
          JOIN content_items ci ON ci.content_key = cir.content_key
          WHERE cir.import_id = content_imports.id AND cir.status = 'imported'
            AND ci.version = cir.content_version AND ci.status IN ('draft','rejected')
            AND CAST(json_extract(ci.payload_json, '$.importSource.importId') AS INTEGER) = cir.import_id)`)
      .bind(importId),
    db.prepare(`INSERT OR IGNORE INTO content_item_versions
      (content_id, version, content_type, content_key, title, payload_json, access_level, status, publish_at, change_type)
      SELECT ci.id, ci.version, ci.content_type, ci.content_key, ci.title, ci.payload_json,
        ci.access_level, ci.status, ci.publish_at, 'snapshot'
      FROM content_import_row_results cir JOIN content_items ci ON ci.content_key = cir.content_key
      WHERE cir.import_id = ? AND cir.status = 'imported' AND ci.version = cir.content_version
        AND EXISTS (SELECT 1 FROM content_imports job WHERE job.id = cir.import_id AND job.review_status = 'submitting')`)
      .bind(importId),
    db.prepare(`UPDATE content_items AS ci SET status = 'pending_review', publish_at = NULL,
      review_note = '', submitted_by = ?, submitted_at = CURRENT_TIMESTAMP,
      reviewed_by = NULL, reviewed_at = NULL, version = ci.version + 1, updated_at = CURRENT_TIMESTAMP
      WHERE EXISTS (SELECT 1 FROM content_import_row_results cir WHERE cir.import_id = ?
        AND cir.status = 'imported' AND cir.content_key = ci.content_key AND cir.content_version = ci.version
        AND EXISTS (SELECT 1 FROM content_imports job WHERE job.id = cir.import_id AND job.review_status = 'submitting'))`)
      .bind(admin.id, importId),
    db.prepare(`INSERT OR REPLACE INTO content_item_versions
      (content_id, version, content_type, content_key, title, payload_json, access_level, status, publish_at, change_type)
      SELECT ci.id, ci.version, ci.content_type, ci.content_key, ci.title, ci.payload_json,
        ci.access_level, ci.status, ci.publish_at, 'import_submit_review'
      FROM content_import_row_results cir JOIN content_items ci ON ci.content_key = cir.content_key
      WHERE cir.import_id = ? AND cir.status = 'imported' AND ci.version = cir.content_version + 1
        AND EXISTS (SELECT 1 FROM content_imports job WHERE job.id = cir.import_id AND job.review_status = 'submitting')`)
      .bind(importId),
    db.prepare(`UPDATE content_import_row_results SET content_version = content_version + 1
      WHERE import_id = ? AND status = 'imported'
        AND EXISTS (SELECT 1 FROM content_imports job WHERE job.id = import_id AND job.review_status = 'submitting')`).bind(importId),
    db.prepare(`UPDATE content_imports SET review_status = 'pending_review', submitted_by = ?,
      submitted_at = CURRENT_TIMESTAMP, reviewed_by = NULL, reviewed_at = NULL, review_note = '',
      updated_at = CURRENT_TIMESTAMP WHERE id = ? AND review_status = 'submitting'`).bind(admin.id, importId),
  ]);
  if (!results[0]?.meta.changes) {
    return json({ error: "批次在提交前发生版本变化，未执行任何内容更新", code: "CONTENT_IMPORT_VERSION_CONFLICT" }, 409);
  }
  return json({ ok: true, importId, reviewStatus: "pending_review", affected: total });
}

async function adminReviewContentImport(payload: Record<string, unknown>) {
  if (!canAdmin(payload, "content.review")) return adminForbidden("content.review");
  const admin = adminFromPayload(payload)!;
  if (admin.role !== "reviewer" && admin.role !== "super_admin") return adminForbidden("content.review");
  const importId = Math.floor(Number(payload.importId));
  const decision = payload.decision === "approve" ? "approve" : payload.decision === "reject" ? "reject" : "";
  const reviewNote = trimmed(payload.reviewNote, 1_000);
  if (!decision) return json({ error: "审核决定无效" }, 400);
  if (decision === "reject" && reviewNote.length < 2) return json({ error: "驳回批次时请填写原因" }, 400);
  const job = await loadContentImportWorkflow(importId);
  if (!job) return json({ error: "内容导入任务不存在" }, 404);
  if (String(job.review_status) !== "pending_review") return json({ error: "该批次不在待审核状态" }, 409);
  if (Number(job.submitted_by) === admin.id && admin.role !== "super_admin") {
    return json({ error: "提交人与审核人需分离；请由另一名审核员处理" }, 409);
  }
  const counts = await contentImportCurrentRowCount(importId, ["pending_review"]);
  const total = Number(counts?.total ?? 0);
  if (total < 1 || Number(counts?.eligible ?? 0) !== total) {
    return json({ error: "批次中的部分内容已发生版本变化，整批审核已中止", code: "CONTENT_IMPORT_VERSION_CONFLICT" }, 409);
  }
  const nextStatus = decision === "approve" ? "published" : "rejected";
  const reviewingStatus = decision === "approve" ? "reviewing_approve" : "reviewing_reject";
  const db = getD1();
  const results = await db.batch([
    db.prepare(`UPDATE content_imports SET review_status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND review_status = 'pending_review' AND imported_rows > 0
        AND imported_rows = (SELECT COUNT(*) FROM content_import_row_results cir
          WHERE cir.import_id = content_imports.id AND cir.status = 'imported')
        AND imported_rows = (SELECT COUNT(*) FROM content_import_row_results cir
          JOIN content_items ci ON ci.content_key = cir.content_key
          WHERE cir.import_id = content_imports.id AND cir.status = 'imported'
            AND ci.version = cir.content_version AND ci.status = 'pending_review'
            AND CAST(json_extract(ci.payload_json, '$.importSource.importId') AS INTEGER) = cir.import_id)
        AND (? = 'rejected' OR (
          NOT EXISTS (
            SELECT 1 FROM content_import_row_results cir
            JOIN content_items ci ON ci.content_key = cir.content_key, json_tree(ci.payload_json) media_ref
            LEFT JOIN media_assets ma ON media_ref.type = 'text'
              AND media_ref.value = '/api/app?media=' || ma.id
            WHERE cir.import_id = content_imports.id AND cir.status = 'imported'
              AND ci.version = cir.content_version AND media_ref.type = 'text'
              AND media_ref.value LIKE '/api/app?media=%'
              AND (ma.id IS NULL OR ma.status <> 'active'
                OR (ci.access_level = 'member' AND ma.access_level <> 'member'))
          )
          AND NOT EXISTS (
            SELECT 1 FROM content_import_row_results cir
            JOIN content_items ci ON ci.content_key = cir.content_key
            LEFT JOIN media_assets ma
              ON json_extract(ci.payload_json, '$.audioUrl') = '/api/app?media=' || ma.id
            WHERE cir.import_id = content_imports.id AND cir.status = 'imported'
              AND ci.version = cir.content_version AND ci.content_type = 'audio_track'
              AND (COALESCE(json_extract(ci.payload_json, '$.audioUrl'), '') NOT LIKE '/api/app?media=%'
                OR ma.id IS NULL OR ma.status <> 'active' OR ma.content_type NOT LIKE 'audio/%'
                OR (ci.access_level = 'member' AND ma.access_level <> 'member'))
          )
        ))`).bind(reviewingStatus, importId, nextStatus),
    db.prepare(`INSERT OR IGNORE INTO content_item_versions
      (content_id, version, content_type, content_key, title, payload_json, access_level, status, publish_at, change_type)
      SELECT ci.id, ci.version, ci.content_type, ci.content_key, ci.title, ci.payload_json,
        ci.access_level, ci.status, ci.publish_at, 'snapshot'
      FROM content_import_row_results cir JOIN content_items ci ON ci.content_key = cir.content_key
      WHERE cir.import_id = ? AND cir.status = 'imported' AND ci.version = cir.content_version
        AND EXISTS (SELECT 1 FROM content_imports job WHERE job.id = cir.import_id AND job.review_status = ?)`)
      .bind(importId, reviewingStatus),
    db.prepare(`UPDATE content_items AS ci SET status = ?, publish_at = NULL, review_note = ?,
      reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP, version = ci.version + 1, updated_at = CURRENT_TIMESTAMP
      WHERE EXISTS (SELECT 1 FROM content_import_row_results cir WHERE cir.import_id = ?
        AND cir.status = 'imported' AND cir.content_key = ci.content_key AND cir.content_version = ci.version
        AND EXISTS (SELECT 1 FROM content_imports job WHERE job.id = cir.import_id AND job.review_status = ?))`)
      .bind(nextStatus, reviewNote, admin.id, importId, reviewingStatus),
    db.prepare(`UPDATE media_assets AS ma SET access_level = 'free', updated_at = CURRENT_TIMESTAMP
      WHERE ma.status = 'active' AND ma.access_level = 'member'
        AND EXISTS (
          SELECT 1 FROM content_import_row_results cir
          JOIN content_items ci ON ci.content_key = cir.content_key, json_tree(ci.payload_json) media_ref
          WHERE cir.import_id = ? AND cir.status = 'imported' AND ci.version = cir.content_version + 1
            AND ci.status = 'published' AND ci.access_level = 'free'
            AND media_ref.type = 'text' AND media_ref.value = '/api/app?media=' || ma.id
            AND EXISTS (SELECT 1 FROM content_imports job
              WHERE job.id = cir.import_id AND job.review_status = 'reviewing_approve')
        )`).bind(importId),
    db.prepare(`INSERT OR REPLACE INTO content_item_versions
      (content_id, version, content_type, content_key, title, payload_json, access_level, status, publish_at, change_type)
      SELECT ci.id, ci.version, ci.content_type, ci.content_key, ci.title, ci.payload_json,
        ci.access_level, ci.status, ci.publish_at, 'import_review'
      FROM content_import_row_results cir JOIN content_items ci ON ci.content_key = cir.content_key
      WHERE cir.import_id = ? AND cir.status = 'imported' AND ci.version = cir.content_version + 1
        AND EXISTS (SELECT 1 FROM content_imports job WHERE job.id = cir.import_id AND job.review_status = ?)`)
      .bind(importId, reviewingStatus),
    db.prepare(`UPDATE content_import_row_results SET content_version = content_version + 1
      WHERE import_id = ? AND status = 'imported'
        AND EXISTS (SELECT 1 FROM content_imports job WHERE job.id = import_id AND job.review_status = ?)`).bind(importId, reviewingStatus),
    db.prepare(`UPDATE content_imports SET review_status = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP,
      review_note = ?, published_at = CASE WHEN ? = 'published' THEN CURRENT_TIMESTAMP ELSE published_at END,
      updated_at = CURRENT_TIMESTAMP WHERE id = ? AND review_status = ?`)
      .bind(nextStatus, admin.id, reviewNote, nextStatus, importId, reviewingStatus),
  ]);
  if (!results[0]?.meta.changes) {
    return json({ error: decision === "approve"
      ? "批次版本或媒体权益校验未通过，未发布任何内容"
      : "批次版本已变化，未驳回任何内容", code: "CONTENT_IMPORT_REVIEW_CONFLICT" }, 409);
  }
  return json({ ok: true, importId, reviewStatus: nextStatus, affected: total });
}

async function adminRollbackContentImport(payload: Record<string, unknown>) {
  if (!canAdmin(payload, "content.publish")) return adminForbidden("content.publish");
  const importId = Math.floor(Number(payload.importId));
  const dataVersion = trimmed(payload.dataVersion, 80);
  const job = await loadContentImportWorkflow(importId);
  if (!job) return json({ error: "内容导入任务不存在" }, 404);
  if (dataVersion && dataVersion !== String(job.data_version)) return json({ error: "批次数据版本不匹配" }, 409);
  if (String(job.review_status) === "rolled_back") return json({ ok: true, importId, reviewStatus: "rolled_back", duplicate: true });
  if (!new Set(["completed", "completed_with_errors"]).has(String(job.status))) {
    return json({ error: "导入尚未结束，不能执行批次回滚" }, 409);
  }
  const counts = await contentImportCurrentRowCount(importId,
    ["draft", "pending_review", "published", "rejected", "scheduled", "archived"]);
  const total = Number(counts?.total ?? 0);
  if (total < 1 || Number(counts?.eligible ?? 0) !== total) {
    return json({ error: "批次内容已被后续编辑，不能自动整批回滚；请按版本记录逐条处理", code: "CONTENT_IMPORT_VERSION_CONFLICT" }, 409);
  }
  const admin = adminFromPayload(payload)!;
  const db = getD1();
  const results = await db.batch([
    db.prepare(`UPDATE content_imports SET review_status = 'rolling_back', updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status IN ('completed','completed_with_errors') AND review_status <> 'rolled_back'
        AND imported_rows > 0
        AND imported_rows = (SELECT COUNT(*) FROM content_import_row_results cir
          WHERE cir.import_id = content_imports.id AND cir.status = 'imported')
        AND imported_rows = (SELECT COUNT(*) FROM content_import_row_results cir
          JOIN content_items ci ON ci.content_key = cir.content_key
          WHERE cir.import_id = content_imports.id AND cir.status = 'imported'
            AND ci.version = cir.content_version
            AND ci.status IN ('draft','pending_review','published','rejected','scheduled','archived')
            AND CAST(json_extract(ci.payload_json, '$.importSource.importId') AS INTEGER) = cir.import_id)`)
      .bind(importId),
    db.prepare(`INSERT OR IGNORE INTO content_item_versions
      (content_id, version, content_type, content_key, title, payload_json, access_level, status, publish_at, change_type)
      SELECT ci.id, ci.version, ci.content_type, ci.content_key, ci.title, ci.payload_json,
        ci.access_level, ci.status, ci.publish_at, 'snapshot'
      FROM content_import_row_results cir JOIN content_items ci ON ci.content_key = cir.content_key
      WHERE cir.import_id = ? AND cir.status = 'imported' AND ci.version = cir.content_version
        AND EXISTS (SELECT 1 FROM content_imports job WHERE job.id = cir.import_id AND job.review_status = 'rolling_back')`).bind(importId),
    db.prepare(`WITH rollback_rows AS (
        SELECT ci.id, imported.version AS import_version, imported.change_type,
          previous.title AS previous_title, previous.payload_json AS previous_payload_json,
          previous.access_level AS previous_access_level
        FROM content_import_row_results cir
        JOIN content_items ci ON ci.content_key = cir.content_key AND ci.version = cir.content_version
        JOIN content_item_versions imported ON imported.content_id = ci.id
          AND imported.change_type IN ('import','import_create')
          AND CAST(json_extract(imported.payload_json, '$.importSource.importId') AS INTEGER) = cir.import_id
        LEFT JOIN content_item_versions previous ON previous.content_id = ci.id
          AND previous.version = imported.version - 1
        WHERE cir.import_id = ? AND cir.status = 'imported'
          AND EXISTS (SELECT 1 FROM content_imports job WHERE job.id = cir.import_id AND job.review_status = 'rolling_back')
      )
      UPDATE content_items AS target SET
        title = CASE WHEN rollback_rows.change_type = 'import_create' THEN target.title ELSE rollback_rows.previous_title END,
        payload_json = CASE WHEN rollback_rows.change_type = 'import_create' THEN target.payload_json ELSE rollback_rows.previous_payload_json END,
        access_level = CASE WHEN rollback_rows.change_type = 'import_create' THEN target.access_level ELSE rollback_rows.previous_access_level END,
        status = CASE WHEN rollback_rows.change_type = 'import_create' THEN 'archived' ELSE 'draft' END,
        publish_at = NULL, review_note = '批次回滚', submitted_by = NULL, submitted_at = NULL,
        reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP, version = target.version + 1,
        updated_at = CURRENT_TIMESTAMP
      FROM rollback_rows WHERE target.id = rollback_rows.id`).bind(importId, admin.id),
    db.prepare(`INSERT OR REPLACE INTO content_item_versions
      (content_id, version, content_type, content_key, title, payload_json, access_level, status, publish_at, change_type)
      SELECT ci.id, ci.version, ci.content_type, ci.content_key, ci.title, ci.payload_json,
        ci.access_level, ci.status, ci.publish_at, 'import_rollback'
      FROM content_import_row_results cir JOIN content_items ci ON ci.content_key = cir.content_key
      WHERE cir.import_id = ? AND cir.status = 'imported' AND ci.version = cir.content_version + 1
        AND EXISTS (SELECT 1 FROM content_imports job WHERE job.id = cir.import_id AND job.review_status = 'rolling_back')`).bind(importId),
    db.prepare(`UPDATE content_import_row_results SET content_version = content_version + 1
      WHERE import_id = ? AND status = 'imported'
        AND EXISTS (SELECT 1 FROM content_imports job WHERE job.id = import_id AND job.review_status = 'rolling_back')`).bind(importId),
    db.prepare(`UPDATE content_imports SET review_status = 'rolled_back', reviewed_by = ?,
      reviewed_at = CURRENT_TIMESTAMP, review_note = '批次回滚', rolled_back_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP WHERE id = ? AND review_status = 'rolling_back'`).bind(admin.id, importId),
  ]);
  if (!results[0]?.meta.changes) {
    return json({ error: "批次在回滚前发生版本变化，未执行任何内容更新", code: "CONTENT_IMPORT_VERSION_CONFLICT" }, 409);
  }
  return json({ ok: true, importId, dataVersion: String(job.data_version), reviewStatus: "rolled_back", affected: total });
}

async function adminStartQuestionImport(payload: Record<string, unknown>) {
  if (!canAdmin(payload, "question.import")) return adminForbidden("question.import");
  const admin = adminFromPayload(payload);
  const bankId = Math.floor(Number(payload.bankId));
  const fileName = trimmed(payload.fileName, 160);
  const fileSize = Math.max(0, Math.floor(Number(payload.fileSize ?? 0)));
  const fileHash = trimmed(payload.fileHash, 64).toLowerCase();
  const duplicateStrategy = trimmed(payload.duplicateStrategy, 40) || "reject";
  const totalRows = Math.max(0, Math.floor(Number(payload.totalRows ?? 0)));
  const requestedChunks = Math.floor(Number(payload.totalChunks ?? 0));
  const chunkSize = Math.max(1, Math.min(QUESTION_IMPORT_CHUNK_ROWS, Math.floor(Number(payload.chunkSize ?? QUESTION_IMPORT_CHUNK_ROWS))));
  const minimumChunks = Math.ceil(totalRows / QUESTION_IMPORT_CHUNK_ROWS);
  const totalChunks = requestedChunks >= minimumChunks
    && requestedChunks <= QUESTION_IMPORT_MAX_CHUNKS_PER_FILE
    && requestedChunks <= totalRows ? requestedChunks : 0;
  if (!Number.isFinite(bankId) || bankId < 1) return json({ error: "请先选择目标题库" }, 400);
  if (!/\.(xlsx|xls|csv)$/i.test(fileName)) return json({ error: "仅支持 XLSX、XLS 或 CSV 文件" }, 400);
  if (fileSize > 20 * 1024 * 1024) return json({ error: "单个文件不能超过20MB" }, 400);
  if (!/^[a-f0-9]{64}$/.test(fileHash)) return json({ error: "文件指纹无效，请重新选择文件" }, 400);
  if (!QUESTION_IMPORT_DUPLICATE_STRATEGIES.has(duplicateStrategy)) {
    return json({ error: "请选择明确的已存在题目处理策略" }, 400);
  }
  if (totalRows < 1 || totalRows > QUESTION_IMPORT_MAX_FILE_ROWS) {
    return json({ error: `单个文件最多${QUESTION_IMPORT_MAX_FILE_ROWS}道题；超出请按年份或地区拆成多个文件导入` }, 400);
  }
  if (!totalChunks) {
    return json({ error: `单个文件最多${QUESTION_IMPORT_MAX_CHUNKS_PER_FILE}个持久化分块；内容过大时请按年份或地区拆分文件` }, 400);
  }
  const db = getD1();
  const bank = await db.prepare("SELECT id, status, library_enabled FROM question_banks WHERE id = ?")
    .bind(bankId).first<{ id: number; status: string; library_enabled: number }>();
  if (!bank) return json({ error: "目标题库不存在" }, 404);
  if (bank.status === "published") {
    return json({ error: "已发布题库不能直接导入；请先下架为草稿，完成导入、复核和审核后再重新发布" }, 409);
  }
  const result = await db.prepare(`INSERT INTO question_imports
    (bank_id, file_name, file_size, file_hash, duplicate_strategy, total_rows, total_chunks, status, created_by, updated_at)
    SELECT id, ?, ?, ?, ?, ?, ?, 'uploading', ?, CURRENT_TIMESTAMP
    FROM question_banks WHERE id = ? AND status = 'draft'`)
    .bind(fileName, fileSize, fileHash, duplicateStrategy, totalRows, totalChunks, admin?.id ?? null, bankId).run();
  if (!result.meta.changes) return json({ error: "题库状态刚刚发生变化，请刷新后下架为草稿再导入" }, 409);
  if (Number(bank.library_enabled) === 1) {
    await db.prepare(`UPDATE question_banks SET library_status = 'draft', updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND library_enabled = 1`).bind(bankId).run();
  }
  return json({ ok: true, importId: Number(result.meta.last_row_id), chunkSize, totalChunks, status: "uploading" });
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
  const rawSourceExamType = trimmed(item.sourceExamType, 40);
  const sourceBatch = trimmed(item.sourceBatch, 80).toUpperCase();
  const region = trimmed(item.region ?? item.sourceRegion, 24).replace(/[·•]/g, "-");
  const explicitSourceExamType = /^(national|国考|国家公务员考试)$/i.test(rawSourceExamType)
    ? "national"
    : /^(provincial|省考|省级公务员考试)$/i.test(rawSourceExamType) || rawSourceExamType.includes("省考") || rawSourceExamType.includes("联考")
      ? "provincial"
      : /^(special|专项)$/i.test(rawSourceExamType)
        || rawSourceExamType.includes("事业") || rawSourceExamType.includes("公安") || rawSourceExamType.includes("行政执法")
        ? "special"
        : "";
  const nationalRegion = new Set(["全国", "国考"]).has(normalizeProvince(region));
  const sourceExamType = explicitSourceExamType || (nationalRegion ? "national" : "provincial");
  const examYear = Math.floor(Number(item.examYear ?? item.sourceYear));
  // 考频和重要星级只能由审核后的真实试卷样本生成。上传文件里的
  // 同名字段一律不进入可信数据，避免编辑人员通过模板注入“高频/5星”。
  const frequencyOccurrences = 0;
  const frequencyPapers = 0;
  const frequencyYears: number[] = [];
  const frequency = "";
  const frequencyUpdatedAt = null;
  const importanceRuleVersion = "";
  const importanceReason = "";
  const importanceOverrideReason = "";
  const importanceStars = 0;
  const scoreRateCorrect = Math.max(0, Math.floor(Number(item.scoreRateCorrect ?? 0)));
  const scoreRateAttempts = Math.max(0, Math.floor(Number(item.scoreRateAttempts ?? 0)));
  const scoreRate = scoreRateAttempts > 0 ? Math.round(scoreRateCorrect * 100 / scoreRateAttempts) : 0;
  const scoreRateScope = trimmed(item.scoreRateScope, 120);
  const scoreRateSource = trimmed(item.scoreRateSource, 500);
  const scoreRateObservedAt = trimmed(item.scoreRateUpdatedAt ?? item.scoreRateObservedAt, 10);
  const scoreRateObservedTime = /^\d{4}-\d{2}-\d{2}$/.test(scoreRateObservedAt)
    ? Date.parse(`${scoreRateObservedAt}T23:59:59Z`) : Number.NaN;
  const scoreRateUpdatedAt = scoreRateAttempts > 0 && Number.isFinite(scoreRateObservedTime)
    ? new Date(`${scoreRateObservedAt}T00:00:00Z`).toISOString() : null;
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
  if (!/^[A-Z0-9][A-Z0-9_-]{2,79}$/.test(sourceBatch)) return { error: "来源批次需使用3—80位大写字母、数字、横线或下划线，同一套试卷使用同一稳定编号" };
  if (!region) return { error: "真题必须填写地区" };
  if (rawSourceExamType && !explicitSourceExamType) return { error: "来源考试类型无法识别，请填写 national/国考、provincial/省考或 special/专项" };
  if (sourceExamType === "national" && !nationalRegion) return { error: "来源考试类型与地区冲突：国考题地区应填写国考或全国" };
  if (sourceExamType === "provincial" && nationalRegion) return { error: "来源考试类型与地区冲突：省考题必须填写具体省份" };
  if (!Number.isInteger(examYear) || examYear < 1990 || examYear > new Date().getFullYear()) return { error: "真题年份无效" };
  if (scoreRateCorrect > scoreRateAttempts) return { error: "拿分率正确人数不能大于有效首答样本数" };
  if (scoreRateAttempts > 0 && !scoreRateScope) return { error: "外部拿分率有样本时必须填写统计范围" };
  if (scoreRateAttempts > 0 && !/^https:\/\//i.test(scoreRateSource)) {
    return { error: "外部拿分率必须填写可追溯的 HTTPS 参考链接；平台拿分率由系统自动计算" };
  }
  if (scoreRateAttempts > 0 && (!scoreRateUpdatedAt || scoreRateObservedTime > Date.now())) {
    return { error: "外部拿分率必须填写不晚于今天的统计日期（YYYY-MM-DD）" };
  }
  if (!explanation) return { error: "解析/参考答案不能为空" };
  if (subject === "行测" && (options.length < 2 || !answer || !/^[A-H]$/.test(answer))) return { error: "行测题必须填写至少2个选项及A—H正确答案" };
  if (subject === "行测" && answer && answer.charCodeAt(0) - 65 >= options.length) return { error: "正确答案超出当前选项数量" };
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
    sourceExamType,
    sourceBatch,
    region,
    examYear,
    // 导入永远只提交待核验，客户端字段不能提升真题可信状态。
    truthVerified: false,
    frequency,
    frequencyOccurrences,
    frequencyPapers,
    frequencyYears,
    frequencyUpdatedAt,
    importanceStars,
    importanceRuleVersion,
    importanceReason,
    importanceOverrideReason,
    scoreRate,
    scoreRateCorrect,
    scoreRateAttempts,
    scoreRateScope,
    scoreRateSource: scoreRateSource || "platform",
    scoreRateUpdatedAt,
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
    && normalize(row.prompt) === normalize(item.prompt)
    && normalize(row.source) === normalize(item.source)
    && normalize(row.source_exam_type) === normalize(item.sourceExamType)
    && normalize(row.source_region) === normalize(item.region)
    && Number(row.source_year) === Number(item.examYear)
    && normalize(row.source_batch) === normalize(item.sourceBatch);
}

async function adminReviewQuestion(payload: Record<string, unknown>) {
  if (!canAdmin(payload, "question.review")) return adminForbidden("question.review");
  const admin = adminFromPayload(payload);
  if (!admin || admin.role === "question_editor") return adminForbidden("question.review");
  const id = Math.floor(Number(payload.id));
  const expectedVersion = Math.floor(Number(payload.expectedVersion));
  const decision = payload.decision === "approve" ? "approve" : payload.decision === "reject" ? "reject" : "";
  const reviewNote = trimmed(payload.reviewNote, 1_000);
  if (!Number.isFinite(id) || id < 1) return json({ error: "待审核题目不存在" }, 400);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    return json({ error: "审核页面中的题目版本已失效，请刷新后重试", code: "QUESTION_REVIEW_VERSION_MISMATCH" }, 409);
  }
  if (!decision) return json({ error: "审核决定无效" }, 400);
  if (decision === "reject" && !reviewNote) return json({ error: "驳回时必须填写原因" }, 400);
  const db = getD1();
  const question = await db.prepare(`SELECT ${ADMIN_QUESTION_SELECT} FROM questions q WHERE q.id = ?`)
    .bind(id).first<Record<string, unknown>>();
  if (!question) return json({ error: "待审核题目不存在" }, 404);
  if (Number(question.version ?? 1) !== expectedVersion || String(question.review_status) !== "pending_review") {
    return json({ error: "题目已被编辑或审核，请刷新队列后重试", code: "QUESTION_REVIEW_VERSION_MISMATCH",
      currentVersion: Number(question.version ?? 1) }, 409);
  }
  const sourceYear = Number(question.source_year);
  if (decision === "approve" && (!trimmed(question.source, 120) || !trimmed(question.source_region, 24)
    || !Number.isInteger(sourceYear) || sourceYear < 1990 || sourceYear > new Date().getFullYear()
    || !trimmed(question.source_batch, 80))) {
    return json({ error: "来源、地区、年份或来源批次不完整，不能通过审核" }, 409);
  }
  if (decision === "approve") {
    const subject = trimmed(question.subject, 10);
    const explanation = trimmed(question.explanation, 8_000);
    const options = parseOptions(String(question.options_json ?? "[]"));
    const answer = trimmed(question.answer, 8).toUpperCase();
    if (!explanation) return json({ error: "解析或参考答案为空，不能通过审核" }, 409);
    if (subject === "行测" && (options.length < 2 || !/^[A-H]$/.test(answer)
      || answer.charCodeAt(0) - 65 >= options.length)) {
      return json({ error: "行测选项或正确答案不完整，不能通过审核" }, 409);
    }
    if (subject === "申论" && !trimmed(question.prompt, 2_000)) {
      return json({ error: "申论作答任务为空，不能通过审核" }, 409);
    }
    const scoreRateCorrect = Math.max(0, Math.floor(Number(question.score_rate_correct ?? 0)));
    const scoreRateAttempts = Math.max(0, Math.floor(Number(question.score_rate_attempts ?? 0)));
    const scoreRate = Number(question.score_rate ?? 0);
    const expectedScoreRate = scoreRateAttempts > 0 ? Math.round(scoreRateCorrect * 100 / scoreRateAttempts) : 0;
    const scoreRateSource = trimmed(question.score_rate_source, 500) || "platform";
    const scoreRateUpdatedAt = trimmed(question.score_rate_updated_at, 40);
    const scoreRateTime = scoreRateUpdatedAt ? Date.parse(scoreRateUpdatedAt) : Number.NaN;
    if (scoreRateCorrect > scoreRateAttempts) return json({ error: "拿分率正确样本数大于总样本数，不能通过审核" }, 409);
    if (!Number.isFinite(scoreRate) || scoreRate !== expectedScoreRate) {
      return json({ error: "拿分率与正确样本数、总样本数计算结果不一致，不能通过审核" }, 409);
    }
    if (scoreRateAttempts > 0 && !trimmed(question.score_rate_scope, 120)) {
      return json({ error: "拿分率缺少统计范围，不能通过审核" }, 409);
    }
    if (scoreRateSource === "platform") {
      const platformStats = await db.prepare(`SELECT COUNT(*) AS attempts,
        COALESCE(SUM(metric_attempt.is_correct), 0) AS correct
        FROM practice_attempts metric_attempt
        JOIN users metric_user ON metric_user.id = metric_attempt.user_id
        WHERE metric_attempt.question_code = ?
          AND ${eligibleFirstAttemptSql("metric_attempt", "metric_user")}`)
        .bind(String(question.question_code)).first<{ attempts: number; correct: number }>();
      if (Number(platformStats?.attempts ?? 0) !== scoreRateAttempts
        || Number(platformStats?.correct ?? 0) !== scoreRateCorrect) {
        return json({ error: "平台拿分率只能由系统答题记录生成，当前样本与系统统计不一致" }, 409);
      }
      if (scoreRateAttempts > 0 && (!Number.isFinite(scoreRateTime) || scoreRateTime > Date.now())) {
        return json({ error: "平台拿分率统计日期无效" }, 409);
      }
    } else {
      let validExternalSource = false;
      try { validExternalSource = new URL(scoreRateSource).protocol === "https:"; } catch { validExternalSource = false; }
      if (!validExternalSource || !Number.isFinite(scoreRateTime) || scoreRateTime > Date.now()) {
        return json({ error: "外部拿分率必须提供可追溯的HTTPS链接和不晚于今天的统计日期" }, 409);
      }
    }
  }
  const bankRows = await db.prepare(`SELECT DISTINCT qb.id AS bank_id, qb.exam_type, qb.province, qb.exam_year, qb.subject
    FROM question_bank_items qbi JOIN question_banks qb ON qb.id = qbi.bank_id
    WHERE qbi.question_id = ?`).bind(id).all<{
      bank_id: number; exam_type: string; province: string | null; exam_year: number | null; subject: string;
    }>();
  if (decision === "approve") {
    const mismatchedBank = bankRows.results.find((bank) => !questionMatchesQuestionBankScope(bank, question));
    if (mismatchedBank) {
      return json({ error: "题目考试类型、科目或地区与关联题库不一致；请先移入正确题库后再审核" }, 409);
    }
  }
  const nextStatus = decision === "approve" ? "approved" : "rejected";
  const currentSnapshot = adminQuestionSnapshot(question);
  const nextVersion = expectedVersion + 1;
  const nextSnapshot = { ...currentSnapshot, truthVerified: decision === "approve", reviewStatus: nextStatus };
  const statements = [
    db.prepare(`INSERT OR IGNORE INTO question_versions
      (question_id, version, question_code, snapshot_json, change_type, admin_user_id, review_status)
      VALUES (?, ?, ?, ?, 'review_baseline', ?, ?)`)
      .bind(id, expectedVersion, String(question.question_code), JSON.stringify(currentSnapshot), admin.id, String(question.review_status)),
    db.prepare(`UPDATE questions SET truth_verified = ?,
      truth_verified_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE NULL END,
      review_status = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP, review_note = ?,
      version = version + 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND version = ? AND review_status = 'pending_review'
        AND ${QUESTION_NOT_LOCKED_BY_IMPORT_SQL}`)
      .bind(decision === "approve" ? 1 : 0, decision === "approve" ? 1 : 0,
        nextStatus, admin.id, reviewNote, id, expectedVersion),
  ];
  if (decision === "reject") {
    statements.push(db.prepare(`UPDATE practice_sessions SET status = 'abandoned', updated_at = CURRENT_TIMESTAMP
      WHERE status = 'active' AND json_valid(question_codes_json)
        AND EXISTS (SELECT 1 FROM json_each(practice_sessions.question_codes_json) WHERE json_each.value = ?)
        AND EXISTS (SELECT 1 FROM questions WHERE id = ? AND version = ? AND review_status = 'rejected')`)
      .bind(String(question.question_code), id, nextVersion));
    const rejectedPostState = { questionId: id, version: nextVersion, reviewStatus: "rejected" };
    statements.push(draftInvalidPublishedBanksForQuestion(db, rejectedPostState));
    statements.push(abandonActiveSessionsForDraftedQuestionBanks(db, rejectedPostState));
  }
  if (decision === "approve") {
    const currentYear = new Date().getFullYear();
    statements.push(db.prepare(QUESTION_VALUE_METRICS_SQL)
      .bind(...questionValueMetricBindsForReview(id, nextVersion, currentYear - 4, currentYear - 2)));
  }
  statements.push(draftEssayLibraryPapersForQuestion(db,
    { questionId: id, version: nextVersion, reviewStatus: nextStatus }));
  statements.push(db.prepare(`INSERT OR IGNORE INTO question_versions
    (question_id, version, question_code, snapshot_json, change_type, from_version, admin_user_id, review_status)
    SELECT id, version, question_code, ?, 'review', ?, ?, ? FROM questions
    WHERE id = ? AND version = ? AND review_status = ?`)
    .bind(JSON.stringify(nextSnapshot), expectedVersion, admin.id, nextStatus, id, nextVersion, nextStatus));
  const results = await db.batch(statements);
  const updated = results[1];
  const abandoned = decision === "reject"
    ? Number(results[2]?.meta.changes ?? 0) + Number(results[4]?.meta.changes ?? 0)
    : 0;
  if (!updated.meta.changes) return json({ error: "题目已被编辑或审核，请刷新队列后重试",
    code: "QUESTION_REVIEW_VERSION_MISMATCH" }, 409);
  return json({ ok: true, id, questionCode: question.question_code, version: nextVersion, reviewStatus: nextStatus,
    truthVerified: decision === "approve", reviewedBy: admin.id, reviewedAt: new Date().toISOString(),
    affectedBankIds: bankRows.results.map((bank) => Number(bank.bank_id)),
    abandonedSessions: abandoned });
}

async function sha256Text(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function importedQuestionSnapshot(item: ImportedQuestion) {
  return {
    questionCode: item.questionCode,
    subject: item.subject,
    module: item.module,
    subType: item.subType ?? "",
    stem: item.stem,
    options: item.options ?? [],
    answer: item.answer ?? null,
    explanation: item.explanation ?? "",
    technique: item.technique ?? "",
    material: item.material ?? "",
    prompt: item.prompt ?? "",
    wordLimit: item.wordLimit ?? null,
    scoringPoints: item.scoringPoints ?? [],
    difficulty: item.difficulty ?? "中等",
    source: item.source ?? "",
    sourceExamType: item.sourceExamType ?? "",
    sourceBatch: item.sourceBatch ?? "",
    region: item.region,
    examYear: item.examYear,
    truthVerified: false,
    reviewStatus: "pending_review",
    frequency: item.frequency,
    frequencyOccurrences: item.frequencyOccurrences ?? 0,
    frequencyPapers: item.frequencyPapers ?? 0,
    frequencyYears: item.frequencyYears ?? [],
    frequencyUpdatedAt: item.frequencyUpdatedAt ?? null,
    importanceStars: item.importanceStars,
    importanceRuleVersion: item.importanceRuleVersion ?? "",
    importanceReason: item.importanceReason ?? "",
    importanceOverrideReason: item.importanceOverrideReason ?? "",
    scoreRate: item.scoreRate,
    scoreRateCorrect: item.scoreRateCorrect ?? 0,
    scoreRateAttempts: item.scoreRateAttempts ?? 0,
    scoreRateScope: item.scoreRateScope ?? "",
    scoreRateSource: item.scoreRateSource ?? "platform",
    scoreRateUpdatedAt: item.scoreRateUpdatedAt ?? null,
    suggestedSeconds: item.suggestedSeconds,
    imageUrl: item.imageUrl,
    resourceUrl: item.resourceUrl,
    status: "active",
  };
}

type ImportRowError = {
  row: number;
  questionCode: string;
  kind: "validation" | "duplicate" | "conflict";
  message: string;
  rawJson: string;
};

async function persistImportRowErrors(importId: number, chunkIndex: number, errors: ImportRowError[]) {
  if (!errors.length) return;
  const db = getD1();
  const encoded = JSON.stringify(errors);
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO question_import_errors
      (import_id, chunk_index, row_number, question_code, kind, message, raw_json)
      SELECT ?, ?, CAST(json_extract(value, '$.row') AS INTEGER),
        COALESCE(json_extract(value, '$.questionCode'), ''), COALESCE(json_extract(value, '$.kind'), 'validation'),
        COALESCE(json_extract(value, '$.message'), '未知错误'), COALESCE(json_extract(value, '$.rawJson'), '{}')
      FROM json_each(?)`).bind(importId, chunkIndex, encoded),
    db.prepare(`INSERT OR IGNORE INTO question_import_row_results
      (import_id, row_number, chunk_index, status, question_code, message)
      SELECT ?, CAST(json_extract(value, '$.row') AS INTEGER), ?, 'failed',
        COALESCE(json_extract(value, '$.questionCode'), ''), COALESCE(json_extract(value, '$.message'), '未知错误')
      FROM json_each(?)`).bind(importId, chunkIndex, encoded),
  ]);
}

async function refreshQuestionImportProgress(importId: number) {
  const db = getD1();
  const [rows, chunks, duplicate] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS processed,
      COALESCE(SUM(CASE WHEN status = 'imported' THEN 1 ELSE 0 END), 0) AS imported,
      COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed
      FROM question_import_row_results WHERE import_id = ?`).bind(importId)
      .first<{ processed: number; imported: number; failed: number }>(),
    db.prepare(`SELECT COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completed,
      COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
      COALESCE(SUM(CASE WHEN status IN ('queued','processing') THEN 1 ELSE 0 END), 0) AS remaining
      FROM question_import_chunks WHERE import_id = ?`).bind(importId)
      .first<{ total: number; completed: number; failed: number; remaining: number }>(),
    db.prepare("SELECT COUNT(*) AS count FROM question_import_errors WHERE import_id = ? AND kind = 'duplicate'")
      .bind(importId).first<{ count: number }>(),
  ]);
  const job = await db.prepare(`SELECT total_rows, total_chunks, uploaded_chunks, cancel_requested, status
    FROM question_imports WHERE id = ?`).bind(importId).first<Record<string, unknown>>();
  if (!job) return null;
  const processed = Number(rows?.processed ?? 0);
  const failed = Number(rows?.failed ?? 0);
  const systemFailedChunks = Number(chunks?.failed ?? 0);
  const remainingChunks = Number(chunks?.remaining ?? 0);
  let status = String(job.status);
  let completedAt = false;
  if (Number(job.cancel_requested) === 1) {
    status = "cancelled";
    completedAt = true;
  } else if (processed >= Number(job.total_rows) && Number(job.uploaded_chunks) === Number(job.total_chunks)) {
    status = failed > 0 ? "completed_with_errors" : "completed";
    completedAt = true;
  } else if (systemFailedChunks > 0 && remainingChunks === 0) {
    status = "failed";
    completedAt = true;
  }
  const errorRows = failed > 0
    ? (await db.prepare(`SELECT row_number, message FROM question_import_errors
        WHERE import_id = ? ORDER BY row_number LIMIT 30`).bind(importId).all<{ row_number: number; message: string }>()).results
    : [];
  const systemErrors = systemFailedChunks > 0
    ? (await db.prepare(`SELECT chunk_index, error_summary FROM question_import_chunks
        WHERE import_id = ? AND status = 'failed' ORDER BY chunk_index LIMIT 10`).bind(importId)
      .all<{ chunk_index: number; error_summary: string }>()).results
    : [];
  const errorSummary = [
    ...errorRows.map((item) => `第${item.row_number}行：${item.message}`),
    ...systemErrors.map((item) => `分块${item.chunk_index + 1}：${item.error_summary || "系统处理失败"}`),
  ].join("\n");
  await db.prepare(`UPDATE question_imports SET processed_rows = ?, imported_rows = ?, failed_rows = ?,
    duplicate_rows = ?, processed_chunks = ?, status = ?, error_summary = ?, updated_at = CURRENT_TIMESTAMP,
    completed_at = CASE WHEN ? = 1 THEN COALESCE(completed_at, CURRENT_TIMESTAMP) ELSE completed_at END
    WHERE id = ?`).bind(processed, Number(rows?.imported ?? 0), failed, Number(duplicate?.count ?? 0),
      Number(chunks?.completed ?? 0), status, errorSummary, completedAt ? 1 : 0, importId).run();
  if (new Set(["completed", "completed_with_errors", "cancelled"]).has(status)) {
    await db.prepare("UPDATE question_import_chunks SET rows_json = '[]' WHERE import_id = ?").bind(importId).run();
  }
  return { status, processed, imported: Number(rows?.imported ?? 0), failed };
}

async function processQuestionImportChunk(importId: number, chunkId: number, leaseToken: string) {
  const db = getD1();
  const chunk = await db.prepare(`SELECT qic.*, qi.bank_id, qi.created_by, qi.duplicate_strategy,
      qb.exam_type AS bank_exam_type, qb.province AS bank_province,
      qb.exam_year AS bank_exam_year, qb.subject AS bank_subject, qb.status AS bank_status
    FROM question_import_chunks qic JOIN question_imports qi ON qi.id = qic.import_id
    JOIN question_banks qb ON qb.id = qi.bank_id
    WHERE qic.id = ? AND qic.import_id = ? AND qic.status = 'processing'
      AND qi.status = 'processing' AND qi.cancel_requested = 0 AND qi.lease_token = ?`)
    .bind(chunkId, importId, leaseToken).first<Record<string, unknown>>();
  if (!chunk) throw new Error("导入分块不存在");
  if (String(chunk.bank_status) === "published") {
    throw new Error("目标题库已发布；请先下架为草稿后再安全重试本导入任务");
  }
  const rows = JSON.parse(String(chunk.rows_json)) as unknown[];
  if (!Array.isArray(rows) || rows.length !== Number(chunk.row_count)) throw new Error("持久化分块内容损坏");
  const chunkIndex = Number(chunk.chunk_index);
  const rowOffset = Number(chunk.row_offset);
  const bankId = Number(chunk.bank_id);
  const duplicateStrategy = QUESTION_IMPORT_DUPLICATE_STRATEGIES.has(String(chunk.duplicate_strategy))
    ? String(chunk.duplicate_strategy) : "reject";
  const importCodeRows = await db.prepare(`SELECT code.row_number, code.base_version,
      CASE WHEN result.row_number IS NULL THEN 0 ELSE 1 END AS completed
    FROM question_import_codes code
    LEFT JOIN question_import_row_results result
      ON result.import_id = code.import_id AND result.row_number = code.row_number
    WHERE code.import_id = ? AND code.chunk_index = ?`).bind(importId, chunkIndex)
    .all<{ row_number: number; base_version: number; completed: number }>();
  const completedSet = new Set(importCodeRows.results
    .filter((item) => Number(item.completed) === 1).map((item) => Number(item.row_number)));
  const baseVersionByRow = new Map(importCodeRows.results
    .map((item) => [Number(item.row_number), Math.max(0, Number(item.base_version ?? 0))]));
  const duplicateRows = await db.prepare(`SELECT all_codes.question_code, MIN(all_codes.row_number) AS first_row,
    COUNT(*) AS count FROM question_import_codes all_codes
    WHERE all_codes.import_id = ? AND all_codes.question_code IN (
      SELECT question_code FROM question_import_codes WHERE import_id = ? AND chunk_index = ?
    ) GROUP BY all_codes.question_code HAVING COUNT(*) > 1`)
    .bind(importId, importId, chunkIndex).all<{ question_code: string; first_row: number; count: number }>();
  const duplicateMap = new Map(duplicateRows.results.map((item) => [item.question_code, Number(item.first_row)]));
  const valid: Array<{ question: ImportedQuestion; row: number; raw: unknown; baseVersion: number }> = [];
  const errors: ImportRowError[] = [];
  rows.forEach((raw, index) => {
    const row = rowOffset + index + 2;
    if (completedSet.has(row)) return;
    const result = validateImportedQuestion(raw);
    const rawObject = raw as Record<string, unknown>;
    const questionCode = result.question?.questionCode ?? trimmed(rawObject?.questionCode, 80).toUpperCase();
    if (!result.question) {
      errors.push({ row, questionCode, kind: "validation", message: result.error ?? "未知错误", rawJson: JSON.stringify(raw).slice(0, 500) });
      return;
    }
    const baseVersion = baseVersionByRow.get(row);
    if (baseVersion === undefined) {
      errors.push({ row, questionCode, kind: "conflict", message: "导入行缺少持久化版本基线，请取消任务后重新上传",
        rawJson: JSON.stringify(raw).slice(0, 500) });
      return;
    }
    if (!questionMatchesQuestionBankScope({
      examType: String(chunk.bank_exam_type ?? ""),
      province: String(chunk.bank_province ?? ""),
      examYear: chunk.bank_exam_year == null ? null : Number(chunk.bank_exam_year),
      subject: String(chunk.bank_subject ?? ""),
    }, result.question)) {
      errors.push({ row, questionCode, kind: "validation",
        message: "题目考试类型、科目或地区与目标题库不一致；省考真题必须进入对应省份题库",
        rawJson: JSON.stringify(raw).slice(0, 500) });
      return;
    }
    const firstRow = duplicateMap.get(result.question.questionCode);
    if (firstRow && firstRow !== row) {
      errors.push({ row, questionCode, kind: "duplicate", message: `文件内题目编号重复，首次出现在第${firstRow}行`, rawJson: JSON.stringify(raw).slice(0, 500) });
      return;
    }
    valid.push({ question: result.question, row, raw, baseVersion });
  });

  type AcceptedImport = { question: ImportedQuestion; row: number; mode: "write" | "reuse"; expectedVersion: number };
  const accepted: AcceptedImport[] = [];
  if (valid.length) {
    const placeholders = valid.map(() => "?").join(",");
    const existingRows = await db.prepare(`SELECT q.id, q.question_code, q.subject, q.module, q.sub_type, q.stem,
      q.options_json, q.answer, q.prompt, q.source, q.source_exam_type, q.source_region, q.source_year, q.source_batch,
      q.version, q.score_rate, q.score_rate_correct, q.score_rate_attempts, q.score_rate_scope,
      q.score_rate_source, q.score_rate_updated_at, COUNT(DISTINCT qb.id) AS bank_count,
      MAX(CASE WHEN qb.id = ? THEN 1 ELSE 0 END) AS in_current_bank,
      GROUP_CONCAT(DISTINCT qb.name) AS bank_names
      FROM questions q
      LEFT JOIN question_bank_items qbi ON qbi.question_id = q.id
      LEFT JOIN question_banks qb ON qb.id = qbi.bank_id
      WHERE q.question_code IN (${placeholders}) GROUP BY q.id`)
      .bind(bankId, ...valid.map((item) => item.question.questionCode)).all<Record<string, unknown>>();
    const existingMap = new Map(existingRows.results.map((item) => [String(item.question_code), item]));
    for (const item of valid) {
      const existing = existingMap.get(item.question.questionCode);
      const currentVersion = existing ? Number(existing.version ?? 1) : 0;
      if (currentVersion !== item.baseVersion) {
        errors.push({ row: item.row, questionCode: item.question.questionCode, kind: "conflict",
          message: `题目在本导入任务上传后已变化（基线v${item.baseVersion}，当前v${currentVersion}）；已阻止覆盖，请新建导入任务`,
          rawJson: JSON.stringify(item.raw).slice(0, 500) });
      } else if (!existing) accepted.push({ question: item.question, row: item.row, mode: "write", expectedVersion: item.baseVersion });
      else if (Number(existing.in_current_bank) === 1 && Number(existing.bank_count) === 1) {
        if (duplicateStrategy === "reject") {
          errors.push({ row: item.row, questionCode: item.question.questionCode, kind: "duplicate",
            message: "题号已存在；本任务选择了“拒绝覆盖”策略", rawJson: JSON.stringify(item.raw).slice(0, 500) });
        } else if (duplicateStrategy === "replace_external_metrics"
          && (!(item.question.scoreRateAttempts > 0) || !/^https:\/\//i.test(item.question.scoreRateSource))) {
          errors.push({ row: item.row, questionCode: item.question.questionCode, kind: "conflict",
            message: "选择替换外部拿分率时，每个覆盖行都必须提供可追溯HTTPS来源及有效样本", rawJson: JSON.stringify(item.raw).slice(0, 500) });
        } else {
          const question = duplicateStrategy === "preserve_metrics" ? {
            ...item.question,
            scoreRate: Number(existing.score_rate ?? item.question.scoreRate),
            scoreRateCorrect: Number(existing.score_rate_correct ?? 0),
            scoreRateAttempts: Number(existing.score_rate_attempts ?? 0),
            scoreRateScope: String(existing.score_rate_scope ?? ""),
            scoreRateSource: String(existing.score_rate_source ?? "platform") || "platform",
            scoreRateUpdatedAt: existing.score_rate_updated_at ? String(existing.score_rate_updated_at) : null,
          } : item.question;
          accepted.push({ question, row: item.row, mode: "write", expectedVersion: item.baseVersion });
        }
      } else if (importedQuestionIdentityMatches(existing, item.question)) {
        accepted.push({ question: item.question, row: item.row, mode: "reuse", expectedVersion: item.baseVersion });
      } else {
        errors.push({ row: item.row, questionCode: item.question.questionCode, kind: "conflict",
          message: `题目编号已用于“${String(existing.bank_names ?? "其他题库")}”且核心内容不一致；共通题可复用编号，但题干、选项和答案必须一致`,
          rawJson: JSON.stringify(item.raw).slice(0, 500) });
      }
    }
  }
  await persistImportRowErrors(importId, chunkIndex, errors);
  if (accepted.length) {
    // One normalized JSON binding replaces up to 400 per-row statements. The
    // upload endpoint caps the source chunk at 480 KiB; this second guard makes
    // the D1 binding limit explicit after normalization/default expansion.
    const acceptedJson = JSON.stringify(accepted.map((item) => ({
      row: item.row,
      mode: item.mode,
      expectedVersion: item.expectedVersion,
      question: importedQuestionSnapshot(item.question),
    })));
    if (new TextEncoder().encode(acceptedJson).byteLength >= QUESTION_IMPORT_MAX_BINDING_BYTES) {
      throw new Error("规范化分块达到768KB绑定上限，请减小源文件分块后重试");
    }
    await db.batch([
      db.prepare(`INSERT INTO questions
        (question_code, subject, module, sub_type, stem, options_json, answer, explanation, technique,
         material, prompt, word_limit, scoring_points_json, difficulty, source, source_exam_type, source_region,
         source_year, source_batch, truth_verified, truth_verified_at, review_status, reviewed_by, reviewed_at,
         review_note, frequency, frequency_occurrences, frequency_papers, frequency_years_json, frequency_updated_at,
         importance_stars, importance_rule_version, importance_reason, importance_override_reason, score_rate,
         score_rate_correct, score_rate_attempts, score_rate_scope, score_rate_source, score_rate_updated_at,
         suggested_seconds, image_url, resource_url, status, version, updated_at)
        SELECT
          json_extract(incoming.value, '$.question.questionCode'),
          json_extract(incoming.value, '$.question.subject'),
          json_extract(incoming.value, '$.question.module'),
          COALESCE(json_extract(incoming.value, '$.question.subType'), ''),
          json_extract(incoming.value, '$.question.stem'),
          COALESCE(json(json_extract(incoming.value, '$.question.options')), '[]'),
          json_extract(incoming.value, '$.question.answer'),
          COALESCE(json_extract(incoming.value, '$.question.explanation'), ''),
          COALESCE(json_extract(incoming.value, '$.question.technique'), ''),
          COALESCE(json_extract(incoming.value, '$.question.material'), ''),
          COALESCE(json_extract(incoming.value, '$.question.prompt'), ''),
          CAST(json_extract(incoming.value, '$.question.wordLimit') AS INTEGER),
          COALESCE(json(json_extract(incoming.value, '$.question.scoringPoints')), '[]'),
          COALESCE(json_extract(incoming.value, '$.question.difficulty'), '中等'),
          COALESCE(json_extract(incoming.value, '$.question.source'), ''),
          COALESCE(json_extract(incoming.value, '$.question.sourceExamType'), ''),
          json_extract(incoming.value, '$.question.region'),
          CAST(json_extract(incoming.value, '$.question.examYear') AS INTEGER),
          COALESCE(json_extract(incoming.value, '$.question.sourceBatch'), ''),
          0, NULL, 'pending_review', NULL, NULL,
          CASE WHEN CAST(json_extract(incoming.value, '$.expectedVersion') AS INTEGER) > 0
            THEN CAST(json_extract(incoming.value, '$.expectedVersion') AS TEXT) ELSE '' END,
          COALESCE(json_extract(incoming.value, '$.question.frequency'), ''),
          COALESCE(CAST(json_extract(incoming.value, '$.question.frequencyOccurrences') AS INTEGER), 0),
          COALESCE(CAST(json_extract(incoming.value, '$.question.frequencyPapers') AS INTEGER), 0),
          COALESCE(json(json_extract(incoming.value, '$.question.frequencyYears')), '[]'),
          json_extract(incoming.value, '$.question.frequencyUpdatedAt'),
          COALESCE(CAST(json_extract(incoming.value, '$.question.importanceStars') AS INTEGER), 0),
          COALESCE(json_extract(incoming.value, '$.question.importanceRuleVersion'), ''),
          COALESCE(json_extract(incoming.value, '$.question.importanceReason'), ''),
          COALESCE(json_extract(incoming.value, '$.question.importanceOverrideReason'), ''),
          COALESCE(CAST(json_extract(incoming.value, '$.question.scoreRate') AS INTEGER), 0),
          COALESCE(CAST(json_extract(incoming.value, '$.question.scoreRateCorrect') AS INTEGER), 0),
          COALESCE(CAST(json_extract(incoming.value, '$.question.scoreRateAttempts') AS INTEGER), 0),
          COALESCE(json_extract(incoming.value, '$.question.scoreRateScope'), ''),
          COALESCE(json_extract(incoming.value, '$.question.scoreRateSource'), 'platform'),
          json_extract(incoming.value, '$.question.scoreRateUpdatedAt'),
          COALESCE(CAST(json_extract(incoming.value, '$.question.suggestedSeconds') AS INTEGER), 60),
          COALESCE(json_extract(incoming.value, '$.question.imageUrl'), ''),
          COALESCE(json_extract(incoming.value, '$.question.resourceUrl'), ''),
          'active', 1, CURRENT_TIMESTAMP
        FROM json_each(?) AS incoming
        WHERE json_extract(incoming.value, '$.mode') = 'write'
          AND NOT EXISTS (SELECT 1 FROM question_import_row_results completed
            WHERE completed.import_id = ?
              AND completed.row_number = CAST(json_extract(incoming.value, '$.row') AS INTEGER))
          AND ${QUESTION_IMPORT_WRITE_GUARD_SQL}
        ON CONFLICT(question_code) DO UPDATE SET
          subject = excluded.subject, module = excluded.module, sub_type = excluded.sub_type, stem = excluded.stem,
          options_json = excluded.options_json, answer = excluded.answer, explanation = excluded.explanation,
          technique = excluded.technique, material = excluded.material, prompt = excluded.prompt,
          word_limit = excluded.word_limit, scoring_points_json = excluded.scoring_points_json,
          difficulty = excluded.difficulty, source = excluded.source, source_exam_type = excluded.source_exam_type,
          source_region = excluded.source_region, source_year = excluded.source_year, source_batch = excluded.source_batch,
          truth_verified = 0, truth_verified_at = NULL, review_status = 'pending_review', reviewed_by = NULL,
          reviewed_at = NULL, review_note = '', frequency = excluded.frequency,
          frequency_occurrences = excluded.frequency_occurrences, frequency_papers = excluded.frequency_papers,
          frequency_years_json = excluded.frequency_years_json, frequency_updated_at = excluded.frequency_updated_at,
          importance_stars = excluded.importance_stars, importance_rule_version = excluded.importance_rule_version,
          importance_reason = excluded.importance_reason, importance_override_reason = excluded.importance_override_reason,
          score_rate = CASE WHEN ? = 'replace_external_metrics' THEN excluded.score_rate ELSE questions.score_rate END,
          score_rate_correct = CASE WHEN ? = 'replace_external_metrics' THEN excluded.score_rate_correct ELSE questions.score_rate_correct END,
          score_rate_attempts = CASE WHEN ? = 'replace_external_metrics' THEN excluded.score_rate_attempts ELSE questions.score_rate_attempts END,
          score_rate_scope = CASE WHEN ? = 'replace_external_metrics' THEN excluded.score_rate_scope ELSE questions.score_rate_scope END,
          score_rate_source = CASE WHEN ? = 'replace_external_metrics' THEN excluded.score_rate_source ELSE questions.score_rate_source END,
          score_rate_updated_at = CASE WHEN ? = 'replace_external_metrics' THEN excluded.score_rate_updated_at ELSE questions.score_rate_updated_at END,
          suggested_seconds = excluded.suggested_seconds, image_url = excluded.image_url,
          resource_url = excluded.resource_url, status = 'active', version = questions.version + 1,
          updated_at = CURRENT_TIMESTAMP
        WHERE questions.version = CAST(excluded.review_note AS INTEGER)`)
        .bind(acceptedJson, importId, chunkId, importId, leaseToken,
          duplicateStrategy, duplicateStrategy, duplicateStrategy, duplicateStrategy, duplicateStrategy, duplicateStrategy),
      db.prepare(`UPDATE practice_sessions SET status = 'abandoned', updated_at = CURRENT_TIMESTAMP
        WHERE status = 'active' AND json_valid(question_codes_json)
          AND EXISTS (
            SELECT 1 FROM json_each(practice_sessions.question_codes_json) session_question
            JOIN json_each(?) incoming
              ON session_question.value = json_extract(incoming.value, '$.question.questionCode')
            JOIN questions q ON q.question_code = json_extract(incoming.value, '$.question.questionCode')
            WHERE json_extract(incoming.value, '$.mode') = 'write'
              AND ${QUESTION_IMPORT_POST_STATE_SQL}
          ) AND ${QUESTION_IMPORT_WRITE_GUARD_SQL}`).bind(acceptedJson, chunkId, importId, leaseToken),
      db.prepare(`INSERT OR IGNORE INTO question_versions
        (question_id, version, question_code, snapshot_json, change_type, import_id, source_row, admin_user_id, review_status)
        SELECT q.id, q.version, q.question_code, json(json_extract(incoming.value, '$.question')),
          'import', ?, CAST(json_extract(incoming.value, '$.row') AS INTEGER), ?, q.review_status
        FROM json_each(?) AS incoming
        JOIN questions q ON q.question_code = json_extract(incoming.value, '$.question.questionCode')
        WHERE json_extract(incoming.value, '$.mode') = 'write'
          AND ${QUESTION_IMPORT_POST_STATE_SQL}
          AND NOT EXISTS (SELECT 1 FROM question_import_row_results completed
            WHERE completed.import_id = ?
              AND completed.row_number = CAST(json_extract(incoming.value, '$.row') AS INTEGER))
          AND ${QUESTION_IMPORT_WRITE_GUARD_SQL}`)
        .bind(importId, chunk.created_by ?? null, acceptedJson, importId, chunkId, importId, leaseToken),
      db.prepare(`INSERT OR IGNORE INTO question_bank_items (bank_id, question_id, sort_order)
        SELECT ?, q.id, CAST(json_extract(incoming.value, '$.row') AS INTEGER) - 2
        FROM json_each(?) AS incoming
        JOIN questions q ON q.question_code = json_extract(incoming.value, '$.question.questionCode')
        WHERE ${QUESTION_IMPORT_POST_STATE_SQL}
          AND ${QUESTION_IMPORT_WRITE_GUARD_SQL}`)
        .bind(bankId, acceptedJson, chunkId, importId, leaseToken),
      db.prepare(`INSERT OR IGNORE INTO question_import_row_results
        (import_id, row_number, chunk_index, status, question_code, question_version)
        SELECT ?, CAST(json_extract(incoming.value, '$.row') AS INTEGER), ?, 'imported', q.question_code, q.version
        FROM json_each(?) AS incoming
        JOIN questions q ON q.question_code = json_extract(incoming.value, '$.question.questionCode')
        WHERE ${QUESTION_IMPORT_POST_STATE_SQL}
          AND ${QUESTION_IMPORT_WRITE_GUARD_SQL}`)
        .bind(importId, chunkIndex, acceptedJson, chunkId, importId, leaseToken),
    ]);
  }
  const counts = await db.prepare(`SELECT COUNT(*) AS processed,
    COALESCE(SUM(CASE WHEN status = 'imported' THEN 1 ELSE 0 END), 0) AS imported,
    COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed
    FROM question_import_row_results WHERE import_id = ? AND chunk_index = ?`)
    .bind(importId, chunkIndex).first<{ processed: number; imported: number; failed: number }>();
  if (Number(counts?.processed ?? 0) !== Number(chunk.row_count)) throw new Error("分块行级结果不完整，可安全重试");
  const duplicateCount = await db.prepare(`SELECT COUNT(*) AS count FROM question_import_errors
    WHERE import_id = ? AND chunk_index = ? AND kind = 'duplicate'`).bind(importId, chunkIndex).first<{ count: number }>();
  await db.prepare(`UPDATE question_import_chunks SET status = 'completed', imported_rows = ?, failed_rows = ?,
    duplicate_rows = ?, error_summary = '', updated_at = CURRENT_TIMESTAMP, completed_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .bind(Number(counts?.imported ?? 0), Number(counts?.failed ?? 0), Number(duplicateCount?.count ?? 0), chunkId).run();
}

const INTERNAL_IMPORT_HEADER = "x-gkrl-internal-job-secret";

function internalJobSecret() {
  return String((env as unknown as { INTERNAL_JOB_SECRET?: string }).INTERNAL_JOB_SECRET ?? "").trim();
}

function sitesBypassBearerToken() {
  return String((env as unknown as { SITES_BYPASS_BEARER_TOKEN?: string }).SITES_BYPASS_BEARER_TOKEN ?? "").trim();
}

async function internalJobSecretMatches(request: Request) {
  const configured = internalJobSecret();
  const provided = request.headers.get(INTERNAL_IMPORT_HEADER) ?? "";
  if (configured.length < 32 || provided.length < 32) return false;
  const [configuredDigest, providedDigest] = await Promise.all([
    digestText(`gkrl-internal-job:${configured}`),
    digestText(`gkrl-internal-job:${provided}`),
  ]);
  return configuredDigest === providedDigest;
}

async function requestQuestionImportContinuation(importId: number, origin: string) {
  const secret = internalJobSecret();
  if (secret.length < 32 || !/^https?:\/\//i.test(origin)) return false;
  const bypassToken = sitesBypassBearerToken();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        [INTERNAL_IMPORT_HEADER]: secret,
      };
      // Owner-only Sites reject identity-less HTTP requests before they reach
      // the Worker. Keep the platform-issued bypass credential in hosted
      // secrets only; public deployments do not require it.
      if (bypassToken) headers["OAI-Sites-Authorization"] = `Bearer ${bypassToken}`;
      const response = await fetch(new URL("/api/app", origin), {
        method: "POST",
        headers,
        body: JSON.stringify({ action: "continueQuestionImportInternal", importId }),
      });
      if (response.ok) return true;
    } catch {
      // 下一次立即重试；任务状态仍在 D1 中保持 queued，不会丢失。
    }
  }
  return false;
}

async function requestContentImportInternal(origin: string, payload: Record<string, unknown>) {
  const secret = internalJobSecret();
  if (secret.length < 32 || !/^https?:\/\//i.test(origin)) return false;
  const bypassToken = sitesBypassBearerToken();
  try {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      [INTERNAL_IMPORT_HEADER]: secret,
    };
    if (bypassToken) headers["OAI-Sites-Authorization"] = `Bearer ${bypassToken}`;
    const response = await fetch(new URL("/api/app", origin), {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    return response.ok;
  } catch {
    // The job and every chunk remain durable in D1. A task-list poll can
    // safely dispatch the same slot/chunk again without duplicating rows.
    return false;
  }
}

async function requestContentImportFanout(importId: number, totalChunks: number, origin: string) {
  const slotCount = Math.min(CONTENT_IMPORT_WORKER_SLOTS, Math.max(0, totalChunks));
  if (slotCount < 1) return false;
  const results = await Promise.all(Array.from({ length: slotCount }, (_, slot) => requestContentImportInternal(origin, {
    action: "fanoutContentImportInternal",
    importId,
    totalChunks,
    slot,
  })));
  return results.every(Boolean);
}

async function requestContentImportSlotChunks(importId: number, totalChunks: number, slot: number, origin: string) {
  const chunkIndexes = Array.from({ length: CONTENT_IMPORT_CHUNKS_PER_SLOT }, (_, offset) => (
    slot + offset * CONTENT_IMPORT_WORKER_SLOTS
  )).filter((chunkIndex) => chunkIndex < totalChunks);
  if (!chunkIndexes.length) return true;
  const results = await Promise.all(chunkIndexes.map((chunkIndex) => requestContentImportInternal(origin, {
    action: "processContentImportChunkInternal",
    importId,
    chunkIndex,
  })));
  return results.every(Boolean);
}

async function reapImportCancellation(importId: number, importKind: "question" | "content") {
  const db = getD1();
  if (importKind === "question") {
    await db.batch([
      db.prepare(`UPDATE question_import_chunks SET status = 'cancelled', rows_json = '[]', updated_at = CURRENT_TIMESTAMP
        WHERE import_id = ? AND status IN ('queued','processing') AND EXISTS (
          SELECT 1 FROM question_imports cancelling_job WHERE cancelling_job.id = ?
            AND cancelling_job.cancel_requested = 1 AND cancelling_job.status = 'cancelling'
            AND (cancelling_job.lease_until IS NULL OR datetime(cancelling_job.lease_until) <= CURRENT_TIMESTAMP)
        )`).bind(importId, importId),
      db.prepare(`UPDATE question_imports SET status = 'cancelled', lease_token = NULL, lease_until = NULL,
          completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND cancel_requested = 1 AND status = 'cancelling'
          AND (lease_until IS NULL OR datetime(lease_until) <= CURRENT_TIMESTAMP)`).bind(importId),
    ]);
    return;
  }
  await db.prepare(`UPDATE content_import_chunks SET status = 'cancelled', lease_token = NULL, lease_until = NULL,
      rows_json = '[]', completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
    WHERE import_id = ? AND status IN ('queued','processing')
      AND (status = 'queued' OR lease_until IS NULL OR datetime(lease_until) <= CURRENT_TIMESTAMP)
      AND EXISTS (SELECT 1 FROM content_imports cancelling_job WHERE cancelling_job.id = ?
        AND cancelling_job.cancel_requested = 1 AND cancelling_job.status = 'cancelling')`)
    .bind(importId, importId).run();
  await refreshContentImportProgress(importId);
}

async function dispatchDueImportWork(request: Request) {
  const db = getD1();
  const job = await db.prepare(`SELECT kind, id, total_chunks, due_at FROM (
      SELECT CASE WHEN cancel_requested = 1 THEN 'question_cancel' ELSE 'question' END AS kind,
        id, 0 AS total_chunks,
        COALESCE(lease_until, updated_at, created_at) AS due_at
      FROM question_imports
      WHERE ((cancel_requested = 0 AND status IN ('queued','processing'))
          OR (cancel_requested = 1 AND status = 'cancelling'))
        AND (lease_until IS NULL OR datetime(lease_until) <= CURRENT_TIMESTAMP)
      UNION ALL
      SELECT 'content' AS kind, id, total_chunks,
        COALESCE(next_retry_at, sealed_at, created_at) AS due_at
      FROM content_imports
      WHERE cancel_requested = 0 AND status IN ('queued','processing')
        AND (next_retry_at IS NULL OR datetime(next_retry_at) <= CURRENT_TIMESTAMP)
      UNION ALL
      SELECT 'content_cancel' AS kind, cancel_job.id, cancel_job.total_chunks,
        cancel_job.updated_at AS due_at
      FROM content_imports cancel_job
      WHERE cancel_job.cancel_requested = 1 AND cancel_job.status = 'cancelling'
        AND NOT EXISTS (SELECT 1 FROM content_import_chunks active_chunk
          WHERE active_chunk.import_id = cancel_job.id AND active_chunk.status = 'processing'
            AND datetime(active_chunk.lease_until) > CURRENT_TIMESTAMP)
    ) ORDER BY due_at, id LIMIT 1`)
    .first<{ kind: "question" | "question_cancel" | "content" | "content_cancel"; id: number; total_chunks: number }>();
  if (!job) return false;
  const origin = new URL(request.url).origin;
  if (job.kind === "question_cancel" || job.kind === "content_cancel") {
    const importKind = job.kind === "question_cancel" ? "question" : "content";
    const schedule = () => requestContentImportInternal(origin, {
      action: "reapImportCancellationInternal", importId: Number(job.id), importKind,
    });
    return scheduleRequestTask(request, schedule) || await schedule();
  }
  if (job.kind === "question") {
    // Always resume in a fresh Worker invocation. Running the importer inside
    // this ordinary request would add its D1 reads to bootstrap/action reads
    // and can cross the Free-plan per-invocation query ceiling.
    return scheduleRequestTask(request, () => requestQuestionImportContinuation(Number(job.id), origin));
  }
  const claimed = await db.prepare(`UPDATE content_imports SET
      dispatch_attempts = dispatch_attempts + 1,
      next_retry_at = CASE
        WHEN dispatch_attempts < 2 THEN datetime('now','+15 seconds')
        WHEN dispatch_attempts < 5 THEN datetime('now','+1 minute')
        ELSE datetime('now','+5 minutes') END,
      last_heartbeat_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND cancel_requested = 0 AND status IN ('queued','processing')
      AND (next_retry_at IS NULL OR datetime(next_retry_at) <= CURRENT_TIMESTAMP)`)
    .bind(Number(job.id)).run();
  if (!claimed.meta.changes) return false;
  return scheduleRequestTask(request, async () => {
    const accepted = await requestContentImportFanout(Number(job.id), Number(job.total_chunks), origin);
    if (!accepted) {
      await db.prepare(`UPDATE content_imports SET next_retry_at = MIN(
          COALESCE(next_retry_at, datetime('now','+1 minute')), datetime('now','+1 minute')
        ), updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status IN ('queued','processing')`).bind(Number(job.id)).run();
    }
  });
}

async function processQuestionImport(importId: number, budgetMs = 24_000, continuationOrigin = "") {
  const db = getD1();
  const leaseToken = crypto.randomUUID();
  const claimed = await db.prepare(`UPDATE question_imports SET lease_token = ?, lease_until = datetime('now', '+45 seconds'),
    status = 'processing', started_at = COALESCE(started_at, CURRENT_TIMESTAMP), last_heartbeat_at = CURRENT_TIMESTAMP,
    updated_at = CURRENT_TIMESTAMP WHERE id = ? AND cancel_requested = 0 AND status IN ('queued','processing')
    AND (lease_until IS NULL OR lease_until < CURRENT_TIMESTAMP)`).bind(leaseToken, importId).run();
  if (!claimed.meta.changes) return;
  const durableMeta = await db.prepare("SELECT total_chunks, uploaded_chunks FROM question_imports WHERE id = ? AND lease_token = ?")
    .bind(importId, leaseToken).first<{ total_chunks: number; uploaded_chunks: number }>();
  if (!durableMeta || Number(durableMeta.total_chunks) < 1) {
    await db.prepare(`UPDATE question_imports SET status = 'failed',
      error_summary = '旧版任务没有持久化分块，无法自动恢复；请使用原文件重新导入',
      lease_token = NULL, lease_until = NULL, completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP),
      updated_at = CURRENT_TIMESTAMP WHERE id = ? AND lease_token = ?`).bind(importId, leaseToken).run();
    return;
  }
  // A Worker can be evicted between claiming a chunk and writing its result.
  // Once the job lease is reclaimed, row-level idempotency makes those stale
  // processing chunks safe to enqueue again.
  await db.prepare(`UPDATE question_import_chunks SET status = 'queued', updated_at = CURRENT_TIMESTAMP
    WHERE import_id = ? AND status = 'processing'`).bind(importId).run();
  const started = Date.now();
  let remainingD1QueryBudget = QUESTION_IMPORT_D1_QUERY_LIMIT - QUESTION_IMPORT_D1_QUERY_RESERVE;
  let attemptedChunks = 0;
  try {
    while (Date.now() - started < budgetMs
      && attemptedChunks < QUESTION_IMPORT_MAX_CHUNKS_PER_INVOCATION
      && remainingD1QueryBudget >= QUESTION_IMPORT_CHUNK_QUERY_BUDGET) {
      const job = await db.prepare("SELECT cancel_requested FROM question_imports WHERE id = ? AND lease_token = ?")
        .bind(importId, leaseToken).first<{ cancel_requested: number }>();
      if (!job || Number(job.cancel_requested) === 1) break;
      const chunk = await db.prepare(`SELECT id, attempts FROM question_import_chunks
        WHERE import_id = ? AND status = 'queued' ORDER BY chunk_index LIMIT 1`).bind(importId)
        .first<{ id: number; attempts: number }>();
      if (!chunk) {
        await refreshQuestionImportProgress(importId);
        break;
      }
      await db.prepare(`UPDATE question_import_chunks SET status = 'processing', attempts = attempts + 1,
        updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'queued'`).bind(chunk.id).run();
      // processQuestionImportChunk is capped at 13 D1 statements in the
      // validation+error+write path; reserve 15 to leave two-query headroom.
      attemptedChunks += 1;
      remainingD1QueryBudget -= QUESTION_IMPORT_CHUNK_QUERY_BUDGET;
      try {
        await processQuestionImportChunk(importId, Number(chunk.id), leaseToken);
      } catch (error) {
        const message = error instanceof Error ? error.message.slice(0, 1_000) : "分块处理失败";
        const nextStatus = Number(chunk.attempts ?? 0) + 1 >= 3 ? "failed" : "queued";
        await db.prepare(`UPDATE question_import_chunks SET status = ?, error_summary = ?,
          updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(nextStatus, message, chunk.id).run();
      }
      await db.prepare(`UPDATE question_imports SET lease_until = datetime('now', '+45 seconds'),
        last_heartbeat_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND lease_token = ?`)
        .bind(importId, leaseToken).run();
      const progress = await refreshQuestionImportProgress(importId);
      if (progress && new Set(["completed", "completed_with_errors", "failed", "cancelled"]).has(progress.status)) break;
    }
  } finally {
    const job = await db.prepare("SELECT cancel_requested, status FROM question_imports WHERE id = ? AND lease_token = ?")
      .bind(importId, leaseToken).first<{ cancel_requested: number; status: string }>();
    if (job && Number(job.cancel_requested) === 1) {
      await db.batch([
        db.prepare("UPDATE question_import_chunks SET status = 'cancelled', rows_json = '[]', updated_at = CURRENT_TIMESTAMP WHERE import_id = ? AND status IN ('queued','processing')").bind(importId),
        db.prepare(`UPDATE question_imports SET status = 'cancelled', lease_token = NULL, lease_until = NULL,
          completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP WHERE id = ? AND lease_token = ?`).bind(importId, leaseToken),
      ]);
    } else if (job && !new Set(["completed", "completed_with_errors", "failed", "cancelled"]).has(job.status)) {
      await db.prepare(`UPDATE question_imports SET status = 'queued', lease_token = NULL, lease_until = NULL,
        updated_at = CURRENT_TIMESTAMP WHERE id = ? AND lease_token = ?`).bind(importId, leaseToken).run();
    } else {
      await db.prepare("UPDATE question_imports SET lease_token = NULL, lease_until = NULL WHERE id = ? AND lease_token = ?")
        .bind(importId, leaseToken).run();
    }
  }
  const pending = await db.prepare("SELECT status FROM question_imports WHERE id = ?")
    .bind(importId).first<{ status: string }>();
  if (pending?.status === "queued" && continuationOrigin) {
    await requestQuestionImportContinuation(importId, continuationOrigin);
  }
}

async function adminImportQuestionBatch(payload: Record<string, unknown>) {
  if (!canAdmin(payload, "question.import")) return adminForbidden("question.import");
  const importId = Math.floor(Number(payload.importId));
  const bankId = Math.floor(Number(payload.bankId));
  const chunkIndex = Math.max(0, Math.floor(Number(payload.chunkIndex ?? 0)));
  const rowOffset = Math.max(0, Math.floor(Number(payload.offset ?? payload.rowOffset ?? 0)));
  if (!Array.isArray(payload.rows) || payload.rows.length < 1 || payload.rows.length > QUESTION_IMPORT_CHUNK_ROWS) {
    return json({ error: "每个持久化分块需包含1—80道题" }, 400);
  }
  const db = getD1();
  const job = await db.prepare(`SELECT id, file_hash, total_rows, total_chunks, status, cancel_requested
    FROM question_imports WHERE id = ? AND bank_id = ?`).bind(importId, bankId).first<Record<string, unknown>>();
  if (!job) return json({ error: "导入任务不存在" }, 404);
  if (trimmed(payload.fileHash, 64).toLowerCase() !== String(job.file_hash)) return json({ error: "文件指纹不一致，不能把不同文件混入同一任务" }, 409);
  if (String(job.status) !== "uploading" || Number(job.cancel_requested) === 1) return json({ error: "任务已封存、取消或进入处理阶段" }, 409);
  if (chunkIndex >= Number(job.total_chunks) || rowOffset + payload.rows.length > Number(job.total_rows)) {
    return json({ error: "分块序号或行范围超出任务边界" }, 400);
  }
  const rowsJson = JSON.stringify(payload.rows);
  if (new TextEncoder().encode(rowsJson).byteLength > QUESTION_IMPORT_UPLOAD_BYTES) {
    return json({ error: "单个持久化分块超过480KB，请减小分块后重试" }, 413);
  }
  const payloadHash = await sha256Text(rowsJson);
  const existing = await db.prepare(`SELECT payload_hash, row_offset, row_count FROM question_import_chunks
    WHERE import_id = ? AND chunk_index = ?`).bind(importId, chunkIndex).first<Record<string, unknown>>();
  if (existing) {
    if (String(existing.payload_hash) !== payloadHash || Number(existing.row_offset) !== rowOffset
      || Number(existing.row_count) !== payload.rows.length) {
      return json({ error: "同一分块序号已上传不同内容；为避免覆盖，请取消任务后重新导入" }, 409);
    }
    return json({ ok: true, idempotent: true, chunkIndex, payloadHash });
  }
  const codes = payload.rows.map((raw, index) => ({
    rowNumber: rowOffset + index + 2,
    questionCode: trimmed((raw as Record<string, unknown>)?.questionCode, 80).toUpperCase(),
  })).filter((item) => item.questionCode);
  await db.batch([
    db.prepare(`INSERT INTO question_import_chunks
      (import_id, chunk_index, row_offset, row_count, payload_hash, rows_json, status)
      VALUES (?, ?, ?, ?, ?, ?, 'queued')`).bind(importId, chunkIndex, rowOffset, payload.rows.length, payloadHash, rowsJson),
    db.prepare(`INSERT OR IGNORE INTO question_import_codes
      (import_id, chunk_index, row_number, question_code, base_version)
      SELECT ?, ?, CAST(json_extract(incoming.value, '$.rowNumber') AS INTEGER),
        json_extract(incoming.value, '$.questionCode'), COALESCE(q.version, 0)
      FROM json_each(?) incoming
      LEFT JOIN questions q ON q.question_code = json_extract(incoming.value, '$.questionCode')`)
      .bind(importId, chunkIndex, JSON.stringify(codes)),
    db.prepare(`UPDATE question_imports SET uploaded_chunks =
        (SELECT COUNT(*) FROM question_import_chunks WHERE import_id = ?),
      uploaded_rows = (SELECT COALESCE(SUM(row_count), 0) FROM question_import_chunks WHERE import_id = ?),
      updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(importId, importId, importId),
  ]);
  return json({ ok: true, idempotent: false, chunkIndex, payloadHash });
}

async function questionImportDuplicatePreview(importId: number) {
  const db = getD1();
  const [withinFile, existing, duplicateCount, existingCount] = await Promise.all([
    db.prepare(`SELECT question_code, COUNT(*) AS occurrences, MIN(row_number) AS first_row,
      GROUP_CONCAT(row_number) AS rows FROM question_import_codes WHERE import_id = ?
      GROUP BY question_code HAVING COUNT(*) > 1 ORDER BY first_row LIMIT 100`).bind(importId).all<Record<string, unknown>>(),
    db.prepare(`SELECT q.question_code, q.version, q.review_status, GROUP_CONCAT(DISTINCT qb.name) AS bank_names
      FROM question_import_codes qic JOIN questions q ON q.question_code = qic.question_code
      LEFT JOIN question_bank_items qbi ON qbi.question_id = q.id LEFT JOIN question_banks qb ON qb.id = qbi.bank_id
      WHERE qic.import_id = ? GROUP BY q.id ORDER BY q.question_code LIMIT 100`).bind(importId).all<Record<string, unknown>>(),
    db.prepare(`SELECT COALESCE(SUM(occurrences - 1), 0) AS count FROM (
      SELECT COUNT(*) AS occurrences FROM question_import_codes WHERE import_id = ?
      GROUP BY question_code HAVING COUNT(*) > 1)`).bind(importId).first<{ count: number }>(),
    db.prepare(`SELECT COUNT(DISTINCT q.id) AS count FROM question_import_codes qic
      JOIN questions q ON q.question_code = qic.question_code WHERE qic.import_id = ?`)
      .bind(importId).first<{ count: number }>(),
  ]);
  const duplicateRows = Number(duplicateCount?.count ?? 0);
  await db.prepare("UPDATE question_imports SET duplicate_rows = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(duplicateRows, importId).run();
  return { withinFile: withinFile.results, existing: existing.results, duplicateRows,
    existingCount: Number(existingCount?.count ?? 0), previewTruncated: withinFile.results.length >= 100 || existing.results.length >= 100 };
}

async function adminPreviewQuestionImportDuplicates(payload: Record<string, unknown>) {
  const importId = Math.floor(Number(payload.importId));
  const job = await getD1().prepare("SELECT id FROM question_imports WHERE id = ?").bind(importId).first();
  if (!job) return json({ error: "导入任务不存在" }, 404);
  return json({ ok: true, ...(await questionImportDuplicatePreview(importId)) });
}

async function adminFinishQuestionImport(request: Request, payload: Record<string, unknown>) {
  if (!canAdmin(payload, "question.import")) return adminForbidden("question.import");
  const importId = Math.floor(Number(payload.importId));
  if (payload.aborted === true) return adminCancelQuestionImport(payload);
  const db = getD1();
  const job = await db.prepare(`SELECT total_rows, total_chunks, uploaded_rows, uploaded_chunks, status
    FROM question_imports WHERE id = ?`).bind(importId).first<Record<string, unknown>>();
  if (!job) return json({ error: "导入任务不存在" }, 404);
  if (String(job.status) !== "uploading") return json({ error: "任务已封存或处理" }, 409);
  const chunks = await db.prepare(`SELECT chunk_index, row_offset, row_count FROM question_import_chunks
    WHERE import_id = ? ORDER BY row_offset`).bind(importId).all<Record<string, unknown>>();
  let expectedOffset = 0;
  for (const chunk of chunks.results) {
    if (Number(chunk.row_offset) !== expectedOffset) return json({ error: `分块不连续，缺少从第${expectedOffset + 2}行开始的数据` }, 409);
    expectedOffset += Number(chunk.row_count);
  }
  if (Number(job.uploaded_rows) !== Number(job.total_rows) || Number(job.uploaded_chunks) !== Number(job.total_chunks)
    || expectedOffset !== Number(job.total_rows)) return json({ error: "文件尚未完整持久化，不能提交后台处理" }, 409);
  const preview = await questionImportDuplicatePreview(importId);
  await db.prepare(`UPDATE question_imports SET status = 'queued', sealed_at = CURRENT_TIMESTAMP,
    updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'uploading'`).bind(importId).run();
  const origin = new URL(request.url).origin;
  // Dispatch processing into a fresh internal Worker invocation. The current
  // admin request has already spent queries on authentication, schema seeding,
  // continuity checks and duplicate preview, so processing a chunk here could
  // exceed D1 Free's per-invocation allowance.
  const scheduled = scheduleRequestTask(request, () => requestQuestionImportContinuation(importId, origin));
  const dispatched = scheduled || await requestQuestionImportContinuation(importId, origin);
  return json({ ok: true, importId, status: "queued", backgroundScheduled: dispatched, duplicatePreview: preview });
}

async function adminGetQuestionImport(request: Request, payload: Record<string, unknown>) {
  const importId = Math.floor(Number(payload.importId));
  const db = getD1();
  const job = await db.prepare(`SELECT qi.*, qb.name AS bank_name FROM question_imports qi
    JOIN question_banks qb ON qb.id = qi.bank_id WHERE qi.id = ?`).bind(importId).first<Record<string, unknown>>();
  if (!job) return json({ error: "导入任务不存在" }, 404);
  if (new Set(["queued", "processing"]).has(String(job.status))) {
    const origin = new URL(request.url).origin;
    scheduleRequestTask(request, () => requestQuestionImportContinuation(importId, origin));
  }
  const errors = await db.prepare(`SELECT row_number, question_code, kind, message FROM question_import_errors
    WHERE import_id = ? ORDER BY row_number LIMIT 100`).bind(importId).all<Record<string, unknown>>();
  return json({ ok: true, job, errors: errors.results });
}

async function adminCancelQuestionImport(payload: Record<string, unknown>) {
  const importId = Math.floor(Number(payload.importId));
  const db = getD1();
  const job = await db.prepare("SELECT status FROM question_imports WHERE id = ?").bind(importId).first<{ status: string }>();
  if (!job) return json({ error: "导入任务不存在" }, 404);
  if (new Set(["completed", "completed_with_errors", "failed", "cancelled"]).has(job.status)) {
    return json({ ok: true, status: job.status, idempotent: true });
  }
  await db.batch([
    db.prepare("UPDATE question_imports SET cancel_requested = 1, status = 'cancelling', updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(importId),
    db.prepare("UPDATE question_import_chunks SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE import_id = ? AND status = 'queued'").bind(importId),
  ]);
  const processing = await db.prepare("SELECT COUNT(*) AS count FROM question_import_chunks WHERE import_id = ? AND status = 'processing'")
    .bind(importId).first<{ count: number }>();
  if (Number(processing?.count ?? 0) === 0) {
    await db.batch([
      db.prepare(`UPDATE question_imports SET status = 'cancelled', completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP),
        lease_token = NULL, lease_until = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(importId),
      db.prepare("UPDATE question_import_chunks SET rows_json = '[]' WHERE import_id = ?").bind(importId),
    ]);
  }
  return json({ ok: true, status: Number(processing?.count ?? 0) ? "cancelling" : "cancelled" });
}

async function adminRetryQuestionImport(request: Request, payload: Record<string, unknown>) {
  const importId = Math.floor(Number(payload.importId));
  const db = getD1();
  const job = await db.prepare("SELECT status FROM question_imports WHERE id = ?").bind(importId).first<{ status: string }>();
  if (!job) return json({ error: "导入任务不存在" }, 404);
  if (job.status !== "failed") return json({ error: "只有系统处理失败的任务可以安全重试；校验失败请修正原文件后新建导入" }, 409);
  const reset = await db.prepare(`UPDATE question_import_chunks SET status = 'queued', attempts = 0, error_summary = '',
    updated_at = CURRENT_TIMESTAMP WHERE import_id = ? AND status = 'failed'`).bind(importId).run();
  if (!reset.meta.changes) return json({ error: "没有可重试的失败分块" }, 409);
  await db.prepare(`UPDATE question_imports SET status = 'queued', cancel_requested = 0, completed_at = NULL,
    lease_token = NULL, lease_until = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(importId).run();
  const origin = new URL(request.url).origin;
  const scheduled = scheduleRequestTask(request, () => requestQuestionImportContinuation(importId, origin));
  const dispatched = scheduled || await requestQuestionImportContinuation(importId, origin);
  return json({ ok: true, status: "queued", backgroundScheduled: dispatched });
}

function csvCell(value: unknown) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

async function adminDownloadQuestionImportErrors(payload: Record<string, unknown>) {
  const importId = Math.floor(Number(payload.importId));
  const offset = Math.max(0, Math.floor(Number(payload.offset ?? 0)));
  const limit = 1_000;
  const db = getD1();
  const job = await db.prepare("SELECT file_name FROM question_imports WHERE id = ?").bind(importId).first<{ file_name: string }>();
  if (!job) return json({ error: "导入任务不存在" }, 404);
  const [rows, total] = await Promise.all([
    db.prepare(`SELECT row_number, question_code, kind, message FROM question_import_errors
      WHERE import_id = ? ORDER BY row_number LIMIT ? OFFSET ?`).bind(importId, limit, offset).all<Record<string, unknown>>(),
    db.prepare("SELECT COUNT(*) AS count FROM question_import_errors WHERE import_id = ?").bind(importId).first<{ count: number }>(),
  ]);
  const content = [...(offset === 0 ? ["行号,题目编号,错误类型,错误原因"] : []), ...rows.results.map((item) =>
    [item.row_number, item.question_code, item.kind, item.message].map(csvCell).join(","))].join("\r\n");
  const baseName = job.file_name.replace(/\.[^.]+$/, "").slice(0, 120);
  const nextOffset = offset + rows.results.length < Number(total?.count ?? 0) ? offset + rows.results.length : null;
  return json({ ok: true, fileName: `${baseName}-导入错误.csv`, contentType: "text/csv;charset=utf-8",
    content: `${offset === 0 ? "\uFEFF" : "\r\n"}${content}`, nextOffset, total: Number(total?.count ?? 0) });
}

async function adminListQuestionVersions(payload: Record<string, unknown>) {
  const questionId = Math.floor(Number(payload.questionId));
  const questionCode = trimmed(payload.questionCode, 80).toUpperCase();
  const db = getD1();
  const question = questionId > 0
    ? await db.prepare(`SELECT q.id, q.question_code, q.version, q.review_status,
        (SELECT COUNT(*) FROM question_bank_items qbi WHERE qbi.question_id = q.id) AS bank_count,
        (SELECT GROUP_CONCAT(qb.name) FROM question_bank_items qbi JOIN question_banks qb ON qb.id = qbi.bank_id
          WHERE qbi.question_id = q.id) AS bank_names FROM questions q WHERE q.id = ?`).bind(questionId).first<Record<string, unknown>>()
    : await db.prepare(`SELECT q.id, q.question_code, q.version, q.review_status,
        (SELECT COUNT(*) FROM question_bank_items qbi WHERE qbi.question_id = q.id) AS bank_count,
        (SELECT GROUP_CONCAT(qb.name) FROM question_bank_items qbi JOIN question_banks qb ON qb.id = qbi.bank_id
          WHERE qbi.question_id = q.id) AS bank_names FROM questions q WHERE q.question_code = ?`).bind(questionCode).first<Record<string, unknown>>();
  if (!question) return json({ error: "题目不存在" }, 404);
  const versions = await db.prepare(`SELECT qv.id, qv.version, qv.question_code, qv.snapshot_json, qv.change_type,
    qv.import_id, qv.source_row, qv.from_version, qv.admin_user_id,
    CASE WHEN qv.version = q.version THEN q.review_status ELSE qv.review_status END AS review_status,
    qv.created_at, au.display_name AS admin_name FROM question_versions qv
    JOIN questions q ON q.id = qv.question_id LEFT JOIN admin_users au ON au.id = qv.admin_user_id
    WHERE qv.question_id = ? ORDER BY qv.version DESC LIMIT 100`).bind(Number(question.id)).all<Record<string, unknown>>();
  return json({ ok: true, question, versions: versions.results.map((item) => ({
    ...item, snapshot: (() => { try { return JSON.parse(String(item.snapshot_json)); } catch { return null; } })(), snapshot_json: undefined,
  })) });
}

async function adminRollbackQuestionVersion(payload: Record<string, unknown>) {
  if (!canAdmin(payload, "question.write")) return adminForbidden("question.write");
  const admin = adminFromPayload(payload);
  const questionId = Math.floor(Number(payload.questionId));
  const targetVersion = Math.floor(Number(payload.version));
  const expectedVersion = Math.floor(Number(payload.expectedVersion));
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    return json({ error: "缺少题目当前版本，请刷新后重试", code: "QUESTION_VERSION_REQUIRED" }, 409);
  }
  const db = getD1();
  const [live, target] = await Promise.all([
    db.prepare("SELECT id, question_code, version, status FROM questions WHERE id = ?").bind(questionId).first<Record<string, unknown>>(),
    db.prepare(`SELECT version, question_code, snapshot_json FROM question_versions
      WHERE question_id = ? AND version = ?`).bind(questionId, targetVersion).first<Record<string, unknown>>(),
  ]);
  if (!live || !target) return json({ error: "题目或目标版本不存在" }, 404);
  if (Number(live.version) !== expectedVersion) {
    return json({
      error: "题目已被其他管理员更新，请刷新版本历史后重试",
      code: "QUESTION_VERSION_CONFLICT",
      currentVersion: Number(live.version),
    }, 409);
  }
  if (targetVersion === Number(live.version)) return json({ error: "当前已经是该版本，无需回滚" }, 409);
  let snapshot: Record<string, unknown>;
  try { snapshot = JSON.parse(String(target.snapshot_json)) as Record<string, unknown>; }
  catch { return json({ error: "目标版本快照损坏，已拒绝回滚" }, 409); }
  if (String(snapshot.questionCode) !== String(live.question_code)) return json({ error: "版本快照与当前题目不匹配" }, 409);
  const pendingSnapshot = { ...snapshot, truthVerified: false, reviewStatus: "pending_review", status: String(live.status ?? "active") };
  const nextVersion = expectedVersion + 1;
  const results = await db.batch([
    db.prepare(`UPDATE questions SET subject = ?, module = ?, sub_type = ?, stem = ?, options_json = ?, answer = ?,
      explanation = ?, technique = ?, material = ?, prompt = ?, word_limit = ?, scoring_points_json = ?, difficulty = ?,
      source = ?, source_exam_type = ?, source_region = ?, source_year = ?, source_batch = ?, truth_verified = 0,
      truth_verified_at = NULL, review_status = 'pending_review', reviewed_by = NULL, reviewed_at = NULL, review_note = '',
      frequency = ?, frequency_occurrences = ?, frequency_papers = ?, frequency_years_json = ?, frequency_updated_at = ?,
      importance_stars = ?, importance_rule_version = ?, importance_reason = ?, importance_override_reason = ?,
      score_rate = ?, score_rate_correct = ?, score_rate_attempts = ?, score_rate_scope = ?, score_rate_source = ?,
       score_rate_updated_at = ?, suggested_seconds = ?, image_url = ?, resource_url = ?, status = ?,
      version = version + 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND version = ? AND ${QUESTION_NOT_LOCKED_BY_IMPORT_SQL}`)
      .bind(String(snapshot.subject ?? ""), String(snapshot.module ?? ""), String(snapshot.subType ?? ""), String(snapshot.stem ?? ""),
        JSON.stringify(Array.isArray(snapshot.options) ? snapshot.options : []), snapshot.answer ?? null,
        String(snapshot.explanation ?? ""), String(snapshot.technique ?? ""), String(snapshot.material ?? ""),
        String(snapshot.prompt ?? ""), snapshot.wordLimit ?? null, JSON.stringify(Array.isArray(snapshot.scoringPoints) ? snapshot.scoringPoints : []),
        String(snapshot.difficulty ?? "中等"), String(snapshot.source ?? ""), String(snapshot.sourceExamType ?? ""),
        String(snapshot.region ?? ""), snapshot.examYear ?? null, String(snapshot.sourceBatch ?? ""), String(snapshot.frequency ?? ""),
        Number(snapshot.frequencyOccurrences ?? 0), Number(snapshot.frequencyPapers ?? 0),
        JSON.stringify(Array.isArray(snapshot.frequencyYears) ? snapshot.frequencyYears : []), snapshot.frequencyUpdatedAt ?? null,
        Number(snapshot.importanceStars ?? 0), String(snapshot.importanceRuleVersion ?? ""), String(snapshot.importanceReason ?? ""),
        String(snapshot.importanceOverrideReason ?? ""), Number(snapshot.scoreRate ?? 0), Number(snapshot.scoreRateCorrect ?? 0),
        Number(snapshot.scoreRateAttempts ?? 0), String(snapshot.scoreRateScope ?? ""), String(snapshot.scoreRateSource ?? "platform"),
        snapshot.scoreRateUpdatedAt ?? null, Number(snapshot.suggestedSeconds ?? 60), String(snapshot.imageUrl ?? ""),
        String(snapshot.resourceUrl ?? ""), String(live.status ?? "active"), questionId, expectedVersion),
    db.prepare(`INSERT INTO question_versions
      (question_id, version, question_code, snapshot_json, change_type, from_version, admin_user_id, review_status)
      SELECT id, version, question_code, ?, 'rollback', ?, ?, 'pending_review' FROM questions
      WHERE id = ? AND version = ? AND changes() = 1`)
      .bind(JSON.stringify(pendingSnapshot), targetVersion, admin?.id ?? null, questionId, nextVersion),
    db.prepare(`UPDATE practice_sessions SET status = 'abandoned', updated_at = CURRENT_TIMESTAMP
      WHERE changes() = 1 AND status = 'active' AND json_valid(question_codes_json)
        AND EXISTS (SELECT 1 FROM json_each(practice_sessions.question_codes_json)
          WHERE json_each.value = ?)`)
      .bind(String(live.question_code)),
    draftInvalidPublishedBanksForQuestion(db,
      { questionId, version: nextVersion, reviewStatus: "pending_review" }),
    abandonActiveSessionsForDraftedQuestionBanks(db,
      { questionId, version: nextVersion, reviewStatus: "pending_review" }),
    draftEssayLibraryPapersForQuestion(db,
      { questionId, version: nextVersion, reviewStatus: "pending_review" }),
  ]);
  if (!results[0]?.meta.changes) {
    return json({
      error: "题目已被其他管理员更新，请刷新版本历史后重试",
      code: "QUESTION_VERSION_CONFLICT",
    }, 409);
  }
  return json({ ok: true, id: questionId, version: nextVersion, reviewStatus: "pending_review",
    rolledBackFromVersion: targetVersion, message: "已生成新的待审核版本；历史版本未被删除" });
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
  const password = String(payload.password ?? payload.adminToken ?? "");
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
  const result = await authenticateAdmin(db, request, getAdminSecret(), username, password);
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
  const [review, imports, scheduled, reports] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS count FROM content_items WHERE status = 'pending_review'").first<{ count: number }>(),
    db.prepare("SELECT COUNT(*) AS count FROM question_imports WHERE status IN ('uploading','queued','processing','cancelling')").first<{ count: number }>(),
    db.prepare("SELECT COUNT(*) AS count FROM content_items WHERE status = 'scheduled' AND datetime(publish_at) <= datetime('now','+7 days')").first<{ count: number }>(),
    db.prepare("SELECT COUNT(*) AS count FROM content_reports WHERE status = 'pending'").first<{ count: number }>(),
  ]);
  const pendingCounts = {
    review: Number(review?.count ?? 0),
    imports: Number(imports?.count ?? 0),
    scheduled: Number(scheduled?.count ?? 0),
    reports: Number(reports?.count ?? 0),
  };
  return json({ authenticated: true, admin: adminPublicShape(admin), expiresAt: admin.expiresAt,
    pendingCount: pendingCounts.review + pendingCounts.imports + pendingCounts.scheduled + pendingCounts.reports, pendingCounts });
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
    failedImports, processingImports, emptyPublishedBanks, staleReview, scheduledSoon, pendingReports, sourceIncomplete, recent] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS count FROM users").first<{ count: number }>(),
    db.prepare("SELECT COUNT(DISTINCT user_id) AS count FROM analytics_events WHERE user_id <> 'system' AND created_at >= datetime('now','-7 days')").first<{ count: number }>(),
    db.prepare("SELECT COUNT(*) AS count FROM content_items WHERE status IN ('published','scheduled')").first<{ count: number }>(),
    db.prepare("SELECT COUNT(*) AS count FROM content_items WHERE status = 'pending_review'").first<{ count: number }>(),
    db.prepare("SELECT COUNT(*) AS count FROM question_banks").first<{ count: number }>(),
    db.prepare("SELECT COUNT(*) AS count FROM questions WHERE status = 'active'").first<{ count: number }>(),
    db.prepare("SELECT COUNT(*) AS count FROM redemptions WHERE redeemed_at >= datetime('now','-7 days')").first<{ count: number }>(),
    db.prepare("SELECT COUNT(*) AS count FROM question_imports WHERE status IN ('failed','completed_with_errors')").first<{ count: number }>(),
    db.prepare("SELECT COUNT(*) AS count FROM question_imports WHERE status IN ('uploading','queued','processing','cancelling')").first<{ count: number }>(),
    db.prepare(`SELECT COUNT(*) AS count FROM question_banks qb WHERE qb.status = 'published'
      AND NOT ${QUESTION_BANK_CAN_PUBLISH_SQL}`).first<{ count: number }>(),
    db.prepare("SELECT COUNT(*) AS count FROM content_items WHERE status = 'pending_review' AND submitted_at < datetime('now','-2 days')").first<{ count: number }>(),
    db.prepare("SELECT COUNT(*) AS count FROM content_items WHERE status = 'scheduled' AND datetime(publish_at) <= datetime('now','+7 days')").first<{ count: number }>(),
    db.prepare("SELECT COUNT(*) AS count FROM content_reports WHERE status = 'pending'").first<{ count: number }>(),
    db.prepare(`SELECT COUNT(*) AS count FROM content_items
      WHERE status IN ('pending_review','published','scheduled') AND (
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
      )`).first<{ count: number }>(),
    db.prepare(`SELECT id, username, role, action, resource_type, resource_id, summary, result, created_at
      FROM admin_audit_logs ORDER BY id DESC LIMIT 12`).all(),
  ]);
  const number = (value: { count: number } | null) => Number(value?.count ?? 0);
  const todos: Array<Record<string, unknown>> = [];
  const anomalies: Array<Record<string, unknown>> = [];
  if (number(pendingReview)) todos.push({ id: "pending-review", type: "review", title: "待审核内容", description: "内容已提交，等待审核后发布", count: number(pendingReview), href: "/admin/content?status=pending_review", priority: "high" });
  if (number(pendingReports)) todos.push({ id: "content-reports", type: "content_report", title: "用户内容报错", description: "核对题目、答案、解析或题源标签", count: number(pendingReports), href: "/admin/content?queue=reports", priority: "high" });
  if (number(sourceIncomplete)) todos.push({ id: "source-incomplete", type: "source", title: "来源/数据版本不完整", description: "发布内容必须补齐权威来源、HTTPS原文和来源日期", count: number(sourceIncomplete), href: "/admin/content", priority: "high" });
  if (number(processingImports)) todos.push({ id: "processing-imports", type: "import", title: "导入任务进行中", description: "题库文件仍在处理", count: number(processingImports), href: "/admin/imports", priority: "medium" });
  if (number(scheduledSoon)) todos.push({ id: "scheduled-soon", type: "schedule", title: "7天内待发布", description: "检查定时内容和素材完整性", count: number(scheduledSoon), href: "/admin/content?status=scheduled", priority: "medium" });
  if (number(failedImports)) anomalies.push({ id: "failed-imports", type: "import", title: "导入失败或有错误", description: "需要下载错误信息并修正数据", count: number(failedImports), href: "/admin/imports", severity: "error" });
  if (number(emptyPublishedBanks)) anomalies.push({ id: "empty-banks", type: "question_bank", title: "已发布但不可练题库", description: "题目为空、审核失效、范围冲突或导入状态异常，请立即下架复核", count: number(emptyPublishedBanks), href: "/admin/question-banks", severity: "error" });
  if (number(staleReview)) anomalies.push({ id: "stale-review", type: "review", title: "审核超过48小时", description: "待审核内容已积压", count: number(staleReview), href: "/admin/content?status=pending_review", severity: "warning" });
  if (number(sourceIncomplete)) anomalies.push({ id: "source-gate", type: "source", title: "线上内容来源不完整", description: "已被发布门禁阻断；历史线上内容需补录后再发版", count: number(sourceIncomplete), href: "/admin/content", severity: "error" });
  return json({
    metrics: {
      users: number(users), activeUsers7d: number(activeUsers), publishedContent: number(publishedContent),
      pendingReview: number(pendingReview), pendingContentReports: number(pendingReports), sourceIncomplete: number(sourceIncomplete), questionBanks: number(banks), questions: number(questionsCount), redemptions7d: number(redemptions7d),
    },
    pendingCount: number(pendingReview) + number(processingImports) + number(scheduledSoon) + number(pendingReports) + number(sourceIncomplete),
    pendingCounts: { review: number(pendingReview), imports: number(processingImports), scheduled: number(scheduledSoon), reports: number(pendingReports), sources: number(sourceIncomplete) },
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
  if (payload.reviewStatus) { conditions.push("q.review_status = ?"); binds.push(trimmed(payload.reviewStatus, 30)); }
  if (Number(payload.bankId) > 0) { conditions.push("EXISTS (SELECT 1 FROM question_bank_items qi WHERE qi.question_id = q.id AND qi.bank_id = ?)"); binds.push(Math.floor(Number(payload.bankId))); }
  const where = conditions.join(" AND ");
  const [questionBanks, questionImports, questions, total, summary, bankSummary, importSummary] = await Promise.all([
    db.prepare(`SELECT b.id, b.bank_code, b.name, b.exam_type, b.province, b.exam_year, b.subject,
      b.description, b.cover_color, b.status, b.updated_at, COUNT(i.id) AS question_count,
      (SELECT COUNT(*) FROM question_imports qi WHERE qi.bank_id = b.id) AS import_count,
      (SELECT COUNT(*) FROM user_question_banks uqb WHERE uqb.bank_code = b.bank_code) AS selection_count,
      (SELECT COUNT(*) FROM practice_sessions ps WHERE ps.status = 'active' AND EXISTS (
        SELECT 1 FROM json_each(ps.bank_codes_json) selected WHERE selected.value = b.bank_code
      )) AS active_session_count
      FROM question_banks b LEFT JOIN question_bank_items i ON i.bank_id = b.id GROUP BY b.id ORDER BY b.id DESC LIMIT 500`).all(),
    db.prepare(`SELECT qi.id, qi.bank_id, qb.name AS bank_name, qi.file_name, qi.file_size, qi.total_rows,
      qi.uploaded_rows, qi.processed_rows, qi.imported_rows, qi.failed_rows, qi.duplicate_rows,
      qi.total_chunks, qi.uploaded_chunks, qi.processed_chunks, qi.cancel_requested,
      qi.status, qi.error_summary, qi.sealed_at, qi.started_at, qi.last_heartbeat_at,
      qi.duplicate_strategy, qi.created_at, qi.updated_at, qi.completed_at
      FROM question_imports qi JOIN question_banks qb ON qb.id = qi.bank_id ORDER BY qi.id DESC LIMIT 200`).all(),
    db.prepare(`SELECT q.id, q.question_code, q.subject, q.module, q.sub_type, q.stem, q.options_json,
      q.answer, q.explanation, q.technique, q.material, q.prompt, q.word_limit, q.scoring_points_json,
      q.difficulty, q.source, q.source_exam_type, q.source_region, q.source_year, q.source_batch,
      q.truth_verified, q.review_status, q.review_note, q.reviewed_by, q.reviewed_at,
      q.frequency, q.frequency_occurrences, q.frequency_papers, q.frequency_years_json, q.frequency_updated_at,
      q.importance_stars, q.importance_rule_version, q.importance_reason, q.importance_override_reason,
      q.score_rate, q.score_rate_correct, q.score_rate_attempts, q.score_rate_scope,
      q.score_rate_source, q.score_rate_updated_at, q.suggested_seconds, q.image_url, q.resource_url,
      q.status, q.version, q.updated_at,
      (SELECT COUNT(*) FROM question_versions qv WHERE qv.question_id = q.id) AS version_count,
      (SELECT GROUP_CONCAT(DISTINCT qb.name) FROM question_bank_items qbi
        JOIN question_banks qb ON qb.id = qbi.bank_id WHERE qbi.question_id = q.id) AS bank_names,
      (SELECT MIN(qbi.bank_id) FROM question_bank_items qbi WHERE qbi.question_id = q.id) AS bank_id
      FROM questions q WHERE ${where}
      ORDER BY CASE q.review_status WHEN 'pending_review' THEN 0 WHEN 'rejected' THEN 1 ELSE 2 END,
        q.id DESC LIMIT ? OFFSET ?`).bind(...binds, pageSize, offset).all(),
    db.prepare(`SELECT COUNT(*) AS count FROM questions q WHERE ${where}`).bind(...binds).first<{ count: number }>(),
    db.prepare(`SELECT COUNT(*) AS question_count,
      SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active_count,
      SUM(CASE WHEN source_year IS NULL OR source_region = '' OR source = '' OR source_batch = '' THEN 1 ELSE 0 END) AS incomplete_count,
      SUM(CASE WHEN review_status = 'pending_review' THEN 1 ELSE 0 END) AS pending_review_count,
      SUM(CASE WHEN review_status = 'rejected' THEN 1 ELSE 0 END) AS rejected_count FROM questions`).first(),
    db.prepare(`SELECT COUNT(*) AS total_banks,
      SUM(CASE WHEN qb.status = 'published' THEN 1 ELSE 0 END) AS published_banks,
      SUM(CASE WHEN qb.status = 'published' AND NOT ${QUESTION_BANK_CAN_PUBLISH_SQL}
        THEN 1 ELSE 0 END) AS empty_published_banks FROM question_banks qb`).first(),
    db.prepare(`SELECT COALESCE(SUM(imported_rows), 0) AS imported_rows,
      SUM(CASE WHEN status IN ('uploading','queued','processing','cancelling') THEN 1 ELSE 0 END) AS processing_imports,
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
      pendingReviewQuestions: Number(rawSummary.pending_review_count ?? 0),
      rejectedQuestions: Number(rawSummary.rejected_count ?? 0),
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
  const [content, total, media, statusCounts, reports, reportStatusCounts, contentImports] = await Promise.all([
    db.prepare(`SELECT id, content_type, content_key, title, payload_json, access_level, status, publish_at, version,
      review_note, submitted_by, submitted_at, reviewed_by, reviewed_at, updated_at,
      (SELECT COUNT(*) FROM content_item_versions v WHERE v.content_id = content_items.id) AS version_count
      FROM content_items WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).bind(...binds, pageSize, offset).all<Record<string, unknown>>(),
    db.prepare(`SELECT COUNT(*) AS count FROM content_items WHERE ${where}`).bind(...binds).first<{ count: number }>(),
    db.prepare(`SELECT id, file_name, content_type, byte_size, storage, access_level, status, created_at,
      '/api/app?media=' || id AS url FROM media_assets ORDER BY created_at DESC LIMIT 200`).all(),
    db.prepare("SELECT status, COUNT(*) AS count FROM content_items WHERE content_type NOT IN ('exam_event','exam_notice','job_position') GROUP BY status").all(),
    db.prepare(`SELECT cr.id, cr.content_type, cr.content_key, cr.reason_code, cr.detail, cr.context_json,
      cr.status, cr.resolution_note, cr.created_at, cr.updated_at, cr.resolved_at,
      CASE WHEN length(cr.user_id) <= 12 THEN substr(cr.user_id, 1, 4) || '***'
        ELSE substr(cr.user_id, 1, 8) || '…' || substr(cr.user_id, -4) END AS reporter,
      q.stem, q.source, q.version AS question_version,
      COALESCE(au.display_name, au.username, '') AS resolver_name
      FROM content_reports cr
      LEFT JOIN questions q ON cr.content_type = 'question' AND q.question_code = cr.content_key
      LEFT JOIN admin_users au ON au.id = cr.resolved_by
      ORDER BY CASE cr.status WHEN 'pending' THEN 0 ELSE 1 END, cr.created_at DESC
      LIMIT 100`).all<Record<string, unknown>>(),
    db.prepare("SELECT status, COUNT(*) AS count FROM content_reports GROUP BY status").all<Record<string, unknown>>(),
    db.prepare(`SELECT id, content_type, file_name, file_size, file_hash, source_name, source_url,
      source_published_at, data_version, duplicate_strategy, metadata_json, total_rows, uploaded_rows, processed_rows,
      imported_rows, failed_rows, duplicate_rows, total_chunks, uploaded_chunks, processed_chunks,
      status, error_summary, dispatch_attempts, next_retry_at, review_status, review_note,
      sealed_at, started_at, last_heartbeat_at, created_at, updated_at, completed_at
      FROM content_imports WHERE content_type NOT IN ('exam_event','exam_notice','job_position')
      ORDER BY id DESC LIMIT 100`).all<Record<string, unknown>>(),
  ]);
  const contentStatusCounts = Object.fromEntries(statusCounts.results.map((item) => [String((item as Record<string, unknown>).status), Number((item as Record<string, unknown>).count ?? 0)]));
  const reportCounts = Object.fromEntries(reportStatusCounts.results.map((item) => [String(item.status), Number(item.count ?? 0)]));
  return json({ content: parseContentRows(content.results), contentImports: contentImports.results,
    mediaAssets: media.results, reports: reports.results,
    reportSummary: {
      total: Object.values(reportCounts).reduce((sum, value) => sum + Number(value), 0),
      pending: reportCounts.pending ?? 0,
      resolved: reportCounts.resolved ?? 0,
      rejected: reportCounts.rejected ?? 0,
      statusCounts: reportStatusCounts.results,
    },
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
  const [rows, total, summary, contentImports] = await Promise.all([
    db.prepare(`SELECT id, content_type, content_key, title, payload_json, access_level, status, publish_at, version,
      review_note, submitted_by, submitted_at, reviewed_by, reviewed_at, updated_at
      FROM content_items WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).bind(...binds, pageSize, offset).all<Record<string, unknown>>(),
    db.prepare(`SELECT COUNT(*) AS count FROM content_items WHERE ${where}`).bind(...binds).first<{ count: number }>(),
    db.prepare("SELECT content_type, status, COUNT(*) AS count FROM content_items WHERE content_type IN ('exam_event','exam_notice','job_position') GROUP BY content_type, status").all(),
    db.prepare(`SELECT id, content_type, file_name, file_size, file_hash, source_name, source_url,
      source_published_at, data_version, duplicate_strategy, metadata_json, total_rows, uploaded_rows, processed_rows,
      imported_rows, failed_rows, duplicate_rows, total_chunks, uploaded_chunks, processed_chunks,
      status, error_summary, dispatch_attempts, next_retry_at, review_status, review_note,
      sealed_at, started_at, last_heartbeat_at, created_at, updated_at, completed_at
      FROM content_imports WHERE content_type IN ('exam_event','exam_notice','job_position')
      ORDER BY id DESC LIMIT 100`).all<Record<string, unknown>>(),
  ]);
  const radarSummary = summary.results as Array<Record<string, unknown>>;
  const countType = (type: string) => radarSummary.filter((item) => String(item.content_type) === type).reduce((sum, item) => sum + Number(item.count ?? 0), 0);
  const countStatus = (status: string) => radarSummary.filter((item) => String(item.status) === status).reduce((sum, item) => sum + Number(item.count ?? 0), 0);
  return json({ content: parseContentRows(rows.results), contentImports: contentImports.results,
    pagination: { page, pageSize, total: Number(total?.count ?? 0) }, summary: radarSummary, stats: {
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
  const [codes, redemptions, events, activeUsers, rewardDays, inviteeRewardDays, monthlyCap] = await Promise.all([
    db.prepare(`SELECT id, code_preview, batch_name, grant_type, duration_days, channel, max_uses, used_count, status, valid_until, created_at
      FROM redemption_codes ORDER BY id DESC LIMIT 300`).all(),
    db.prepare(`SELECT r.id, r.redeemed_at, r.user_id, c.code_preview, c.grant_type, c.duration_days
      FROM redemptions r JOIN redemption_codes c ON c.id = r.code_id ORDER BY r.id DESC LIMIT 300`).all(),
    db.prepare(`SELECT event_name, COUNT(*) AS count FROM analytics_events
      WHERE user_id <> 'system' AND created_at >= datetime('now','-7 days')
        AND EXISTS (SELECT 1 FROM users metric_user WHERE metric_user.id = analytics_events.user_id AND metric_user.analytics_eligible = 1)
      GROUP BY event_name ORDER BY count DESC`).all(),
    db.prepare(`SELECT COUNT(DISTINCT user_id) AS count FROM analytics_events
      WHERE user_id <> 'system' AND created_at >= datetime('now','-7 days')
        AND EXISTS (SELECT 1 FROM users metric_user WHERE metric_user.id = analytics_events.user_id AND metric_user.analytics_eligible = 1)`)
      .first<{ count: number }>(),
    getConfigNumber("invite_reward_days", 7),
    getConfigNumber("invitee_reward_days", 3),
    getConfigNumber("invite_monthly_cap", 30),
  ]);
  return json({ codes: codes.results, redemptions: redemptions.results, config: { rewardDays, inviteeRewardDays, monthlyCap },
    analytics: { activeUsers: Number(activeUsers?.count ?? 0), eventCounts: events.results } });
}

async function recomputePlatformScoreRatesForUser(userId: string) {
  const db = getD1();
  await db.prepare(`WITH eligible_stats AS (
      SELECT metric_attempt.question_code, COUNT(*) AS attempts, COALESCE(SUM(metric_attempt.is_correct), 0) AS correct
      FROM practice_attempts metric_attempt
      JOIN users metric_user ON metric_user.id = metric_attempt.user_id
      WHERE ${eligibleFirstAttemptSql("metric_attempt", "metric_user")}
      GROUP BY metric_attempt.question_code
    )
    UPDATE questions SET
      score_rate_attempts = COALESCE((SELECT attempts FROM eligible_stats WHERE eligible_stats.question_code = questions.question_code), 0),
      score_rate_correct = COALESCE((SELECT correct FROM eligible_stats WHERE eligible_stats.question_code = questions.question_code), 0),
      score_rate = COALESCE((SELECT CAST(ROUND(correct * 100.0 / NULLIF(attempts, 0)) AS INTEGER)
        FROM eligible_stats WHERE eligible_stats.question_code = questions.question_code), 0),
      score_rate_scope = CASE WHEN EXISTS (SELECT 1 FROM eligible_stats WHERE eligible_stats.question_code = questions.question_code)
        THEN '平台有效账号·每人首答' ELSE '' END,
      score_rate_source = 'platform', score_rate_updated_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE score_rate_source IN ('', 'platform') AND question_code IN (
      SELECT DISTINCT question_code FROM practice_attempts WHERE user_id = ?
    )`).bind(userId).run();
}

async function adminSetAnalyticsEligibility(payload: Record<string, unknown>) {
  if (!canAdmin(payload, "users.manage")) return adminForbidden("users.manage");
  const userId = trimmed(payload.userId, 160);
  if (!validUserId(userId)) return json({ error: "学习用户ID格式无效" }, 400);
  if (typeof payload.eligible !== "boolean") return json({ error: "请选择纳入或排除统计" }, 400);
  const db = getD1();
  const updated = await db.prepare("UPDATE users SET analytics_eligible = ? WHERE id = ?")
    .bind(payload.eligible ? 1 : 0, userId).run();
  if (!updated.meta.changes) return json({ error: "学习用户不存在" }, 404);
  await recomputePlatformScoreRatesForUser(userId);
  return json({ ok: true, userId, analyticsEligible: payload.eligible });
}

async function adminListAnalytics(payload: Record<string, unknown>) {
  if (!canAdmin(payload, "analytics.read")) return adminForbidden("analytics.read");
  const db = getD1();
  const days = Number(payload.days) <= 14 ? 14 : 30;
  const windowModifier = `-${days} days`;
  const [totalUsers, active7, active30, members, attempts30, dailyTrend, eventCounts, modules, redemptions30, invites30, apiMetricSummary] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS count FROM users WHERE analytics_eligible = 1").first<{ count: number }>(),
    db.prepare(`SELECT COUNT(DISTINCT user_id) AS count FROM analytics_events
      WHERE user_id <> 'system' AND created_at >= datetime('now','-7 days')
        AND EXISTS (SELECT 1 FROM users metric_user WHERE metric_user.id = analytics_events.user_id AND metric_user.analytics_eligible = 1)`)
      .first<{ count: number }>(),
    db.prepare(`SELECT COUNT(DISTINCT user_id) AS count FROM analytics_events
      WHERE user_id <> 'system' AND created_at >= datetime('now','-30 days')
        AND EXISTS (SELECT 1 FROM users metric_user WHERE metric_user.id = analytics_events.user_id AND metric_user.analytics_eligible = 1)`)
      .first<{ count: number }>(),
    db.prepare(`SELECT COUNT(*) AS count FROM users WHERE analytics_eligible = 1
      AND (membership_type = 'lifetime' OR datetime(membership_end) > CURRENT_TIMESTAMP)`).first<{ count: number }>(),
    db.prepare(`SELECT COUNT(*) AS answers, COALESCE(AVG(pa.is_correct),0) AS accuracy FROM practice_attempts pa
      JOIN users metric_user ON metric_user.id = pa.user_id AND metric_user.analytics_eligible = 1
      WHERE pa.apply_status = 'applied' AND pa.answered_at >= datetime('now','-30 days')`).first<{ answers: number; accuracy: number }>(),
    db.prepare(`SELECT date(created_at,'+8 hours') AS date, COUNT(DISTINCT user_id) AS active_users,
      SUM(CASE WHEN event_name = 'app_open' THEN 1 ELSE 0 END) AS opens,
      SUM(CASE WHEN event_name = 'practice_answer' THEN 1 ELSE 0 END) AS answers
      FROM analytics_events WHERE user_id <> 'system' AND created_at >= datetime('now', ?)
        AND EXISTS (SELECT 1 FROM users metric_user WHERE metric_user.id = analytics_events.user_id AND metric_user.analytics_eligible = 1)
      GROUP BY date(created_at,'+8 hours') ORDER BY date ASC`).bind(windowModifier).all<Record<string, unknown>>(),
    db.prepare(`SELECT event_name, COUNT(*) AS count, COUNT(DISTINCT user_id) AS users
      FROM analytics_events WHERE user_id <> 'system' AND created_at >= datetime('now','-30 days')
        AND EXISTS (SELECT 1 FROM users metric_user WHERE metric_user.id = analytics_events.user_id AND metric_user.analytics_eligible = 1)
      GROUP BY event_name ORDER BY count DESC`).all<Record<string, unknown>>(),
    db.prepare(`SELECT module, COUNT(*) AS answers, COALESCE(AVG(is_correct),0) AS accuracy
      FROM practice_attempts pa JOIN users metric_user ON metric_user.id = pa.user_id AND metric_user.analytics_eligible = 1
      WHERE pa.apply_status = 'applied' AND pa.answered_at >= datetime('now','-30 days')
      GROUP BY module ORDER BY answers DESC`).all<Record<string, unknown>>(),
    db.prepare(`SELECT COUNT(*) AS count FROM redemptions r JOIN users metric_user ON metric_user.id = r.user_id
      AND metric_user.analytics_eligible = 1 WHERE r.redeemed_at >= datetime('now','-30 days')`).first<{ count: number }>(),
    db.prepare(`SELECT COUNT(*) AS count FROM invite_relations ir JOIN users metric_user ON metric_user.id = ir.invitee_id
      AND metric_user.analytics_eligible = 1 WHERE ir.bound_at >= datetime('now','-30 days')`).first<{ count: number }>(),
    db.prepare(`SELECT COUNT(*) AS sample_count,
      COALESCE(SUM(CASE WHEN CAST(json_extract(event_data, '$.status') AS INTEGER) >= 500 THEN 1 ELSE 0 END), 0) AS error_5xx_count
      FROM analytics_events
      WHERE user_id = 'system' AND event_name = 'api_request_metric'
        AND created_at >= datetime('now','-30 days')
        AND json_valid(event_data) = 1
        AND json_type(event_data, '$.durationMs') IN ('integer','real')`)
      .first<{ sample_count: number; error_5xx_count: number }>(),
  ]);
  const apiSampleCount = Number(apiMetricSummary?.sample_count ?? 0);
  const apiError5xxCount = Number(apiMetricSummary?.error_5xx_count ?? 0);
  let apiP95Ms: number | null = null;
  if (apiSampleCount > 0) {
    const p95Offset = Math.max(0, Math.ceil(apiSampleCount * 0.95) - 1);
    const p95 = await db.prepare(`SELECT CAST(json_extract(event_data, '$.durationMs') AS REAL) AS duration_ms
      FROM analytics_events
      WHERE user_id = 'system' AND event_name = 'api_request_metric'
        AND created_at >= datetime('now','-30 days')
        AND json_valid(event_data) = 1
        AND json_type(event_data, '$.durationMs') IN ('integer','real')
      ORDER BY CAST(json_extract(event_data, '$.durationMs') AS REAL) ASC
      LIMIT 1 OFFSET ?`).bind(p95Offset).first<{ duration_ms: number }>();
    if (p95 && Number.isFinite(Number(p95.duration_ms))) {
      apiP95Ms = Math.round(Number(p95.duration_ms) * 100) / 100;
    }
  }
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
    apiHealth: {
      windowDays: 30,
      sampleCount: apiSampleCount,
      p95Ms: apiP95Ms,
      error5xxCount: apiError5xxCount,
      errorRate5xx: apiSampleCount > 0 ? Math.round(apiError5xxCount / apiSampleCount * 10_000) / 100 : null,
      state: apiSampleCount > 0 && apiP95Ms !== null ? "measured" : "collecting",
      message: apiSampleCount > 0 && apiP95Ms !== null ? "基于近30天真实接口请求" : "等待真实数据",
    },
    days,
    generatedAt: new Date().toISOString(),
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

async function adminResolveContentReport(payload: Record<string, unknown>) {
  if (!canAdmin(payload, "content.write") && !canAdmin(payload, "content.review")) {
    return adminForbidden("content.write");
  }
  const admin = adminFromPayload(payload);
  if (!admin) return adminForbidden("content.write");
  const id = Math.floor(Number(payload.id));
  const decision = String(payload.decision ?? "");
  const resolutionNote = trimmed(payload.resolutionNote, 1000);
  if (!(id > 0) || (decision !== "resolved" && decision !== "rejected")) {
    return json({ error: "处理决定无效" }, 400);
  }
  if (resolutionNote.length < 2) return json({ error: "请填写处理说明，便于后续复核" }, 400);

  const db = getD1();
  const updated = await db.prepare(`UPDATE content_reports SET status = ?, resolved_by = ?, resolution_note = ?,
    resolved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'`)
    .bind(decision, admin.id, resolutionNote, id).run();
  if (!updated.meta.changes) {
    const current = await db.prepare("SELECT id, status FROM content_reports WHERE id = ?")
      .bind(id).first<{ id: number; status: string }>();
    if (!current) return json({ error: "内容报错记录不存在" }, 404);
    if (current.status === decision) return json({ ok: true, id, status: decision, duplicate: true });
    return json({ error: "该报错已被其他管理员处理，请刷新列表" }, 409);
  }
  return json({ ok: true, id, status: decision });
}

async function adminSubmitContentReview(payload: Record<string, unknown>) {
  payload.status = "pending_review";
  return adminSetContentStatus(payload);
}

async function adminReviewContent(payload: Record<string, unknown>) {
  const admin = adminFromPayload(payload);
  if (!admin || (admin.role !== "reviewer" && admin.role !== "super_admin")) return adminForbidden("content.review");
  if (payload.decision === "reject") {
    payload.status = "rejected";
    return adminSetContentStatus(payload);
  }
  if (payload.decision !== "approve") return json({ error: "审核决定无效" }, 400);

  const contentId = Math.floor(Number(payload.id));
  const expectedVersion = Math.floor(Number(payload.expectedVersion));
  const db = getD1();
  const content = await db.prepare(`SELECT id, content_type, content_key, title, access_level, status, version,
    publish_at, payload_json FROM content_items WHERE id = ?`)
    .bind(contentId).first<{
      id: number; content_type: string; content_key: string; title: string; access_level: "free" | "member";
      status: string; version: number; publish_at: string | null; payload_json: string;
    }>();
  if (!content) return json({ error: "内容不存在" }, 404);
  if (content.status !== "pending_review" || content.version !== expectedVersion) {
    return json({
      error: "待审内容版本已经变化，请刷新后重新审核",
      code: "CONTENT_REVIEW_VERSION_MISMATCH",
      currentVersion: content.version,
    }, 409);
  }

  let storedRequestedAt = "";
  let storedPayload: Record<string, unknown> = {};
  try {
    storedPayload = JSON.parse(content.payload_json) as Record<string, unknown>;
    storedRequestedAt = String(storedPayload.requestedPublishAt ?? storedPayload.publishAt ?? "");
  } catch { storedRequestedAt = ""; }
  const invalid = publishabilityError(content.content_type, content.content_key, storedPayload);
  if (invalid) return invalid;
  const mediaValidation = await validateContentMediaAssets(
    content.content_type,
    content.content_key,
    content.access_level,
    storedPayload,
    true,
  );
  if (mediaValidation.invalid) return mediaValidation.invalid;

  const requestedAt = String(payload.publishAt ?? payload.requestedPublishAt ?? content.publish_at ?? storedRequestedAt ?? "");
  const requestedTimestamp = requestedAt ? Date.parse(requestedAt) : 0;
  const status = requestedTimestamp > Date.now() ? "scheduled" : "published";
  const publishAt = status === "scheduled" ? new Date(requestedTimestamp).toISOString() : null;
  const nextVersion = expectedVersion + 1;
  const reviewedAssetIds = mediaValidation.referencedAssetIds;
  const mediaAccessPredicate = content.access_level === "member" ? " AND access_level = 'member'" : "";
  const reviewedMediaCondition = reviewedAssetIds.length
    ? ` AND (SELECT COUNT(*) FROM media_assets WHERE id IN (${reviewedAssetIds.map(() => "?").join(",")})
        AND status = 'active'${mediaAccessPredicate}) = ?`
    : "";
  const statements: D1PreparedStatement[] = [
    db.prepare(`INSERT OR IGNORE INTO content_item_versions
      (content_id, version, content_type, content_key, title, payload_json, access_level, status, publish_at, change_type)
      SELECT id, version, content_type, content_key, title, payload_json, access_level, status, publish_at, 'snapshot'
      FROM content_items WHERE id = ? AND version = ? AND status = 'pending_review'`)
      .bind(contentId, expectedVersion),
    db.prepare(`UPDATE content_items SET status = ?, publish_at = ?, review_note = '', reviewed_by = ?,
      reviewed_at = CURRENT_TIMESTAMP, version = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND version = ? AND status = 'pending_review'${reviewedMediaCondition}`)
      .bind(status, publishAt, admin.id, nextVersion, contentId, expectedVersion,
        ...reviewedAssetIds, ...(reviewedAssetIds.length ? [reviewedAssetIds.length] : [])),
    db.prepare(`UPDATE media_assets AS ma SET access_level = 'free', updated_at = CURRENT_TIMESTAMP
      WHERE ma.id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
        AND ma.status = 'active' AND ma.access_level IN ('member','free')
        AND EXISTS (
          SELECT 1 FROM content_items ci, json_tree(ci.payload_json) media_ref
          WHERE ci.id = ? AND ci.version = ? AND ci.status = ? AND ci.access_level = 'free'
            AND media_ref.type = 'text' AND media_ref.value = '/api/app?media=' || ma.id
        )`)
      .bind(JSON.stringify(content.access_level === "free" ? reviewedAssetIds : []),
        contentId, nextVersion, status),
  ];
  statements.push(db.prepare(`INSERT OR REPLACE INTO content_item_versions
    (content_id, version, content_type, content_key, title, payload_json, access_level, status, publish_at, change_type)
    SELECT id, version, content_type, content_key, title, payload_json, access_level, status, publish_at, 'review_approve'
    FROM content_items WHERE id = ? AND version = ? AND status = ?`)
    .bind(contentId, nextVersion, status));
  const results = await db.batch(statements);
  if (!results[1]?.meta.changes) {
    return json({ error: "待审内容版本已经变化，请刷新后重新审核", code: "CONTENT_VERSION_CONFLICT" }, 409);
  }
  return json({ ok: true, id: contentId, status, version: nextVersion });
}

const ADMIN_ACTION_PERMISSIONS: Record<string, AdminPermission[]> = {
  adminDashboard: ["dashboard.read"],
  adminList: ["system.read"],
  adminListQuestions: ["question.read"],
  adminListQuizzes: ["content.read"],
  adminSearchQuestions: ["question.read"],
  adminListContent: ["content.read"],
  adminListRadar: ["radar.read"],
  adminListGrowth: ["growth.read"],
  adminListAnalytics: ["analytics.read"],
  adminSetAnalyticsEligibility: ["users.manage"],
  adminListSystem: ["system.read", "users.manage", "audit.read"],
  adminListUsers: ["system.read", "users.manage"],
  adminListAuditLogs: ["audit.read"],
  adminGetContent: ["content.read", "radar.read"],
  adminCreateCodes: ["growth.write"],
  adminDisableCode: ["growth.write"],
  adminUpdateConfig: ["growth.write"],
  adminSetMediaAccess: ["media.upload"],
  adminUpsertContentBatch: ["content.write", "radar.write"],
  adminSetContentStatus: ["content.publish", "content.write", "radar.write"],
  adminListContentVersions: ["content.read", "radar.read"],
  adminRollbackContent: ["content.publish"],
  adminDisableContent: ["content.publish"],
  adminDuplicateContent: ["content.write", "radar.write"],
  adminUpsertQuestionBank: ["question.write"],
  adminSetQuestionBankStatus: ["question.write"],
  adminUpsertQuestion: ["question.write"],
  adminSetQuestionStatus: ["question.write"],
  adminStartQuestionImport: ["question.import"],
  adminImportQuestionBatch: ["question.import"],
  adminFinishQuestionImport: ["question.import"],
  adminPreviewQuestionImportDuplicates: ["question.import"],
  adminGetQuestionImport: ["question.read", "question.import"],
  adminCancelQuestionImport: ["question.import"],
  adminRetryQuestionImport: ["question.import"],
  adminDownloadQuestionImportErrors: ["question.read", "question.import"],
  adminStartContentImport: ["radar.write", "content.write"],
  adminUploadContentImportChunk: ["radar.write", "content.write"],
  adminFinishContentImport: ["radar.write", "content.write"],
  adminGetContentImport: ["radar.read", "content.read"],
  adminCancelContentImport: ["radar.write", "content.write"],
  adminRetryContentImport: ["radar.write", "content.write"],
  adminDownloadContentImportErrors: ["radar.read", "content.read"],
  adminSubmitContentImportReview: ["radar.write", "content.write"],
  adminReviewContentImport: ["content.review"],
  adminRollbackContentImport: ["content.publish"],
  adminListQuestionVersions: ["question.read"],
  adminRollbackQuestionVersion: ["question.write"],
  adminReviewQuestion: ["question.review"],
  adminCreateUser: ["users.manage"],
  adminSetUserStatus: ["users.manage"],
  adminUpdateUser: ["users.manage"],
  adminResolveContentReport: ["content.write", "content.review"],
  adminReviewContent: ["content.review"],
  adminSubmitContentReview: ["content.write", "radar.write"],
  adminUpdateQuiz: ["content.write"],
  adminCreateQuiz: ["content.write"],
  adminUpsertQuizQuestion: ["content.write"],
  adminBulkUpsertQuizQuestions: ["content.write"],
  adminSetQuizQuestionStatus: ["content.write"],
  adminUpsertQuizResult: ["content.write"],
  adminGetEssayReferenceLibrary: ["content.read"],
  adminUpsertEssayPaper: ["content.write"],
  adminSetEssayPaperStatus: ["content.publish"],
  adminUpsertEssayMaterial: ["content.write"],
  adminDeleteEssayMaterial: ["content.write"],
  adminUpsertEssayLibraryQuestion: ["content.write"],
  adminReviewEssayLibraryQuestion: ["question.review"],
  adminUpsertEssayAnswerSource: ["content.write"],
  adminSetEssayAnswerSourceStatus: ["content.write"],
  adminUpsertEssayReferenceAnswer: ["content.write"],
  adminSetEssayReferenceAnswerStatus: ["content.publish"],
  adminUpdateEssayLibrarySettings: ["content.publish"],
};

const ADMIN_WRITE_ACTIONS = new Set([
  "adminCreateCodes", "adminDisableCode", "adminUpdateConfig", "adminSetMediaAccess", "adminUpsertContentBatch",
  "adminDisableContent", "adminSetContentStatus", "adminRollbackContent", "adminDuplicateContent",
  "adminUpsertQuestionBank", "adminSetQuestionBankStatus", "adminUpsertQuestion", "adminSetQuestionStatus", "adminStartQuestionImport",
  "adminImportQuestionBatch", "adminFinishQuestionImport", "adminCancelQuestionImport", "adminRetryQuestionImport",
  "adminStartContentImport", "adminUploadContentImportChunk", "adminFinishContentImport",
  "adminCancelContentImport", "adminRetryContentImport", "adminSubmitContentImportReview",
  "adminReviewContentImport", "adminRollbackContentImport",
  "adminRollbackQuestionVersion", "adminCreateUser", "adminSetUserStatus",
  "adminUpdateUser", "adminSetAnalyticsEligibility", "adminSubmitContentReview", "adminReviewContent", "adminReviewQuestion", "adminResolveContentReport",
  "adminCreateQuiz", "adminUpdateQuiz", "adminUpsertQuizQuestion", "adminBulkUpsertQuizQuestions", "adminSetQuizQuestionStatus", "adminUpsertQuizResult",
  "adminUpsertEssayPaper", "adminSetEssayPaperStatus", "adminUpsertEssayMaterial", "adminDeleteEssayMaterial",
  "adminUpsertEssayLibraryQuestion", "adminReviewEssayLibraryQuestion", "adminUpsertEssayAnswerSource", "adminSetEssayAnswerSourceStatus",
  "adminUpsertEssayReferenceAnswer", "adminSetEssayReferenceAnswerStatus", "adminUpdateEssayLibrarySettings",
]);

function resourceTypeForAdminAction(action: string) {
  if (action.includes("Essay")) return "essay_reference_library";
  if (action.includes("ContentReport")) return "content_report";
  if (action.includes("Media")) return "media";
  if (action.includes("Quiz")) return "quiz";
  if (action.includes("QuestionImport")) return "question_import";
  if (action.includes("ContentImport")) return "content_import";
  if (action.includes("QuestionBank")) return "question_bank";
  if (action.includes("Question")) return "question";
  if (action.includes("Content")) return "content";
  if (action.includes("Code")) return "redemption_code";
  if (action.includes("Config")) return "config";
  if (action.includes("User")) return "admin_user";
  return "admin";
}

function adminHasAnyPermission(admin: AdminIdentity, permissions: AdminPermission[]) {
  return permissions.some((permission) => hasAdminPermission(admin, permission));
}

const AUDIT_SECRET_KEY = /(password|passphrase|admintoken|tokenhash|secret|cookie|authorization|sessiontoken|codehash|plaintext|privatekey)/i;
const AUDIT_CODE_KEY = /^(code|codes|redemptioncodes)$/i;

function sanitizeAuditValue(value: unknown, key = "", depth = 0): unknown {
  if (AUDIT_SECRET_KEY.test(key) || AUDIT_CODE_KEY.test(key)) return "[REDACTED]";
  if (depth >= 4) return "[TRUNCATED]";
  if (Array.isArray(value)) {
    if (/^(rows|questions|items)$/i.test(key)) return `[${value.length} records omitted]`;
    return value.slice(0, 20).map((item) => sanitizeAuditValue(item, "item", depth + 1));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .slice(0, 60)
      .map(([childKey, childValue]) => [childKey, sanitizeAuditValue(childValue, childKey, depth + 1)]));
  }
  if (typeof value === "string") return value.length > 500 ? `${value.slice(0, 500)}…[truncated]` : value;
  return value;
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
    details: sanitizeAuditValue({ request: payload, response: responseBody }) as Record<string, unknown>,
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
  else if (action === "adminListQuizzes") response = await adminListQuizzes(payload);
  else if (action === "adminListContent") response = await adminListContent(payload);
  else if (action === "adminListRadar") response = await adminListRadar(payload);
  else if (action === "adminListGrowth") response = await adminListGrowth(payload);
  else if (action === "adminListAnalytics") response = await adminListAnalytics(payload);
  else if (action === "adminSetAnalyticsEligibility") response = await adminSetAnalyticsEligibility(payload);
  else if (action === "adminListSystem") response = await adminListSystem(payload);
  else if (action === "adminListUsers") response = await adminListUsers(payload);
  else if (action === "adminListAuditLogs") response = await adminListAuditLogs(payload);
  else if (action === "adminGetContent") response = await adminGetContent(payload);
  else if (action === "adminCreateCodes") response = await adminCreateCodes(payload);
  else if (action === "adminDisableCode") response = await adminDisableCode(payload);
  else if (action === "adminUpdateConfig") response = await adminUpdateConfig(payload);
  else if (action === "adminSetMediaAccess") response = await adminSetMediaAccess(payload);
  else if (action === "adminUpsertContentBatch") response = await adminUpsertContentBatch(payload);
  else if (action === "adminDisableContent") response = await adminDisableContent(payload);
  else if (action === "adminSetContentStatus") response = await adminSetContentStatus(payload);
  else if (action === "adminListContentVersions") response = await adminListContentVersions(payload);
  else if (action === "adminRollbackContent") response = await adminRollbackContent(payload);
  else if (action === "adminDuplicateContent") response = await adminDuplicateContent(payload);
  else if (action === "adminUpsertQuestionBank") response = await adminUpsertQuestionBank(payload);
  else if (action === "adminSetQuestionBankStatus") response = await adminSetQuestionBankStatus(payload);
  else if (action === "adminSearchQuestions") response = await adminSearchQuestions(payload);
  else if (action === "adminUpsertQuestion") response = await adminUpsertQuestion(payload);
  else if (action === "adminSetQuestionStatus") response = await adminSetQuestionStatus(payload);
  else if (action === "adminStartQuestionImport") response = await adminStartQuestionImport(payload);
  else if (action === "adminImportQuestionBatch") response = await adminImportQuestionBatch(payload);
  else if (action === "adminPreviewQuestionImportDuplicates") response = await adminPreviewQuestionImportDuplicates(payload);
  else if (action === "adminFinishQuestionImport") response = await adminFinishQuestionImport(request, payload);
  else if (action === "adminGetQuestionImport") response = await adminGetQuestionImport(request, payload);
  else if (action === "adminCancelQuestionImport") response = await adminCancelQuestionImport(payload);
  else if (action === "adminRetryQuestionImport") response = await adminRetryQuestionImport(request, payload);
  else if (action === "adminDownloadQuestionImportErrors") response = await adminDownloadQuestionImportErrors(payload);
  else if (action === "adminStartContentImport") response = await adminStartContentImport(payload);
  else if (action === "adminUploadContentImportChunk") response = await adminUploadContentImportChunk(payload);
  else if (action === "adminFinishContentImport") response = await adminFinishContentImport(request, payload);
  else if (action === "adminGetContentImport") response = await adminGetContentImport(request, payload);
  else if (action === "adminCancelContentImport") response = await adminCancelContentImport(payload);
  else if (action === "adminRetryContentImport") response = await adminRetryContentImport(request, payload);
  else if (action === "adminDownloadContentImportErrors") response = await adminDownloadContentImportErrors(payload);
  else if (action === "adminSubmitContentImportReview") response = await adminSubmitContentImportReview(payload);
  else if (action === "adminReviewContentImport") response = await adminReviewContentImport(payload);
  else if (action === "adminRollbackContentImport") response = await adminRollbackContentImport(payload);
  else if (action === "adminListQuestionVersions") response = await adminListQuestionVersions(payload);
  else if (action === "adminRollbackQuestionVersion") response = await adminRollbackQuestionVersion(payload);
  else if (action === "adminReviewQuestion") response = await adminReviewQuestion(payload);
  else if (action === "adminCreateUser") response = await adminCreateUser(payload);
  else if (action === "adminSetUserStatus") response = await adminSetUserStatus(payload);
  else if (action === "adminUpdateUser") response = await adminUpdateUser(payload);
  else if (action === "adminResolveContentReport") response = await adminResolveContentReport(payload);
  else if (action === "adminSubmitContentReview") response = await adminSubmitContentReview(payload);
  else if (action === "adminReviewContent") response = await adminReviewContent(payload);
  else if (action === "adminCreateQuiz") response = await adminCreateQuiz(payload);
  else if (action === "adminUpdateQuiz") response = await adminUpdateQuiz(payload);
  else if (action === "adminUpsertQuizQuestion") response = await adminUpsertQuizQuestion(payload);
  else if (action === "adminBulkUpsertQuizQuestions") response = await adminBulkUpsertQuizQuestions(payload);
  else if (action === "adminSetQuizQuestionStatus") response = await adminSetQuizQuestionStatus(payload);
  else if (action === "adminUpsertQuizResult") response = await adminUpsertQuizResult(payload);
  else if (action === "adminGetEssayReferenceLibrary") response = await adminGetEssayReferenceLibrary(payload);
  else if (action === "adminUpsertEssayPaper") response = await adminUpsertEssayPaper(payload);
  else if (action === "adminSetEssayPaperStatus") response = await adminSetEssayPaperStatus(payload);
  else if (action === "adminUpsertEssayMaterial") response = await adminUpsertEssayMaterial(payload);
  else if (action === "adminDeleteEssayMaterial") response = await adminDeleteEssayMaterial(payload);
  else if (action === "adminUpsertEssayLibraryQuestion") response = await adminUpsertEssayLibraryQuestion(payload);
  else if (action === "adminReviewEssayLibraryQuestion") response = await adminReviewEssayLibraryQuestion(payload);
  else if (action === "adminUpsertEssayAnswerSource") response = await adminUpsertEssayAnswerSource(payload);
  else if (action === "adminSetEssayAnswerSourceStatus") response = await adminSetEssayAnswerSourceStatus(payload);
  else if (action === "adminUpsertEssayReferenceAnswer") response = await adminUpsertEssayReferenceAnswer(payload);
  else if (action === "adminSetEssayReferenceAnswerStatus") response = await adminSetEssayReferenceAnswerStatus(payload);
  else if (action === "adminUpdateEssayLibrarySettings") response = await adminUpdateEssayLibrarySettings(payload);
  else return json({ error: "未知管理操作" }, 400);
  await auditAdminResponse(request, admin, action, payload, response);
  return response;
}

function adminRequestIsSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site") return false;
  if (!origin) return true;
  try { return new URL(origin).origin === new URL(request.url).origin; } catch { return false; }
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const mediaId = url.searchParams.get("media");
    if (!mediaId && !allowPassiveBootstrap(request)) {
      const response = json({ error: "访问过于频繁，请稍后再试", code: "RATE_LIMITED" }, 429);
      response.headers.set("retry-after", "60");
      return response;
    }
    await ensureSchema();
    if (mediaId) return serveAuthorizedMedia(mediaId, request);
    await dispatchDueImportWork(request).catch(() => false);
    return await bootstrap(request);
  } catch { return json({ error: "服务暂时不可用，请稍后重试", code: "INTERNAL_ERROR" }, 500); }
}

export async function POST(request: Request) {
  try {
    // Durable import continuations only run after an upload task has
    // already proven the schema exists. Handle it before the additive runtime
    // bootstrap so a cold self-fetch keeps its full D1 Free query allowance for
    // the import chunk itself.
    if (request.headers.has(INTERNAL_IMPORT_HEADER)) {
      if (!(await internalJobSecretMatches(request))) {
        return json({ error: "内部任务凭证无效" }, 403);
      }
      const internalPayload = await request.json() as Record<string, unknown>;
      const internalAction = String(internalPayload.action ?? "");
      const importId = Math.floor(Number(internalPayload.importId));
      if (!Number.isFinite(importId) || importId < 1) return json({ error: "导入任务无效" }, 400);
      let scheduled = false;
      if (internalAction === "continueQuestionImportInternal") {
        scheduled = scheduleRequestTask(request, () => processQuestionImport(importId, 24_000, new URL(request.url).origin));
      } else if (internalAction === "reapImportCancellationInternal") {
        const importKind = String(internalPayload.importKind ?? "");
        if (importKind !== "question" && importKind !== "content") {
          return json({ error: "取消回收任务类型无效" }, 400);
        }
        scheduled = scheduleRequestTask(request, () => reapImportCancellation(importId, importKind));
      } else if (internalAction === "fanoutContentImportInternal") {
        const totalChunks = Math.floor(Number(internalPayload.totalChunks));
        const slot = Math.floor(Number(internalPayload.slot));
        if (!Number.isInteger(totalChunks) || totalChunks < 1 || totalChunks > CONTENT_IMPORT_MAX_CHUNKS
          || !Number.isInteger(slot) || slot < 0 || slot >= CONTENT_IMPORT_WORKER_SLOTS || slot >= totalChunks) {
          return json({ error: "内容导入分发参数无效" }, 400);
        }
        scheduled = scheduleRequestTask(request, () => requestContentImportSlotChunks(
          importId, totalChunks, slot, new URL(request.url).origin,
        ));
      } else if (internalAction === "processContentImportChunkInternal") {
        const chunkIndex = Math.floor(Number(internalPayload.chunkIndex));
        if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= CONTENT_IMPORT_MAX_CHUNKS) {
          return json({ error: "内容导入分块无效" }, 400);
        }
        scheduled = scheduleRequestTask(request, () => processContentImportChunk(importId, chunkIndex));
      } else {
        return json({ error: "内部任务类型无效" }, 400);
      }
      if (!scheduled) return json({ error: "后台执行上下文不可用" }, 503);
      return json({ ok: true, accepted: true }, 202);
    }
    if ((request.headers.get("content-type") ?? "").toLowerCase().includes("multipart/form-data")) {
      await ensureSchema();
      await ensureDefaults();
      if (!adminRequestIsSameOrigin(request)) return json({ error: "跨站管理请求已拒绝" }, 403);
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
    if (!action.startsWith("admin") && !PUBLIC_ACTIONS.has(action)) {
      return json({ error: "未知操作" }, 400);
    }
    if (action.startsWith("admin") && !new Set(["adminLogin", "adminSession", "adminLogout"]).has(action)
      && !Object.prototype.hasOwnProperty.call(ADMIN_ACTION_PERMISSIONS, action)) {
      return json({ error: "未知管理操作" }, 400);
    }
    if (!action.startsWith("admin") && !allowPublicWrite(request, action)) {
      const response = json({ error: "操作过于频繁，请稍后再试", code: "RATE_LIMITED" }, 429);
      response.headers.set("retry-after", "60");
      return response;
    }
    if (action.startsWith("admin") && !adminRequestIsSameOrigin(request)) return json({ error: "跨站管理请求已拒绝" }, 403);
    await ensureSchema();
    await ensureDefaults();
    await dispatchDueImportWork(request).catch(() => false);
    if (action === "adminLogin") return adminLogin(request, payload);
    if (action === "adminSession") return adminSession(request);
    if (action === "adminLogout") return adminLogout(request);
    if (action.startsWith("admin")) {
      delete payload.adminToken;
      return dispatchAdminAction(request, payload, action);
    }
    const identity = await ensureUser(request, { persist: !PASSIVE_PUBLIC_ACTIONS.has(action) });
    if (identity.bootstrapDeferred) {
      // Identity/session preparation may include a device→account merge close
      // to D1 Free's per-invocation query ceiling. No business handler has run
      // yet, so the same payload is safe to retry after the new opaque cookie
      // is stored by the browser.
      return json({
        error: "账号信息同步中，请稍后重试",
        code: "IDENTITY_PREPARING",
        retryAction: true,
        retryBootstrap: true,
        bootstrapStage: identity.bootstrapStage ?? "identity_prepared",
        maxBootstrapRequests: BOOTSTRAP_MAX_REQUESTS,
      }, 409, identity.setCookie);
    }
    const verifiedLearningActions = new Set([
      "saveEssayAttempt", "redeem", "bindInvite",
      "createTestOrder", "completeTestPayment", "recordDailyCheckin", "submitContentReport",
    ]);
    if (!identity.signedIn && verifiedLearningActions.has(action)) {
      const response = json({
        error: "请先登录后继续，学习记录与会员权益将统一保存至当前账号",
        code: "VERIFIED_ACCOUNT_REQUIRED",
      }, 403);
      appendCookies(response.headers, identity.setCookie);
      return response;
    }
    let response: Response;
    if (action === "saveProgress") response = await saveProgress(identity.userId, payload);
    else if (action === "saveExamProfile") response = await saveExamProfile(identity.userId, payload);
    else if (action === "searchJobPositions") response = await searchJobPositions(identity.userId, payload);
    else if (action === "toggleQuestionBank") response = await toggleQuestionBank(identity.userId, payload);
    else if (action === "getPracticeBatch") response = await getPracticeBatch(identity.userId, payload);
    else if (action === "getEssayPracticeBatch") response = await getEssayPracticeBatch(identity.userId, payload);
    else if (action === "saveEssayAttempt") response = await saveEssayAttempt(identity.userId, payload);
    else if (action === "submitPracticeAnswer") response = await submitPracticeAnswer(identity.userId, payload, identity.signedIn);
    else if (action === "updateQuestionMeta") response = await updateQuestionMeta(identity.userId, payload, identity.signedIn);
    else if (action === "submitContentReport") response = await submitContentReport(identity.userId, payload);
    else if (action === "getPracticeSessionSummary") response = await getPracticeSessionSummary(identity.userId, payload);
    else if (action === "recordDailyStep") response = await recordDailyStep(identity.userId, payload);
    else if (action === "recordDailyCheckin") response = await recordDailyCheckin(identity.userId, payload);
    else if (action === "authorizeAudioPlayback") response = await authorizeAudioPlayback(identity.userId, payload);
    else if (action === "bindInvite") response = await bindInvite(identity.userId, payload);
    else if (action === "redeem") response = await redeem(identity.userId, payload);
    else if (action === "getCommerceProducts") response = await getCommerceProducts(request, identity.userId);
    else if (action === "createTestOrder") response = await createTestOrder(request, identity.userId, payload);
    else if (action === "completeTestPayment") response = await completeTestPayment(request, identity.userId, payload);
    else if (action === "trackEvent") response = await trackEvent(identity.userId, payload);
    else if (action === "getQuiz") response = await getQuiz(identity.userId, payload);
    else if (action === "startQuizAttempt") response = await startQuizAttempt(identity.userId, payload);
    else if (action === "submitQuizAnswer") response = await submitQuizAnswer(identity.userId, payload);
    else if (action === "completeQuizAttempt") response = await completeQuizAttempt(identity.userId, payload);
    else if (action === "recordQuizShare") response = await recordQuizShare(identity.userId, payload);
    else if (action === "getEssayReferenceLibrary") response = await getEssayReferenceLibrary(payload);
    else response = json({ error: "未知操作" }, 400);
    appendCookies(response.headers, identity.setCookie);
    return response;
  } catch {
    return json({ error: "请求暂时失败，请稍后重试", code: "INTERNAL_ERROR" }, 500);
  }
}
