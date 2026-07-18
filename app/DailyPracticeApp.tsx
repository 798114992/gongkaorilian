"use client";

/* eslint-disable react-hooks/refs -- session snapshots and queued saves intentionally use refs inside event handlers */
/* eslint-disable @next/next/no-img-element -- operator-uploaded question media can come from runtime-configured sources */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PracticeDay, Question } from "./data/content";
import type { AudioTrack } from "./data/audio";
import AudioHub from "./AudioHub";
import CommercePaywall, { type PaywallReason } from "./CommercePaywall";
import EssayReferenceLibrary, { type EssayLibraryPaper, type EssayReferencePaper, type EssayReferenceQuestion } from "./EssayReferenceLibrary";
import QuizFeature from "./QuizFeature";
import { BOOTSTRAP_MAX_REQUESTS, bootstrapRetryDecision } from "./bootstrap-retry.mjs";
import { prioritizeTodayItems, resolveCampaignDisplay, resolveDailyPrimaryTask, type DailyPrimaryState } from "./daily-orchestration.mjs";

type Tab = "today" | "banks" | "resources" | "essayLibrary" | "audio" | "review" | "report" | "calendar" | "me" | "about" | "support" | "copyright";
type Module = "morning" | "practice" | "affairs" | "essay" | null;
type PracticeMode = "mixed" | "review";
type PlanMinutes = 10 | 30 | 45 | 60;
type PracticeKind = "daily" | "review" | "bank" | "bonus" | "diagnostic";
type PracticeStartOptions = { kind?: PracticeKind; limit?: number; forceNew?: boolean; focusModule?: string; focusSubTypes?: string[]; strictFocus?: boolean; focusLabel?: string; frequency?: string; importanceStars?: number; scoreRateMin?: number; scoreRateMax?: number };
type EssayStartOptions = { bankCodes?: string[]; daily?: boolean; focusModule?: string; focusSubTypes?: string[]; questionCode?: string; attemptDateKey?: string };
type AnswerConfidence = "" | "confident" | "hesitant" | "guessed";
type ContentReportReason = "stem_or_option" | "answer" | "explanation" | "asset" | "source_label" | "other";
type ContentReportDraft = { questionId: string; reasonCode: ContentReportReason | ""; detail: string; submitted: boolean };
type ReminderMode = "in_app" | "browser";
type RadarMode = "notices" | "positions" | "tasks";
type DailyStep = "morning" | "practice" | "essay";
type EssayStage = "draft" | "self_check" | "self_score" | "revision" | "scheduled" | "completed";

type PracticeAnswerPayload = {
  action: "submitPracticeAnswer";
  questionCode: string;
  bankCode: string;
  selectedAnswer: number;
  uncertain: boolean;
  durationMs: number;
  practiceSessionId: string;
  clientSessionId: string;
  attemptKey: string;
};

type QueuedPracticeAttempt = {
  version: 1;
  key: string;
  userId: string;
  payload: PracticeAnswerPayload;
  createdAt: string;
  lastTriedAt: string;
  attempts: number;
  lastError: string;
  blocked: boolean;
};

const PENDING_PRACTICE_STORAGE_KEY = "gongkao-rilian:pending-practice-attempts:v1";
const MAX_PENDING_PRACTICE_ATTEMPTS = 20;
const PENDING_INVITE_SESSION_KEY = "gongkao-rilian:pending-invite:v1";
const CONSUMED_INVITE_SESSION_KEY = "gongkao-rilian:consumed-invite:v1";
const PAYWALL_LOGIN_INTENT_KEY = "gongkao-rilian:paywall-login-intent:v1";
const LOGIN_INTENT_TTL_MS = 30 * 60 * 1000;

type PaywallLoginIntent = {
  version: 1;
  createdAt: number;
  reason: PaywallReason;
  returnContext: Record<string, unknown>;
};

function normalizedInviteCode(value: unknown) {
  const code = String(value ?? "").trim().toUpperCase();
  return /^[A-Z0-9]{4,32}$/.test(code) ? code : "";
}

function currentSafeReturnPath() {
  if (typeof window === "undefined") return "/";
  const path = `${window.location.pathname}${window.location.search}`;
  return path.startsWith("/") && !path.startsWith("//") ? path : "/";
}

function signInHrefFor(returnPath: string) {
  const safePath = returnPath.startsWith("/") && !returnPath.startsWith("//") ? returnPath : "/";
  return `/signin-with-chatgpt?return_to=${encodeURIComponent(safePath)}`;
}

function readPaywallLoginIntent(): PaywallLoginIntent | null {
  if (typeof window === "undefined") return null;
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(PAYWALL_LOGIN_INTENT_KEY) ?? "null") as Partial<PaywallLoginIntent> | null;
    if (!parsed || parsed.version !== 1 || !Number.isFinite(parsed.createdAt)
      || Date.now() - Number(parsed.createdAt) > LOGIN_INTENT_TTL_MS
      || !["daily_limit", "second_bank", "essay", "radar", "value_loop"].includes(String(parsed.reason))
      || !parsed.returnContext || typeof parsed.returnContext !== "object") return null;
    return parsed as PaywallLoginIntent;
  } catch {
    return null;
  }
}

function readPendingPracticeAttempts(): QueuedPracticeAttempt[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(PENDING_PRACTICE_STORAGE_KEY) || "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is QueuedPracticeAttempt => {
      if (!item || typeof item !== "object") return false;
      const candidate = item as Partial<QueuedPracticeAttempt>;
      return candidate.version === 1 && typeof candidate.key === "string" && typeof candidate.userId === "string"
        && Boolean(candidate.payload) && candidate.payload?.action === "submitPracticeAnswer"
        && typeof candidate.payload.questionCode === "string" && typeof candidate.payload.attemptKey === "string"
        && Number.isInteger(candidate.payload.selectedAnswer);
    }).slice(-MAX_PENDING_PRACTICE_ATTEMPTS);
  } catch {
    return [];
  }
}

function writePendingPracticeAttempts(items: QueuedPracticeAttempt[]) {
  if (typeof window === "undefined") return false;
  try {
    window.localStorage.setItem(PENDING_PRACTICE_STORAGE_KEY, JSON.stringify(items.slice(-MAX_PENDING_PRACTICE_ATTEMPTS)));
    return true;
  } catch {
    return false;
  }
}

function isRetryablePracticeError(error: unknown) {
  if (typeof navigator !== "undefined" && !navigator.onLine) return true;
  if (!error || typeof error !== "object" || !("status" in error)) return true;
  const status = Number((error as { status?: unknown }).status);
  return !Number.isFinite(status) || status === 408 || status === 429 || status >= 500;
}

type DrillPreset = {
  id: string;
  title: string;
  subtitle: string;
  icon: string;
  color: string;
  subject: string;
  module: string;
  subTypes: string[];
  bankCodes: string[];
  questionCount: number;
  minutes: number;
  sortOrder: number;
  enabled: boolean;
  frequency?: string;
  importanceStars?: number;
  scoreRateMin?: number;
  scoreRateMax?: number;
};

type StrategyConfig = {
  timePlans?: Partial<Record<`${PlanMinutes}`, {
    morning?: number;
    practice?: number;
    essay?: number;
    questionCount?: number;
  }>>;
  reviewIntervals?: number[];
  scoreRateSweetSpot?: [number, number];
  dueShare?: number;
  urgentDays?: number;
  essayRubric?: string[];
};

type ResourceCard = {
  id: string; title: string; eyebrow: string; summary: string; meta: string; actionLabel: string;
  actionType: "tab" | "essay_library" | "quiz" | "paywall"; actionTarget: string;
  icon: string; tone: "blue" | "green" | "orange" | "purple"; placement: "primary" | "support";
  sortOrder: number; accessLevel: "free" | "member";
};

type CampaignSlot = {
  id: string; slot: "today_after_alerts" | "resources_after_primary" | "me_benefits";
  title: string; eyebrow: string; summary: string; actionLabel: string;
  actionType: "quiz" | "tab" | "paywall"; actionTarget: string;
  audience: "all" | "new_user" | "member" | "non_member" | "multi_exam" | "first_practice_done";
  priority: number; maxPerDay: number; cooldownHours: number; hideAfterCompleteDays: number; endAt: string;
  tone: "blue" | "green" | "orange" | "purple";
};

type PaywallPolicy = {
  id: string; triggerEvent: string; reason: PaywallReason; eyebrow: string; title: string; detail: string;
  priority: number; cooldownHours: number; maxPerDay: number; audience: "all" | "member" | "non_member" | "new_user";
};

type ContentEntry<T = Record<string, unknown>> = {
  id?: string;
  contentKey?: string;
  title?: string;
  payload?: T;
} & Partial<T>;

type FrequencyMeta = { reliable: boolean; occurrences: number; paperCount: number; years: number[]; updatedAt: string | null; scope: string };
type ImportanceMeta = { reliable: boolean; ruleVersion: string; reason: string; overrideReason: string };
type ScoreRateMeta = { reliable: boolean; correct: number; sampleSize: number; scope: string; source: string; updatedAt: string | null };

type EssayPracticeQuestion = {
  id: string;
  bankCode: string;
  bankName: string;
  material: string;
  prompt: string;
  wordLimit: number;
  scoringPoints: string[];
  reference: string;
  region: string;
  examYear: number | null;
  frequency: string;
  importanceStars: number;
  scoreRate: number | null;
  frequencyMeta?: FrequencyMeta;
  importanceMeta?: ImportanceMeta;
  scoreRateMeta?: ScoreRateMeta;
  imageUrl: string;
  resourceUrl: string;
  truthLabel: string;
  serverAttempt?: EssayAttemptSnapshot | null;
};

type EssayAttemptSnapshot = {
  id: string;
  dateKey: string;
  stage: EssayStage;
  firstDraft: string;
  selfChecks: string[];
  selfScore: number | null;
  lossReasons: string[];
  revisedDraft: string;
  rewriteDraft: string;
  elapsedSeconds: number;
  rewriteDueAt: string;
};

type ExamEvent = {
  id: string;
  targetCode: string;
  targetLabel: string;
  eventType: string;
  title: string;
  eventDate: string;
  reminderDays: number;
  reminderEnabled: boolean;
  sourceUrl: string;
};

type ExamNotice = {
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

type JobPosition = {
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

type CandidateProfile = {
  education: string;
  degree: string;
  major: string;
  majorCategory: string;
  freshStatus: string;
  politicalStatus: string;
  household: string;
  grassrootsYears: string;
  grassrootsProject: string;
  gender: string;
  certificates: string;
  acceptRemote: string;
};

type ActivePracticeSession = {
  version: 1;
  clientSessionId: string;
  serverSessionId?: string;
  serverSessionKind?: string;
  dateKey: string;
  kind: PracticeKind;
  mode: PracticeMode;
  planMinutes: PlanMinutes;
  questionTarget: number;
  bankCodes: string[];
  questionIds: string[];
  cursor: number;
  answered: number;
  correct: number;
  reviewAdded: number;
  elapsedSeconds: number;
};

type Progress = {
  currentDay: number;
  completed: Record<string, boolean>;
  answers: Record<string, number>;
  submittedDays: Record<string, boolean>;
  wrongIds: string[];
  reviewedIds: string[];
  wrongReasons: Record<string, string>;
  favorites: string[];
  essayDrafts: Record<string, string>;
  essayChecks: Record<string, string[]>;
  essayStages: Record<string, EssayStage>;
  essaySelfScores: Record<string, number>;
  essayLossReasons: Record<string, string[]>;
  essaySecondDrafts: Record<string, string>;
  essayRewriteDrafts: Record<string, string>;
  essayRewriteDue: Record<string, string>;
  checkins: string[];
  primaryBankCode: string;
  planOverrides: Record<string, PlanMinutes>;
  activePractice: ActivePracticeSession | null;
  examEvents: ExamEvent[];
  reminderMode: ReminderMode;
  candidateProfile: CandidateProfile;
  savedPositionIds: string[];
  radarTodoDone: Record<string, boolean>;
  firstResultSeenSessionId: string;
};

type ExamTarget = {
  code: string;
  label: string;
  examType: "国考" | "省考";
  province: string;
  examYear: number;
  examDate: string | null;
};

type ExamProfile = {
  onboarded: boolean;
  dailyMinutes: number;
  targets: ExamTarget[];
};

type QuestionBank = {
  code: string;
  name: string;
  examType: string;
  province: string;
  examYear: number | null;
  subject: string;
  description: string;
  coverColor: string;
  questionCount: number;
  availableEssayCount?: number;
  studiedCount: number;
  masteredCount: number;
  weakCount: number;
  dueCount: number;
  added: boolean;
  practiceAvailable?: boolean;
  locked?: boolean;
  targetMatch: boolean;
  recommended: boolean;
  scopeLabel: string;
  mismatchReason: string;
  frequency?: string;
  importanceStars?: number;
  scoreRate?: number;
};

type StudyInsights = {
  total: number;
  accuracy: number;
  avgSeconds: number;
  dueCount: number;
  uncertainCount: number;
  overtimeCount: number;
  stateCounts: { learning: number; weak: number; mastered: number };
  modules: Array<{ module: string; total: number; accuracy: number; avgSeconds: number }>;
  weakPoints: Array<{
    point: string;
    module: string;
    total: number;
    accuracy: number;
    wrong: number;
    hesitant: number;
    guessed: number;
    overtime: number;
    wrongReason: string;
    frequency: string;
    frequencyOccurrences: number;
    frequencyPapers: number;
    importanceStars: number;
    scoreRate: number | null;
    scoreRateAttempts: number;
  }>;
  recent: Array<{ day: string; total: number; accuracy: number }>;
  today: {
    total: number;
    correct: number;
    repairedDue: number;
    wrong: number;
    hesitant: number;
    guessed: number;
    overtime: number;
    avgSeconds: number;
    accuracyDelta: number | null;
    avgSecondsDelta: number | null;
    highFrequencyPoints: string[];
  };
  weekly: {
    total: number;
    accuracy: number;
    activeDays: number;
    avgSeconds: number;
    highFrequencyCoverage: number;
    repeatErrorRate: number | null;
    accuracyDelta: number | null;
    avgSecondsDelta: number | null;
    repeatErrorRateDelta: number | null;
    masteredPoints: string[];
    nextIssues: string[];
  };
  tomorrowPlan: { dueCount: number; focusModule: string | null; focusQuestionCount: number; estimatedMinutes: number; taskText: string };
};

type PracticeQuestion = {
  id: string;
  module: string;
  stem: string;
  options: string[];
  knowledge: string;
  source: string;
  difficulty: string;
  bankCode: string;
  bankName: string;
  state: "new" | "learning" | "weak" | "mastered";
  due: boolean;
  favorite: boolean;
  wrongReason: string;
  planReason: string;
  scopeLabel: string;
  reviewedAt: string | null;
  region?: string;
  examYear?: number | null;
  frequency?: string;
  importanceStars?: number;
  scoreRate?: number | null;
  frequencyMeta?: FrequencyMeta;
  importanceMeta?: ImportanceMeta;
  scoreRateMeta?: ScoreRateMeta;
  suggestedSeconds?: number;
  imageUrl?: string;
  resourceUrl?: string;
  truthLabel?: string;
  pendingAttempt?: (AnswerFeedback & { selectedAnswer: number; uncertain: boolean }) | null;
};

type AnswerFeedback = {
  duplicate?: boolean;
  correct: boolean;
  correctAnswer: number;
  explanation: string;
  technique: string;
  state: "learning" | "weak" | "mastered";
  nextReviewAt: string;
  reviewDays: number;
  reviewStage: number;
  needsReview: boolean;
  attemptId: number;
  overtime: boolean;
  targetSeconds: number;
};

type PracticeComposition = {
  due: number;
  weak: number;
  new: number;
  primary: number;
  other: number;
  byBank: Array<{ bankCode: string; bankName: string; count: number }>;
};

type DailyReadiness = {
  ready: boolean;
  distinctQuestionCount: number;
  requiredQuestionCount: number;
  effectiveBankCodes: string[];
  planMinutes?: number;
};

type EssayReferenceLibraryResponse = {
  papers?: EssayLibraryPaper[];
  page?: number;
  pageSize?: number;
  total?: number;
  contactEmail?: string;
  copyrightContactEmail?: string;
  settings?: { copyrightContactEmail?: string };
};

type DailyQueueItem = {
  id: string;
  dateKey: string;
  itemType: "bank_practice" | "essay_reference";
  sourceId: string;
  sourceParentId: string;
  title: string;
  detail: string;
  estimatedMinutes: number;
  status: "scheduled" | "completed";
  origin: "manual" | "system";
  sortOrder: number;
  completedAt: string | null;
};

type ReviewQueueItem = {
  questionCode: string;
  module: string;
  knowledge: string;
  bankName: string;
  state: string;
  reason: string;
  nextReviewAt: string;
  reviewStage: number;
};

type SupportInfo = {
  supportEmail: string;
  supportWechat: string;
  serviceHours: string;
  officialAccountName: string;
  purchaseUrl: string;
  purchaseInstructions: string;
  wrongAccountPolicy: string;
  unusedCodePolicy: string;
  accountMergePolicy: string;
  codeTransferPolicy: string;
  miniProgramStatus: "preparing";
};

type PracticeSummary = {
  sessionId?: string;
  kind: PracticeKind;
  mode: PracticeMode;
  answered: number;
  correct: number;
  reviewAdded: number;
  elapsedSeconds: number;
  bankCodes: string[];
  wrong: number;
  hesitant: number;
  guessed: number;
  overtime: number;
  repairedDue: number;
  weakModules: Array<{ module: string; total: number; accuracy: number }>;
  points: Array<{ point: string; total: number; correct: number; wrong: number; uncertain: number; repairedDue: number }>;
};

type Bootstrap = {
  user: {
    id: string;
    inviteCode: string;
    membershipType: "duration" | "lifetime";
    membershipEnd: string | null;
    membershipActive: boolean;
    signedIn: boolean;
    authProvider: "chatgpt" | "device";
    displayName: string;
  };
  content: {
    practiceDays: PracticeDay[];
    audioTracks: AudioTrack[];
    examEvents: Array<Omit<ExamEvent, "reminderEnabled">>;
    examNotices: ExamNotice[];
    jobPositions: JobPosition[];
    morningReads?: Array<ContentEntry>;
    currentAffairs?: Array<ContentEntry>;
    essayMicros?: Array<ContentEntry>;
    drillPresets?: Array<ContentEntry<Partial<DrillPreset>>>;
    strategyConfig?: StrategyConfig;
    resourceCards?: ResourceCard[];
    campaignSlots?: CampaignSlot[];
    paywallPolicies?: PaywallPolicy[];
    access: "premium" | "preview";
  };
  progress: Partial<Progress>;
  progressVersion: number;
  examProfile: ExamProfile;
  questionBanks: QuestionBank[];
  dailyReadiness?: DailyReadiness;
  studyInsights: StudyInsights;
  ledger: Array<{ delta_days: number; source_type: string; note: string; created_at: string }>;
  inviteStats: { total: number; rewarded: number; pending: number };
  inviteConfig: { rewardDays: number; inviteeRewardDays: number; monthlyCap: number };
  wrongAudioQuestions: Question[];
  dueEssayRewrites: Array<{
    questionCode: string;
    originalDateKey: string;
    rewriteDueAt: string;
    module: string;
    truthLabel: string;
    bankCode: string;
    bankName: string;
  }>;
  dailyQueue: DailyQueueItem[];
  reviewQueue: ReviewQueueItem[];
  dailyPracticeCompleted?: boolean;
  firstCompletedPractice?: { sessionId: string; kind: "diagnostic" | "daily" } | null;
  todayKey: string;
};

const emptyCandidateProfile: CandidateProfile = {
  education: "",
  degree: "",
  major: "",
  majorCategory: "",
  freshStatus: "",
  politicalStatus: "",
  household: "",
  grassrootsYears: "",
  grassrootsProject: "",
  gender: "",
  certificates: "",
  acceptRemote: "可接受",
};

const emptyProgress: Progress = {
  currentDay: 1,
  completed: {},
  answers: {},
  submittedDays: {},
  wrongIds: [],
  reviewedIds: [],
  wrongReasons: {},
  favorites: [],
  essayDrafts: {},
  essayChecks: {},
  essayStages: {},
  essaySelfScores: {},
  essayLossReasons: {},
  essaySecondDrafts: {},
  essayRewriteDrafts: {},
  essayRewriteDue: {},
  checkins: [],
  primaryBankCode: "",
  planOverrides: {},
  activePractice: null,
  examEvents: [],
  reminderMode: "in_app",
  candidateProfile: emptyCandidateProfile,
  savedPositionIds: [],
  radarTodoDone: {},
  firstResultSeenSessionId: "",
};

const emptyInsights: StudyInsights = {
  total: 0,
  accuracy: 0,
  avgSeconds: 0,
  dueCount: 0,
  uncertainCount: 0,
  overtimeCount: 0,
  stateCounts: { learning: 0, weak: 0, mastered: 0 },
  modules: [],
  weakPoints: [],
  recent: [],
  today: { total: 0, correct: 0, repairedDue: 0, wrong: 0, hesitant: 0, guessed: 0, overtime: 0, avgSeconds: 0, accuracyDelta: null, avgSecondsDelta: null, highFrequencyPoints: [] },
  weekly: { total: 0, accuracy: 0, activeDays: 0, avgSeconds: 0, highFrequencyCoverage: 0, repeatErrorRate: null, accuracyDelta: null, avgSecondsDelta: null, repeatErrorRateDelta: null, masteredPoints: [], nextIssues: [] },
  tomorrowPlan: { dueCount: 0, focusModule: null, focusQuestionCount: 0, estimatedMinutes: 5, taskText: "完成首轮日练后生成明日安排。" },
};

const loadingQuestion: Question = {
  id: "loading", module: "加载中", stem: "正在准备今日练习……", options: ["请稍候"], answer: 0,
  explanation: "", knowledge: "",
};

const loadingDay: PracticeDay = {
  day: 1,
  label: "今日练习",
  morning: { title: "正在加载今日晨读", lead: "", paragraphs: [], keywords: [] },
  questions: [loadingQuestion],
  currentAffairs: [],
  essay: { expressions: [], prompt: "正在加载今日申论微练", reference: "", wordLimit: 60 },
};

const emptyPublishedDay: PracticeDay = {
  day: 1,
  label: "内容待发布",
  morning: { title: "今日晨读尚未发布", lead: "", paragraphs: [], keywords: [] },
  questions: [],
  currentAffairs: [],
  essay: { expressions: [], prompt: "", reference: "", wordLimit: 300 },
};

const defaultProvinces = [
  "北京", "天津", "上海", "重庆", "河北", "山西", "内蒙古", "辽宁", "吉林", "黑龙江",
  "江苏", "浙江", "安徽", "福建", "江西", "山东", "河南", "湖北", "湖南", "广东",
  "广西", "海南", "四川", "贵州", "云南", "西藏", "陕西", "甘肃", "青海", "宁夏", "新疆",
];
const reasonOptions = [
  { value: "知识点不会", label: "知识点未掌握" },
  { value: "方法没想到", label: "未识别解题方法" },
  { value: "计算失误", label: "计算失误" },
  { value: "审题错误", label: "审题偏差" },
  { value: "时间不足", label: "时间不足" },
];
const contentReportReasons: Array<{ code: ContentReportReason; label: string }> = [
  { code: "stem_or_option", label: "题干/选项" },
  { code: "answer", label: "答案" },
  { code: "explanation", label: "解析" },
  { code: "asset", label: "图片/附件" },
  { code: "source_label", label: "题源/标签" },
  { code: "other", label: "其他" },
];
const defaultEssayRubric = ["观点准确", "表达规范", "结构清晰", "语言简洁"];
const essayLossReasonOptions = ["漏掉采分点", "表述不规范", "结构不清", "脱离材料", "字数或时间失控"];
const essayStageOrder: Record<EssayStage, number> = { draft: 0, self_check: 1, self_score: 2, revision: 3, scheduled: 4, completed: 5 };
const examEventTypes = ["公告发布", "职位表发布", "报考筛选", "报名开始", "报名截止", "资格审查", "缴费截止", "准考证打印", "笔试", "面试", "自定义"];
const weekLabels = ["一", "二", "三", "四", "五", "六", "日"];
const legacyDrillPresets: DrillPreset[] = [
  { id: "data", icon: "算", title: "资料分析速算", subtitle: "增长率、比重、基期", minutes: 8, subject: "行测", module: "资料分析", subTypes: [], bankCodes: [], questionCount: 5, color: "#245c92", sortOrder: 10, enabled: true },
  { id: "graph", icon: "图", title: "图形判断", subtitle: "位置、样式、数量规律", minutes: 8, subject: "行测", module: "图形", subTypes: [], bankCodes: [], questionCount: 5, color: "#e27f42", sortOrder: 20, enabled: true },
  { id: "idiom", icon: "词", title: "言语易错成语", subtitle: "语境辨析与高频误用", minutes: 6, subject: "行测", module: "逻辑填空", subTypes: [], bankCodes: [], questionCount: 5, color: "#2f8067", sortOrder: 30, enabled: true },
  { id: "affairs", icon: "政", title: "常识时政", subtitle: "政策、法律与重要会议", minutes: 6, subject: "行测", module: "政治", subTypes: [], bankCodes: [], questionCount: 5, color: "#875da8", sortOrder: 40, enabled: true },
  { id: "essay", icon: "写", title: "申论规范表达", subtitle: "真题材料与采分点自评", minutes: 8, subject: "申论", module: "申论", subTypes: [], bankCodes: [], questionCount: 1, color: "#b9634c", sortOrder: 50, enabled: true },
];
const drillColorMap: Record<string, string> = {
  blue: "#245c92",
  orange: "#e27f42",
  green: "#2f8067",
  purple: "#875da8",
};

const candidateOptions = {
  education: ["", "大专", "本科", "硕士研究生", "博士研究生"],
  degree: ["", "无", "学士", "硕士", "博士"],
  freshStatus: ["", "2027应届", "2026应届", "往届", "基层项目人员"],
  politicalStatus: ["", "不限", "群众", "共青团员", "中共党员", "中共预备党员"],
  grassrootsYears: ["", "无", "1年", "2年", "3年及以上"],
  grassrootsProject: ["", "无", "三支一扶", "西部计划", "大学生村官", "特岗教师", "退役士兵"],
  gender: ["", "不限", "男", "女"],
  acceptRemote: ["可接受", "只看城区", "不接受艰苦边远"],
} as const;

const educationRank = ["高中", "中专", "大专", "本科", "硕士研究生", "博士研究生"];

function safeExamEvents(input: unknown): ExamEvent[] {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 96).flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Partial<ExamEvent>;
    const eventDate = typeof item.eventDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(item.eventDate) ? item.eventDate : "";
    const targetCode = typeof item.targetCode === "string" ? item.targetCode.slice(0, 60) : "";
    const title = typeof item.title === "string" ? item.title.trim().slice(0, 40) : "";
    if (!eventDate || !targetCode || !title) return [];
    return [{
      id: typeof item.id === "string" && item.id ? item.id.slice(0, 80) : `event-${targetCode}-${eventDate}-${title}`,
      targetCode,
      targetLabel: typeof item.targetLabel === "string" ? item.targetLabel.slice(0, 24) : "报考目标",
      eventType: typeof item.eventType === "string" ? item.eventType.slice(0, 24) : "自定义",
      title,
      eventDate,
      reminderDays: [0, 1, 3, 7, 14].includes(Number(item.reminderDays)) ? Number(item.reminderDays) : 3,
      reminderEnabled: item.reminderEnabled !== false,
      sourceUrl: typeof item.sourceUrl === "string" && /^https?:\/\//i.test(item.sourceUrl) ? item.sourceUrl.slice(0, 400) : "",
    }];
  });
}

function safeText(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function safeCandidateProfile(input: unknown): CandidateProfile {
  if (!input || typeof input !== "object") return emptyCandidateProfile;
  const item = input as Partial<CandidateProfile>;
  return {
    education: safeText(item.education, 20),
    degree: safeText(item.degree, 20),
    major: safeText(item.major, 40),
    majorCategory: safeText(item.majorCategory, 40),
    freshStatus: safeText(item.freshStatus, 20),
    politicalStatus: safeText(item.politicalStatus, 20),
    household: safeText(item.household, 40),
    grassrootsYears: safeText(item.grassrootsYears, 20),
    grassrootsProject: safeText(item.grassrootsProject, 30),
    gender: safeText(item.gender, 10),
    certificates: safeText(item.certificates, 120),
    acceptRemote: safeText(item.acceptRemote, 20) || "可接受",
  };
}

function safeStringList(input: unknown, max = 160) {
  return Array.isArray(input)
    ? Array.from(new Set(input.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim().slice(0, 120)))).slice(0, max)
    : [];
}

function mergeProgress(input?: Partial<Progress>): Progress {
  const activePractice = input?.activePractice;
  const validSession = activePractice?.version === 1
    && Array.isArray(activePractice.questionIds)
    && activePractice.questionIds.length <= 20
    && ["daily", "review", "bank", "bonus", "diagnostic"].includes(activePractice.kind)
    ? activePractice
    : null;
  return {
    ...emptyProgress,
    ...input,
    completed: { ...emptyProgress.completed, ...(input?.completed ?? {}) },
    answers: { ...emptyProgress.answers, ...(input?.answers ?? {}) },
    submittedDays: { ...emptyProgress.submittedDays, ...(input?.submittedDays ?? {}) },
    wrongIds: Array.isArray(input?.wrongIds) ? input.wrongIds : [],
    reviewedIds: Array.isArray(input?.reviewedIds) ? input.reviewedIds : [],
    wrongReasons: { ...emptyProgress.wrongReasons, ...(input?.wrongReasons ?? {}) },
    favorites: Array.isArray(input?.favorites) ? input.favorites : [],
    essayDrafts: { ...emptyProgress.essayDrafts, ...(input?.essayDrafts ?? {}) },
    essayChecks: { ...emptyProgress.essayChecks, ...(input?.essayChecks ?? {}) },
    essayStages: { ...emptyProgress.essayStages, ...(input?.essayStages ?? {}) },
    essaySelfScores: { ...emptyProgress.essaySelfScores, ...(input?.essaySelfScores ?? {}) },
    essayLossReasons: { ...emptyProgress.essayLossReasons, ...(input?.essayLossReasons ?? {}) },
    essaySecondDrafts: { ...emptyProgress.essaySecondDrafts, ...(input?.essaySecondDrafts ?? {}) },
    essayRewriteDrafts: { ...emptyProgress.essayRewriteDrafts, ...(input?.essayRewriteDrafts ?? {}) },
    essayRewriteDue: { ...emptyProgress.essayRewriteDue, ...(input?.essayRewriteDue ?? {}) },
    checkins: Array.isArray(input?.checkins) ? input.checkins : [],
    primaryBankCode: typeof input?.primaryBankCode === "string" ? input.primaryBankCode : "",
    planOverrides: { ...emptyProgress.planOverrides, ...(input?.planOverrides ?? {}) },
    activePractice: validSession ? {
      ...validSession,
      clientSessionId: typeof validSession.clientSessionId === "string" && validSession.clientSessionId
        ? validSession.clientSessionId
        : `legacy-${validSession.dateKey}-${validSession.kind}`,
      reviewAdded: Number(validSession.reviewAdded ?? 0),
    } : null,
    examEvents: safeExamEvents(input?.examEvents),
    reminderMode: input?.reminderMode === "browser" ? "browser" : "in_app",
    candidateProfile: safeCandidateProfile(input?.candidateProfile),
    savedPositionIds: safeStringList(input?.savedPositionIds, 120),
    radarTodoDone: { ...emptyProgress.radarTodoDone, ...(input?.radarTodoDone ?? {}) },
    firstResultSeenSessionId: typeof input?.firstResultSeenSessionId === "string" ? input.firstResultSeenSessionId.slice(0, 100) : "",
  };
}

function normalizePlanMinutes(value: unknown): PlanMinutes {
  return value === 10 || value === 45 || value === 60 ? value : 30;
}

function boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, Math.round(parsed))) : fallback;
}

function buildDailyPlan(value: unknown, preview = false, strategy?: StrategyConfig) {
  const minutes = normalizePlanMinutes(value);
  const plans = {
    10: { minutes: 10 as const, morningMinutes: 0, practiceMinutes: 10, essayMinutes: 0, questionCount: 5 },
    30: { minutes: 30 as const, morningMinutes: 5, practiceMinutes: 20, essayMinutes: 5, questionCount: 10 },
    45: { minutes: 45 as const, morningMinutes: 5, practiceMinutes: 30, essayMinutes: 10, questionCount: 15 },
    60: { minutes: 60 as const, morningMinutes: 10, practiceMinutes: 35, essayMinutes: 15, questionCount: 20 },
  };
  const fallback = plans[minutes];
  const configured = strategy?.timePlans?.[String(minutes) as `${PlanMinutes}`];
  const plan = {
    minutes,
    morningMinutes: boundedNumber(configured?.morning, fallback.morningMinutes, 0, minutes),
    practiceMinutes: boundedNumber(configured?.practice, fallback.practiceMinutes, 0, minutes),
    essayMinutes: boundedNumber(configured?.essay, fallback.essayMinutes, 0, minutes),
    questionCount: boundedNumber(configured?.questionCount, fallback.questionCount, 1, 20),
  };
  return { ...plan, questionCount: preview ? Math.min(5, plan.questionCount) : plan.questionCount };
}

function unwrapContentPayload<T extends object>(entry: ContentEntry<T>): Partial<T> {
  return entry && typeof entry === "object" && entry.payload && typeof entry.payload === "object"
    ? { ...entry, ...entry.payload }
    : entry;
}

function normalizeDrillPresets(entries?: Array<ContentEntry<Partial<DrillPreset>>>) {
  // Only use the legacy presets for an older API that omits this field.
  // An explicit empty array means operators intentionally hid every preset.
  if (entries === undefined) return legacyDrillPresets;
  if (!entries.length) return [];
  return entries.flatMap((entry, index) => {
    const item = unwrapContentPayload(entry);
    if (item.enabled === false) return [];
    const id = safeText(item.id ?? entry.contentKey, 80) || `drill-${index + 1}`;
    const title = safeText(item.title ?? entry.title, 40);
    if (!title) return [];
    return [{
      id,
      title,
      subtitle: safeText(item.subtitle, 80) || "精选真题，短时完成",
      icon: safeText(item.icon, 4) || title.slice(0, 1),
      color: /^#[0-9a-f]{6}$/i.test(String(item.color ?? "")) ? String(item.color) : drillColorMap[String(item.color ?? "")] ?? "#245c92",
      subject: safeText(item.subject, 20) || "行测",
      module: safeText(item.module, 40),
      subTypes: Array.isArray(item.subTypes)
        ? item.subTypes.map((value) => safeText(value, 40)).filter(Boolean).slice(0, 12)
        : safeText(item.subType, 120).split(/[、,，|｜;；\n]+/).map((value) => value.trim()).filter(Boolean).slice(0, 12),
      bankCodes: Array.isArray(item.bankCodes)
        ? item.bankCodes.map((value) => safeText(value, 80)).filter(Boolean).slice(0, 32)
        : safeText(item.bankCodes, 1_000).split(/[,，、|｜;；\n]+/).map((value) => value.trim()).filter(Boolean).slice(0, 32),
      questionCount: boundedNumber(item.questionCount, 5, 1, 20),
      minutes: boundedNumber(item.minutes, 8, 3, 30),
      sortOrder: boundedNumber(item.sortOrder ?? item.sort, index * 10, -9999, 9999),
      enabled: true,
      frequency: safeText(item.frequency, 10),
      importanceStars: boundedNumber(item.importanceStars, 0, 0, 5) || undefined,
      scoreRateMin: boundedNumber(item.scoreRateMin, 0, 0, 100),
      scoreRateMax: boundedNumber(item.scoreRateMax, 100, 0, 100),
    } satisfies DrillPreset];
  }).sort((a, b) => a.sortOrder - b.sortOrder || a.title.localeCompare(b.title));
}

function normalizeTruthLabel(region?: string, examYear?: number | null, fallback = "") {
  const rawRegion = (region ?? "").trim().replace(/省考$|真题$/g, "");
  const cleanRegion = rawRegion === "全国" ? "国考" : rawRegion;
  if (cleanRegion && examYear) return `${cleanRegion}-${examYear}`;
  return fallback
    .replace(/([\u4e00-\u9fa5]{2,12})[·・](20\d{2})真题/g, "$1-$2")
    .replace(/([\u4e00-\u9fa5]{2,12})[·・](20\d{2})/g, "$1-$2")
    .replace(/真题/g, "")
    .trim();
}

function starText(value?: number | null, meta?: ImportanceMeta, showPending = false) {
  if (meta && !meta.reliable) return showPending ? "重要度待评估" : "";
  const stars = boundedNumber(value, 0, 0, 5);
  return stars ? `${"★".repeat(stars)}${"☆".repeat(5 - stars)}` : "";
}

function frequencyText(value?: string | null, meta?: FrequencyMeta, showPending = false) {
  if (meta && !meta.reliable) return showPending ? "考频：样本积累中" : "";
  const frequency = value?.trim();
  if (!frequency) return "";
  const base = frequency.includes("考频") ? frequency : `考频：${frequency}`;
  return meta?.reliable ? `${base}（近5年${meta.occurrences}/${meta.paperCount}套）` : base;
}

function scoreRateText(value?: number | null, meta?: ScoreRateMeta, showPending = false) {
  if (meta && !meta.reliable) return showPending ? `拿分率样本积累中（${meta.sampleSize}/100）` : "";
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "";
  const percent = Number(value) <= 1 ? Number(value) * 100 : Number(value);
  const base = `拿分率${Math.max(0, Math.min(100, Math.round(percent)))}%`;
  return meta?.reliable ? `${base}（${meta.sampleSize}次有效首答）` : base;
}

function MetricMethod({ frequency, importance, scoreRate }: {
  frequency?: FrequencyMeta;
  importance?: ImportanceMeta;
  scoreRate?: ScoreRateMeta;
}) {
  const rows = [
    frequency?.reliable
      ? `考频：${frequency.scope || "当前考试范围"}近5年，覆盖${frequency.occurrences}/${frequency.paperCount}套有效试卷${frequency.years.length ? `（${frequency.years.join("、")}）` : ""}${frequency.updatedAt ? `；更新于${shortDate(frequency.updatedAt)}` : ""}`
      : "考频：有效试卷样本尚不足，暂不判定高/中/低频",
    importance?.reliable
      ? `重要星级：按${importance.ruleVersion}评估；${importance.overrideReason || importance.reason}`
      : "重要星级：尚无完整规则版本和评分理由，暂不展示默认星级",
    scoreRate?.reliable
      ? `拿分率：${scoreRate.scope || "当前统计范围"}的${scoreRate.sampleSize}次有效首答，来源${scoreRate.source || "平台统计"}${scoreRate.updatedAt ? `；更新于${shortDate(scoreRate.updatedAt)}` : ""}`
      : `拿分率：有效首答${scoreRate?.sampleSize ?? 0}/100，样本不足时不用于误导性比较`,
  ];
  return <details className="metric-method"><summary>查看标签计算口径</summary>{rows.map((row) => <p key={row}>{row}</p>)}</details>;
}

function bankTruthLabel(bank: QuestionBank) {
  const region = bank.examType === "国考" ? "国考" : bank.province || bank.scopeLabel || bank.examType;
  return normalizeTruthLabel(region, bank.examYear, bank.scopeLabel || bank.name);
}

function normalizeEssayAttempt(raw: unknown): EssayAttemptSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const stage = String(item.stage ?? "draft") as EssayStage;
  if (!Object.prototype.hasOwnProperty.call(essayStageOrder, stage)) return null;
  const dateKey = safeText(item.dateKey, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return null;
  const selfScoreValue = item.selfScore === null || item.selfScore === undefined ? null : Number(item.selfScore);
  return {
    id: safeText(item.id, 80),
    dateKey,
    stage,
    firstDraft: safeText(item.firstDraft, 8_000),
    selfChecks: safeStringList(item.selfChecks, 20),
    selfScore: selfScoreValue !== null && Number.isFinite(selfScoreValue) ? selfScoreValue : null,
    lossReasons: safeStringList(item.lossReasons, 20),
    revisedDraft: safeText(item.revisedDraft, 8_000),
    rewriteDraft: safeText(item.rewriteDraft, 8_000),
    elapsedSeconds: boundedNumber(item.elapsedSeconds, 0, 0, 4 * 3600),
    rewriteDueAt: /^\d{4}-\d{2}-\d{2}$/.test(String(item.rewriteDueAt ?? "")) ? String(item.rewriteDueAt) : "",
  };
}

function applyEssayAttemptSnapshot(progress: Progress, questionId: string, attempt: EssayAttemptSnapshot): Progress {
  const key = `essay:${questionId}`;
  return {
    ...progress,
    essayDrafts: { ...progress.essayDrafts, [key]: attempt.firstDraft },
    essayChecks: { ...progress.essayChecks, [key]: attempt.selfChecks },
    essayStages: { ...progress.essayStages, [key]: attempt.stage },
    essaySelfScores: attempt.selfScore === null
      ? Object.fromEntries(Object.entries(progress.essaySelfScores).filter(([entryKey]) => entryKey !== key))
      : { ...progress.essaySelfScores, [key]: attempt.selfScore },
    essayLossReasons: { ...progress.essayLossReasons, [key]: attempt.lossReasons },
    essaySecondDrafts: { ...progress.essaySecondDrafts, [key]: attempt.revisedDraft },
    essayRewriteDrafts: { ...progress.essayRewriteDrafts, [key]: attempt.rewriteDraft },
    essayRewriteDue: { ...progress.essayRewriteDue, [key]: attempt.rewriteDueAt },
  };
}

function normalizeEssayQuestion(raw: unknown, index: number): EssayPracticeQuestion | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const prompt = safeText(item.prompt ?? item.stem, 2000);
  if (!prompt) return null;
  const region = safeText(item.region, 40);
  const examYear = Number.isFinite(Number(item.examYear)) ? Number(item.examYear) : null;
  const rawPoints = Array.isArray(item.scoringPoints)
    ? item.scoringPoints
    : typeof item.scoringPoints === "string"
      ? String(item.scoringPoints).split(/[\n；;]/)
      : [];
  const scoringPoints = rawPoints.map((value) => safeText(value, 240)).filter(Boolean).slice(0, 16);
  const rawFrequencyMeta = item.frequencyMeta && typeof item.frequencyMeta === "object" ? item.frequencyMeta as Record<string, unknown> : null;
  const rawImportanceMeta = item.importanceMeta && typeof item.importanceMeta === "object" ? item.importanceMeta as Record<string, unknown> : null;
  const rawScoreRateMeta = item.scoreRateMeta && typeof item.scoreRateMeta === "object" ? item.scoreRateMeta as Record<string, unknown> : null;
  return {
    id: safeText(item.id ?? item.code, 80) || `essay-${index + 1}`,
    bankCode: safeText(item.bankCode, 80),
    bankName: safeText(item.bankName, 100) || "申论真题",
    material: safeText(item.material, 8000),
    prompt,
    wordLimit: boundedNumber(item.wordLimit, 300, 30, 2000),
    scoringPoints,
    reference: safeText(item.reference ?? item.referenceAnswer ?? item.sampleAnswer ?? item.answer, 8000),
    region,
    examYear,
    frequency: safeText(item.frequency, 20),
    importanceStars: boundedNumber(item.importanceStars, 0, 0, 5),
    scoreRate: item.scoreRate === null || item.scoreRate === undefined ? null : Number(item.scoreRate),
    frequencyMeta: rawFrequencyMeta ? {
      reliable: rawFrequencyMeta.reliable === true,
      occurrences: boundedNumber(rawFrequencyMeta.occurrences, 0, 0, 9999),
      paperCount: boundedNumber(rawFrequencyMeta.paperCount, 0, 0, 9999),
      years: Array.isArray(rawFrequencyMeta.years) ? rawFrequencyMeta.years.map(Number).filter(Number.isFinite).slice(0, 5) : [],
      updatedAt: rawFrequencyMeta.updatedAt ? String(rawFrequencyMeta.updatedAt) : null,
      scope: safeText(rawFrequencyMeta.scope, 100),
    } : undefined,
    importanceMeta: rawImportanceMeta ? {
      reliable: rawImportanceMeta.reliable === true,
      ruleVersion: safeText(rawImportanceMeta.ruleVersion, 40),
      reason: safeText(rawImportanceMeta.reason, 500),
      overrideReason: safeText(rawImportanceMeta.overrideReason, 500),
    } : undefined,
    scoreRateMeta: rawScoreRateMeta ? {
      reliable: rawScoreRateMeta.reliable === true,
      correct: boundedNumber(rawScoreRateMeta.correct, 0, 0, 1_000_000),
      sampleSize: boundedNumber(rawScoreRateMeta.sampleSize, 0, 0, 1_000_000),
      scope: safeText(rawScoreRateMeta.scope, 120),
      source: safeText(rawScoreRateMeta.source, 240),
      updatedAt: rawScoreRateMeta.updatedAt ? String(rawScoreRateMeta.updatedAt) : null,
    } : undefined,
    imageUrl: safeText(item.imageUrl, 500),
    resourceUrl: safeText(item.resourceUrl, 500),
    truthLabel: normalizeTruthLabel(region, examYear, safeText(item.truthLabel ?? item.source, 100)),
    serverAttempt: normalizeEssayAttempt(item.serverAttempt),
  };
}

function localChinaDateKey() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

function shiftDateKey(dateKey: string, days: number) {
  const date = new Date(`${dateKey}T12:00:00+08:00`);
  date.setUTCDate(date.getUTCDate() + days);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function weekDateKeys(dateKey: string) {
  const chinaNoon = new Date(`${dateKey}T12:00:00+08:00`);
  const mondayFirstIndex = (chinaNoon.getUTCDay() + 6) % 7;
  return Array.from({ length: 7 }, (_, index) => shiftDateKey(dateKey, index - mondayFirstIndex));
}

function eventDaysLeft(eventDate: string, todayKey: string) {
  const value = Math.round((Date.parse(`${eventDate}T12:00:00+08:00`) - Date.parse(`${todayKey}T12:00:00+08:00`)) / 86_400_000);
  return Number.isFinite(value) ? value : 9999;
}

function compactText(value: string) {
  return value.replace(/\s+/g, "").toLowerCase();
}

function isUnlimited(value: string) {
  return !value.trim() || /不限|无要求|不限制|均可|不限专业/.test(value);
}

function educationMatches(requirement: string, profileEducation: string) {
  if (isUnlimited(requirement)) return true;
  if (!profileEducation) return null;
  const req = compactText(requirement);
  const userRank = educationRank.findIndex((item) => profileEducation.includes(item));
  const requiredRank = educationRank.findIndex((item) => req.includes(item.toLowerCase()));
  if (/本科及以上|本科以上/.test(requirement) && userRank >= educationRank.indexOf("本科")) return true;
  if (/大专及以上|专科及以上|大专以上|专科以上/.test(requirement) && userRank >= educationRank.indexOf("大专")) return true;
  if (/硕士及以上|研究生及以上|硕士研究生及以上/.test(requirement) && userRank >= educationRank.indexOf("硕士研究生")) return true;
  if (requiredRank >= 0 && userRank >= 0) return userRank >= requiredRank;
  return req.includes(compactText(profileEducation)) || compactText(profileEducation).includes(req);
}

function fieldMatches(requirement: string, profileValue: string) {
  if (isUnlimited(requirement)) return true;
  if (!profileValue) return null;
  const req = compactText(requirement);
  const value = compactText(profileValue);
  return req.includes(value) || value.includes(req);
}

function majorMatches(position: JobPosition, profile: CandidateProfile) {
  const requirement = `${position.majors} ${position.majorCodes}`;
  if (isUnlimited(requirement)) return true;
  if (!profile.major && !profile.majorCategory) return null;
  const req = compactText(requirement);
  const major = compactText(profile.major);
  const category = compactText(profile.majorCategory);
  return Boolean((major && req.includes(major)) || (category && req.includes(category)));
}

function matchPosition(position: JobPosition, profile: CandidateProfile) {
  const reasons: string[] = [];
  const risks: string[] = [];
  const fails: string[] = [];

  const education = educationMatches(position.education, profile.education);
  if (education === true) reasons.push("学历基本符合");
  else if (education === false) fails.push("学历不匹配");
  else risks.push("学历待补充");

  const degree = fieldMatches(position.degree, profile.degree);
  if (degree === true && !isUnlimited(position.degree)) reasons.push("学位匹配");
  else if (degree === false) risks.push("学位需核对");
  else if (degree === null && !isUnlimited(position.degree)) risks.push("学位待补充");

  const major = majorMatches(position, profile);
  if (major === true) reasons.push(isUnlimited(`${position.majors} ${position.majorCodes}`) ? "不限专业" : "专业方向匹配");
  else if (major === false) fails.push("专业不匹配");
  else risks.push("专业待补充");

  if (/应届/.test(position.freshLimit) && !/应届/.test(profile.freshStatus)) fails.push("应届身份不符");
  else if (!isUnlimited(position.freshLimit) && !profile.freshStatus) risks.push("应届/往届待补充");

  if (/党员|中共/.test(position.politicalStatus) && !/党员/.test(profile.politicalStatus)) fails.push("政治面貌不符");
  else if (!isUnlimited(position.politicalStatus) && !profile.politicalStatus) risks.push("政治面貌待补充");

  const household = fieldMatches(position.household, profile.household);
  if (household === false) risks.push("户籍/生源地需核对");
  else if (household === null && !isUnlimited(position.household)) risks.push("户籍待补充");

  const grassroots = fieldMatches(position.grassrootsYears, profile.grassrootsYears);
  if (grassroots === false) risks.push("基层经历年限需核对");
  else if (grassroots === null && !isUnlimited(position.grassrootsYears)) risks.push("基层经历待补充");

  if (!isUnlimited(position.gender) && profile.gender && position.gender !== profile.gender) fails.push("性别限制不符");
  else if (!isUnlimited(position.gender) && !profile.gender) risks.push("性别待补充");

  if (!isUnlimited(position.certificates) && !profile.certificates) risks.push("证书要求待核对");
  else if (!isUnlimited(position.certificates) && !compactText(profile.certificates).includes(compactText(position.certificates))) risks.push("证书可能不匹配");

  if (/艰苦|边远|驻外|夜班|加班/.test(position.remote) && profile.acceptRemote === "不接受艰苦边远") risks.push("工作地点/强度需谨慎");

  if (!profile.education || !profile.major || !profile.freshStatus) {
    return {
      level: "risk" as const,
      label: "待确认",
      reasons: ["学历、专业、身份至少补全后再筛"],
      missing: [!profile.education ? "学历" : "", !profile.major ? "专业" : "", !profile.freshStatus ? "应届/往届" : ""].filter(Boolean),
      basis: [position.education, position.majors, position.freshLimit].filter((item) => !isUnlimited(item)),
      score: 1,
    };
  }
  const basis = [
    `学历：${position.education || "不限"}`,
    `专业：${position.majors || "不限"}`,
    `身份：${position.freshLimit || "不限"}`,
    `政治面貌：${position.politicalStatus || "不限"}`,
  ];
  if (fails.length) return { level: "fail" as const, label: "明确不符合", reasons: fails.slice(0, 3), missing: [], basis, score: 0 };
  if (risks.length) return {
    level: "risk" as const,
    label: "待确认",
    reasons: risks.slice(0, 3),
    missing: risks.filter((item) => item.includes("待补充")).map((item) => item.replace("待补充", "")),
    basis,
    score: 2,
  };
  return { level: "fit" as const, label: "初步符合", reasons: reasons.slice(0, 3), missing: [], basis, score: 3 };
}

function checkinStreak(checkins: string[], todayKey: string) {
  const checked = new Set(checkins);
  let cursor = checked.has(todayKey) ? todayKey : shiftDateKey(todayKey, -1);
  let streak = 0;
  while (checked.has(cursor) && streak < 3660) {
    streak += 1;
    cursor = shiftDateKey(cursor, -1);
  }
  return streak;
}

function shortDate(value: string) {
  const date = new Date(`${value}T12:00:00+08:00`);
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

function contentDayIndex(dateKey: string, count: number) {
  if (count <= 1) return 0;
  const dayNumber = Math.floor(new Date(`${dateKey}T00:00:00+08:00`).getTime() / 86_400_000);
  return Math.abs(dayNumber) % count;
}

function createClientSessionId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `local-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function questionTargetSeconds(question?: Pick<PracticeQuestion, "module" | "knowledge">) {
  if (!question) return 60;
  if (question.module.includes("常识") || question.module.includes("政治")) return 35;
  if (question.module.includes("资料")) return 90;
  if (question.module.includes("数量")) return 120;
  if (question.knowledge.includes("图形")) return 75;
  return 60;
}

function formatDate(value: string | null) {
  if (!value) return "体验用户";
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
}

function reviewDateLabel(value: string | null | undefined, todayKey = localChinaDateKey()) {
  if (!value) return "待系统安排";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "待系统安排";
  const dateKey = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(parsed);
  const days = Math.round((new Date(`${dateKey}T12:00:00+08:00`).getTime() - new Date(`${todayKey}T12:00:00+08:00`).getTime()) / 86_400_000);
  const dateText = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric" }).format(parsed);
  if (days === 0) return `今天到期 · ${dateText}`;
  if (days < 0) return `已逾期${Math.abs(days)}天 · ${dateText}`;
  if (days === 1) return `明天复习 · ${dateText}`;
  return `${dateText}复习 · ${days}天后`;
}

function daysLeft(date: string | null) {
  if (!date) return null;
  const value = Math.ceil((new Date(`${date}T23:59:59`).getTime() - Date.now()) / 86_400_000);
  return Number.isFinite(value) ? Math.max(0, value) : null;
}

function createTarget(examType: "国考" | "省考", province = ""): ExamTarget {
  const code = examType === "国考" ? "national" : `province:${province}`;
  return {
    code,
    label: examType === "国考" ? "国考" : `${province}省考`,
    examType,
    province: examType === "省考" ? province : "",
    examYear: new Date().getFullYear() + 1,
    examDate: null,
  };
}

function targetMatchesBank(target: ExamTarget, bank: QuestionBank) {
  return target.examType === bank.examType && (target.examType === "国考" || target.province === bank.province);
}

function bankYearSupportsTarget(bankYear: number | null, targetYear: number) {
  // 题库年份是真题来源年份，不是报考年份。当前目标优先采用截至目标年近5年的真题。
  return bankYear === null || (bankYear <= targetYear && bankYear >= targetYear - 4);
}

function bankCanPowerDailyPractice(target: ExamTarget, bank: QuestionBank) {
  // The question-bank API only returns published banks. Here we validate the
  // remaining signals that decide whether this bank can really enter daily practice.
  return bank.code !== "starter-gk"
    && targetMatchesBank(target, bank)
    && (bank.subject === "行测" || bank.subject === "综合")
    && bank.questionCount >= 5
    && bankYearSupportsTarget(bank.examYear, target.examYear);
}

type BankFit = {
  show: boolean;
  score: number;
  badge: string;
  reason: string;
  tone: "recommended" | "generic" | "mismatch";
};

function resolveBankFit(bank: QuestionBank, profile: ExamProfile, primaryTarget: ExamTarget | null, primaryBankCode = ""): BankFit {
  const matchedTarget = profile.targets.find((target) => targetMatchesBank(target, bank));
  const hasLearningSignal = bank.studiedCount > 0 || bank.weakCount > 0 || bank.dueCount > 0;
  const isStarter = bank.code === "starter-gk" || bank.examType === "通用";
  const isSpecial = bank.examType === "专项";
  const signals: string[] = [];
  let score = 0;

  if (bank.code === primaryBankCode) {
    score += 120;
    signals.push("主攻题库");
  }
  if (primaryTarget && matchedTarget?.code === primaryTarget.code) {
    score += 105;
    signals.push(`匹配主攻${primaryTarget.label}`);
  } else if (matchedTarget) {
    score += 85;
    signals.push(`匹配${matchedTarget.label}`);
  }
  if (bank.added) {
    score += 70;
    signals.push("已加入备考组合");
  }
  if (bank.dueCount > 0) {
    score += 34;
    signals.push(`${bank.dueCount}题到期`);
  }
  if (bank.weakCount > 0) {
    score += 24;
    signals.push(`${bank.weakCount}题薄弱`);
  }
  if (isStarter && (bank.added || !profile.onboarded)) {
    score += 36;
    signals.push("基础日常训练");
  }
  if (isSpecial && !bank.added && !hasLearningSignal) {
    score = 0;
    signals.length = 0;
  }

  const show = score > 0;
  const badge = bank.code === primaryBankCode
    ? "✓ 主攻推荐"
    : matchedTarget
      ? `✓ ${matchedTarget.label}匹配`
      : bank.added
        ? "✓ 已在我的组合"
        : hasLearningSignal
          ? "✓ 按薄弱/到期推荐"
          : bank.scopeLabel;
  const reason = signals.slice(0, 2).join(" · ") || (show ? "符合当前学习条件" : bank.mismatchReason || bank.scopeLabel);
  const tone: BankFit["tone"] = bank.code === primaryBankCode || matchedTarget
    ? "recommended"
    : bank.added || hasLearningSignal || isStarter
      ? "generic"
      : "mismatch";
  return { show, score, badge, reason, tone };
}

function membershipText(user?: Bootstrap["user"], extended = false) {
  if (!user?.membershipActive) return "免费版";
  if (user.membershipType === "lifetime") return "终身会员";
  if (extended) return "会员有效";
  if (!user.membershipEnd) return "体验中";
  const days = Math.max(1, Math.ceil((Date.parse(user.membershipEnd) - Date.now()) / 86_400_000));
  return `体验期剩余${days}天`;
}

function learnerWrongReason(reason: string) {
  const labels: Record<string, string> = {
    "知识点不会": "知识点未掌握",
    "方法没想到": "未识别解题方法",
    "审题错误": "审题偏差",
    "蒙对了": "猜测作答",
  };
  return labels[reason] ?? reason;
}

function apiErrorCode(error: unknown) {
  if (!error || typeof error !== "object" || !("data" in error)) return "";
  const data = (error as { data?: unknown }).data;
  if (!data || typeof data !== "object" || !("code" in data)) return "";
  return String((data as { code?: unknown }).code ?? "");
}

function threeDayReportShareText(insights: StudyInsights) {
  const weekly = insights.weekly;
  const issues = weekly.nextIssues.slice(0, 3);
  return [
    "我的公考日练 · 3天体验报告",
    `最近7个自然日有效学习${weekly.activeDays}天，完成${weekly.total}道真题，正确率${weekly.accuracy}%。`,
    `累计标记掌握不稳定或猜测作答${insights.uncertainCount}道、超时${insights.overtimeCount}道。`,
    `当前到期复习${insights.dueCount}道，最近7日覆盖可靠高频考点${weekly.highFrequencyCoverage}个。`,
    `下一阶段优先训练：${issues.length ? issues.join("；") : "当前样本不足，继续训练后生成建议"}。`,
    "以上内容基于实际作答记录，不含排名或提分预测。",
  ].join("\n");
}

async function copyPlainText(text: string) {
  if (window.navigator.clipboard?.writeText) {
    await window.navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("COPY_UNAVAILABLE");
}

export default function DailyPracticeApp() {
  const [tab, setTab] = useState<Tab>("today");
  const [activeModule, setActiveModule] = useState<Module>(null);
  const [progress, setProgress] = useState<Progress>(emptyProgress);
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [bootstrapLoadState, setBootstrapLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [bootstrapError, setBootstrapError] = useState("");
  const [toast, setToast] = useState("");
  const [busy, setBusy] = useState(false);
  const [redeemCode, setRedeemCode] = useState("");
  const [paywall, setPaywall] = useState<{ reason: PaywallReason; returnContext: Record<string, unknown>; policyId?: string; triggerEvent?: string; copy?: { eyebrow?: string; title?: string; detail?: string } } | null>(null);
  const [essayReference, setEssayReference] = useState(false);
  const [hideKeywords, setHideKeywords] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [profileDraft, setProfileDraft] = useState<ExamProfile>({ onboarded: false, dailyMinutes: 30, targets: [] });
  const [onboardingBankCode, setOnboardingBankCode] = useState("");
  const [diagnosticPromptOpen, setDiagnosticPromptOpen] = useState(false);
  const [bonusExpanded, setBonusExpanded] = useState(false);
  const [bonusDrillOffset, setBonusDrillOffset] = useState(0);
  const [todayGainExpanded, setTodayGainExpanded] = useState(false);
  const [campaignVisibility, setCampaignVisibility] = useState<Record<string, boolean>>({});
  const [campaignNow] = useState(() => Date.now());
  const [bankFilter, setBankFilter] = useState("适合我");
  const [essayLibraryPapers, setEssayLibraryPapers] = useState<EssayLibraryPaper[]>([]);
  const [essayLibraryLoading, setEssayLibraryLoading] = useState(false);
  const [essayLibraryLoaded, setEssayLibraryLoaded] = useState(false);
  const [essayLibraryError, setEssayLibraryError] = useState("");
  const [essayLibraryPage, setEssayLibraryPage] = useState(0);
  const [essayLibraryTotal, setEssayLibraryTotal] = useState(0);
  const [essayLibraryLoadingMore, setEssayLibraryLoadingMore] = useState(false);
  const [essayLibraryInitialPaperId, setEssayLibraryInitialPaperId] = useState<string | undefined>(undefined);
  const [essayLibraryInitialQuestionId, setEssayLibraryInitialQuestionId] = useState<string | undefined>(undefined);
  const [copyrightContactEmail, setCopyrightContactEmail] = useState("");
  const [copyrightContactLoading, setCopyrightContactLoading] = useState(false);
  const [supportInfo, setSupportInfo] = useState<SupportInfo | null>(null);
  const [supportInfoLoading, setSupportInfoLoading] = useState(false);
  const [practiceQuestions, setPracticeQuestions] = useState<PracticeQuestion[]>([]);
  const [practiceIndex, setPracticeIndex] = useState(0);
  const [practiceMode, setPracticeMode] = useState<PracticeMode>("mixed");
  const [selectedAnswer, setSelectedAnswer] = useState<number | null>(null);
  const [feedback, setFeedback] = useState<AnswerFeedback | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [answerConfidence, setAnswerConfidence] = useState<AnswerConfidence>("");
  const [contentReportDraft, setContentReportDraft] = useState<ContentReportDraft | null>(null);
  const [contentReportSubmitting, setContentReportSubmitting] = useState(false);
  const [online, setOnline] = useState(true);
  const [pendingPracticeAttempts, setPendingPracticeAttempts] = useState<QueuedPracticeAttempt[]>([]);
  const [pendingQueueDurable, setPendingQueueDurable] = useState(true);
  const [questionSeconds, setQuestionSeconds] = useState(0);
  const [sessionAnswered, setSessionAnswered] = useState(0);
  const [sessionCorrect, setSessionCorrect] = useState(0);
  const [sessionReviewAdded, setSessionReviewAdded] = useState(0);
  const [sessionWrongQuestions, setSessionWrongQuestions] = useState<Question[]>([]);
  const [practiceEmpty, setPracticeEmpty] = useState(false);
  const [practiceKind, setPracticeKind] = useState<PracticeKind>("daily");
  const [practiceBankCodes, setPracticeBankCodes] = useState<string[]>([]);
  const [practiceComposition, setPracticeComposition] = useState<PracticeComposition>({ due: 0, weak: 0, new: 0, primary: 0, other: 0, byBank: [] });
  const [practiceSummary, setPracticeSummary] = useState<PracticeSummary | null>(null);
  const [serverDailyPracticeCompleted, setServerDailyPracticeCompleted] = useState(false);
  const [sessionElapsedSeconds, setSessionElapsedSeconds] = useState(0);
  const [eventFormOpen, setEventFormOpen] = useState(false);
  const [eventDraft, setEventDraft] = useState({ targetCode: "", eventType: "报名截止", title: "报名截止", eventDate: "", reminderDays: 3, sourceUrl: "" });
  const [editingEventId, setEditingEventId] = useState("");
  const [focusedEventId, setFocusedEventId] = useState("");
  const [radarMode, setRadarMode] = useState<RadarMode>("notices");
  const [radarPositions, setRadarPositions] = useState<JobPosition[]>([]);
  const [radarPositionsLoading, setRadarPositionsLoading] = useState(false);
  const [radarKeyword, setRadarKeyword] = useState("");
  const [radarTargetFilter, setRadarTargetFilter] = useState("");
  const [radarPage, setRadarPage] = useState(1);
  const [radarTotal, setRadarTotal] = useState(0);
  const [radarLimited, setRadarLimited] = useState(false);
  const [comparePositions, setComparePositions] = useState<JobPosition[]>([]);
  const [essayPracticeQuestions, setEssayPracticeQuestions] = useState<EssayPracticeQuestion[]>([]);
  const [essayPracticeIndex, setEssayPracticeIndex] = useState(0);
  const [essayPracticeLoading, setEssayPracticeLoading] = useState(false);
  const [essayCompletesDaily, setEssayCompletesDaily] = useState(true);
  const [essayElapsedSeconds, setEssayElapsedSeconds] = useState(0);
  const [signInHref, setSignInHref] = useState(() => signInHrefFor("/"));
  const trackedUserRef = useRef("");
  const reportViewTrackedRef = useRef("");
  const reminderShownRef = useRef("");
  const progressRef = useRef<Progress>(emptyProgress);
  const progressVersionRef = useRef(0);
  const progressGenerationRef = useRef(0);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const resumeAfterPaywallRef = useRef<null | (() => void | Promise<void>)>(null);
  const retryPendingPracticeRef = useRef<(attempt: QueuedPracticeAttempt) => void>(() => undefined);
  const autoRetriedPracticeKeyRef = useRef("");
  const pendingPracticeAttemptsRef = useRef<QueuedPracticeAttempt[]>([]);
  const radarRequestSequenceRef = useRef(0);
  const essayLibraryReturnTabRef = useRef<"today" | "banks" | "resources">("resources");
  const inviteBindingRef = useRef("");
  const bootstrapRetryAttemptRef = useRef(0);
  const bootstrapRetryTimerRef = useRef<number | null>(null);
  const campaignEvaluationRef = useRef<Record<string, string>>({});
  const campaignVisibilityRef = useRef<Record<string, boolean>>({});
  const loadBootstrapRef = useRef<() => Promise<void>>(async () => undefined);

  const practiceDays = bootstrap?.content.practiceDays ?? [];
  const dayKey = bootstrap?.todayKey ?? localChinaDateKey();
  const scheduledDay = practiceDays.find((item) => item.date === dayKey);
  const day = scheduledDay ?? practiceDays[contentDayIndex(dayKey, practiceDays.length)] ?? practiceDays[0] ?? (bootstrap ? emptyPublishedDay : loadingDay);
  const insights = bootstrap?.studyInsights ?? emptyInsights;
  const profile = bootstrap?.examProfile ?? profileDraft;
  const dailyQueue = bootstrap?.dailyQueue ?? [];
  const todayQueueItems = dailyQueue.filter((item) => item.dateKey === dayKey);
  const todayBankFocusItems = todayQueueItems.filter((item) => item.itemType === "bank_practice" && item.status === "scheduled");
  const todayEssayQueueItem = todayQueueItems.find((item) => item.itemType === "essay_reference") ?? null;
  const todayEssayReferenceItem = todayEssayQueueItem?.status === "scheduled" ? todayEssayQueueItem : null;
  const queuedBankCodes = todayBankFocusItems.map((item) => item.sourceId);
  const examNotices = bootstrap?.content.examNotices ?? [];
  const strategyConfig = bootstrap?.content.strategyConfig;
  const drillPresets = normalizeDrillPresets(bootstrap?.content.drillPresets);
  const resourceCards = bootstrap?.content.resourceCards ?? [];
  const primaryResourceCard = resourceCards.find((card) => card.placement === "primary") ?? null;
  const supportResourceCards = resourceCards.filter((card) => card.placement === "support");
  const campaignSlots = bootstrap?.content.campaignSlots ?? [];
  const activeTargetCodes = new Set(profile.targets.map((target) => target.code));
  const relevantNotices = examNotices
    .filter((notice) => !profile.targets.length || activeTargetCodes.has(notice.targetCode))
    .sort((a, b) => b.publishDate.localeCompare(a.publishDate));
  const relevantPositions = radarPositions
    .filter((position) => !profile.targets.length || activeTargetCodes.has(position.targetCode))
    .sort((a, b) => a.targetLabel.localeCompare(b.targetLabel) || a.department.localeCompare(b.department));
  const dailySessionForPlan = progress.activePractice?.dateKey === dayKey && progress.activePractice.kind === "daily"
    ? progress.activePractice
    : null;
  const todayPlanMinutes = dailySessionForPlan?.planMinutes ?? progress.planOverrides[dayKey] ?? profile.dailyMinutes;
  const dailyPlan = buildDailyPlan(todayPlanMinutes, bootstrap?.content.access === "preview", strategyConfig);
  const datedTargets = profile.targets
    .map((target) => ({ target, days: daysLeft(target.examDate) }))
    .filter((item): item is { target: ExamTarget; days: number } => item.days !== null)
    .sort((a, b) => a.days - b.days);
  const nextExam = datedTargets[0] ?? null;
  const hasExtendedMembership = Boolean(bootstrap?.ledger.some((item) => item.source_type !== "trial"));
  const addedBanks = bootstrap?.questionBanks.filter((bank) => bank.added) ?? [];
  const availableProvinces = Array.from(new Set([
    ...defaultProvinces,
    ...(bootstrap?.questionBanks ?? []).map((bank) => bank.province).filter((province) => defaultProvinces.includes(province)),
    ...profile.targets.map((target) => target.province).filter((province) => defaultProvinces.includes(province)),
  ]));
  const activeLearningBanks = addedBanks.filter((bank) => bank.subject !== "申论" && bank.practiceAvailable !== false);
  const activeEssayBanks = addedBanks.filter((bank) => bank.subject === "申论" && bank.practiceAvailable !== false);
  const hasMorningContent = day.morning.paragraphs.length > 0 || Boolean(day.morning.lead.trim());
  const hasEssayContent = activeEssayBanks.some((bank) => (bank.availableEssayCount ?? bank.questionCount) > 0)
    || Boolean(bootstrap?.dueEssayRewrites?.length) || Boolean(todayEssayReferenceItem);
  const primaryTarget = profile.targets[0] ?? null;
  const campaignAudienceMatches = (campaign: CampaignSlot) => campaign.audience === "all"
    || (campaign.audience === "new_user" && !bootstrap?.firstCompletedPractice)
    || (campaign.audience === "member" && Boolean(bootstrap?.user.membershipActive))
    || (campaign.audience === "non_member" && !bootstrap?.user.membershipActive)
    || (campaign.audience === "multi_exam" && profile.targets.length > 1)
    || (campaign.audience === "first_practice_done" && Boolean(bootstrap?.firstCompletedPractice));
  const todayCampaign = campaignSlots.find((campaign) => campaign.slot === "today_after_alerts"
    && campaignAudienceMatches(campaign)
    && (!campaign.endAt || Number.isNaN(Date.parse(campaign.endAt)) || Date.parse(campaign.endAt) > campaignNow)) ?? null;
  const resourcesCampaign = campaignSlots.find((campaign) => campaign.slot === "resources_after_primary"
    && campaignAudienceMatches(campaign)
    && (!campaign.endAt || Number.isNaN(Date.parse(campaign.endAt)) || Date.parse(campaign.endAt) > campaignNow)) ?? null;
  const meCampaign = campaignSlots.find((campaign) => campaign.slot === "me_benefits"
    && campaignAudienceMatches(campaign)
    && (!campaign.endAt || Number.isNaN(Date.parse(campaign.endAt)) || Date.parse(campaign.endAt) > campaignNow)) ?? null;
  const validLearningBanks = activeLearningBanks.filter((bank) => profile.targets.some((target) => bankCanPowerDailyPractice(target, bank)));
  const savedPrimaryBank = validLearningBanks.find((bank) => bank.code === progress.primaryBankCode);
  const primaryBank = savedPrimaryBank
    ?? validLearningBanks.find((bank) => primaryTarget && bankCanPowerDailyPractice(primaryTarget, bank))
    ?? validLearningBanks[0]
    ?? null;
  const orderedBankCodes = validLearningBanks.map((bank) => bank.code).sort((a, b) => Number(b === primaryBank?.code) - Number(a === primaryBank?.code));
  const bankConfigGaps = profile.targets.filter((target) => !validLearningBanks.some((bank) => bankCanPowerDailyPractice(target, bank)));
  // 未完成首次配置时也不能让旧的本地完成标记伪装成一套可执行日练。
  // 新服务端直接给出“有效权益题库内的不重复真题数”；旧服务端才回退到题库存在性。
  const dailyConfigurationBlocking = Boolean(bootstrap && dailyPlan.questionCount > 0
    && (bootstrap.dailyReadiness ? !bootstrap.dailyReadiness.ready : validLearningBanks.length === 0));
  const dailyReadinessCount = bootstrap?.dailyReadiness?.distinctQuestionCount ?? 0;
  const dailyReadinessRequired = bootstrap?.dailyReadiness?.requiredQuestionCount ?? 5;
  const targetSummary = profile.targets.length
    ? `${profile.targets.slice(0, 3).map((target) => target.label).join("＋")}${profile.targets.length > 3 ? `等${profile.targets.length}项` : ""}`
    : "尚未设置报考目标";
  // 规范化打卡由服务端在真实 daily 会话完成后写入；旧 progress_json 中的
  // completed/checkins 不能单独让页面显示“已完成”。
  const practiceDone = serverDailyPracticeCompleted;
  const enabledDailySteps: DailyStep[] = [
    ...(dailyPlan.morningMinutes > 0 && hasMorningContent ? ["morning" as const] : []),
    ...(dailyPlan.questionCount > 0 && !dailyConfigurationBlocking ? ["practice" as const] : []),
    ...((dailyPlan.essayMinutes > 0 && hasEssayContent) || todayEssayQueueItem ? ["essay" as const] : []),
  ];
  const stepDone = {
    morning: Boolean(progress.completed[`${dayKey}-morning`]),
    practice: practiceDone,
    essay: Boolean(progress.completed[`${dayKey}-essay`]) || todayEssayQueueItem?.status === "completed",
  };
  const doneCount = enabledDailySteps.filter((step) => stepDone[step]).length;
  const dailyTasksDone = !dailyConfigurationBlocking && enabledDailySteps.length > 0 && doneCount === enabledDailySteps.length;
  const dailyCheckinDone = progress.checkins.includes(dayKey);
  const allDailyDone = dailyTasksDone && dailyCheckinDone;
  const nextDailyStep = enabledDailySteps.find((step) => !stepDone[step]) ?? null;
  const essayQuestion = essayPracticeQuestions[essayPracticeIndex] ?? null;
  const essayDraftKey = essayQuestion ? `essay:${essayQuestion.id}` : dayKey;
  const currentDueEssayRewrite = essayQuestion
    ? bootstrap?.dueEssayRewrites?.find((item) => item.questionCode === essayQuestion.id)
    : null;
  const essayAttemptDateKey = essayQuestion?.serverAttempt?.dateKey ?? currentDueEssayRewrite?.originalDateKey ?? dayKey;
  const essayStage = progress.essayStages[essayDraftKey]
    ?? (essayCompletesDaily && progress.completed[`${dayKey}-essay`] ? "completed" : "draft");
  const essayStageIndex = essayStageOrder[essayStage];
  const essayRewriteDue = progress.essayRewriteDue[essayDraftKey] ?? "";
  const essayRubric = strategyConfig?.essayRubric?.filter((item) => typeof item === "string" && item.trim()).slice(0, 8) ?? defaultEssayRubric;
  const audioWrongQuestions = Array.from(new Map([...(bootstrap?.wrongAudioQuestions ?? []), ...sessionWrongQuestions].map((question) => [question.id, question])).values());
  const currentPractice = practiceQuestions[practiceIndex];
  const currentPracticeSessionIdentity = progress.activePractice?.serverSessionId
    ?? progress.activePractice?.clientSessionId
    ?? `standalone-${dayKey}`;
  const currentPracticeAttemptKey = currentPractice ? `${currentPracticeSessionIdentity}:${currentPractice.id}` : "";
  const currentPendingPracticeAttempt = pendingPracticeAttempts.find((attempt) => attempt.key === currentPracticeAttemptKey) ?? null;
  const activeDailySession = dailySessionForPlan;
  const dailyRemaining = activeDailySession
    ? Math.max(0, activeDailySession.questionTarget - activeDailySession.answered)
    : dailyPlan.questionCount;
  const calendarEvents = useMemo(() => {
    const activeTargetCodes = new Set(profile.targets.map((target) => target.code));
    const official = (bootstrap?.content.examEvents ?? [])
      .filter((event) => activeTargetCodes.has(event.targetCode))
      .map((event) => ({ ...event, reminderEnabled: true }));
    const explicit = progress.examEvents.filter((event) => activeTargetCodes.has(event.targetCode));
    const automatic = profile.targets.flatMap((target) => {
      if (!target.examDate || [...official, ...explicit].some((event) => event.targetCode === target.code && event.eventDate === target.examDate && event.eventType === "笔试")) return [];
      return [{
        id: `exam-${target.code}-${target.examDate}`,
        targetCode: target.code,
        targetLabel: target.label,
        eventType: "笔试",
        title: `${target.label}笔试`,
        eventDate: target.examDate,
        reminderDays: 7,
        reminderEnabled: true,
        sourceUrl: "",
      } satisfies ExamEvent];
    });
    return [...official, ...explicit, ...automatic].sort((a, b) => a.eventDate.localeCompare(b.eventDate) || a.title.localeCompare(b.title));
  }, [bootstrap?.content.examEvents, profile.targets, progress.examEvents]);
  const upcomingCalendarEvents = calendarEvents
    .map((event) => ({ ...event, days: eventDaysLeft(event.eventDate, dayKey) }))
    .filter((event) => event.days >= 0)
    .sort((a, b) => a.days - b.days || a.eventDate.localeCompare(b.eventDate));
  const nextCalendarEvent = upcomingCalendarEvents[0] ?? null;
  const dueReminder = upcomingCalendarEvents.find((event) => event.reminderEnabled && event.days <= event.reminderDays) ?? null;
  const criticalReminder = upcomingCalendarEvents.find((event) =>
    event.reminderEnabled
    && event.days <= 1
    && /报名截止|缴费截止|准考证打印|资格审查/.test(`${event.eventType}${event.title}`)
    && !progress.radarTodoDone[`event:${event.id}`]) ?? null;
  const savedPositions = relevantPositions.filter((position) => progress.savedPositionIds.includes(position.id));
  const savedPositionCount = progress.savedPositionIds.length;
  const matchedPositions = relevantPositions
    .map((position) => ({ position, match: matchPosition(position, progress.candidateProfile), saved: progress.savedPositionIds.includes(position.id) }))
    .sort((a, b) => b.match.score - a.match.score || Number(b.saved) - Number(a.saved) || b.position.recruitCount - a.position.recruitCount);
  const comparisonPositions = comparePositions
    .map((position) => ({ position, match: matchPosition(position, progress.candidateProfile) }))
    .slice(0, 3);
  const candidateProfileMissing = !progress.candidateProfile.education || !progress.candidateProfile.major || !progress.candidateProfile.freshStatus;
  const radarTodoItems = [
    ...(candidateProfileMissing ? [{ id: "profile:complete", kind: "profile" as const, title: "完善我的报考条件", detail: "至少补全学历、专业和应届/往届信息，以提高职位初筛准确度。", tone: "urgent" as const, actionLabel: "完善信息" }] : []),
    ...upcomingCalendarEvents.slice(0, 4).map((event) => ({
      id: `event:${event.id}`,
      kind: "event" as const,
      title: `${event.targetLabel} · ${event.title}`,
      detail: event.days === 0 ? "今天处理，优先级最高。" : `${shortDate(event.eventDate)} · 还有${event.days}天 · 提前${event.reminderDays}天提醒`,
      tone: event.days <= event.reminderDays ? "urgent" as const : "normal" as const,
      actionLabel: event.id.startsWith("exam-") ? "修改日期" : event.sourceUrl ? "查看来源" : "查看",
    })),
    ...relevantNotices.slice(0, 2).map((notice) => ({
      id: `notice:${notice.id}`,
      kind: "notice" as const,
      title: `${notice.targetLabel} · ${notice.noticeType}`,
      detail: notice.title,
      tone: "normal" as const,
      actionLabel: "看公告",
    })),
    ...savedPositions.slice(0, 3).map((position) => ({
      id: `position:${position.id}`,
      kind: "position" as const,
      title: `核对备选岗位 · ${position.title}`,
      detail: `${position.targetLabel} · ${position.department}${position.region ? ` · ${position.region}` : ""}`,
      tone: "normal" as const,
      actionLabel: "核对信息",
    })),
  ].slice(0, 8);
  const streak = checkinStreak(progress.checkins, dayKey);
  const currentWeekCheckinKeys = weekDateKeys(dayKey);
  const nextStreakMilestone = [7, 14, 30, 60, 100, 180, 365].find((value) => value > streak) ?? Math.ceil((streak + 1) / 100) * 100;

  const notify = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2600);
  }, []);

  const trackEvent = useCallback((eventName: string, eventData: Record<string, unknown> = {}) => {
    void fetch("/api/app", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "trackEvent", eventName, eventData }), keepalive: true }).catch(() => undefined);
  }, []);

  const api = useCallback(async <T,>(payload: Record<string, unknown>, options: { signal?: AbortSignal } = {}) => {
    for (let requestNumber = 1; requestNumber <= BOOTSTRAP_MAX_REQUESTS; requestNumber += 1) {
      const response = await fetch("/api/app", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: options.signal });
      let data: T & { error?: string; code?: string; retryAction?: boolean };
      try {
        data = await response.json() as T & { error?: string; code?: string; retryAction?: boolean };
      } catch {
        data = {} as T & { error?: string; code?: string; retryAction?: boolean };
      }
      // The server emits this signal only before entering a business handler.
      // Replaying the same payload is therefore safe and lets the newly issued
      // opaque session cookie isolate identity work from the action's queries.
      if (response.status === 409 && data.code === "IDENTITY_PREPARING" && data.retryAction) {
        if (requestNumber < BOOTSTRAP_MAX_REQUESTS) continue;
        throw Object.assign(new Error("账号初始化未完成，请稍后重试"), { status: response.status, data });
      }
      if (!response.ok) throw Object.assign(new Error(data.error || "操作失败，请稍后再试"), { status: response.status, data });
      return data;
    }
    throw new Error("账号初始化未完成，请稍后重试");
  }, []);

  const addQueueItem = useCallback(async (itemType: DailyQueueItem["itemType"], sourceId: string) => {
    const result = await api<{ item: DailyQueueItem | null; scheduledDate: string; scheduledToday?: boolean; duplicate?: boolean }>({
      action: "addTodayItem",
      itemType,
      sourceId,
    });
    if (result.item) {
      setBootstrap((current) => current ? {
        ...current,
        dailyQueue: [
          ...(current.dailyQueue ?? []).filter((item) => item.id !== result.item?.id),
          result.item,
        ].sort((a, b) => a.dateKey.localeCompare(b.dateKey) || a.sortOrder - b.sortOrder),
      } : current);
    }
    const when = result.scheduledDate === localChinaDateKey() ? "今日计划" : `${shortDate(result.scheduledDate)}计划`;
    notify(result.duplicate ? `已在${when}中` : `已加入${when}`);
    trackEvent("today_item_add", { itemType, sourceId, scheduledDate: result.scheduledDate, duplicate: Boolean(result.duplicate) });
    return result;
  }, [api, notify, trackEvent]);

  const updateQueueItem = useCallback(async (id: string, status: "completed" | "removed") => {
    await api({ action: "updateTodayItem", id, status });
    setBootstrap((current) => current ? {
      ...current,
      dailyQueue: status === "removed"
        ? (current.dailyQueue ?? []).filter((item) => item.id !== id)
        : (current.dailyQueue ?? []).map((item) => item.id === id ? { ...item, status: "completed", completedAt: new Date().toISOString() } : item),
    } : current);
    trackEvent("today_item_update", { id, status });
    notify(status === "completed" ? "已完成今日查阅" : "已从计划中移除");
  }, [api, notify, trackEvent]);

  const upsertPendingPracticeAttempt = useCallback((attempt: QueuedPracticeAttempt) => {
    const next = [...pendingPracticeAttemptsRef.current.filter((item) => item.key !== attempt.key), attempt].slice(-MAX_PENDING_PRACTICE_ATTEMPTS);
    pendingPracticeAttemptsRef.current = next;
    setPendingPracticeAttempts(next);
    setPendingQueueDurable(writePendingPracticeAttempts(next));
  }, []);

  const removePendingPracticeAttempt = useCallback((attemptKey: string) => {
    const next = pendingPracticeAttemptsRef.current.filter((item) => item.key !== attemptKey);
    pendingPracticeAttemptsRef.current = next;
    setPendingPracticeAttempts(next);
    setPendingQueueDurable(writePendingPracticeAttempts(next));
    if (autoRetriedPracticeKeyRef.current === attemptKey) autoRetriedPracticeKeyRef.current = "";
  }, []);

  const loadEssayReferenceLibrary = useCallback(async (force = false, requestedPage = 1) => {
    if (essayLibraryLoading || essayLibraryLoadingMore || (requestedPage === 1 && essayLibraryLoaded && !force)) return;
    if (requestedPage > 1) setEssayLibraryLoadingMore(true);
    else setEssayLibraryLoading(true);
    setEssayLibraryError("");
    try {
      const data = await api<EssayReferenceLibraryResponse>({ action: "getEssayReferenceLibrary", page: requestedPage, pageSize: 50 });
      const incoming = Array.isArray(data.papers) ? data.papers : [];
      setEssayLibraryPapers((current) => {
        if (requestedPage === 1) return incoming;
        const merged = new Map(current.map((paper) => [String(paper.id), paper]));
        incoming.forEach((paper) => merged.set(String(paper.id), { ...merged.get(String(paper.id)), ...paper }));
        return [...merged.values()];
      });
      setEssayLibraryPage(Number(data.page ?? requestedPage));
      setEssayLibraryTotal(Math.max(0, Number(data.total ?? incoming.length)));
      setCopyrightContactEmail(
        String(data.contactEmail ?? data.copyrightContactEmail ?? data.settings?.copyrightContactEmail ?? "").trim(),
      );
      setEssayLibraryLoaded(true);
    } catch (error) {
      setEssayLibraryError(error instanceof Error ? error.message : "资料库加载失败，请稍后重试");
    } finally {
      setEssayLibraryLoading(false);
      setEssayLibraryLoadingMore(false);
    }
  }, [api, essayLibraryLoaded, essayLibraryLoading, essayLibraryLoadingMore]);

  const loadEssayPaperDetail = useCallback(async (paperId: string) => {
    const existing = essayLibraryPapers.find((paper) => String(paper.id) === String(paperId));
    if (Array.isArray(existing?.questions) && Array.isArray(existing?.materials)) {
      const url = new URL(window.location.href);
      url.searchParams.set("essayPaper", String(existing.code ?? paperId));
      window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
      trackEvent("essay_reference_paper_open", { paperId, cached: true });
      return;
    }
    try {
      const data = await api<EssayReferenceLibraryResponse>({ action: "getEssayReferenceLibrary", paperId });
      const detail = data.papers?.[0];
      if (!detail) throw new Error("该试卷暂时不可用，请返回后重试");
      setEssayLibraryPapers((current) => current.map((paper) => (
        String(paper.id) === String(paperId) ? { ...paper, ...detail } : paper
      )));
      const paperKey = String(detail.code ?? existing?.code ?? paperId);
      const url = new URL(window.location.href);
      url.searchParams.set("essayPaper", paperKey);
      window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
      trackEvent("essay_reference_paper_open", { paperId, cached: false });
    } catch (error) {
      notify(error instanceof Error ? error.message : "试卷详情加载失败，请稍后重试");
      throw error;
    }
  }, [api, essayLibraryPapers, notify, trackEvent]);

  const loadCopyrightSettings = useCallback(async () => {
    setCopyrightContactLoading(true);
    try {
      const data = await api<EssayReferenceLibraryResponse>({ action: "getEssayReferenceLibrary", settingsOnly: true });
      setCopyrightContactEmail(String(data.contactEmail ?? "").trim());
    } catch {
      setCopyrightContactEmail("");
    } finally {
      setCopyrightContactLoading(false);
    }
  }, [api]);

  const loadSupportInfo = useCallback(async () => {
    setSupportInfoLoading(true);
    try {
      setSupportInfo(await api<SupportInfo>({ action: "getSupportInfo" }));
    } catch {
      setSupportInfo(null);
    } finally {
      setSupportInfoLoading(false);
    }
  }, [api]);

  useEffect(() => {
    const visibleSlots: Array<[CampaignSlot["slot"], CampaignSlot | null]> = [
      ["today_after_alerts", tab === "today" ? todayCampaign : null],
      ["resources_after_primary", tab === "resources" ? resourcesCampaign : null],
      ["me_benefits", tab === "me" ? meCampaign : null],
    ];
    for (const [slot, campaign] of visibleSlots) {
      if (!campaign) {
        // Clear only the slot signature. The cached decision is intentionally
        // retained so the same campaign can reappear when its audience becomes
        // eligible again without being counted as a second impression.
        campaignEvaluationRef.current[slot] = "";
        continue;
      }
      const visibilityKey = campaign.id;
      const signature = [campaign.id, campaign.maxPerDay, campaign.cooldownHours, campaign.hideAfterCompleteDays, campaign.endAt, campaign.audience].join(":");
      if (campaignEvaluationRef.current[slot] === signature) continue;
      campaignEvaluationRef.current[slot] = signature;
      if (Object.prototype.hasOwnProperty.call(campaignVisibilityRef.current, visibilityKey)) continue;
      let visible = true;
      try {
        const storageKey = `gongkao-rilian:campaign:${campaign.id}`;
        const stored = JSON.parse(window.localStorage.getItem(storageKey) ?? "{}") as { day?: string; dayCount?: number; lastAt?: number; completedAt?: number };
        const decision = resolveCampaignDisplay(stored, campaign, Date.now(), localChinaDateKey());
        visible = decision.visible;
        if (visible) window.localStorage.setItem(storageKey, JSON.stringify(decision.nextRecord));
      } catch { visible = true; }
      campaignVisibilityRef.current = { ...campaignVisibilityRef.current, [visibilityKey]: visible };
      setCampaignVisibility(campaignVisibilityRef.current);
      if (visible) trackEvent("campaign_impression", { campaignId: campaign.id, slot: campaign.slot, audience: campaign.audience });
    }
  }, [meCampaign, resourcesCampaign, tab, todayCampaign, trackEvent]);

  const clearEssayPaperLink = useCallback(() => {
    setEssayLibraryInitialPaperId(undefined);
    setEssayLibraryInitialQuestionId(undefined);
    const url = new URL(window.location.href);
    url.searchParams.delete("essayPaper");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);

  const shareEssayReferencePaper = useCallback(async (paper: EssayReferencePaper) => {
    const url = new URL(window.location.href);
    url.searchParams.set("essayPaper", String(paper.code ?? paper.id));
    const shareUrl = url.toString();
    const text = `${paper.region}-${paper.year} ${paper.volumeType}申论真题及参考答案`;
    try {
      if (typeof window.navigator.share === "function") {
        await window.navigator.share({ title: paper.title, text, url: shareUrl });
        trackEvent("essay_reference_share", { paperId: paper.id, method: "native" });
        return;
      }
      await copyPlainText(`${paper.title}\n${shareUrl}`);
      notify("试卷链接已复制");
      trackEvent("essay_reference_share", { paperId: paper.id, method: "clipboard" });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      try {
        await copyPlainText(`${paper.title}\n${shareUrl}`);
        notify("试卷链接已复制");
        trackEvent("essay_reference_share", { paperId: paper.id, method: "clipboard_fallback" });
      } catch {
        notify("当前浏览器暂时无法分享，请稍后重试");
      }
    }
  }, [notify, trackEvent]);

  const closeEssayReferenceLibrary = useCallback(() => {
    clearEssayPaperLink();
    const returnTab = essayLibraryReturnTabRef.current;
    if (returnTab === "banks") setBankFilter("申论");
    setTab(returnTab);
  }, [clearEssayPaperLink]);

  const navigateFromBottom = useCallback((nextTab: Tab) => {
    if (tab === "essayLibrary") clearEssayPaperLink();
    setTab(nextTab);
    trackEvent("module_open", { module: nextTab, entry: "bottom_nav" });
  }, [clearEssayPaperLink, tab, trackEvent]);

  const openEssayReferenceLibrary = useCallback((returnTab: "today" | "banks" | "resources" = "resources") => {
    essayLibraryReturnTabRef.current = returnTab;
    setActiveModule(null);
    setTab("essayLibrary");
    trackEvent("essay_reference_library_open", { entry: returnTab === "banks" ? "essay_bank_filter" : "resources_primary" });
    void loadEssayReferenceLibrary(true, 1);
  }, [loadEssayReferenceLibrary, trackEvent]);

  const openCopyrightNotice = useCallback(() => {
    setActiveModule(null);
    setTab("copyright");
    void loadCopyrightSettings();
  }, [loadCopyrightSettings]);

  const addBankToToday = useCallback(async (bank: QuestionBank) => {
    if (busy) return;
    setBusy(true);
    try { await addQueueItem("bank_practice", bank.code); }
    catch (error) { notify(error instanceof Error ? error.message : "加入计划失败"); }
    finally { setBusy(false); }
  }, [addQueueItem, busy, notify]);

  const addEssayQuestionToToday = useCallback(async (_paper: EssayReferencePaper, question: EssayReferenceQuestion) => {
    try { return await addQueueItem("essay_reference", String(question.id)); }
    catch (error) { notify(error instanceof Error ? error.message : "加入计划失败"); }
  }, [addQueueItem, notify]);

  const openQueuedEssayItem = useCallback(async (item: DailyQueueItem) => {
    if (!item.sourceParentId) return notify("该申论资料暂时无法打开");
    essayLibraryReturnTabRef.current = "today";
    setEssayLibraryLoading(true);
    setEssayLibraryError("");
    setEssayLibraryInitialPaperId(item.sourceParentId);
    setEssayLibraryInitialQuestionId(item.sourceId);
    setActiveModule(null);
    setTab("essayLibrary");
    try {
      const data = await api<EssayReferenceLibraryResponse>({ action: "getEssayReferenceLibrary", paperId: item.sourceParentId });
      const detail = data.papers?.[0];
      if (!detail) throw new Error("该试卷暂时不可用");
      setEssayLibraryPapers((current) => {
        const merged = new Map(current.map((paper) => [String(paper.id), paper]));
        merged.set(String(detail.id), { ...merged.get(String(detail.id)), ...detail });
        return [...merged.values()];
      });
      setEssayLibraryLoaded(true);
      trackEvent("essay_reference_library_open", { entry: "today_plan", questionId: item.sourceId });
    } catch (error) {
      setEssayLibraryError(error instanceof Error ? error.message : "资料加载失败");
      notify(error instanceof Error ? error.message : "资料加载失败");
    } finally { setEssayLibraryLoading(false); }
  }, [api, notify, trackEvent]);

  const openSupportNotice = useCallback(() => {
    setActiveModule(null);
    setTab("support");
    void loadSupportInfo();
  }, [loadSupportInfo]);

  const loadEssayReferenceDeepLink = useCallback(async (paperCode: string, signal?: AbortSignal) => {
    essayLibraryReturnTabRef.current = "resources";
    setActiveModule(null);
    setTab("essayLibrary");
    setEssayLibraryLoading(true);
    setEssayLibraryError("");
    try {
      const [catalog, detailData] = await Promise.all([
        api<EssayReferenceLibraryResponse>({ action: "getEssayReferenceLibrary", page: 1, pageSize: 50 }, { signal }),
        api<EssayReferenceLibraryResponse>({ action: "getEssayReferenceLibrary", paperCode }, { signal }),
      ]);
      const detail = detailData.papers?.[0];
      if (!detail) throw new Error("分享的试卷暂时不可用");
      const catalogPapers = Array.isArray(catalog.papers) ? catalog.papers : [];
      const merged = new Map(catalogPapers.map((paper) => [String(paper.id), paper]));
      merged.set(String(detail.id), { ...merged.get(String(detail.id)), ...detail });
      setEssayLibraryPapers([...merged.values()]);
      setEssayLibraryInitialPaperId(String(detail.id));
      setEssayLibraryPage(Number(catalog.page ?? 1));
      setEssayLibraryTotal(Math.max(Number(catalog.total ?? catalogPapers.length), merged.size));
      setCopyrightContactEmail(String(catalog.contactEmail ?? detailData.contactEmail ?? "").trim());
      setEssayLibraryLoaded(true);
      trackEvent("essay_reference_deep_link_open", { paperCode, paperId: detail.id });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setEssayLibraryError(error instanceof Error ? error.message : "分享的试卷加载失败");
    } finally {
      if (!signal?.aborted) setEssayLibraryLoading(false);
    }
  }, [api, trackEvent]);

  useEffect(() => {
    const paperCode = new URLSearchParams(window.location.search).get("essayPaper")?.trim() ?? "";
    if (!paperCode) return;
    const controller = new AbortController();
    queueMicrotask(() => {
      if (!controller.signal.aborted) void loadEssayReferenceDeepLink(paperCode, controller.signal);
    });
    return () => controller.abort();
  }, [loadEssayReferenceDeepLink]);

  const shareThreeDayReport = useCallback(async () => {
    const report = bootstrap?.studyInsights;
    if (!report || report.weekly.activeDays < 3) return;
    const summary = threeDayReportShareText(report);
    const shareUrl = `${window.location.origin}/?from=three-day-report`;
    try {
      if (typeof window.navigator.share === "function") {
        await window.navigator.share({ title: "公考日练 · 3天体验报告", text: summary, url: shareUrl });
        trackEvent("three_day_report_share", { method: "native", activeDays: report.weekly.activeDays, questionCount: report.weekly.total });
        notify("学习摘要已分享");
        return;
      }
      await copyPlainText(`${summary}\n${shareUrl}`);
      trackEvent("three_day_report_share", { method: "clipboard", activeDays: report.weekly.activeDays, questionCount: report.weekly.total });
      notify("学习摘要已复制");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      try {
        await copyPlainText(`${summary}\n${shareUrl}`);
        trackEvent("three_day_report_share", { method: "clipboard_fallback", activeDays: report.weekly.activeDays, questionCount: report.weekly.total });
        notify("学习摘要已复制");
      } catch {
        notify("当前浏览器无法分享，请稍后再试");
      }
    }
  }, [bootstrap?.studyInsights, notify, trackEvent]);

  const loadBootstrap = useCallback(async () => {
    setBootstrapLoadState("loading");
    setBootstrapError("");
    try {
      let response: Response | undefined;
      let data: (Bootstrap & { error?: string; retryBootstrap?: boolean; bootstrapStage?: string }) | undefined;
      for (let requestNumber = 1; requestNumber <= BOOTSTRAP_MAX_REQUESTS; requestNumber += 1) {
        response = await fetch("/api/app", { cache: "no-store" });
        data = await response.json() as Bootstrap & { error?: string; retryBootstrap?: boolean; bootstrapStage?: string };
        const retryDecision = bootstrapRetryDecision(requestNumber, response.ok, Boolean(data.retryBootstrap));
        if (retryDecision === "retry") continue;
        if (retryDecision === "exhausted") {
          throw new Error("账号初始化未完成，请稍后刷新");
        }
        break;
      }
      if (!response || !data) throw new Error("加载失败");
      if (!response.ok) throw new Error(data.error || "加载失败");
      if (data.retryBootstrap) throw new Error("账号初始化未完成，请稍后刷新");
      if (bootstrapRetryTimerRef.current) window.clearTimeout(bootstrapRetryTimerRef.current);
      bootstrapRetryTimerRef.current = null;
      bootstrapRetryAttemptRef.current = 0;
      setBootstrapLoadState("ready");
      setBootstrap({ ...data, dailyQueue: Array.isArray(data.dailyQueue) ? data.dailyQueue : [], reviewQueue: Array.isArray(data.reviewQueue) ? data.reviewQueue : [] });
      progressVersionRef.current = Number(data.progressVersion ?? 0);
      const mergedProgress = mergeProgress(data.progress);
      const nextProgress = data.dailyPracticeCompleted
        && mergedProgress.activePractice?.kind === "daily"
        && mergedProgress.activePractice.dateKey === data.todayKey
        ? { ...mergedProgress, activePractice: null }
        : mergedProgress;
      progressRef.current = nextProgress;
      setProgress(nextProgress);
      setServerDailyPracticeCompleted(Boolean(data.dailyPracticeCompleted));
      setProfileDraft({ ...data.examProfile, dailyMinutes: normalizePlanMinutes(data.examProfile.dailyMinutes) });
      setOnboardingOpen(!data.examProfile.onboarded);
      setSignInHref(signInHrefFor(currentSafeReturnPath()));
      const query = new URLSearchParams(window.location.search);
      const queryInvite = normalizedInviteCode(query.get("invite"));
      let pendingInvite = "";
      try {
        const stored = JSON.parse(window.sessionStorage.getItem(PENDING_INVITE_SESSION_KEY) ?? "null") as { code?: unknown; createdAt?: unknown } | null;
        if (stored && Number.isFinite(Number(stored.createdAt)) && Date.now() - Number(stored.createdAt) <= LOGIN_INTENT_TTL_MS) {
          pendingInvite = normalizedInviteCode(stored.code);
        } else window.sessionStorage.removeItem(PENDING_INVITE_SESSION_KEY);
      } catch {
        window.sessionStorage.removeItem(PENDING_INVITE_SESSION_KEY);
      }
      const inviteCode = queryInvite || pendingInvite;
      if (inviteCode && !data.user.signedIn) {
        try { window.sessionStorage.setItem(PENDING_INVITE_SESSION_KEY, JSON.stringify({ code: inviteCode, createdAt: Date.now() })); } catch { /* query remains available for login return */ }
      } else if (inviteCode && data.user.signedIn && inviteBindingRef.current !== inviteCode) {
        let consumedInvite = "";
        try { consumedInvite = normalizedInviteCode(window.sessionStorage.getItem(CONSUMED_INVITE_SESSION_KEY)); } catch { consumedInvite = ""; }
        try { window.sessionStorage.removeItem(PENDING_INVITE_SESSION_KEY); } catch { /* optional storage */ }
        if (query.has("invite")) {
          query.delete("invite");
          const nextQuery = query.toString();
          window.history.replaceState(null, "", `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ""}${window.location.hash}`);
        }
        if (consumedInvite !== inviteCode) {
          inviteBindingRef.current = inviteCode;
          try {
            window.sessionStorage.setItem(CONSUMED_INVITE_SESSION_KEY, inviteCode);
            window.sessionStorage.removeItem(PENDING_INVITE_SESSION_KEY);
          } catch { /* in-memory guard still prevents duplicate binding */ }
          try {
            const result = await api<{ message?: string }>({ action: "bindInvite", inviteCode });
            notify(result.message || "邀请关系已绑定");
          } catch (error) {
            notify(error instanceof Error ? error.message : "邀请关系绑定失败");
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "学习记录暂时无法加载";
      setBootstrapLoadState("error");
      setBootstrapError(message);
      notify(message);
      bootstrapRetryAttemptRef.current += 1;
      const delay = Math.min(30_000, 2_000 * (2 ** Math.min(4, bootstrapRetryAttemptRef.current - 1)));
      if (bootstrapRetryTimerRef.current) window.clearTimeout(bootstrapRetryTimerRef.current);
      bootstrapRetryTimerRef.current = window.setTimeout(() => void loadBootstrapRef.current(), delay);
    }
  }, [api, notify]);
  loadBootstrapRef.current = loadBootstrap;

  const openPaywall = useCallback((
    reason: PaywallReason,
    resume?: () => void | Promise<void>,
    returnContext: Record<string, unknown> = {},
  ) => {
    const triggerEvent = String(returnContext.paywallEvent ?? ({
      daily_limit: "free_daily_limit_hit",
      second_bank: "second_bank_attempt",
      essay: "essay_practice_attempt",
      radar: "radar_position_save_attempt",
      value_loop: "manual_benefits_open",
    } satisfies Record<PaywallReason, string>)[reason]);
    const policy = (bootstrap?.content.paywallPolicies ?? []).find((item) => item.triggerEvent === triggerEvent
      && (item.audience === "all" || item.audience === "non_member" || (item.audience === "new_user" && !bootstrap?.firstCompletedPractice)));
    let policyWithinFrequency = Boolean(policy);
    if (policy && typeof window !== "undefined" && triggerEvent !== "manual_benefits_open") {
      const key = `gongkao-rilian:paywall-policy:${policy.id}`;
      try {
        const stored = JSON.parse(window.localStorage.getItem(key) ?? "{}") as { day?: string; count?: number; lastAt?: number };
        const today = localChinaDateKey();
        const dayCount = stored.day === today ? Math.max(0, Number(stored.count ?? 0)) : 0;
        const cooling = Number(stored.lastAt ?? 0) > 0 && Date.now() - Number(stored.lastAt) < policy.cooldownHours * 3_600_000;
        policyWithinFrequency = dayCount < policy.maxPerDay && !cooling;
        if (policyWithinFrequency) window.localStorage.setItem(key, JSON.stringify({ day: today, count: dayCount + 1, lastAt: Date.now() }));
      } catch { /* hard entitlement gates still use their safe built-in copy */ }
    }
    resumeAfterPaywallRef.current = resume ?? null;
    setPaywall({
      reason: policy?.reason ?? reason,
      returnContext: { ...returnContext, paywallEvent: triggerEvent, policyId: policy?.id ?? "" },
      policyId: policy?.id,
      triggerEvent,
      copy: policy && policyWithinFrequency ? { eyebrow: policy.eyebrow, title: policy.title, detail: policy.detail } : undefined,
    });
    trackEvent("paywall_action", { action: "policy_trigger", triggerEvent, policyId: policy?.id ?? "fallback", frequencyCopyApplied: policyWithinFrequency });
  }, [bootstrap?.content.paywallPolicies, bootstrap?.firstCompletedPractice, trackEvent]);

  const recordCampaignClick = useCallback((campaign: CampaignSlot) => {
    trackEvent("campaign_click", { campaignId: campaign.id, slot: campaign.slot, actionType: campaign.actionType, actionTarget: campaign.actionTarget });
  }, [trackEvent]);

  const markCampaignComplete = useCallback((campaign: CampaignSlot) => {
    try {
      const key = `gongkao-rilian:campaign:${campaign.id}`;
      const stored = JSON.parse(window.localStorage.getItem(key) ?? "{}") as Record<string, unknown>;
      window.localStorage.setItem(key, JSON.stringify({ ...stored, completedAt: Date.now() }));
    } catch { /* completion still belongs to the quiz attempt on the server */ }
    campaignVisibilityRef.current = { ...campaignVisibilityRef.current, [campaign.id]: false };
    setCampaignVisibility(campaignVisibilityRef.current);
  }, []);

  const isCampaignVisible = (campaign: CampaignSlot | null) => Boolean(campaign && campaignVisibility[campaign.id]);

  const runConfiguredAction = useCallback((actionType: ResourceCard["actionType"] | CampaignSlot["actionType"], actionTarget: string, source: string) => {
    if (actionType === "essay_library") { openEssayReferenceLibrary("resources"); return; }
    if (actionType === "tab" && ["today", "banks", "resources", "audio", "review", "report", "calendar", "me"].includes(actionTarget)) {
      trackEvent("module_open", { module: actionTarget, entry: source });
      setTab(actionTarget as Tab);
      return;
    }
    if (actionType === "paywall") {
      const reason: PaywallReason = ["daily_limit", "second_bank", "essay", "radar", "value_loop"].includes(actionTarget)
        ? actionTarget as PaywallReason : "value_loop";
      openPaywall(reason, undefined, { tab, paywallEvent: reason === "value_loop" ? "manual_benefits_open" : undefined, source });
      return;
    }
    if (actionType === "quiz") {
      const url = new URL(window.location.href);
      url.searchParams.set("quiz", actionTarget === "director-thinking" ? "juzhang-thinking" : actionTarget);
      if (source.startsWith("campaign:")) url.searchParams.set("campaign", source.slice("campaign:".length, 120));
      window.location.assign(url.toString());
    }
  }, [openEssayReferenceLibrary, openPaywall, tab, trackEvent]);

  const closePaywall = useCallback(() => {
    resumeAfterPaywallRef.current = null;
    setPaywall(null);
  }, []);

  const authorizeAudioPlayback = useCallback(async (track: AudioTrack) => {
    try {
      await api({ action: "authorizeAudioPlayback", trackId: track.id });
      return true;
    } catch (error) {
      if (apiErrorCode(error) === "PAYWALL_AUDIO") {
        openPaywall("value_loop", undefined, { tab: "audio", trackId: track.id, resumeAction: "play_audio", paywallEvent: "audio_member_attempt" });
      }
      notify(error instanceof Error ? error.message : "节目暂时无法播放");
      return false;
    }
  }, [api, notify, openPaywall]);

  const preparePaywallLogin = useCallback(() => {
    if (!paywall || typeof window === "undefined") return;
    const intent: PaywallLoginIntent = {
      version: 1,
      createdAt: Date.now(),
      reason: paywall.reason,
      returnContext: paywall.returnContext,
    };
    try { window.sessionStorage.setItem(PAYWALL_LOGIN_INTENT_KEY, JSON.stringify(intent)); }
    catch { /* login still proceeds; the learner can reopen the gate manually */ }
  }, [paywall]);

  const finishPaywallActivation = useCallback(async () => {
    const resume = resumeAfterPaywallRef.current;
    resumeAfterPaywallRef.current = null;
    await loadBootstrap();
    setPaywall(null);
    if (resume) await resume();
  }, [loadBootstrap]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadBootstrap(), 0);
    return () => {
      window.clearTimeout(timer);
      if (bootstrapRetryTimerRef.current) window.clearTimeout(bootstrapRetryTimerRef.current);
    };
  }, [loadBootstrap]);

  useEffect(() => {
    const storedAttempts = readPendingPracticeAttempts();
    pendingPracticeAttemptsRef.current = storedAttempts;
    const storageAvailable = writePendingPracticeAttempts(storedAttempts);
    const initialOnline = window.navigator.onLine;
    const initialTimer = window.setTimeout(() => {
      setPendingPracticeAttempts(storedAttempts);
      setPendingQueueDurable(storageAvailable);
      setOnline(initialOnline);
    }, 0);
    const handleOnline = () => setOnline(true);
    const handleOffline = () => {
      autoRetriedPracticeKeyRef.current = "";
      setOnline(false);
    };
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.clearTimeout(initialTimer);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  useEffect(() => {
    if (!currentPendingPracticeAttempt || feedback) return;
    const timer = window.setTimeout(() => {
      setSelectedAnswer(currentPendingPracticeAttempt.payload.selectedAnswer);
      setUncertain(currentPendingPracticeAttempt.payload.uncertain);
      setQuestionSeconds(Math.max(0, Math.round(currentPendingPracticeAttempt.payload.durationMs / 1000)));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [currentPendingPracticeAttempt, feedback]);

  useEffect(() => {
    if (!bootstrap?.user.id || !profile.targets.length) {
      radarRequestSequenceRef.current += 1;
      const emptyTimer = window.setTimeout(() => { setRadarPositions([]); setRadarTotal(0); setRadarLimited(false); }, 0);
      return () => window.clearTimeout(emptyTimer);
    }
    const requestSequence = radarRequestSequenceRef.current + 1;
    radarRequestSequenceRef.current = requestSequence;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setRadarPositionsLoading(true);
      void api<{ positions: JobPosition[]; total: number; limited?: boolean }>({
        action: "searchJobPositions",
        targetCodes: radarTargetFilter ? [radarTargetFilter] : profile.targets.map((target) => target.code),
        candidateProfile: progressRef.current.candidateProfile,
        keyword: radarKeyword,
        page: radarPage,
        pageSize: 20,
      }, { signal: controller.signal }).then((result) => {
        if (radarRequestSequenceRef.current !== requestSequence) return;
        const total = Number(result.total ?? 0);
        if (result.limited && radarPage !== 1) {
          setRadarPage(1);
          return;
        }
        const maxPage = Math.max(1, Math.ceil(total / 20));
        if (radarPage > maxPage) {
          setRadarPage(maxPage);
          return;
        }
        setRadarPositions(result.positions ?? []);
        setRadarTotal(total);
        setRadarLimited(Boolean(result.limited));
      })
        .catch((error) => {
          if (controller.signal.aborted || radarRequestSequenceRef.current !== requestSequence || (error instanceof DOMException && error.name === "AbortError")) return;
          setRadarPositions([]);
          setRadarTotal(0);
          setRadarLimited(false);
        })
        .finally(() => {
          if (radarRequestSequenceRef.current === requestSequence) setRadarPositionsLoading(false);
        });
    }, 260);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [api, bootstrap?.user.id, profile.targets, progress.candidateProfile, radarKeyword, radarPage, radarTargetFilter]);

  useEffect(() => {
    if (!bootstrap?.user.id || trackedUserRef.current === bootstrap.user.id) return;
    trackedUserRef.current = bootstrap.user.id;
    trackEvent("app_open", { access: bootstrap.content.access, signedIn: bootstrap.user.signedIn });
  }, [bootstrap, trackEvent]);

  useEffect(() => {
    const report = bootstrap?.studyInsights;
    if (tab !== "report" || !bootstrap?.user.id || !report) return;
    const signature = `${bootstrap.user.id}:${report.weekly.activeDays}:${report.weekly.total}:${report.dueCount}`;
    if (reportViewTrackedRef.current === signature) return;
    reportViewTrackedRef.current = signature;
    trackEvent("three_day_report_view", {
      activeDays: report.weekly.activeDays,
      eligible: report.weekly.activeDays >= 3,
      questionCount: report.weekly.total,
    });
  }, [bootstrap?.studyInsights, bootstrap?.user.id, tab, trackEvent]);

  useEffect(() => {
    progressRef.current = progress;
  }, [progress]);

  useEffect(() => {
    if (activeModule !== "practice" || feedback) return;
    const timer = window.setInterval(() => setQuestionSeconds((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [activeModule, feedback, practiceIndex]);

  useEffect(() => {
    if (activeModule !== "essay" || essayPracticeLoading || !essayQuestion) return;
    const timer = window.setInterval(() => setEssayElapsedSeconds((value) => Math.min(4 * 3600, value + 1)), 1000);
    return () => window.clearInterval(timer);
  }, [activeModule, essayPracticeLoading, essayQuestion]);

  useEffect(() => {
    if (!bootstrap?.user.id || progress.reminderMode !== "browser" || typeof window === "undefined" || !("Notification" in window)) return;
    if (window.Notification.permission !== "granted" || !dueReminder) return;
    const reminderKey = `${dayKey}:${dueReminder.id}`;
    if (reminderShownRef.current === reminderKey) return;
    reminderShownRef.current = reminderKey;
    new window.Notification("公考日练·报名提醒", {
      body: dueReminder.days === 0 ? `${dueReminder.targetLabel}：${dueReminder.title}就在今天` : `${dueReminder.targetLabel}：${dueReminder.title}还有${dueReminder.days}天`,
    });
  }, [bootstrap?.user.id, dayKey, dueReminder, progress.reminderMode]);

  const persist = useCallback((next: Progress) => {
    const generation = progressGenerationRef.current;
    progressRef.current = next;
    setProgress(next);
    saveQueueRef.current = saveQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        if (generation !== progressGenerationRef.current) return;
        try {
          const result = await api<{ progressVersion: number }>({
            action: "saveProgress",
            progress: next,
            progressVersion: progressVersionRef.current,
          });
          progressVersionRef.current = Number(result.progressVersion ?? progressVersionRef.current + 1);
        } catch (error) {
          const conflict = error as Error & { status?: number };
          if (conflict.status === 409) {
            progressGenerationRef.current += 1;
            notify("其他设备已有新进度，正在重新同步，请重做刚才一步");
            await loadBootstrap();
          } else {
            notify("本次操作尚未同步，请保持页面并稍后重试");
          }
        }
      });
    return saveQueueRef.current;
  }, [api, loadBootstrap, notify]);

  const recordValidDailyCheckin = useCallback(async () => {
    try {
      await api({ action: "recordDailyCheckin", dateKey: dayKey });
      trackEvent("daily_practice_complete", { dateKey: dayKey });
      return true;
    } catch (error) {
      notify(error instanceof Error ? error.message : "打卡暂未同步，请稍后重试");
      return false;
    }
  }, [api, dayKey, notify, trackEvent]);

  const recordDailyStep = useCallback(async (step: "morning" | "essay") => {
    try {
      await api({ action: "recordDailyStep", dateKey: dayKey, step });
      return true;
    } catch (error) {
      notify(error instanceof Error ? error.message : "学习步骤暂未同步，请重试");
      return false;
    }
  }, [api, dayKey, notify]);

  const syncDailyCheckin = useCallback(async () => {
    if (!dailyTasksDone) return false;
    if (progressRef.current.completed[`${dayKey}-morning`] && !await recordDailyStep("morning")) return false;
    if (progressRef.current.completed[`${dayKey}-essay`] && !await recordDailyStep("essay")) return false;
    const checked = await recordValidDailyCheckin();
    if (!checked) return false;
    const current = progressRef.current;
    if (!current.checkins.includes(dayKey)) await persist({ ...current, checkins: [...current.checkins, dayKey] });
    notify("今日任务与云端打卡均已同步");
    return true;
  }, [dailyTasksDone, dayKey, notify, persist, recordDailyStep, recordValidDailyCheckin]);

  const complete = async (key: string) => {
    const current = progressRef.current;
    const serverStep = key === `${dayKey}-morning` ? "morning" : key === `${dayKey}-essay` ? "essay" : null;
    if (serverStep && !await recordDailyStep(serverStep)) return current;
    const next = { ...current, completed: { ...current.completed, [key]: true } };
    const allDone = !dailyConfigurationBlocking && enabledDailySteps.length > 0 && enabledDailySteps.every((step) => step === "practice"
      ? serverDailyPracticeCompleted
      : Boolean(next.completed[`${dayKey}-${step}`]));
    let checkinSynced = next.checkins.includes(dayKey);
    if (allDone && !checkinSynced && await recordValidDailyCheckin()) {
      next.checkins = [...next.checkins, dayKey];
      checkinSynced = true;
    }
    await persist(next);
    notify(allDone && !checkinSynced ? "任务已完成，打卡尚未同步；可在首页重新同步" : "完成记录已保存");
    return next;
  };

  const toggleTarget = (examType: "国考" | "省考", province = "") => {
    const code = examType === "国考" ? "national" : `province:${province}`;
    setProfileDraft((current) => {
      const exists = current.targets.some((target) => target.code === code);
      return {
        ...current,
        targets: exists
          ? current.targets.filter((target) => target.code !== code)
          : [...current.targets, createTarget(examType, province)],
      };
    });
  };

  const updateTarget = (code: string, patch: Partial<Pick<ExamTarget, "examYear" | "examDate">>) => {
    setProfileDraft((current) => ({
      ...current,
      targets: current.targets.map((target) => target.code === code ? { ...target, ...patch } : target),
    }));
  };

  const setPrimaryTarget = (code: string) => {
    setProfileDraft((current) => {
      const target = current.targets.find((item) => item.code === code);
      return target ? { ...current, targets: [target, ...current.targets.filter((item) => item.code !== code)] } : current;
    });
  };

  const setPrimaryBank = (bankCode: string) => {
    const current = progressRef.current;
    void persist({ ...current, primaryBankCode: bankCode });
    notify("已设为主攻题库，综合练习会优先安排");
  };

  const toggleBusyMode = () => {
    if (dailySessionForPlan || practiceDone) return notify("今日行测已经开始，明天可重新选择训练时长");
    const current = progressRef.current;
    const planOverrides = { ...current.planOverrides };
    if (dailyPlan.minutes === 10) {
      delete planOverrides[dayKey];
      notify(`已恢复默认的${normalizePlanMinutes(profile.dailyMinutes)}分钟计划`);
    } else {
      planOverrides[dayKey] = 10;
      notify("已切换为10分钟精简训练，今日安排5道行测真题");
    }
    void persist({ ...current, planOverrides });
    trackEvent("plan_override", { minutes: dailyPlan.minutes === 10 ? normalizePlanMinutes(profile.dailyMinutes) : 10 });
  };

  const saveProfile = async () => {
    if (!profileDraft.targets.length) return notify("请至少选择国考或一个省考目标");
    const firstSetup = !profile.onboarded;
    const matchingBanks = (bootstrap?.questionBanks ?? []).filter((bank) =>
      (bank.subject === "行测" || bank.subject === "综合") && bank.questionCount >= 5
      && profileDraft.targets.some((target) => targetMatchesBank(target, bank) && bankYearSupportsTarget(bank.examYear, target.examYear)));
    if (firstSetup && matchingBanks.length > 0 && !matchingBanks.some((bank) => bank.code === onboardingBankCode)) {
      return notify("请选择一套当前可用且与报考目标匹配的真题库");
    }
    setBusy(true);
    setRadarPage(1);
    try {
      const result = await api<{ abandonedSessionIds?: string[] }>({ action: "saveExamProfile", targets: profileDraft.targets, dailyMinutes: normalizePlanMinutes(profileDraft.dailyMinutes), initialBankCode: firstSetup ? onboardingBankCode : "" });
      const activePractice = progressRef.current.activePractice;
      if (activePractice?.kind === "daily" && (result.abandonedSessionIds ?? []).includes(activePractice.serverSessionId ?? "")) {
        await persist({ ...progressRef.current, activePractice: null });
        setPracticeQuestions([]);
        setPracticeSummary(null);
        setActiveModule(null);
      }
      trackEvent("profile_save", { targetCount: profileDraft.targets.length, targets: profileDraft.targets.map((target) => target.code), dailyMinutes: profileDraft.dailyMinutes });
      setOnboardingOpen(false);
      if (firstSetup && onboardingBankCode) setDiagnosticPromptOpen(true);
      notify(firstSetup && onboardingBankCode ? "备考组合已配置，可选择先完成10题能力诊断" : "报考目标已保存；已加入题库将继续参与每日组题");
      await loadBootstrap();
    } catch (error) { notify(error instanceof Error ? error.message : "保存失败"); }
    finally { setBusy(false); }
  };

  const openEventForm = (targetCode = primaryTarget?.code ?? profile.targets[0]?.code ?? "", eventType = "报名截止", title = eventType) => {
    setEditingEventId("");
    setEventDraft({ targetCode, eventType, title, eventDate: "", reminderDays: 3, sourceUrl: "" });
    setEventFormOpen(true);
  };

  const openExistingEventForm = (event: ExamEvent) => {
    if (!event.id.startsWith("event-")) return;
    setEditingEventId(event.id);
    setEventDraft({
      targetCode: event.targetCode,
      eventType: event.eventType,
      title: event.title,
      eventDate: event.eventDate,
      reminderDays: event.reminderDays,
      sourceUrl: event.sourceUrl,
    });
    setEventFormOpen(true);
  };

  const focusCalendarEvent = (event: ExamEvent, message: string) => {
    setRadarMode("tasks");
    setFocusedEventId(event.id);
    notify(message);
    window.setTimeout(() => document.getElementById(`calendar-event-${event.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 0);
  };

  const saveExamEvent = async () => {
    const target = profile.targets.find((item) => item.code === eventDraft.targetCode);
    if (!target) return notify("请先选择一个报考目标");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDraft.eventDate)) return notify("请选择节点日期");
    const title = eventDraft.title.trim().slice(0, 40);
    if (!title) return notify("请填写节点名称");
    const event: ExamEvent = {
      id: editingEventId || `event-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      targetCode: target.code,
      targetLabel: target.label,
      eventType: eventDraft.eventType,
      title,
      eventDate: eventDraft.eventDate,
      reminderDays: eventDraft.reminderDays,
      reminderEnabled: true,
      sourceUrl: /^https?:\/\//i.test(eventDraft.sourceUrl.trim()) ? eventDraft.sourceUrl.trim().slice(0, 400) : "",
    };
    const current = progressRef.current;
    const examEvents = editingEventId
      ? current.examEvents.map((item) => item.id === editingEventId ? event : item)
      : [...current.examEvents, event].slice(-96);
    await persist({ ...current, examEvents });
    setEventFormOpen(false);
    setEditingEventId("");
    setFocusedEventId(event.id);
    trackEvent("calendar_event_save", { targetCode: target.code, eventType: event.eventType, reminderDays: event.reminderDays });
    notify(editingEventId ? "考试节点已更新，提醒时间已同步" : "考试节点已加入日历，打开应用时会检查提醒");
  };

  const removeExamEvent = async (eventId: string) => {
    if (eventId.startsWith("exam-")) return notify("笔试日期来自报考目标，请在目标设置中修改");
    if (eventId.startsWith("official-")) return notify("该节点来自已发布公告，可通过官方来源核对");
    const current = progressRef.current;
    await persist({ ...current, examEvents: current.examEvents.filter((event) => event.id !== eventId) });
    notify("节点已删除");
  };

  const updateCandidateProfile = (patch: Partial<CandidateProfile>) => {
    setRadarPage(1);
    setProgress((current) => {
      const next = { ...current, candidateProfile: { ...current.candidateProfile, ...patch } };
      progressRef.current = next;
      return next;
    });
  };

  const saveCandidateProfile = async () => {
    const current = progressRef.current;
    const next = { ...current, candidateProfile: safeCandidateProfile(current.candidateProfile) };
    await persist(next);
    trackEvent("candidate_profile_save", {
      education: next.candidateProfile.education,
      freshStatus: next.candidateProfile.freshStatus,
      hasMajor: Boolean(next.candidateProfile.major),
    });
    notify("报考条件档案已保存，职位匹配会按它重新判断");
  };

  const toggleSavedPosition = async (position: JobPosition, entitlementConfirmed = false) => {
    if (radarLimited && !entitlementConfirmed) {
      openPaywall("radar", () => toggleSavedPosition(position, true), { tab: "calendar", radarMode: "positions", resumeAction: "save_position", positionId: position.id, paywallEvent: "radar_position_save_attempt" });
      return;
    }
    const current = progressRef.current;
    const exists = current.savedPositionIds.includes(position.id);
    const savedPositionIds = exists
      ? current.savedPositionIds.filter((id) => id !== position.id)
      : [...current.savedPositionIds, position.id].slice(-120);
    await persist({ ...current, savedPositionIds });
    trackEvent("position_save", { positionId: position.id, targetCode: position.targetCode, saved: !exists });
    notify(exists ? "已从备选岗位移除" : "已加入备选岗位，报名待办会提醒你核对");
  };

  const toggleComparedPosition = (position: JobPosition, entitlementConfirmed = false) => {
    if (radarLimited && !entitlementConfirmed) {
      openPaywall("radar", () => toggleComparedPosition(position, true), { tab: "calendar", radarMode: "positions", resumeAction: "compare_position", positionId: position.id, paywallEvent: "radar_position_compare_attempt" });
      return;
    }
    setComparePositions((current) => current.some((item) => item.id === position.id)
      ? current.filter((item) => item.id !== position.id)
      : current.length >= 3 ? [...current.slice(1), position] : [...current, position]);
    trackEvent("radar_position_compare", { positionId: position.id, targetCode: position.targetCode });
  };

  const toggleRadarTodo = async (todoId: string) => {
    const current = progressRef.current;
    const nextDone = !current.radarTodoDone[todoId];
    await persist({ ...current, radarTodoDone: { ...current.radarTodoDone, [todoId]: nextDone } });
    trackEvent("radar_todo_toggle", { todoId, done: nextDone });
  };

  const enableBrowserReminders = async () => {
    if (typeof window === "undefined" || !("Notification" in window)) return notify("当前设备不支持系统通知，站内提醒仍然有效");
    const permission = await window.Notification.requestPermission();
    if (permission !== "granted") return notify("通知权限未开启，仍会在每次打开时显示站内提醒");
    const current = progressRef.current;
    await persist({ ...current, reminderMode: "browser" });
    trackEvent("reminder_enable", { channel: "browser" });
    notify("系统通知已开启；每次打开公考日练时会同步检查节点");
  };

  const toggleBank = async (bank: QuestionBank): Promise<void> => {
    setBusy(true);
    try {
      const result = await api<{ banks: QuestionBank[]; profile: ExamProfile; dailyReadiness?: DailyReadiness; abandonedSessionIds?: string[] }>(
        { action: "toggleQuestionBank", bankCode: bank.code, added: !bank.added, planMinutes: dailyPlan.minutes },
      );
      setBootstrap((current) => current ? {
        ...current,
        questionBanks: result.banks,
        examProfile: result.profile,
        dailyReadiness: result.dailyReadiness ?? current.dailyReadiness,
        dailyQueue: bank.added
          ? (current.dailyQueue ?? []).filter((item) => !(item.itemType === "bank_practice" && item.sourceId === bank.code && item.status === "scheduled"))
          : (current.dailyQueue ?? []),
      } : current);
      setProfileDraft(result.profile);
      trackEvent("bank_toggle", { bankCode: bank.code, added: !bank.added });
      const nextBank = result.banks.find((item) => item.code === bank.code);
      let abandonedLocalSession = false;
      let clearedPendingAttempts = 0;
      if (bank.added) {
        const abandonedIds = new Set((result.abandonedSessionIds ?? []).map(String));
        const currentUserId = bootstrap?.user.id ?? "";
        const current = progressRef.current;
        const active = current.activePractice;
        abandonedLocalSession = Boolean(active && (
          active.bankCodes.includes(bank.code)
          || (active.serverSessionId && abandonedIds.has(active.serverSessionId))
        ));
        const remainingAttempts = pendingPracticeAttemptsRef.current.filter((attempt) => {
          const belongsToCurrentUser = !currentUserId || attempt.userId === currentUserId;
          const matchesCancelledPractice = attempt.payload.bankCode === bank.code
            || Boolean(attempt.payload.practiceSessionId && abandonedIds.has(attempt.payload.practiceSessionId));
          return !(belongsToCurrentUser && matchesCancelledPractice);
        });
        clearedPendingAttempts = pendingPracticeAttemptsRef.current.length - remainingAttempts.length;
        if (clearedPendingAttempts > 0) {
          pendingPracticeAttemptsRef.current = remainingAttempts;
          setPendingPracticeAttempts(remainingAttempts);
          setPendingQueueDurable(writePendingPracticeAttempts(remainingAttempts));
          autoRetriedPracticeKeyRef.current = "";
        }
        if (abandonedLocalSession) {
          await persist({ ...current, activePractice: null });
          setPracticeQuestions([]);
          setPracticeBankCodes([]);
          setPracticeSummary(null);
          setPracticeIndex(0);
          setSelectedAnswer(null);
          setFeedback(null);
          setAnswerConfidence("");
          setActiveModule(null);
        }
      }
      notify(bank.added
        ? nextBank?.added
          ? "至少保留一套可练题库，基础题库已继续保留"
          : abandonedLocalSession || clearedPendingAttempts
            ? `已取消题库；相关未完成练习已结束${clearedPendingAttempts ? `，${clearedPendingAttempts}条未同步答题已清除` : ""}`
            : "已取消加入；报考目标和本题库历史进度仍会保留"
        : bank.targetMatch ? "已加入我的题库" : `已加入题库，并同步加入${bank.examType === "省考" ? bank.province : "国考"}备考目标`);
    } catch (error) {
      if (apiErrorCode(error) === "FREE_BANK_LIMIT") {
        openPaywall("second_bank", () => toggleBank(bank), { tab: "banks", bankCode: bank.code, resumeAction: "toggle_bank" });
      } else {
        notify(error instanceof Error ? error.message : "题库操作失败");
      }
    }
    finally { setBusy(false); }
  };

  const openPracticeSummary = (session: ActivePracticeSession) => {
    setPracticeKind(session.kind);
    setPracticeBankCodes(session.bankCodes);
    setPracticeSummary({
      sessionId: session.serverSessionId,
      kind: session.kind,
      mode: session.mode,
      answered: session.answered,
      correct: session.correct,
      reviewAdded: session.reviewAdded ?? 0,
      elapsedSeconds: session.elapsedSeconds,
      bankCodes: session.bankCodes,
      wrong: Math.max(0, session.answered - session.correct),
      hesitant: 0,
      guessed: 0,
      overtime: 0,
      repairedDue: 0,
      weakModules: [],
      points: [],
    });
    setPracticeQuestions([]);
    setActiveModule("practice");
  };

  const startPractice = async (
    mode: PracticeMode = "mixed",
    bankCodes?: string[],
    options: PracticeStartOptions = {},
  ): Promise<void> => {
    let kind = options.kind ?? (mode === "review" ? "review" : bankCodes?.length === 1 ? "bank" : "daily");
    if (kind === "daily" && !progressRef.current.activePractice && dailyConfigurationBlocking) {
      setBankFilter("适合我");
      setTab("banks");
      return notify("先加入一套与报考地区、年份匹配且已有真题的题库");
    }
    let activeSession = progressRef.current.activePractice;
    if (!options.forceNew && kind !== "daily" && activeSession?.kind === "daily" && activeSession.dateKey === dayKey
      && activeSession.answered < activeSession.questionTarget) {
      notify("今日训练尚未完成，请先从上次进度继续；完成后可进行专项强化");
      kind = "daily";
      mode = activeSession.mode;
      bankCodes = activeSession.bankCodes;
    }
    activeSession = !options.forceNew && activeSession?.dateKey === dayKey
      && ((kind === "daily" && activeSession.kind === "daily") || (kind === "diagnostic" && activeSession.kind === "diagnostic"))
      ? activeSession : null;
    if (activeSession && activeSession.cursor >= activeSession.questionIds.length) {
      openPracticeSummary(activeSession);
      const current = progressRef.current;
      void persist({ ...current, activePractice: null });
      return;
    }

    setBusy(true);
    setPracticeEmpty(false);
    setPracticeSummary(null);
    try {
      const resumeQuestionCodes = activeSession?.questionIds.slice(activeSession.cursor) ?? [];
      const requestedBankCodes = activeSession?.bankCodes ?? bankCodes ?? orderedBankCodes;
      if (mode !== "review" && !requestedBankCodes.length) {
        setBankFilter("适合我");
        setTab("banks");
      return notify("请先添加一套与报考目标匹配的可练题库");
      }
      const requestedLimit = activeSession?.questionTarget
        ?? options.limit
        ?? (kind === "diagnostic" ? 5 : kind === "bonus" ? 5 : kind === "review" ? Math.min(dailyPlan.questionCount, Math.max(1, insights.dueCount)) : dailyPlan.questionCount);
      const clientSessionId = activeSession?.clientSessionId ?? createClientSessionId();
      const serverSessionKind = activeSession?.serverSessionKind
        ?? (kind === "daily" ? "daily" : kind === "diagnostic" ? "diagnostic" : kind === "review" ? `review:${dayKey}` : `${kind}:${clientSessionId}`);
      const result = await api<{
        questions: PracticeQuestion[]; composition: PracticeComposition; sessionId?: string; quotaExceeded?: boolean;
        freeRemaining?: number | null; dailyCompleted?: boolean;
        session?: { targetCount: number; answeredCount: number; correctCount: number; reviewAdded: number; elapsedSeconds: number; status: string } | null;
      }>({
        action: "getPracticeBatch",
        mode,
        limit: resumeQuestionCodes.length || requestedLimit,
        bankCodes: requestedBankCodes,
        primaryBankCode: primaryBank?.code ?? "",
        resumeQuestionCodes,
        focusModule: options.focusModule ?? "",
        focusSubTypes: options.focusSubTypes ?? [],
        strictFocus: options.strictFocus === true,
        frequency: options.frequency ?? "",
        importanceStars: options.importanceStars ?? 0,
        scoreRateMin: options.scoreRateMin ?? 0,
        scoreRateMax: options.scoreRateMax ?? 100,
        kind,
        dateKey: dayKey,
        planMinutes: kind === "daily" ? dailyPlan.minutes : normalizePlanMinutes(profile.dailyMinutes),
        clientSessionId,
        sessionKind: serverSessionKind,
        resetSession: options.forceNew === true,
      });
      if (result.quotaExceeded) {
        openPaywall("daily_limit", () => startPractice(mode, bankCodes, options), { tab: "today", sessionKind: serverSessionKind, resumeAction: "start_practice", mode, bankCodes: bankCodes ?? [], practiceOptions: options });
        return;
      }
      if (result.dailyCompleted && kind === "daily") {
        setServerDailyPracticeCompleted(true);
        const current = progressRef.current;
        const completed = { ...current.completed, [`${dayKey}-practice`]: true };
        const dailyComplete = !dailyConfigurationBlocking && enabledDailySteps.length > 0
          && enabledDailySteps.every((step) => step === "practice" || Boolean(completed[`${dayKey}-${step}`]));
        const checked = dailyComplete && !current.checkins.includes(dayKey) ? await recordValidDailyCheckin() : false;
        await persist({
          ...current,
          completed,
          checkins: checked ? [...current.checkins, dayKey] : current.checkins,
          activePractice: null,
        });
        setTab("today");
        notify("已保留更新前完成的真题记录，今日练习无需重做");
        return;
      }
      if (!result.questions.length) {
        setPracticeEmpty(true);
        setTab(mode === "review" ? "review" : "banks");
        return notify(mode === "review" ? "今日暂无到期复习题，可继续完成新题训练" : options.focusLabel ? `“${options.focusLabel}”暂无可练题目，请选择其他专项` : "该题库暂无可练行测题");
      }
      const effectiveBanks = Array.from(new Set(result.questions.map((question) => question.bankCode)));
      const nextSession: ActivePracticeSession = {
        version: 1,
        clientSessionId,
        serverSessionId: result.sessionId ?? activeSession?.serverSessionId,
        serverSessionKind,
        dateKey: dayKey,
        kind,
        mode,
        planMinutes: activeSession?.planMinutes ?? (kind === "daily" ? dailyPlan.minutes : normalizePlanMinutes(profile.dailyMinutes)),
        questionTarget: result.session?.targetCount ?? activeSession?.questionTarget ?? result.questions.length,
        bankCodes: requestedBankCodes.length ? requestedBankCodes : effectiveBanks,
        questionIds: result.questions.map((question) => question.id),
        cursor: 0,
        answered: result.session?.answeredCount ?? activeSession?.answered ?? 0,
        correct: result.session?.correctCount ?? activeSession?.correct ?? 0,
        reviewAdded: result.session?.reviewAdded ?? activeSession?.reviewAdded ?? 0,
        elapsedSeconds: result.session?.elapsedSeconds ?? activeSession?.elapsedSeconds ?? 0,
      };
      setPracticeQuestions(result.questions);
      setPracticeMode(mode);
      setPracticeKind(kind);
      setPracticeBankCodes(nextSession.bankCodes);
      setPracticeComposition(result.composition ?? { due: 0, weak: 0, new: 0, primary: 0, other: 0, byBank: [] });
      setPracticeIndex(0);
      const resumedAttempt = result.questions[0]?.pendingAttempt ?? null;
      setSelectedAnswer(resumedAttempt?.selectedAnswer ?? null);
      setFeedback(resumedAttempt ? { ...resumedAttempt, duplicate: true } : null);
      setUncertain(resumedAttempt?.uncertain ?? false);
      setAnswerConfidence("");
      setContentReportDraft(null);
      setQuestionSeconds(0);
      setSessionAnswered(nextSession.answered);
      setSessionCorrect(nextSession.correct);
      setSessionReviewAdded(nextSession.reviewAdded);
      setSessionElapsedSeconds(nextSession.elapsedSeconds);
      setActiveModule("practice");
      if (resumedAttempt) notify("已恢复上次答题结果，请确认掌握状态");
      const current = progressRef.current;
      await persist({ ...current, activePractice: nextSession });
      trackEvent("practice_batch", { mode, kind, count: result.questions.length, target: nextSession.questionTarget, focusModule: options.focusModule ?? "" });
    } catch (error) {
      if (apiErrorCode(error) === "FREE_DAILY_LIMIT") {
        openPaywall("daily_limit", () => startPractice(mode, bankCodes, options), { tab: "today", sessionKind: kind, resumeAction: "start_practice", mode, bankCodes: bankCodes ?? [], practiceOptions: options });
      } else if (apiErrorCode(error) === "FREE_BANK_LIMIT") {
        openPaywall("second_bank", () => startPractice(mode, bankCodes, options), { tab: "banks", sessionKind: kind, resumeAction: "start_practice", mode, bankCodes: bankCodes ?? [], practiceOptions: options });
      } else if (apiErrorCode(error) === "DAILY_BANK_INSUFFICIENT") {
        setBankFilter("适合我");
        setTab("banks");
        notify("当前题库可练真题不足5道，请添加一套题量充足的已审核题库");
      } else {
        notify(error instanceof Error ? error.message : "组题失败");
      }
    }
    finally { setBusy(false); }
  };

  const startEssayPractice = async (options: EssayStartOptions = {}): Promise<void> => {
    setEssayPracticeLoading(true);
    setEssayPracticeQuestions([]);
    setEssayPracticeIndex(0);
    setEssayReference(false);
    setEssayCompletesDaily(options.daily !== false);
    setEssayElapsedSeconds(0);
    setActiveModule("essay");
    try {
      const dueRewrite = options.daily !== false && !options.questionCode ? bootstrap?.dueEssayRewrites?.[0] : null;
      const bankCodes = options.bankCodes?.length
        ? options.bankCodes
        : dueRewrite?.bankCode ? [dueRewrite.bankCode] : activeEssayBanks.map((bank) => bank.code);
      const result = await api<{ questions?: unknown[] }>({
        action: "getEssayPracticeBatch",
        bankCodes,
        limit: 1,
        focusModule: options.focusModule ?? "",
        focusSubTypes: options.focusSubTypes ?? [],
        questionCode: options.questionCode ?? dueRewrite?.questionCode ?? "",
        attemptDateKey: options.attemptDateKey ?? dueRewrite?.originalDateKey ?? "",
      });
      const questions = (result.questions ?? []).map(normalizeEssayQuestion).filter((item): item is EssayPracticeQuestion => Boolean(item));
      if (questions.length) {
        const serverAttempt = questions[0].serverAttempt;
        if (serverAttempt) {
          const hydrated = applyEssayAttemptSnapshot(progressRef.current, questions[0].id, serverAttempt);
          progressRef.current = hydrated;
          setProgress(hydrated);
          setEssayElapsedSeconds(serverAttempt.elapsedSeconds);
        }
        setEssayPracticeQuestions(questions);
        trackEvent("essay_practice_open", { bankCodes, questionId: questions[0].id, daily: options.daily !== false });
      } else {
        setActiveModule(null);
        notify(options.daily === false ? "该申论题库当前暂无可练真题" : "今日申论真题暂时无法生成，本项未计为完成");
      }
    } catch (error) {
      if (apiErrorCode(error) === "PAYWALL_ESSAY") {
        openPaywall("essay", () => startEssayPractice(options), { tab: "today", sessionKind: options.daily === false ? "essay_drill" : "daily_essay", resumeAction: "start_essay", essayOptions: options });
      } else {
        setActiveModule(null);
        notify(error instanceof Error ? error.message : "申论真题暂时无法加载");
      }
    } finally {
      setEssayPracticeLoading(false);
    }
  };

  const startMicroDrill = (drill: DrillPreset) => {
    if (drill.subject === "申论" || drill.module === "申论") {
      void startEssayPractice({ bankCodes: drill.bankCodes, daily: false, focusModule: drill.module, focusSubTypes: drill.subTypes });
      trackEvent("micro_drill_open", { drill: drill.id, source: "cms" });
      return;
    }
    trackEvent("micro_drill_open", { drill: drill.id });
    void startPractice("mixed", drill.bankCodes.length ? drill.bankCodes : undefined, {
      kind: "bonus",
      limit: drill.questionCount,
      forceNew: true,
      focusModule: drill.module || drill.subTypes[0] || "",
      focusSubTypes: drill.subTypes,
      strictFocus: true,
      focusLabel: drill.title,
      frequency: drill.frequency,
      importanceStars: drill.importanceStars,
      scoreRateMin: drill.scoreRateMin,
      scoreRateMax: drill.scoreRateMax,
    });
  };

  const answerPractice = async (answer: number, queuedAttempt?: QueuedPracticeAttempt): Promise<void> => {
    if (!currentPractice || feedback || busy) return;
    if (queuedAttempt && queuedAttempt.payload.questionCode !== currentPractice.id) {
      notify("这条待同步答题不属于当前题目，请回到原练习后重试");
      return;
    }
    const answeringSession = progressRef.current.activePractice;
    const sessionIdentity = answeringSession?.serverSessionId ?? answeringSession?.clientSessionId ?? `standalone-${dayKey}`;
    const answerPayload: PracticeAnswerPayload = queuedAttempt?.payload ?? {
      action: "submitPracticeAnswer",
      questionCode: currentPractice.id,
      bankCode: currentPractice.bankCode,
      selectedAnswer: answer,
      uncertain,
      durationMs: questionSeconds * 1000,
      practiceSessionId: answeringSession?.serverSessionId ?? "",
      clientSessionId: answeringSession?.clientSessionId ?? "",
      attemptKey: `${sessionIdentity}:${currentPractice.id}`,
    };
    const answerUncertain = answerPayload.uncertain;
    const answerSeconds = Math.max(0, Math.round(answerPayload.durationMs / 1000));
    setSelectedAnswer(answerPayload.selectedAnswer);
    setUncertain(answerUncertain);
    setBusy(true);
    try {
      const rawResult = await api<AnswerFeedback>(answerPayload);
      removePendingPracticeAttempt(answerPayload.attemptKey);
      const result: AnswerFeedback = {
        ...rawResult,
        reviewDays: Number.isFinite(Number(rawResult.reviewDays)) ? Number(rawResult.reviewDays) : 1,
        needsReview: typeof rawResult.needsReview === "boolean" ? rawResult.needsReview : rawResult.state === "weak",
        nextReviewAt: rawResult.nextReviewAt ?? "",
      };
      setFeedback(result);
      setAnswerConfidence("");
      // A queued answer has never been applied to this client session. If the
      // first response was lost after the server committed, the idempotent retry
      // returns duplicate=true but still needs to advance the local cursor once.
      const isNewAttempt = Boolean(queuedAttempt) || result.duplicate !== true;
      const nextAnswered = sessionAnswered + (isNewAttempt ? 1 : 0);
      const nextCorrect = sessionCorrect + (isNewAttempt && result.correct ? 1 : 0);
      const nextReviewAdded = sessionReviewAdded + (isNewAttempt && result.needsReview ? 1 : 0);
      const nextElapsed = sessionElapsedSeconds + (isNewAttempt ? answerSeconds : 0);
      setSessionAnswered(nextAnswered);
      setSessionCorrect(nextCorrect);
      setSessionReviewAdded(nextReviewAdded);
      setSessionElapsedSeconds(nextElapsed);
      if (isNewAttempt && !result.correct) setSessionWrongQuestions((items) => [...items, {
        id: currentPractice.id,
        module: currentPractice.module,
        stem: currentPractice.stem,
        options: currentPractice.options,
        answer: result.correctAnswer,
        explanation: result.explanation,
        knowledge: currentPractice.knowledge,
      }]);
      const activeSession = progressRef.current.activePractice;
      if (activeSession) {
        const isFinal = practiceIndex >= practiceQuestions.length - 1;
        const nextSession: ActivePracticeSession = {
          ...activeSession,
          // A correct answer is not complete until the learner explicitly says
          // whether it was genuine mastery, hesitation or a lucky guess.
          cursor: result.correct ? activeSession.cursor : Math.min(activeSession.questionIds.length, activeSession.cursor + 1),
          answered: nextAnswered,
          correct: nextCorrect,
          reviewAdded: nextReviewAdded,
          elapsedSeconds: nextElapsed,
        };
        const current = progressRef.current;
        const completed = isFinal && !result.correct && activeSession.kind === "daily"
          ? { ...current.completed, [`${dayKey}-practice`]: true }
          : current.completed;
        const dailyComplete = !dailyConfigurationBlocking && enabledDailySteps.length > 0
          && enabledDailySteps.every((step) => step === "practice" || Boolean(completed[`${dayKey}-${step}`]));
        const checked = isFinal && !result.correct && activeSession.kind === "daily" && dailyComplete && !current.checkins.includes(dayKey)
          ? await recordValidDailyCheckin()
          : false;
        const checkins = checked ? [...current.checkins, dayKey] : current.checkins;
        await persist({ ...current, completed, checkins, activePractice: nextSession });
        if (isFinal && !result.correct && activeSession.kind === "daily") setServerDailyPracticeCompleted(true);
      }
      trackEvent("practice_answer", { module: currentPractice.module, correct: result.correct, uncertain: answerUncertain, overtime: result.overtime, seconds: answerSeconds, retried: Boolean(queuedAttempt) });
    } catch (error) {
      if (apiErrorCode(error) === "FREE_DAILY_LIMIT") {
        setSelectedAnswer(null);
        openPaywall("daily_limit", () => answerPractice(answer), { tab: "today", sessionKind: practiceKind, resumeAction: "resume_practice", mode: practiceMode, bankCodes: practiceBankCodes, practiceKind });
      } else if (["PRACTICE_SESSION_INVALIDATED", "PRACTICE_SESSION_ENTITLEMENT_CHANGED"].includes(apiErrorCode(error))) {
        const entitlementChanged = apiErrorCode(error) === "PRACTICE_SESSION_ENTITLEMENT_CHANGED";
        const invalidSessionId = answeringSession?.serverSessionId ?? "";
        const remainingAttempts = pendingPracticeAttemptsRef.current.filter((attempt) => (
          !invalidSessionId || attempt.payload.practiceSessionId !== invalidSessionId
        ));
        pendingPracticeAttemptsRef.current = remainingAttempts;
        setPendingPracticeAttempts(remainingAttempts);
        setPendingQueueDurable(writePendingPracticeAttempts(remainingAttempts));
        setSelectedAnswer(null);
        setFeedback(null);
        setPracticeQuestions([]);
        setActiveModule(null);
        setTab("today");
        const current = progressRef.current;
        if (current.activePractice?.serverSessionId === invalidSessionId) {
          await persist({ ...current, activePractice: null });
        }
        notify(entitlementChanged
          ? "会员或试用权益、题库组合已变化，旧练习已结束；已完成记录保留，请重新开始"
          : "题库内容已更新，旧练习已结束；已完成记录仍保留，请重新开始本组");
      } else if (isRetryablePracticeError(error)) {
        const now = new Date().toISOString();
        upsertPendingPracticeAttempt({
          version: 1,
          key: answerPayload.attemptKey,
          userId: bootstrap?.user.id ?? "",
          payload: answerPayload,
          createdAt: queuedAttempt?.createdAt ?? now,
          lastTriedAt: now,
          attempts: (queuedAttempt?.attempts ?? 0) + 1,
          lastError: error instanceof Error ? error.message : "网络请求失败",
          blocked: false,
        });
        notify(online ? "网络波动：本题已暂存在本机，尚未同步，正在等待重试" : "当前离线：本题已暂存在本机，尚未计入学习进度");
      } else if (queuedAttempt) {
        upsertPendingPracticeAttempt({
          ...queuedAttempt,
          lastTriedAt: new Date().toISOString(),
          attempts: queuedAttempt.attempts + 1,
          lastError: error instanceof Error ? error.message : "同步失败",
          blocked: true,
        });
        notify("本题同步未成功，请重新载入练习后再试");
      } else {
        setSelectedAnswer(null);
        notify(error instanceof Error ? error.message : "答案提交失败");
      }
    }
    finally { setBusy(false); }
  };

  retryPendingPracticeRef.current = (attempt) => {
    void answerPractice(attempt.payload.selectedAnswer, attempt);
  };

  useEffect(() => {
    if (!online || !currentPendingPracticeAttempt || currentPendingPracticeAttempt.blocked || feedback || busy) return;
    if (autoRetriedPracticeKeyRef.current === currentPendingPracticeAttempt.key) return;
    autoRetriedPracticeKeyRef.current = currentPendingPracticeAttempt.key;
    const timer = window.setTimeout(() => retryPendingPracticeRef.current(currentPendingPracticeAttempt), 350);
    return () => window.clearTimeout(timer);
  }, [busy, currentPendingPracticeAttempt, feedback, online]);

  const finishPracticeSession = async () => {
    const activeSession = progressRef.current.activePractice;
    let details: Pick<PracticeSummary, "wrong" | "hesitant" | "guessed" | "overtime" | "repairedDue" | "weakModules" | "points"> = {
      wrong: Math.max(0, (activeSession?.answered ?? sessionAnswered) - (activeSession?.correct ?? sessionCorrect)),
      hesitant: 0,
      guessed: 0,
      overtime: 0,
      repairedDue: 0,
      weakModules: [],
      points: [],
    };
    const serverSessionId = activeSession?.serverSessionId;
    if (serverSessionId) {
      try {
        const result = await api<typeof details>({ action: "getPracticeSessionSummary", practiceSessionId: serverSessionId });
        details = { ...details, ...result };
      } catch {
        notify("本轮已完成，详细诊断稍后可在学习报告查看");
      }
    }
    const summary: PracticeSummary = activeSession ? {
      sessionId: activeSession.serverSessionId,
      kind: activeSession.kind,
      mode: activeSession.mode,
      answered: activeSession.answered,
      correct: activeSession.correct,
      reviewAdded: activeSession.reviewAdded ?? 0,
      elapsedSeconds: activeSession.elapsedSeconds,
      bankCodes: activeSession.bankCodes,
      ...details,
    } : {
      sessionId: undefined,
      kind: practiceKind,
      mode: practiceMode,
      answered: sessionAnswered,
      correct: sessionCorrect,
      reviewAdded: sessionReviewAdded,
      elapsedSeconds: sessionElapsedSeconds,
      bankCodes: practiceBankCodes,
      ...details,
    };
    setPracticeSummary(summary);
    setPracticeQuestions([]);
    setContentReportDraft(null);
    const current = progressRef.current;
    void persist({ ...current, activePractice: null });
  };

  const nextPracticeQuestion = () => {
    if (feedback?.correct && !answerConfidence) {
      notify("请先选择本题的掌握状态，系统将据此安排复习");
      return;
    }
    if (practiceIndex >= practiceQuestions.length - 1) { void finishPracticeSession(); return; }
    setPracticeIndex((value) => value + 1);
    setSelectedAnswer(null);
    setFeedback(null);
    setUncertain(false);
    setAnswerConfidence("");
    setContentReportDraft(null);
    setQuestionSeconds(0);
  };

  const updateQuestionMeta = async (values: { favorite?: boolean; wrongReason?: string }) => {
    if (!currentPractice) return;
    try {
      await api({ action: "updateQuestionMeta", questionCode: currentPractice.id, attemptId: feedback?.attemptId ?? 0, ...values });
      setPracticeQuestions((items) => items.map((item, index) => index === practiceIndex ? { ...item, ...values } : item));
      notify(values.favorite !== undefined ? values.favorite ? "已收藏这道题" : "已取消收藏" : "错因已记录");
    } catch (error) { notify(error instanceof Error ? error.message : "保存失败"); }
  };

  const submitContentReport = async () => {
    if (!currentPractice || contentReportDraft?.questionId !== currentPractice.id || !contentReportDraft.reasonCode) {
      return notify("请先选择问题类型");
    }
    if (contentReportDraft.reasonCode === "other" && contentReportDraft.detail.trim().length < 2) {
      return notify("请补充说明具体问题");
    }
    setContentReportSubmitting(true);
    try {
      const result = await api<{ duplicate?: boolean }>({
        action: "submitContentReport",
        questionCode: currentPractice.id,
        bankCode: currentPractice.bankCode,
        reasonCode: contentReportDraft.reasonCode,
        detail: contentReportDraft.detail.trim(),
      });
      setContentReportDraft((current) => current?.questionId === currentPractice.id ? { ...current, submitted: true } : current);
      notify(result.duplicate ? "这条问题已在处理中，无需重复提交" : "已收到，作答不受影响");
    } catch (error) {
      notify(error instanceof Error ? error.message : "报错提交失败，请稍后重试");
    } finally {
      setContentReportSubmitting(false);
    }
  };

  const markConfidence = async (confidence: Exclude<AnswerConfidence, "">) => {
    if (!currentPractice || !feedback || !feedback.correct || busy) return;
    if (answerConfidence) return notify("掌握程度已保存，本题不再重复改判");
    if (uncertain && confidence === "confident") return notify("本题已标记为把握不足，将按掌握不稳定安排复习");
    setBusy(true);
    try {
      const firstClassification = answerConfidence === "";
      const result = await api<{ state: AnswerFeedback["state"]; nextReviewAt: string | null; duplicate?: boolean; confidence?: AnswerConfidence; needsReview?: boolean }>({
        action: "updateQuestionMeta",
        questionCode: currentPractice.id,
        attemptId: feedback.attemptId,
        confidence,
      });
      const serverConfidence = result.confidence === "confident" || result.confidence === "hesitant" || result.confidence === "guessed"
        ? result.confidence
        : confidence;
      const serverNeedsReview = typeof result.needsReview === "boolean"
        ? result.needsReview
        : serverConfidence !== "confident" || feedback.overtime || uncertain;
      const newlyAdded = serverNeedsReview && !feedback.needsReview;
      setAnswerConfidence(serverConfidence);
      setFeedback((current) => current ? {
        ...current,
        state: result.state ?? current.state,
        needsReview: serverNeedsReview,
        reviewDays: serverNeedsReview ? 1 : current.reviewDays,
        nextReviewAt: result.nextReviewAt ?? current.nextReviewAt,
      } : current);
      const nextReviewAdded = newlyAdded ? sessionReviewAdded + 1 : sessionReviewAdded;
      if (newlyAdded) setSessionReviewAdded(nextReviewAdded);
      const current = progressRef.current;
      if (current.activePractice && (firstClassification || newlyAdded)) {
        const isFinal = practiceIndex >= practiceQuestions.length - 1;
        const nextActivePractice = {
          ...current.activePractice,
          cursor: firstClassification
            ? Math.min(current.activePractice.questionIds.length, current.activePractice.cursor + 1)
            : current.activePractice.cursor,
          reviewAdded: nextReviewAdded,
        };
        const completed = firstClassification && isFinal && current.activePractice.kind === "daily"
          ? { ...current.completed, [`${dayKey}-practice`]: true }
          : current.completed;
        const dailyComplete = !dailyConfigurationBlocking && enabledDailySteps.length > 0
          && enabledDailySteps.every((step) => step === "practice" || Boolean(completed[`${dayKey}-${step}`]));
        const checked = firstClassification && isFinal && current.activePractice.kind === "daily" && dailyComplete && !current.checkins.includes(dayKey)
          ? await recordValidDailyCheckin()
          : false;
        const checkins = checked ? [...current.checkins, dayKey] : current.checkins;
        await persist({ ...current, completed, checkins, activePractice: nextActivePractice });
        if (firstClassification && isFinal && current.activePractice.kind === "daily") setServerDailyPracticeCompleted(true);
      }
      if (serverConfidence === "guessed") setPracticeQuestions((items) => items.map((item, index) => index === practiceIndex ? { ...item, wrongReason: "蒙对了" } : item));
      trackEvent("practice_confidence", { confidence: serverConfidence, module: currentPractice.module, duplicate: Boolean(result.duplicate) });
      notify(serverConfidence === "confident"
        ? feedback.overtime ? "已记录为确定掌握；因作答超时，仍将安排复习" : "已记录为确定掌握"
        : serverConfidence === "hesitant" ? "已按掌握不稳定安排明日复习" : "猜测作答不计为稳定掌握，明日将再次复习");
    } catch (error) { notify(error instanceof Error ? error.message : "掌握状态保存失败"); }
    finally { setBusy(false); }
  };

  const toggleFavoritePhrase = (phrase: string) => {
    const current = progress;
    const favorites = current.favorites.includes(phrase) ? current.favorites.filter((item) => item !== phrase) : [...current.favorites, phrase];
    void persist({ ...current, favorites });
  };

  const toggleEssayCheck = (item: string) => {
    if (essayStage !== "self_check") return;
    const currentProgress = progressRef.current;
    const current = currentProgress.essayChecks[essayDraftKey] ?? [];
    const nextChecks = current.includes(item) ? current.filter((value) => value !== item) : [...current, item];
    void persist({ ...currentProgress, essayChecks: { ...currentProgress.essayChecks, [essayDraftKey]: nextChecks } });
  };

  const updateEssayDraft = (value: string) => {
    if (essayStage !== "draft") return;
    const current = progressRef.current;
    const next = { ...current, essayDrafts: { ...current.essayDrafts, [essayDraftKey]: value } };
    progressRef.current = next;
    setProgress(next);
  };

  const saveEssayStage = async (stage: EssayStage, current: Progress, rewriteDueAt?: string) => {
    if (!essayQuestion) {
      notify("这道申论真题尚未成功加载，请返回后重试");
      return false;
    }
    try {
      const result = await api<{ scoringPoints?: string[]; reference?: string; attempt?: EssayAttemptSnapshot }>({
        action: "saveEssayAttempt",
        questionCode: essayQuestion.id,
        dateKey: essayAttemptDateKey,
        stage,
        firstDraft: current.essayDrafts[essayDraftKey] ?? "",
        selfChecks: current.essayChecks[essayDraftKey] ?? [],
        selfScore: current.essaySelfScores[essayDraftKey],
        lossReasons: current.essayLossReasons[essayDraftKey] ?? [],
        revisedDraft: current.essaySecondDrafts[essayDraftKey] ?? "",
        rewriteDraft: current.essayRewriteDrafts[essayDraftKey] ?? "",
        rewriteDueAt: rewriteDueAt ?? current.essayRewriteDue[essayDraftKey] ?? "",
        elapsedSeconds: essayElapsedSeconds,
      });
      if (result.scoringPoints || result.reference !== undefined) {
        setEssayPracticeQuestions((questions) => questions.map((question) => question.id === essayQuestion.id ? {
          ...question,
          scoringPoints: result.scoringPoints ?? question.scoringPoints,
          reference: result.reference ?? question.reference,
        } : question));
      }
      if (result.attempt) {
        const snapshot = normalizeEssayAttempt(result.attempt);
        if (snapshot) {
          const hydrated = applyEssayAttemptSnapshot(progressRef.current, essayQuestion.id, snapshot);
          progressRef.current = hydrated;
          setProgress(hydrated);
          setEssayPracticeQuestions((questions) => questions.map((question) => question.id === essayQuestion.id
            ? { ...question, serverAttempt: snapshot }
            : question));
          await persist(hydrated);
        }
      }
      return true;
    } catch (error) {
      notify(error instanceof Error ? error.message : "申论进度同步失败，请重试");
      return false;
    }
  };

  const submitEssayDraft = async () => {
    const current = progressRef.current;
    if ((current.essayDrafts[essayDraftKey] ?? "").trim().length < 10) return notify("先独立完成至少10个字的作答");
    if (!(await saveEssayStage("self_check", current))) return;
    trackEvent("essay_draft_submit", { questionId: essayQuestion?.id, stage: "self_check" });
    notify("独立作答已锁定，现在只按标准自查，不会提前看到答案");
  };

  const submitEssayChecks = async () => {
    const current = progressRef.current;
    if ((current.essayChecks[essayDraftKey] ?? []).length < 2) return notify("请按标准完成至少两项自查");
    if (!(await saveEssayStage("self_score", current))) return;
    notify("采分点已显示，请先完成自评，再查看参考表达");
  };

  const setEssaySelfScore = (score: number) => {
    const current = progressRef.current;
    void persist({ ...current, essaySelfScores: { ...current.essaySelfScores, [essayDraftKey]: score } });
  };

  const toggleEssayLossReason = (reason: string) => {
    if (essayStage !== "self_score") return;
    const current = progressRef.current;
    const selected = current.essayLossReasons[essayDraftKey] ?? [];
    const next = selected.includes(reason) ? selected.filter((item) => item !== reason) : [...selected, reason];
    void persist({ ...current, essayLossReasons: { ...current.essayLossReasons, [essayDraftKey]: next } });
  };

  const submitEssaySelfScore = async () => {
    const current = progressRef.current;
    if (!Number.isFinite(current.essaySelfScores[essayDraftKey])) return notify("请先按采分点选择自评得分");
    if (!(await saveEssayStage("revision", current))) return;
    setEssayReference(true);
    notify("参考表达已显示，请对照后完成第二版作答");
  };

  const updateEssaySecondDraft = (value: string) => {
    if (essayStage !== "revision") return;
    const current = progressRef.current;
    const next = { ...current, essaySecondDrafts: { ...current.essaySecondDrafts, [essayDraftKey]: value } };
    progressRef.current = next;
    setProgress(next);
  };

  const submitEssayRevision = async () => {
    const current = progressRef.current;
    if ((current.essaySecondDrafts[essayDraftKey] ?? "").trim().length < 10) return notify("请完成至少10个字的第二版作答");
    const rewriteDue = shiftDateKey(dayKey, 3);
    if (!(await saveEssayStage("scheduled", current, rewriteDue))) return;
    if (essayCompletesDaily) await complete(`${dayKey}-essay`);
    trackEvent("essay_revision_submit", { questionId: essayQuestion?.id, rewriteDue });
    notify(`第二版作答已保存，${shortDate(rewriteDue)}安排一次独立重写`);
    setActiveModule(null);
    setTab(essayCompletesDaily ? "report" : "today");
  };

  const updateEssayRewriteDraft = (value: string) => {
    const current = progressRef.current;
    const next = { ...current, essayRewriteDrafts: { ...current.essayRewriteDrafts, [essayDraftKey]: value } };
    progressRef.current = next;
    setProgress(next);
  };

  const submitEssayRewrite = async () => {
    const current = progressRef.current;
    if ((current.essayRewriteDrafts[essayDraftKey] ?? "").trim().length < 10) return notify("请先完成独立重写");
    if (!(await saveEssayStage("completed", current))) return;
    if (essayCompletesDaily) await complete(`${dayKey}-essay`);
    notify("3天后独立重写已完成，本题全部训练步骤已完成");
    setActiveModule(null);
  };

  const speakMorning = () => {
    if (!("speechSynthesis" in window)) return notify("当前浏览器暂不支持语音朗读");
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance([day.morning.title, day.morning.lead, ...day.morning.paragraphs].join("。"));
    utterance.lang = "zh-CN";
    utterance.rate = 0.92;
    window.speechSynthesis.speak(utterance);
    notify("已开始逐段朗读");
  };

  const redeem = async () => {
    if (!redeemCode.trim()) return notify("请输入兑换码");
    setBusy(true);
    try {
      const result = await api<{ grantType: "duration" | "lifetime"; days: number | null }>({ action: "redeem", code: redeemCode });
      setRedeemCode("");
      notify(result.grantType === "lifetime" ? "激活成功，已升级为终身会员" : `激活成功，会员时长增加 ${result.days} 天`);
      const resume = resumeAfterPaywallRef.current;
      resumeAfterPaywallRef.current = null;
      await loadBootstrap();
      if (resume) window.setTimeout(() => void resume(), 0);
    } catch (error) { notify(error instanceof Error ? error.message : "兑换失败"); }
    finally { setBusy(false); }
  };

  const copyInvite = async () => {
    if (!bootstrap?.user.signedIn) return;
    if (!bootstrap.user.inviteCode) return notify("邀请码正在生成");
    const url = `${window.location.origin}/?invite=${bootstrap.user.inviteCode}`;
    const shareText = `我的公考日练邀请码：${bootstrap.user.inviteCode}\n${url}`;
    try { await navigator.clipboard.writeText(shareText); notify("邀请码和邀请链接已复制；好友完成奖励条件后，双方会员时长将自动发放"); }
    catch { notify(shareText); }
  };

  useEffect(() => {
    if (!bootstrap?.user.signedIn) return;
    const intent = readPaywallLoginIntent();
    try { window.sessionStorage.removeItem(PAYWALL_LOGIN_INTENT_KEY); } catch { /* one-shot in this tab when storage is available */ }
    if (!intent) return;
    const context = intent.returnContext;
    const allowedBankCodes = new Set(bootstrap.questionBanks.map((bank) => bank.code));
    const bankCodes = Array.isArray(context.bankCodes)
      ? context.bankCodes.map(String).filter((code) => allowedBankCodes.has(code)).slice(0, 12)
      : [];
    const kind = ["daily", "review", "bank", "bonus", "diagnostic"].includes(String(context.practiceKind ?? context.sessionKind))
      ? String(context.practiceKind ?? context.sessionKind) as PracticeKind
      : "daily";
    let resume: null | (() => void | Promise<void>) = null;
    if (context.resumeAction === "toggle_bank") {
      const bank = bootstrap.questionBanks.find((item) => item.code === String(context.bankCode ?? ""));
      if (bank) resume = () => toggleBank(bank);
    } else if (context.resumeAction === "save_position") {
      const positionId = String(context.positionId ?? "").slice(0, 100);
      if (positionId) resume = async () => {
        const current = progressRef.current;
        if (!current.savedPositionIds.includes(positionId)) await persist({ ...current, savedPositionIds: [...current.savedPositionIds, positionId].slice(-120) });
        notify("已恢复刚才的操作，职位已加入备选");
      };
    } else if (context.resumeAction === "compare_position") {
      const positionId = String(context.positionId ?? "").slice(0, 100);
      const position = radarPositions.find((item) => item.id === positionId) ?? bootstrap.content.jobPositions.find((item) => item.id === positionId);
      resume = () => {
        setRadarMode("positions");
        setTab("calendar");
        if (position) toggleComparedPosition(position, true);
        else notify("权益已同步，请在职位列表中再次点击“加入对比”");
      };
    } else if (context.resumeAction === "start_practice") {
      const rawOptions = context.practiceOptions && typeof context.practiceOptions === "object" ? context.practiceOptions as Record<string, unknown> : {};
      const options: PracticeStartOptions = {
        kind: ["daily", "review", "bank", "bonus", "diagnostic"].includes(String(rawOptions.kind)) ? String(rawOptions.kind) as PracticeKind : kind,
        limit: Number.isFinite(Number(rawOptions.limit)) ? Math.max(1, Math.min(20, Math.floor(Number(rawOptions.limit)))) : undefined,
        forceNew: rawOptions.forceNew === true,
        focusModule: String(rawOptions.focusModule ?? "").slice(0, 40) || undefined,
        focusSubTypes: Array.isArray(rawOptions.focusSubTypes) ? rawOptions.focusSubTypes.map(String).map((item) => item.slice(0, 40)).slice(0, 12) : undefined,
        strictFocus: rawOptions.strictFocus === true,
        focusLabel: String(rawOptions.focusLabel ?? "").slice(0, 80) || undefined,
      };
      const mode: PracticeMode = context.mode === "review" ? "review" : "mixed";
      resume = () => startPractice(mode, bankCodes.length ? bankCodes : undefined, options);
    } else if (context.resumeAction === "resume_practice") {
      const mode: PracticeMode = context.mode === "review" ? "review" : "mixed";
      resume = () => startPractice(mode, bankCodes.length ? bankCodes : undefined, { kind });
    } else if (context.resumeAction === "start_essay") {
      const rawOptions = context.essayOptions && typeof context.essayOptions === "object" ? context.essayOptions as Record<string, unknown> : {};
      const options: EssayStartOptions = {
        bankCodes: Array.isArray(rawOptions.bankCodes) ? rawOptions.bankCodes.map(String).filter((code) => allowedBankCodes.has(code)).slice(0, 12) : undefined,
        daily: rawOptions.daily !== false,
        focusModule: String(rawOptions.focusModule ?? "").slice(0, 40) || undefined,
        focusSubTypes: Array.isArray(rawOptions.focusSubTypes) ? rawOptions.focusSubTypes.map(String).map((item) => item.slice(0, 40)).slice(0, 12) : undefined,
        questionCode: String(rawOptions.questionCode ?? "").slice(0, 100) || undefined,
      };
      resume = () => startEssayPractice(options);
    } else if (context.resumeAction === "play_audio") {
      resume = () => {
        setTab("audio");
        notify("会员权益已同步，请再次点击播放");
      };
    }
    const returnTab = String(context.tab ?? "");
    window.setTimeout(() => {
      if (["today", "banks", "resources", "audio", "review", "report", "calendar", "me"].includes(returnTab)) setTab(returnTab as Tab);
      if (bootstrap.user.membershipActive) {
        if (resume) void resume();
        else notify("登录成功，会员权益已同步");
        return;
      }
      openPaywall(intent.reason, resume ?? undefined, context);
      notify("登录成功，已回到刚才的权益操作");
    }, 0);
    // The intent is removed before replay, so rerenders and refreshes cannot run it twice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bootstrap?.user.id, bootstrap?.user.signedIn, bootstrap?.user.membershipActive, openPaywall]);

  const firstCompletedPractice = bootstrap?.firstCompletedPractice ?? null;
  const primaryTodayResolution = resolveDailyPrimaryTask({
    onboarded: profile.onboarded,
    targetCount: profile.targets.length,
    dailyReady: !dailyConfigurationBlocking,
    criticalReminderId: criticalReminder?.id ?? null,
    activeSessionKind: progress.activePractice && ["daily", "diagnostic"].includes(progress.activePractice.kind)
      ? progress.activePractice.kind as "daily" | "diagnostic" : null,
    activeSessionDateKey: progress.activePractice?.dateKey ?? null,
    todayKey: dayKey,
    firstCompletedSessionId: firstCompletedPractice?.sessionId ?? null,
    firstResultSeenSessionId: progress.firstResultSeenSessionId,
    dailyTasksDone,
    checkinDone: dailyCheckinDone,
    dueCount: insights.dueCount,
    morningEnabled: enabledDailySteps.includes("morning"),
    morningDone: stepDone.morning,
    practiceEnabled: enabledDailySteps.includes("practice"),
    practiceDone: stepDone.practice,
    essayEnabled: enabledDailySteps.includes("essay"),
    essayDone: stepDone.essay,
  });
  const primaryTodayState = primaryTodayResolution.state as DailyPrimaryState;

  const viewFirstPracticeResult = async () => {
    if (!firstCompletedPractice?.sessionId) return;
    setBusy(true);
    try {
      const result = await api<PracticeSummary>({ action: "getPracticeSessionSummary", practiceSessionId: firstCompletedPractice.sessionId });
      setPracticeSummary({
        ...result,
        sessionId: result.sessionId || firstCompletedPractice.sessionId,
        kind: result.kind === "daily" ? "daily" : "diagnostic",
        mode: result.mode === "review" ? "review" : "mixed",
        bankCodes: Array.isArray(result.bankCodes) ? result.bankCodes : [],
        weakModules: Array.isArray(result.weakModules) ? result.weakModules : [],
        points: Array.isArray(result.points) ? result.points : [],
      });
      setActiveModule("practice");
    } catch (error) { notify(error instanceof Error ? error.message : "首次训练结果暂时无法读取"); }
    finally { setBusy(false); }
  };

  const primaryTodayCopy = (() => {
    switch (primaryTodayState) {
      case "needs_target": return { eyebrow: "开始使用", title: "先设置你的报考目标", detail: "可同时选择国考和多个省考，系统自动匹配题库与日练。", actionLabel: "设置报考目标" };
      case "needs_bank": return { eyebrow: "备考组合待补全", title: bootstrap.dailyReadiness ? `可练真题${dailyReadinessCount}/${dailyReadinessRequired}道` : "加入一套可参与日练的真题库", detail: "仅统计地区、年份匹配且已核验的非重复真题。", actionLabel: "补全可练题库" };
      case "critical_exam": return { eyebrow: criticalReminder?.days === 0 ? "今日需处理" : "报考事项临近", title: `${criticalReminder?.targetLabel ?? "报考目标"} · ${criticalReminder?.title ?? "核对报考节点"}`, detail: `${criticalReminder ? shortDate(criticalReminder.eventDate) : ""} · 请核对官方公告，避免错过。`, actionLabel: "立即核对报考事项" };
      case "resume_session": return { eyebrow: primaryTodayResolution.activeSessionKind === "diagnostic" ? "首次体验未完成" : "训练进度已保存", title: primaryTodayResolution.activeSessionKind === "diagnostic" ? "继续完成首次5题体验" : `继续行测日练，还剩${dailyRemaining}题`, detail: "进度已保存，继续作答即可。", actionLabel: primaryTodayResolution.activeSessionKind === "diagnostic" ? "继续首次体验" : "继续今日训练" };
      case "sync_checkin": return { eyebrow: "任务已完成", title: "同步今日打卡", detail: "同步成功后计入连续打卡。", actionLabel: "同步今日打卡" };
      case "first_practice": return { eyebrow: "首次体验", title: "先完成5道真题，建立学习基线", detail: "约5分钟，完成后生成薄弱点和复习安排。", actionLabel: "开始5题体验" };
      case "first_result": return { eyebrow: "首次结果已生成", title: "查看首份学习诊断", detail: "查看正确率、薄弱模块和待复习题。", actionLabel: "查看首次诊断" };
      case "due_review": return { eyebrow: "到期复习优先", title: `${insights.dueCount}道题今日到期`, detail: `先复习，再练${primaryBank?.name ?? "主攻题库"}新题。`, actionLabel: "开始到期复习" };
      case "morning": return { eyebrow: `晨读 ${dailyPlan.morningMinutes}分钟`, title: "先完成今日晨读", detail: `阅读《${day.morning.title}》，提取规范表达。`, actionLabel: `开始今日${dailyPlan.minutes}分钟训练` };
      case "practice": return { eyebrow: `行测日练 ${dailyPlan.practiceMinutes}分钟`, title: `完成${dailyPlan.questionCount}道真题`, detail: `${primaryBank ? `主攻${primaryBank.name}` : "已加入题库"} · 到期题优先。`, actionLabel: `开始行测日练 · ${dailyPlan.questionCount}题` };
      case "essay": return { eyebrow: `申论真题 ${dailyPlan.essayMinutes}分钟`, title: "完成今日申论真题微练", detail: "独立作答后，按采分点自评。", actionLabel: "开始申论微练" };
      default: return { eyebrow: "今日已完成", title: "今日学习任务已完成", detail: "结果已保存，可查看报告和明日安排。", actionLabel: "查看学习报告" };
    }
  })();
  const dailyActionLabel = primaryTodayCopy.actionLabel;
  const primaryActionMeta = primaryTodayState === "needs_target" ? "约1分钟 · 可同时选择多个考试"
    : primaryTodayState === "needs_bank" ? `还差${Math.max(0, dailyReadinessRequired - dailyReadinessCount)}道 · 补足后自动编排`
      : primaryTodayState === "critical_exam" ? "报考事项优先于今日学习任务"
        : primaryTodayState === "first_practice" || (primaryTodayState === "resume_session" && primaryTodayResolution.activeSessionKind === "diagnostic") ? "5道真题 · 约5分钟"
          : primaryTodayState === "first_result" ? "结果依据实际作答生成"
            : primaryTodayState === "sync_checkin" ? "学习任务已完成 · 点击重新同步"
              : primaryTodayState === "complete" ? "查看报告与明日安排"
                : `预计${dailyPlan.minutes}分钟 · 完成后自动打卡`;

  const runDailyAction = () => {
    if (primaryTodayState === "needs_target") { setProfileDraft(profile); setOnboardingOpen(true); return; }
    if (primaryTodayState === "needs_bank") { setBankFilter("适合我"); setTab("banks"); return; }
    if (primaryTodayState === "critical_exam") {
      if (criticalReminder) { setFocusedEventId(criticalReminder.id); setRadarMode("tasks"); }
      setTab("calendar"); return;
    }
    if (primaryTodayState === "resume_session") return void startPractice("mixed", undefined, { kind: primaryTodayResolution.activeSessionKind ?? "daily", limit: primaryTodayResolution.activeSessionKind === "diagnostic" ? 5 : undefined });
    if (primaryTodayState === "sync_checkin") return void syncDailyCheckin();
    if (primaryTodayState === "first_practice") return void startPractice("mixed", undefined, { kind: "diagnostic", limit: 5 });
    if (primaryTodayState === "first_result") return void viewFirstPracticeResult();
    if (primaryTodayState === "due_review" || primaryTodayState === "practice") return void startPractice("mixed", undefined, { kind: "daily" });
    if (primaryTodayState === "morning") return setActiveModule("morning");
    if (primaryTodayState === "essay") return void startEssayPractice({ daily: true });
    setTab("report");
  };

  const runBonusPractice = () => {
    if (!orderedBankCodes.length) {
      setBankFilter("适合我");
      setTab("banks");
      return notify("请先添加一套可练题库，再进行专项强化");
    }
    void startPractice("mixed", orderedBankCodes, { kind: "bonus", limit: 5, forceNew: true });
  };

  const renderPractice = () => {
    if (practiceSummary) {
      const accuracy = practiceSummary.answered ? Math.round((practiceSummary.correct / practiceSummary.answered) * 100) : 0;
      const closeLabel = practiceSummary.kind === "daily"
        ? nextDailyStep === "morning" ? "继续晨读" : nextDailyStep === "essay" ? "继续申论微练" : "完成今日学习"
        : practiceSummary.kind === "review" ? "完成到期复习" : "结束本轮";
      const closeSummary = async () => {
        if (practiceSummary.sessionId && (practiceSummary.sessionId === bootstrap.firstCompletedPractice?.sessionId
          || (!bootstrap.firstCompletedPractice && practiceSummary.kind === "diagnostic" && practiceSummary.answered >= 5))
          && progressRef.current.firstResultSeenSessionId !== practiceSummary.sessionId) {
          const current = progressRef.current;
          await persist({ ...current, firstResultSeenSessionId: practiceSummary.sessionId });
        }
        setPracticeSummary(null);
        setActiveModule(null);
        if (practiceSummary.kind === "daily" && nextDailyStep === "morning") return setActiveModule("morning");
        if (practiceSummary.kind === "daily" && nextDailyStep === "essay") return void startEssayPractice({ daily: true });
        setTab(practiceSummary.kind === "review" ? "review" : practiceSummary.kind === "daily" ? "report" : "today");
        void loadBootstrap();
      };
      return <article className="practice-summary">
        <span>✓</span><h3>{practiceSummary.kind === "diagnostic" ? "能力诊断结果已生成" : `已完成${practiceSummary.answered}道题，查看本轮训练结果`}</h3><p>{practiceSummary.kind === "diagnostic" ? `当前优先训练：${practiceSummary.weakModules.slice(0, 2).map((item) => item.module).join("、") || "继续积累有效作答"}。薄弱点与复习时间均依据本次实际作答生成。` : practiceSummary.repairedDue > 0 ? `本轮完成${practiceSummary.repairedDue}道到期题复习；答错、掌握不稳定及猜测作答的题目已纳入后续复习。` : practiceSummary.kind === "daily" && nextDailyStep ? "本轮结果已保存，请继续今日下一项学习任务。" : "本轮结果与复习时间已保存，无需手动整理错题。"}</p>
        {practiceSummary.points.length > 0 && <section className="practice-summary-points"><div><b>本轮考点结果</b><small>按考点展示掌握情况</small></div>{practiceSummary.points.slice(0, 3).map((point) => <article key={point.point}><span>{point.point}</span><p>{point.total}题 · 答对{point.correct}题{point.repairedDue ? ` · 复习后答对${point.repairedDue}题` : ""}{point.wrong ? ` · 答错${point.wrong}题` : ""}{point.uncertain ? ` · ${point.uncertain}题掌握不稳定` : ""}</p></article>)}</section>}
        <div className="practice-summary-stats"><div><b>{accuracy}%</b><span>正确率</span></div><div><b>{Math.floor(practiceSummary.elapsedSeconds / 60)}:{String(practiceSummary.elapsedSeconds % 60).padStart(2, "0")}</b><span>本轮用时</span></div><div><b>{practiceSummary.reviewAdded}</b><span>纳入复习</span></div><div><b>{practiceSummary.wrong}</b><span>答错</span></div><div><b>{practiceSummary.hesitant}</b><span>掌握不稳定</span></div><div><b>{practiceSummary.guessed}</b><span>猜测作答</span></div><div><b>{practiceSummary.overtime}</b><span>超时</span></div><div><b>{practiceSummary.repairedDue}</b><span>完成到期复习</span></div></div>
        {practiceSummary.kind === "diagnostic" && !bootstrap?.user.signedIn && <p className="diagnostic-save-note">登录后可将本次薄弱点、错题和复习安排同步到其他设备，并获得一次72小时完整体验。</p>}
        <div className="practice-summary-actions"><button className="primary-button" onClick={closeSummary}>{closeLabel}</button>{(practiceSummary.kind !== "daily" || !nextDailyStep) && <button className="secondary-button" onClick={() => { const summary = practiceSummary; setPracticeSummary(null); void startPractice("mixed", summary.bankCodes, { kind: "bonus", limit: 5, forceNew: true }); }}>专项强化10分钟</button>}</div>
      </article>;
    }
    if (!currentPractice) return <div className="empty-state"><span>练</span><h3>正在准备题目</h3></div>;
    const finished = feedback && practiceIndex === practiceQuestions.length - 1;
    const target = progress.activePractice?.questionTarget ?? practiceQuestions.length;
    const targetSeconds = feedback?.targetSeconds ?? currentPractice.suggestedSeconds ?? questionTargetSeconds(currentPractice);
    const truthLabel = normalizeTruthLabel(currentPractice.region, currentPractice.examYear, currentPractice.truthLabel || currentPractice.scopeLabel || currentPractice.source);
    const importance = starText(currentPractice.importanceStars, currentPractice.importanceMeta, true);
    const scoreRate = scoreRateText(currentPractice.scoreRate, currentPractice.scoreRateMeta, true);
    const frequency = frequencyText(currentPractice.frequency, currentPractice.frequencyMeta, true);
    const valueSignals = [frequency, importance, scoreRate].filter(Boolean);
    const activeContentReport = contentReportDraft?.questionId === currentPractice.id ? contentReportDraft : null;
    return (
      <div className="smart-practice">
        <div className="practice-overview">
          <div><span>{practiceMode === "review" ? "到期复习" : currentPractice.planReason}</span><b>{currentPractice.bankName}</b></div>
          <div><strong>{Math.min(target, sessionAnswered + (feedback ? 0 : 1))}</strong> / {target}<small>{questionSeconds}s / 建议{targetSeconds}s{sessionAnswered ? ` · 正确率${Math.round((sessionCorrect / sessionAnswered) * 100)}%` : ""}</small></div>
        </div>
        <div className="practice-composition"><span>到期 {practiceComposition.due}</span><span>其中薄弱 {practiceComposition.weak}</span><span>新题 {practiceComposition.new}</span><span>主攻 {practiceComposition.primary} · 兼顾 {practiceComposition.other}</span><b>还剩 {Math.max(0, target - sessionAnswered)} 题</b></div>
        <div className="practice-progress"><i style={{ width: `${Math.min(100, (sessionAnswered / Math.max(1, target)) * 100)}%` }} /></div>
        <article className="question-card smart-question-card">
          <div className="question-context"><span>{truthLabel || currentPractice.scopeLabel}</span><b>推荐理由：{[currentPractice.planReason, ...valueSignals].filter(Boolean).join(" · ")}</b></div>
          {valueSignals.length > 0 && <div className="truth-signal-row" aria-label="真题价值标签">{frequency && <span>{frequency}</span>}{importance && <span className="importance-stars">{importance}</span>}{scoreRate && <span>{scoreRate}</span>}</div>}
          <MetricMethod frequency={currentPractice.frequencyMeta} importance={currentPractice.importanceMeta} scoreRate={currentPractice.scoreRateMeta} />
          <div className="question-meta"><span>{currentPractice.module} · {currentPractice.knowledge}</span><em>{currentPractice.difficulty}</em></div>
          <h3>{currentPractice.stem}</h3>
          {currentPractice.imageUrl && <figure className="question-resource"><img src={currentPractice.imageUrl} alt={`${truthLabel || "本题"}配图或图表`} loading="lazy" /></figure>}
          {currentPractice.resourceUrl && <a className="question-resource-link" href={currentPractice.resourceUrl} target="_blank" rel="noreferrer">查看题目原始附件</a>}
          <div className="options-list">
            {currentPractice.options.map((option, index) => {
              const state = feedback && index === feedback.correctAnswer ? " correct" : feedback && index === selectedAnswer && !feedback.correct ? " wrong" : selectedAnswer === index ? " selected" : "";
              return <button key={`${index}-${option}`} disabled={Boolean(feedback) || Boolean(currentPendingPracticeAttempt) || busy} className={`option${state}`} onClick={() => void answerPractice(index)}><b>{String.fromCharCode(65 + index)}</b><span>{option}</span></button>;
            })}
          </div>
          {!feedback && !currentPendingPracticeAttempt && <button className={`uncertain-button ${uncertain ? "active" : ""}`} aria-pressed={uncertain} onClick={() => setUncertain((value) => !value)}>？ {uncertain ? "已标记为把握不足（答对后仍会复习）" : "标记为把握不足"}</button>}
          {!feedback && currentPendingPracticeAttempt && <div className={`practice-pending-sync${currentPendingPracticeAttempt.blocked ? " blocked" : ""}`}>
            <div><b>{busy ? "正在同步本题…" : "本题暂未同步"}</b><span>{currentPendingPracticeAttempt.blocked
              ? "同步失败，本次答案尚未保存，请刷新后重新提交。"
              : online
                ? `已保留选项 ${String.fromCharCode(65 + currentPendingPracticeAttempt.payload.selectedAnswer)}，系统将自动重试；同步成功前不计入进度。`
                : `已保留选项 ${String.fromCharCode(65 + currentPendingPracticeAttempt.payload.selectedAnswer)}；恢复联网后自动重试，同步成功前不计入进度，当前不能查看解析。`}</span></div>
            <div><button disabled={!online || busy} onClick={() => retryPendingPracticeRef.current(currentPendingPracticeAttempt)}>{busy ? "同步中…" : "重试同步"}</button>{currentPendingPracticeAttempt.blocked && <button className="secondary" onClick={() => window.location.reload()}>刷新并核对</button>}</div>
          </div>}
          <div className="content-report-entry">
            <button
              className="content-report-trigger"
              aria-expanded={Boolean(activeContentReport && !activeContentReport.submitted)}
              onClick={() => setContentReportDraft((current) => current?.questionId === currentPractice.id
                ? current.submitted ? current : null
                : { questionId: currentPractice.id, reasonCode: "", detail: "", submitted: false })}
            >
              {activeContentReport?.submitted ? "✓ 已反馈" : activeContentReport ? "收起报错" : "题目有误？反馈"}
            </button>
            {activeContentReport?.submitted && <span>反馈已提交，平台将进行核对；本题仍可继续作答</span>}
          </div>
          {activeContentReport && !activeContentReport.submitted && <div className="content-report-panel" aria-label="题目报错">
            <strong>哪里有问题？</strong>
            <div className="content-report-reasons">
              {contentReportReasons.map((reason) => <button
                key={reason.code}
                className={activeContentReport.reasonCode === reason.code ? "active" : ""}
                aria-pressed={activeContentReport.reasonCode === reason.code}
                onClick={() => setContentReportDraft((current) => current?.questionId === currentPractice.id ? { ...current, reasonCode: reason.code } : current)}
              >{reason.label}</button>)}
            </div>
            <textarea
              aria-label="题目报错补充说明"
              rows={3}
              maxLength={500}
              value={activeContentReport.detail}
              placeholder={activeContentReport.reasonCode === "other" ? "请说明具体问题（必填）" : "补充说明（选填），请勿填写个人信息"}
              onChange={(event) => setContentReportDraft((current) => current?.questionId === currentPractice.id ? { ...current, detail: event.target.value } : current)}
            />
            <div className="content-report-actions"><small>{activeContentReport.detail.length}/500</small><button disabled={contentReportSubmitting || !activeContentReport.reasonCode} onClick={() => void submitContentReport()}>{contentReportSubmitting ? "提交中…" : "提交报错"}</button></div>
          </div>}
          {feedback && <div className={`answer-result ${feedback.correct ? "is-correct" : "is-wrong"}`}>
            <div><strong>{feedback.correct ? "回答正确" : `正确答案 ${String.fromCharCode(65 + feedback.correctAnswer)}`}</strong><span>{feedback.needsReview ? `${feedback.overtime ? "超时" : "需巩固"} · ${feedback.reviewDays}天后复习` : feedback.state === "mastered" ? `已掌握 · ${feedback.reviewDays}天后巩固` : `学习中 · ${feedback.reviewDays}天后复习`}</span></div>
            <small className="review-next-date">下次安排：{reviewDateLabel(feedback.nextReviewAt, dayKey)}</small>
            <p>{feedback.explanation}</p>
            {feedback.technique && <aside><b>解题提示</b>{feedback.technique}</aside>}
            <footer><span>题源：{truthLabel || normalizeTruthLabel(undefined, undefined, currentPractice.source) || "已核验真题"}{currentPractice.reviewedAt ? ` · 校验 ${currentPractice.reviewedAt.slice(0, 10)}` : ""}</span><button onClick={() => void updateQuestionMeta({ favorite: !currentPractice.favorite })}>{currentPractice.favorite ? "★ 已收藏" : "☆ 收藏"}</button></footer>
          </div>}
        </article>
        {feedback && !feedback.correct && <div className="wrong-reason-box"><span>请选择本题的错误原因</span><div>{reasonOptions.map((reason) => <button key={reason.value} className={currentPractice.wrongReason === reason.value ? "active" : ""} onClick={() => void updateQuestionMeta({ wrongReason: reason.value })}>{reason.label}</button>)}</div></div>}
        {feedback?.correct && <div className="confidence-box"><span>请选择本题的掌握状态</span><div><button disabled={uncertain || busy || Boolean(answerConfidence)} className={answerConfidence === "confident" ? "active" : ""} onClick={() => void markConfidence("confident")}>确定掌握</button><button disabled={busy || Boolean(answerConfidence)} className={answerConfidence === "hesitant" ? "active" : ""} onClick={() => void markConfidence("hesitant")}>掌握不稳定</button><button disabled={busy || Boolean(answerConfidence)} className={answerConfidence === "guessed" ? "active" : ""} onClick={() => void markConfidence("guessed")}>猜测作答</button></div><small>{answerConfidence ? "掌握状态已确认。" : "掌握不稳定、猜测作答或超时答对均不计为稳定掌握。"}</small></div>}
        {feedback && <button className="primary-button full-button practice-next" disabled={busy || (feedback.correct && !answerConfidence)} onClick={nextPracticeQuestion}>{feedback.correct && !answerConfidence ? "先确认掌握程度" : finished ? "查看本轮总结" : "下一题"}</button>}
      </div>
    );
  };

  const renderModule = () => {
    if (!activeModule) return null;
    const essayPrompt = essayQuestion?.prompt ?? day.essay.prompt;
    const essayMaterial = essayQuestion?.material ?? day.essay.material ?? "";
    const essayWordLimit = essayQuestion?.wordLimit ?? day.essay.wordLimit ?? 60;
    const essayReferenceText = essayQuestion?.reference ?? day.essay.reference;
    const essayScoringPoints = essayQuestion?.scoringPoints ?? day.essay.scoringPoints ?? [];
    const essayTruthLabel = essayQuestion?.truthLabel ?? "";
    const essaySignals = essayQuestion ? [
      frequencyText(essayQuestion.frequency, essayQuestion.frequencyMeta, true),
      starText(essayQuestion.importanceStars, essayQuestion.importanceMeta, true),
      scoreRateText(essayQuestion.scoreRate, essayQuestion.scoreRateMeta, true),
    ].filter(Boolean) : [];
    const essayMaxScore = Math.max(1, essayScoringPoints.length || 5);
    const essayRewriteIsDue = Boolean(essayRewriteDue && essayRewriteDue <= dayKey);
    return (
      <section className="module-page" aria-label="学习模块">
        <header className="module-header">
          <button className="icon-button" onClick={() => setActiveModule(null)} aria-label="返回首页">‹</button>
          <div><span className="eyebrow">{activeModule === "practice" ? "智能学习队列" : `第 ${day.day} 组 · ${day.label}`}</span><h2>{activeModule === "morning" ? "晨读训练" : activeModule === "practice" ? "行测智能练习" : activeModule === "affairs" ? "时政常识" : "申论表达"}</h2></div>
          <span className="day-pill">{activeModule === "practice" ? currentPendingPracticeAttempt ? "本题尚未同步" : online ? "练习进度自动保存" : "离线，进度未同步" : activeModule === "morning" ? `约${dailyPlan.morningMinutes}分钟` : activeModule === "essay" ? `约${dailyPlan.essayMinutes}分钟` : "约5分钟"}</span>
        </header>

        {activeModule === "practice" && renderPractice()}

        {activeModule === "morning" && <div className="reading-card enhanced-reading">
          <div className="reading-steps"><span className="active">1 阅读</span><span>2 记表达</span><span>3 尝试复述</span></div>
          <span className="content-tag">今日晨读</span><h3>{day.morning.title}</h3><p className="lead">{day.morning.lead}</p>
          {day.morning.paragraphs.map((paragraph) => <p key={paragraph}>{hideKeywords ? day.morning.keywords.reduce((text, keyword) => text.replaceAll(keyword, "____"), paragraph) : paragraph}</p>)}
          <div className="keyword-training"><div><b>今天记住这3个表达</b><button onClick={() => setHideKeywords((value) => !value)}>{hideKeywords ? "显示关键词" : "挖空自测"}</button></div><div className="keyword-row">{day.morning.keywords.map((keyword) => <span key={keyword}>{hideKeywords ? "____" : keyword}</span>)}</div></div>
          <div className="button-row reading-actions"><button className="secondary-button" onClick={speakMorning}>▶ 逐段朗读</button>{day.currentAffairs.length > 0 && <button className="secondary-button" onClick={() => setActiveModule("affairs")}>今日时政 {day.currentAffairs.length}条</button>}<button className="primary-button" onClick={async () => { if (progress.completed[`${dayKey}-morning`]) return setActiveModule(null); await complete(`${dayKey}-morning`); setActiveModule(null); await startPractice("mixed", undefined, { kind: "daily" }); }}>{progress.completed[`${dayKey}-morning`] ? "✓ 已完成" : "完成并继续行测训练"}</button></div>
        </div>}

        {activeModule === "affairs" && (day.currentAffairs.length ? <div className="affairs-grid">{day.currentAffairs.map((item, index) => <article className="affair-card" key={`${item.title}-${index}`}><div><span>{String(index + 1).padStart(2, "0")}</span><em>{item.tag}</em></div><h3>{item.title}</h3><p>{item.detail}</p></article>)}</div> : <div className="empty-state compact"><span>政</span><h3>今日时政正在更新</h3><p>内容发布后将自动显示在此处。</p></div>)}

        {activeModule === "essay" && <div className="essay-wrap">
          {essayPracticeLoading ? <div className="empty-state compact essay-loading"><span>写</span><h3>正在从已加入题库选题</h3><p>优先匹配你的主攻地区、年份和高价值真题。</p></div> : <>
            {!essayQuestion && day.essay.expressions.length > 0 && <div className="expression-list">{day.essay.expressions.map((item) => <article className="expression-card" key={item.phrase}><span>{item.scene}</span><p>{item.phrase}</p><button onClick={() => toggleFavoritePhrase(item.phrase)}>{progress.favorites.includes(item.phrase) ? "★ 已收藏" : "☆ 收藏"}</button></article>)}</div>}
            <article className="writing-card essay-practice-card">
              <div className="essay-source-row"><span className="content-tag">{essayTruthLabel || "今日申论练习"}</span>{essayQuestion?.bankName && <small>{essayQuestion.bankName}</small>}</div>
              {essaySignals.length > 0 && <div className="truth-signal-row">{essaySignals.map((signal) => <span key={signal} className={signal.includes("★") ? "importance-stars" : ""}>{signal}</span>)}</div>}
              {essayQuestion && <MetricMethod frequency={essayQuestion.frequencyMeta} importance={essayQuestion.importanceMeta} scoreRate={essayQuestion.scoreRateMeta} />}
              {essayMaterial && <section className="essay-material"><b>给定材料</b><p>{essayMaterial}</p></section>}
              {essayQuestion?.imageUrl && <figure className="question-resource"><img src={essayQuestion.imageUrl} alt={`${essayTruthLabel || "申论真题"}材料配图`} loading="lazy" /></figure>}
              {essayQuestion?.resourceUrl && <a className="question-resource-link" href={essayQuestion.resourceUrl} target="_blank" rel="noreferrer">查看完整材料附件</a>}
              <h3>{essayPrompt}</h3>
              <div className="essay-stage-strip" aria-label="申论练习进度">
                {["独立作答", "标准自查", "采分自评", "第二版作答", "3天后重写"].map((label, index) => <span key={label} className={essayStageIndex >= index ? "done" : ""}>{index + 1}<small>{label}</small></span>)}
              </div>
              <div className="essay-guidance">{essayStage === "draft" ? "请独立阅读材料、提炼要点并作答；提交前不展示采分点和参考表达。" : essayStage === "self_check" ? "初稿已锁定。请先按通用标准完成自查，再查看采分点。" : essayStage === "self_score" ? "采分点已显示。请完成自评并记录失分原因，再查看参考表达。" : essayStage === "revision" ? "请对照参考表达完成第二版作答，重点补充遗漏要点并规范表述。" : essayStage === "scheduled" ? `第二版作答已完成，${essayRewriteDue ? `${shortDate(essayRewriteDue)}进行独立重写。` : "系统已安排3天后独立重写。"}` : "本题已完成初稿、自查、自评、第二版作答和3天后独立重写。"}</div>
              <label className="essay-field-label">第一版独立作答</label>
              <textarea aria-label="第一版独立作答" readOnly={essayStage !== "draft"} className={essayStage !== "draft" ? "locked-draft" : ""} value={progress.essayDrafts[essayDraftKey] ?? ""} onChange={(event) => updateEssayDraft(event.target.value)} onBlur={() => void persist(progressRef.current)} placeholder="根据材料独立作答……" maxLength={essayWordLimit} />
              <div className="writing-meta"><span>{(progress.essayDrafts[essayDraftKey] ?? "").length} / {essayWordLimit}</span><em>{essayStage === "draft" ? "参考内容暂不可见" : "初稿已锁定"}</em></div>
              {essayStage === "draft" && <button className="primary-button full-button" onClick={() => void submitEssayDraft()}>提交独立作答，进入自查</button>}

              {essayStageIndex >= essayStageOrder.self_check && <div className="essay-rubric"><span>第2步 · 按标准自查（至少选择2项）</span><div>{essayRubric.map((item) => <button disabled={essayStage !== "self_check"} key={item} className={(progress.essayChecks[essayDraftKey] ?? []).includes(item) ? "active" : ""} onClick={() => toggleEssayCheck(item)}>{(progress.essayChecks[essayDraftKey] ?? []).includes(item) ? "✓ " : ""}{item}</button>)}</div></div>}
              {essayStage === "self_check" && <button className="primary-button full-button" onClick={() => void submitEssayChecks()}>完成自查，查看采分点</button>}

              {essayStageIndex >= essayStageOrder.self_score && <div className="reference-answer scoring-points"><b>本题采分点</b>{essayScoringPoints.length ? <ol>{essayScoringPoints.map((point) => <li key={point}>{point}</li>)}</ol> : <p>本题采分点暂未完善，请先按题干要求和通用标准自评。</p>}<small>此处仅展示采分依据，参考表达仍未显示。</small></div>}
              {essayStage === "self_score" && <section className="essay-self-score">
                <label>第3步 · 自评得分<select value={Number.isFinite(progress.essaySelfScores[essayDraftKey]) ? progress.essaySelfScores[essayDraftKey] : ""} onChange={(event) => setEssaySelfScore(Number(event.target.value))}><option value="" disabled>请选择</option>{Array.from({ length: essayMaxScore + 1 }, (_, score) => <option key={score} value={score}>{score} / {essayMaxScore} 分</option>)}</select></label>
                <span>失分原因（可多选）</span><div>{essayLossReasonOptions.map((reason) => <button key={reason} className={(progress.essayLossReasons[essayDraftKey] ?? []).includes(reason) ? "active" : ""} onClick={() => toggleEssayLossReason(reason)}>{reason}</button>)}</div>
                <button className="primary-button full-button" onClick={() => void submitEssaySelfScore()}>确认自评，查看参考表达</button>
              </section>}

              {essayStageIndex >= essayStageOrder.revision && <div className="essay-reference-toggle"><button className="secondary-button" onClick={() => setEssayReference((value) => !value)}>{essayReference ? "收起参考表达" : "展开参考表达"}</button></div>}
              {essayStageIndex >= essayStageOrder.revision && essayReference && <div className="reference-answer"><b>参考表达</b>{essayReferenceText ? <p>{essayReferenceText}</p> : <p>本题参考表达暂未上传，请依据采分点完成第二版作答。</p>}<small>请重点参考结构、要点和规范表达，无需逐字复述。</small></div>}
              {essayStage === "revision" && <>
                <label className="essay-field-label">第4步 · 第二版作答</label>
                <textarea aria-label="第二版作答" value={progress.essaySecondDrafts[essayDraftKey] ?? ""} onChange={(event) => updateEssaySecondDraft(event.target.value)} onBlur={() => void persist(progressRef.current)} placeholder="合上参考内容，用自己的话重新作答……" maxLength={essayWordLimit} />
                <div className="writing-meta"><span>{(progress.essaySecondDrafts[essayDraftKey] ?? "").length} / {essayWordLimit}</span><em>提交后安排3天重写</em></div>
                <button className="primary-button full-button" onClick={() => void submitEssayRevision()}>提交第二版，安排3天后重写</button>
              </>}
              {essayStage === "scheduled" && <div className={`essay-rewrite-card${essayRewriteIsDue ? " due" : ""}`}><b>{essayRewriteIsDue ? "第5步 · 今日到期重写" : "已安排3天后重写"}</b><p>{essayRewriteIsDue ? "请在不查看初稿和参考表达的情况下重新作答。" : `${shortDate(essayRewriteDue)}进行独立重写，以检验掌握情况。`}</p>{essayRewriteIsDue && <><textarea aria-label="3天后独立重写" value={progress.essayRewriteDrafts[essayDraftKey] ?? ""} onChange={(event) => updateEssayRewriteDraft(event.target.value)} placeholder="不查看参考内容，完成独立重写……" maxLength={essayWordLimit} /><button className="primary-button full-button" onClick={() => void submitEssayRewrite()}>完成独立重写</button></>}</div>}
              {essayStage === "completed" && <div className="essay-complete-state"><span>✓</span><div><b>本题训练已完成</b><p>独立作答 → 自查 → 自评 → 第二版作答 → 3天后独立重写均已保存。</p></div></div>}
            </article>
          </>}
        </div>}
      </section>
    );
  };

  const bankFitMap = new Map((bootstrap?.questionBanks ?? []).map((bank) => [
    bank.code,
    resolveBankFit(bank, profile, primaryTarget, primaryBank?.code),
  ]));

  const filteredBanks = (() => {
    const banks = bootstrap?.questionBanks ?? [];
    if (bankFilter === "适合我") {
      return banks
        .filter((bank) => bankFitMap.get(bank.code)?.show)
        .sort((a, b) => (bankFitMap.get(b.code)?.score ?? 0) - (bankFitMap.get(a.code)?.score ?? 0));
    }
    if (bankFilter === "我的") return banks.filter((bank) => bank.added);
    if (bankFilter === "国考") return banks.filter((bank) => bank.examType === "国考");
    if (bankFilter === "省考") return banks.filter((bank) => bank.examType === "省考");
    if (bankFilter === "专项") return banks.filter((bank) => bank.examType === "专项");
    if (bankFilter === "申论") return banks.filter((bank) => bank.subject === "申论");
    return banks;
  })();

  const weakestModule = insights.modules.length ? [...insights.modules].sort((a, b) => a.accuracy - b.accuracy)[0] : null;
  const todayMetrics = insights.today ?? emptyInsights.today;
  const recommendationPoint = insights.weakPoints.length
    ? insights.weakPoints[bonusDrillOffset % insights.weakPoints.length]
    : null;
  const rankedBonusDrills = drillPresets
    .map((drill, index) => {
      const target = recommendationPoint?.point.trim() || recommendationPoint?.module.trim() || weakestModule?.module.trim() || "";
      const searchable = `${drill.title} ${drill.module} ${drill.subTypes.join(" ")}`;
      const moduleMatch = Boolean(target && (searchable.includes(target) || (drill.module && target.includes(drill.module))));
      return {
        drill,
        score: (moduleMatch ? 100 : 0)
          + (drill.importanceStars ?? 0) * 3
          + (drill.frequency?.includes("高") ? 8 : 0)
          - index / 100,
        moduleMatch,
      };
    })
    .sort((a, b) => b.score - a.score);
  const recommendedDrillEntry = rankedBonusDrills.length
    ? rankedBonusDrills[recommendationPoint ? 0 : bonusDrillOffset % rankedBonusDrills.length]
    : null;
  const recommendedDrill = recommendedDrillEntry?.drill ?? null;
  const bonusAlternativeCount = recommendationPoint ? insights.weakPoints.length : rankedBonusDrills.length;
  const needsDiagnostic = !bootstrap?.firstCompletedPractice;
  const bonusRecommendationTitle = needsDiagnostic
    ? "完成5题首次体验，建立初始基线"
    : recommendationPoint
      ? `${recommendationPoint.point}专项强化`
      : recommendedDrill?.title ?? "主攻题库综合强化";
  const pointProblemParts = recommendationPoint ? [
    recommendationPoint.wrong ? `错${recommendationPoint.wrong}题` : "",
    recommendationPoint.hesitant ? `掌握不稳定${recommendationPoint.hesitant}次` : "",
    recommendationPoint.guessed ? `猜测作答${recommendationPoint.guessed}次` : "",
    recommendationPoint.overtime ? `超时${recommendationPoint.overtime}次` : "",
  ].filter(Boolean) : [];
  const bonusRecommendationReason = needsDiagnostic
    ? "完成后将根据答错、掌握不稳定、猜测作答和超时情况生成薄弱点建议。"
    : recommendationPoint
      ? `近7天作答${recommendationPoint.total}题，${pointProblemParts.join("、") || `正确率${recommendationPoint.accuracy}%`}${recommendationPoint.wrongReason ? `；主要错因：${learnerWrongReason(recommendationPoint.wrongReason)}` : ""}。`
    : recommendedDrillEntry?.moduleMatch && weakestModule
      ? `近阶段${weakestModule.module}正确率${weakestModule.accuracy}%，建议优先强化当前薄弱模块。`
      : weakestModule
        ? `当前薄弱模块为${weakestModule.module}；暂未匹配对应专项，将优先安排已发布的重点真题。`
        : "根据主攻考试和已发布真题生成一组专项训练。";
  const bonusRecommendationMeta = needsDiagnostic
    ? "5道真题 · 约5分钟"
    : recommendationPoint
      ? "5道针对性真题 · 约8分钟"
    : recommendedDrill
      ? `${recommendedDrill.questionCount}${recommendedDrill.subject === "申论" ? "题" : "道"}真题 · 约${recommendedDrill.minutes}分钟`
      : "5道真题 · 约10分钟";
  const recommendationEvidence = recommendationPoint ? [
    "依据：近7天实际作答",
    recommendationPoint.frequency ? `${recommendationPoint.frequency}${recommendationPoint.frequencyOccurrences && recommendationPoint.frequencyPapers ? ` · ${recommendationPoint.frequencyOccurrences}次/${recommendationPoint.frequencyPapers}套` : ""}` : "",
    recommendationPoint.importanceStars ? `重要${"★".repeat(recommendationPoint.importanceStars)}` : "",
    recommendationPoint.scoreRate !== null ? `拿分率${recommendationPoint.scoreRate}% · ${recommendationPoint.scoreRateAttempts}样本` : "",
  ].filter(Boolean) : [];
  const startRecommendedBonus = () => {
    if (needsDiagnostic) {
      void startPractice("mixed", undefined, { kind: "diagnostic", limit: 5, forceNew: true });
      return;
    }
    if (recommendationPoint) {
      void startPractice("mixed", undefined, {
        kind: "bonus",
        limit: 5,
        forceNew: true,
        focusModule: recommendationPoint.point,
        focusSubTypes: [recommendationPoint.point, recommendationPoint.module],
        strictFocus: true,
        focusLabel: `${recommendationPoint.point}专项强化`,
      });
      return;
    }
    if (recommendedDrill) {
      startMicroDrill(recommendedDrill);
      return;
    }
    runBonusPractice();
  };
  const tomorrowPlan = insights.tomorrowPlan;
  const nextStepText = primaryTodayCopy.eyebrow;
  const primaryTaskTitle = primaryTodayCopy.title;
  const primaryTaskDetail = primaryTodayCopy.detail;
  const dailyStepItems = [
    ...(dailyPlan.morningMinutes > 0 && hasMorningContent ? [{ key: "morning" as const, icon: "读", title: "晨读", minutes: dailyPlan.morningMinutes, detail: "记住3个规范表达", done: stepDone.morning, action: () => setActiveModule("morning") }] : []),
    ...(!dailyConfigurationBlocking ? [{ key: "practice" as const, icon: "练", title: "行测日练", minutes: dailyPlan.practiceMinutes, detail: activeDailySession ? `进度已保存，还剩${dailyRemaining}题` : queuedBankCodes.length ? `${dailyPlan.questionCount}道 · 优先${todayBankFocusItems.map((item) => item.title).join("、")}` : `${dailyPlan.questionCount}道 · 到期错题优先`, done: stepDone.practice, action: () => void startPractice("mixed", queuedBankCodes.length ? queuedBankCodes : undefined, { kind: "daily" }) }] : []),
    ...((dailyPlan.essayMinutes > 0 && hasEssayContent) || todayEssayQueueItem ? [{ key: "essay" as const, icon: todayEssayQueueItem ? "查" : "写", title: todayEssayQueueItem ? "申论答案查阅" : "申论真题", minutes: todayEssayQueueItem?.estimatedMinutes ?? dailyPlan.essayMinutes, detail: todayEssayQueueItem?.title ?? (activeEssayBanks.length ? "材料作答 · 采分点自评" : "今日表达练习"), done: stepDone.essay, action: () => todayEssayQueueItem ? void openQueuedEssayItem(todayEssayQueueItem) : void startEssayPractice({ daily: true }) }] : []),
  ];
  const todayAlertCandidates = [
    ...((bootstrap?.dueEssayRewrites ?? []).slice(0, 1).map((item) => ({
      id: `essay-rewrite:${item.questionCode}`,
      priority: "review" as const,
      label: "申论重写",
      title: `${item.truthLabel} · ${item.module}`,
      detail: "3天后独立重写已到期，请重新作答以检验掌握情况",
      action: () => void startEssayPractice({ bankCodes: [item.bankCode], daily: false, questionCode: item.questionCode, attemptDateKey: item.originalDateKey }),
    }))),
    ...(dueReminder && dueReminder !== criticalReminder ? [{ id: "radar", priority: "urgent" as const, label: "报名提醒", title: `${dueReminder.targetLabel} · ${dueReminder.title}`, detail: dueReminder.days === 0 ? "今天处理" : `还有${dueReminder.days}天 · ${shortDate(dueReminder.eventDate)}`, action: () => setTab("calendar") }] : []),
    ...(insights.dueCount > dailyPlan.questionCount ? [{ id: "review-backlog", priority: "review" as const, label: "到期复习", title: `${insights.dueCount}道到期题等待复习`, detail: `今日优先完成${Math.min(insights.dueCount, dailyPlan.questionCount)}道，其余任务自动顺延`, action: () => setTab("review") }] : []),
  ];
  const todayAlertItems = prioritizeTodayItems(todayAlertCandidates, primaryTodayState === "due_review" ? "review-backlog" : "", 2);
  const todayInsight = insights.recent.find((item) => item.day === dayKey || item.day.slice(0, 10) === dayKey);
  const todayAnswered = Math.max(todayInsight?.total ?? 0, sessionAnswered, activeDailySession?.answered ?? 0);
  const todayAccuracy = sessionAnswered > 0
    ? Math.round((sessionCorrect / sessionAnswered) * 100)
    : todayInsight?.accuracy ?? 0;
  const todayReviewAdded = Math.max(sessionReviewAdded, activeDailySession?.reviewAdded ?? 0);
  const weeklyMetrics = insights.weekly ?? emptyInsights.weekly;
  const todayValueHeadline = todayAnswered === 0
    ? "暂无学习结果"
    : todayMetrics.repairedDue > 0
      ? `今日已完成${todayMetrics.repairedDue}道到期题复习`
      : todayMetrics.highFrequencyPoints.length > 0
        ? `今日覆盖${todayMetrics.highFrequencyPoints.length}个可靠高频考点`
        : `今日完成${todayAnswered}道真题，作答结果已记录`;
  const valueComparisonItems = [
    todayMetrics.accuracyDelta === null ? "" : `较前7日正确率${todayMetrics.accuracyDelta >= 0 ? "提升" : "下降"}${Math.abs(todayMetrics.accuracyDelta)}pp`,
    weeklyMetrics.repeatErrorRateDelta === null ? "" : `重复错误率${weeklyMetrics.repeatErrorRateDelta <= 0 ? "下降" : "上升"}${Math.abs(weeklyMetrics.repeatErrorRateDelta)}pp`,
    weeklyMetrics.masteredPoints.length ? `本周新掌握${weeklyMetrics.masteredPoints.length}个考点` : "",
  ].filter(Boolean);
  const threeDayReportReady = weeklyMetrics.activeDays >= 3;
  const threeDayReportProgress = Math.min(3, weeklyMetrics.activeDays);
  const threeDayNextIssues = weeklyMetrics.nextIssues.slice(0, 3);
  const visibleTodayQuizCampaign = todayCampaign && todayCampaign.actionType === "quiz" && isCampaignVisible(todayCampaign) ? todayCampaign : null;

  if (!bootstrap) {
    return <main className="app-shell"><div className="app-frame"><header className="topbar"><div className="brand-mark">公</div><div className="brand-copy"><strong>公考日练</strong><span>每天10–60分钟，完成重点训练</span></div></header><section className="empty-state bootstrap-state" role={bootstrapLoadState === "error" ? "alert" : "status"}><span>{bootstrapLoadState === "error" ? "!" : "…"}</span><h3>{bootstrapLoadState === "error" ? "学习数据暂时没有加载成功" : "正在同步账户、题库权益与学习进度"}</h3><p>{bootstrapLoadState === "error" ? `${bootstrapError || "网络暂时不可用"}。数据加载失败时不会更新学习进度。` : "首次进入时将同步账号状态与学习记录。"}</p>{bootstrapLoadState === "error" && <button className="primary-button" onClick={() => void loadBootstrap()}>立即重试</button>}</section>{toast && <div className="toast" role="status">{toast}</div>}</div></main>;
  }

  return (
    <main className="app-shell">
      <div className="app-frame">
        <header className="topbar"><div className="brand-mark">公</div><div className="brand-copy"><strong>公考日练</strong><span>每天10–60分钟，完成重点训练</span></div><button className="member-chip" onClick={() => setTab("me")}>{membershipText(bootstrap?.user, hasExtendedMembership)}</button></header>

        {(!online || pendingPracticeAttempts.length > 0) && <section className={`practice-sync-banner${online ? " pending" : " offline"}`} role="status" aria-live="polite">
          <div><b>{online ? `${pendingPracticeAttempts.length}次答题尚未同步` : "网络已断开，当前为离线状态"}</b><span>{online
            ? currentPendingPracticeAttempt?.blocked
              ? "上次同步未成功；记录仍保留，请刷新练习后再次核对。"
              : "待同步记录不会计入进度；回到对应题目会自动重试，也可手动重试。"
            : pendingQueueDurable
              ? "本题选择会先保存在此浏览器；恢复联网前不会显示答案或计入进度。"
              : "浏览器未允许本地保存，请保持当前页面，恢复联网后立即重试。"}</span></div>
          {online && currentPendingPracticeAttempt && <button disabled={busy} onClick={() => retryPendingPracticeRef.current(currentPendingPracticeAttempt)}>{busy ? "同步中…" : "立即重试"}</button>}
        </section>}

        {activeModule ? renderModule() : <>
          {tab === "today" && <div className="page-content today-redesign">
            <section className={`today-focus-strip${profile.onboarded && dailyConfigurationBlocking ? " has-config-gap" : ""}`}>
              <div className="today-focus-summary"><span>我的备考组合</span><b>{primaryTarget?.label ?? "尚未设置主攻考试"}{profile.targets.length > 1 ? ` · 兼顾${profile.targets.length - 1}项` : ""}</b><small>{nextExam ? `最近：${nextExam.target.label} · ${nextExam.days}天` : "设置目标后自动安排主攻与兼顾"}</small></div>
              <button className="today-focus-adjust" onClick={() => { setProfileDraft(profile); setOnboardingOpen(true); }}>调整</button>
              {profile.onboarded && dailyConfigurationBlocking && <button className="bank-config-gap" onClick={() => { setBankFilter("适合我"); setTab("banks"); }}>
                <span>可练题库待补全</span>
                <div><b>{bootstrap?.dailyReadiness ? `可练真题 ${dailyReadinessCount}/${dailyReadinessRequired}道` : `${bankConfigGaps[0]?.label ?? "当前目标"}暂无可练行测题库`}</b><small>{bootstrap?.dailyReadiness ? "仅计入地区、年份匹配且已核验的非重复真题" : "请加入年份适用且至少含5道非重复真题的题库"}</small></div>
                <i>去补全 ›</i>
              </button>}
            </section>

            <section className={`today-command-card${allDailyDone ? " completed" : ""}`}>
              <div className="today-command-top"><span>{dailyPlan.minutes === 10 ? "10分钟精简计划" : "今日重点任务"}</span><em>{new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "long", day: "numeric", weekday: "short" }).format(new Date())}</em></div>
              <div className="today-command-main">
                <div><p>{nextStepText}</p><h1>{primaryTaskTitle}</h1><small>{primaryTaskDetail}</small><div className="today-mission-tags"><span>{dailyPlan.questionCount ? `${dailyPlan.questionCount}道真题` : "晨读优先"}</span><span>{validLearningBanks.length ? `${validLearningBanks.length}本题库参与` : "待选题库"}</span><span>{nextExam ? `${nextExam.days}天后考试` : "先建目标"}</span></div></div>
                <div className="today-progress-orb" style={{ "--progress": `${doneCount * (360 / Math.max(1, enabledDailySteps.length))}deg` } as React.CSSProperties}><strong>{dailyConfigurationBlocking ? "—" : `${doneCount}/${enabledDailySteps.length}`}</strong><span>{dailyConfigurationBlocking ? "待配置" : "完成"}</span></div>
              </div>
              <button className="today-primary-action" disabled={busy} onClick={runDailyAction}>{dailyActionLabel}<span>{primaryActionMeta}</span></button>
              <div className="today-secondary-row">{!dailyConfigurationBlocking && <button disabled={Boolean(dailySessionForPlan) || practiceDone} onClick={toggleBusyMode}>{dailyPlan.minutes === 10 ? `恢复${normalizePlanMinutes(profile.dailyMinutes)}分钟计划` : "切换为10分钟精简计划"}</button>}</div>
              <details className="plan-basis-disclosure"><summary>计划如何生成 <span>查看依据⌄</span></summary><div><span>每日时间：{dailyPlan.minutes}分钟</span><span>到期复习：{insights.dueCount}道优先</span><span>考试目标：{targetSummary}</span>{todayQueueItems.some((item) => item.status === "scheduled") && <span>自主加入：{todayQueueItems.filter((item) => item.status === "scheduled").length}项</span>}<p>系统先安排到期复习，再按主攻题库、临近考试和自主加入内容生成任务；超出当日容量的内容自动顺延。</p></div></details>
            </section>

            {bootstrap?.content.access === "preview" && <section className="access-card compact-access"><div><span>当前为免费版</span><h3>每天5题，体验完整流程</h3></div><button onClick={() => setTab("me")}>激活权益</button></section>}


            <section className="daily-timeline-card"><div className="compact-section-heading"><div><span>今日{dailyStepItems.length}项安排</span><h2>{dailyConfigurationBlocking ? "题库补全后自动生成行测" : allDailyDone ? "今日任务已完成" : "系统已按优先级安排"}</h2></div><em>{dailyConfigurationBlocking ? "待配置" : allDailyDone ? "已完成" : `还剩${enabledDailySteps.length - doneCount}项`}</em></div>
              {!dailyConfigurationBlocking && (insights.dueCount > 0 || todayMetrics.repairedDue > 0) && <button
                className={`review-priority-card${insights.dueCount === 0 ? " completed" : ""}`}
                onClick={() => stepDone.practice ? setTab("review") : void startPractice("mixed", undefined, { kind: "daily" })}
              >
                <span>{insights.dueCount === 0 ? "✓" : "复"}</span>
                <div><b>{insights.dueCount === 0 ? "今日到期复习已完成" : "到期复习已排入今日行测"}</b><small>{insights.dueCount === 0 ? `已完成${todayMetrics.repairedDue}道到期题复习，今日无需重复练习。` : `${insights.dueCount}道到期题将优先出现；超出今日容量的题目自动顺延。`}</small></div>
                <em>{insights.dueCount === 0 ? "已完成" : stepDone.practice ? "继续复习" : "优先复习"}</em>
              </button>}
              <div className="daily-timeline">{dailyStepItems.map((item, index) => {
                const active = !item.done && item.key === nextDailyStep;
                return <button key={item.key} className={`${item.done ? "done" : active ? "active" : "pending"}`} onClick={item.action}>
                  <span className="timeline-index">{item.done ? "✓" : index + 1}</span>
                  <i>{item.icon}</i>
                  <div><b>{item.title}</b><small>{item.detail}</small></div>
                  <em>{item.done ? "已完成" : active ? "下一步" : `${item.minutes}分钟`}</em>
                </button>;
              })}</div>
            </section>

            <section className="today-gain-card compact-gain-card">
              <details className="today-gain-disclosure" open={todayGainExpanded} onToggle={(event) => setTodayGainExpanded(event.currentTarget.open)}>
                <summary><div><span>今日学习结果</span><b>{todayValueHeadline}</b><small>{allDailyDone ? "依据实际作答生成" : todayAnswered ? `已完成${todayAnswered}题 · 待复习${todayReviewAdded}题` : "完成练习后显示"}</small></div><em>{todayGainExpanded ? "收起" : "查看"}⌄</em></summary>
                <div className="today-gain-content">
                  {valueComparisonItems.length > 0 && <div className="value-comparison-row">{valueComparisonItems.map((item) => <span key={item}>{item}</span>)}</div>}
                  <div className="today-gain-grid"><div><b>{todayAnswered}</b><span>已完成真题</span></div><div><b>{todayAnswered ? `${todayAccuracy}%` : "—"}</b><span>今日正确率</span></div><div><b>{todayMetrics.repairedDue}</b><span>完成到期复习</span></div><div><b>{todayMetrics.wrong}</b><span>答错题目</span></div></div>
                  <div className="today-gain-detail-grid"><div><b>{todayMetrics.guessed}</b><span>猜测作答</span></div><div><b>{todayMetrics.hesitant}</b><span>掌握不稳定</span></div><div><b>{todayMetrics.overtime}</b><span>超时</span></div><div><b>{todayMetrics.avgSecondsDelta === null ? "—" : `${todayMetrics.avgSecondsDelta >= 0 ? "+" : ""}${todayMetrics.avgSecondsDelta}秒`}</b><span>较前7日均时</span></div><div><b>{weeklyMetrics.masteredPoints.length}</b><span>本周新掌握考点</span></div><div><b>{tomorrowPlan.dueCount}</b><span>明日到期复习</span></div></div>
                  <p className="gain-point-note"><b>今日覆盖的可靠高频考点：</b>{todayMetrics.highFrequencyPoints.length ? todayMetrics.highFrequencyPoints.join("、") : "暂无达到统计样本标准的考点，暂不展示高频标签。"}</p>
                  <p className="today-gain-review-note">本轮新增复习安排 {todayReviewAdded} 道 · 完成 {doneCount}/{enabledDailySteps.length} 项学习任务</p>
                  <div className="today-gain-streak"><div><b>本周打卡</b><span>距{nextStreakMilestone}天还差{Math.max(0, nextStreakMilestone - streak)}天</span></div><div className="streak-dot-row" aria-label="本周打卡进度">{currentWeekCheckinKeys.map((key, index) => <em key={key} className={progress.checkins.includes(key) ? "checked" : key === dayKey ? "today" : ""} title={`${weekLabels[index]} ${key}`}>{weekLabels[index]}</em>)}</div></div>
                </div>
              </details>
            </section>

            {todayAlertItems.length > 0 && <section className="today-alert-card"><div className="compact-section-heading"><div><span>今日提醒</span><h2>今日优先事项</h2></div></div>
              <div className="today-alert-list">{todayAlertItems.map((item) => <button key={item.id} className="urgent" onClick={item.action}><span>{item.label}</span><div><b>{item.title}</b><small>{item.detail}</small></div><i>›</i></button>)}</div>
            </section>}

            {todayCampaign && todayCampaign.actionType !== "quiz" && isCampaignVisible(todayCampaign) && <section className={`configured-campaign-card tone-${todayCampaign.tone}`}>
              <div><span>{todayCampaign.eyebrow}</span><h2>{todayCampaign.title}</h2><p>{todayCampaign.summary}</p></div>
              <button onClick={() => { recordCampaignClick(todayCampaign); runConfiguredAction(todayCampaign.actionType, todayCampaign.actionTarget, `campaign:${todayCampaign.id}`); }}>{todayCampaign.actionLabel}</button>
            </section>}

            <section className={`quick-practice-card smart-bonus-card${allDailyDone ? " ready" : ""}`}>
              <div className="compact-section-heading"><div><span>专项强化（约10分钟）</span><h2>{allDailyDone ? "系统已生成推荐训练" : "完成今日任务后开放"}</h2></div></div>
              <details
                className="smart-bonus-disclosure"
                open={bonusExpanded}
                onToggle={(event) => setBonusExpanded(event.currentTarget.open)}
              >
                <summary>
                  <div><span>{allDailyDone ? "今日任务已完成" : "按需加练"}</span><b>{allDailyDone ? "已根据作答结果推荐" : "不计入今日任务"}</b></div>
                  <em>{bonusExpanded ? "收起" : "展开"}⌄</em>
                </summary>
                <div className="smart-bonus-content">
                  {allDailyDone ? <article className="smart-bonus-recommendation">
                    <div className="smart-bonus-icon" style={{ color: recommendedDrill?.color, background: recommendedDrill ? `${recommendedDrill.color}18` : undefined }}>{needsDiagnostic ? "测" : recommendedDrill?.icon ?? "练"}</div>
                    <div className="smart-bonus-copy"><span>{needsDiagnostic ? "首次诊断" : recommendationPoint ? "考点级推荐" : recommendedDrillEntry?.moduleMatch ? "薄弱项优先" : "智能推荐"}</span><h3>{bonusRecommendationTitle}</h3><p>{bonusRecommendationReason}</p>{recommendationEvidence.length > 0 && <div className="recommendation-evidence">{recommendationEvidence.map((item) => <em key={item}>{item}</em>)}</div>}<small>{bonusRecommendationMeta}</small></div>
                    <div className="smart-bonus-actions"><button className="primary-button" disabled={busy} onClick={startRecommendedBonus}>{needsDiagnostic ? "开始能力诊断" : "开始专项强化"}</button>{bonusAlternativeCount > 1 && !needsDiagnostic && <button className="bonus-switch-button" onClick={() => setBonusDrillOffset((value) => value + 1)}>更换推荐</button>}</div>
                  </article> : <div className="bonus-locked-note"><span>主</span><div><b>完成今日任务后开放</b><small>根据作答表现推荐专项。</small></div><button onClick={runDailyAction}>继续今日任务</button></div>}
                  <div className="bonus-more-heading"><span>其他方式</span><small>按需使用</small></div>
                  <div className="smart-bonus-tools">
                    <button className="bonus-tool-entry" onClick={() => { setBankFilter("专项"); setTab("banks"); }}><span>专</span><b>专项自选</b><small>自主选择5–10分钟专项训练</small></button>
                    <button className="bonus-tool-entry" onClick={() => setTab("audio")}><span>听</span><b>通勤听练</b><small>不便看屏幕时使用</small></button>
                  </div>
                  {allDailyDone && <button className="finish-today-button" onClick={() => { setBonusExpanded(false); notify("今日学习已完成，明天继续"); }}>结束今日学习</button>}
                </div>
              </details>
            </section>

            <QuizFeature
              notify={notify}
              trackEvent={trackEvent}
              variant="teaser"
              entryVisible
              teaserConfig={visibleTodayQuizCampaign ? { eyebrow: "趣味测试", title: visibleTodayQuizCampaign.title, actionLabel: "开始测试" } : undefined}
              onEntryOpen={visibleTodayQuizCampaign ? () => recordCampaignClick(visibleTodayQuizCampaign) : undefined}
              onComplete={visibleTodayQuizCampaign ? () => markCampaignComplete(visibleTodayQuizCampaign) : undefined}
            />
          </div>}

          {tab === "banks" && <div className="page-content subpage">
            <div className="subpage-heading bank-heading"><div><span>题库书架</span><h1>按报考计划组合题库</h1><p>可同时加入国考、多省考及专项题库，各地区独立组题。</p></div><strong>{addedBanks.length} 本已添加</strong></div>
            <div className="target-scope-note"><b>主攻优先 · 兼顾其他题库</b><span>{primaryBank ? `主攻《${primaryBank.name}》，其他题库同步参与` : "请先添加一套行测题库"}</span><button onClick={() => { setProfileDraft(profile); setOnboardingOpen(true); }}>管理目标</button></div>
            <div className="bank-filters">{["适合我", "我的", "全部", "国考", "省考", "专项", "申论"].map((item) => <button key={item} className={bankFilter === item ? "active" : ""} onClick={() => setBankFilter(item)}>{item}</button>)}</div>
            {bankFilter === "适合我" && <div className="fit-rule-note"><b>推荐标准</b><span>根据报考目标、已选地区、薄弱考点和到期复习推荐。</span></div>}
            {bankFilter === "申论" && <section className="essay-reference-entry">
              <div className="essay-reference-entry-icon">查</div>
              <div><span>免费资料查询</span><h2>申论真题答案对比</h2><p>按地区、年份和卷种查题，对比多来源参考答案。</p><small>独立查询 · 免费开放</small></div>
              <button type="button" onClick={() => openEssayReferenceLibrary("banks")}>查看答案对比</button>
            </section>}
            <section className="bank-list">{filteredBanks.map((bank) => {
              const percent = bank.questionCount ? Math.round((bank.studiedCount / bank.questionCount) * 100) : 0;
              const estimatedDays = bank.questionCount ? Math.max(1, Math.ceil(Math.max(0, bank.questionCount - bank.studiedCount) / dailyPlan.questionCount)) : 0;
              const isPrimary = bank.code === primaryBank?.code;
              const bankLocked = bank.added && (bank.locked === true || bank.practiceAvailable === false);
              const fit = bankFitMap.get(bank.code) ?? resolveBankFit(bank, profile, primaryTarget, primaryBank?.code);
              const queuedBankItem = dailyQueue.find((item) => item.itemType === "bank_practice" && item.sourceId === bank.code && item.status === "scheduled");
              return <article className={`bank-card bank-${bank.coverColor}${isPrimary ? " is-primary" : ""}${bankLocked ? " is-locked" : ""}`} key={bank.code}>
                <div className="bank-cover"><span>{bank.examType}</span><b>{bank.subject}</b><small>{bankTruthLabel(bank)}</small></div>
                <div className="bank-copy"><div><span>{bankTruthLabel(bank)} · {bank.questionCount}题</span><h3>{bank.name}</h3>{isPrimary && <div className="primary-bank-badge">主攻题库</div>}<p>{bank.description}</p><div className={`scope-badge ${fit.tone}`}>{fit.badge}</div>{bankFilter === "适合我" && <small className="fit-reason">推荐依据：{[fit.reason, frequencyText(bank.frequency), starText(bank.importanceStars), scoreRateText(bank.scoreRate)].filter(Boolean).join(" · ")}</small>}</div>
                  <div className="bank-progress"><div><i style={{ width: `${percent}%` }} /></div><span>{percent}%</span></div>
                  {bank.added && !bankLocked && bank.subject !== "申论" && bank.questionCount > 0 && <div className="bank-today-action-row">{queuedBankItem
                    ? <><span>{queuedBankItem.dateKey === dayKey ? "已优先排入今日行测" : `已排入${shortDate(queuedBankItem.dateKey)}`}</span><button type="button" onClick={() => void updateQueueItem(queuedBankItem.id, "removed")}>移除计划</button></>
                    : <><span>将本题库设为下一次日练的优先来源</span><button type="button" disabled={busy} onClick={() => void addBankToToday(bank)}>加入今日</button></>}</div>}
                  <footer><small>{bank.questionCount === 0 ? "内容准备中，不影响基础日练" : bankLocked ? "权益已到期，学习进度已保留" : bank.added ? `已掌握${bank.masteredCount} · 薄弱${bank.weakCount} · 到期${bank.dueCount} · 预计${estimatedDays}天完成一轮` : fit.show ? fit.reason : bank.mismatchReason}</small><div>{bank.added ? <><button disabled className="added-state">{bankLocked ? "🔒 已保留" : "✓ 已加入"}</button><button disabled={busy} className="cancel-bank" onClick={() => void toggleBank(bank)}>取消</button></> : <button disabled={busy} onClick={() => void toggleBank(bank)}>{bank.targetMatch ? "+ 添加" : "+ 添加并备考"}</button>}{bank.added && !bankLocked && bank.subject !== "申论" && !isPrimary && <button className="primary-bank-button" onClick={() => setPrimaryBank(bank.code)}>设为主攻</button>}{bank.added && bankLocked && bank.questionCount > 0 ? <button className="start-bank" onClick={() => bank.subject === "申论" ? openPaywall("essay", () => startEssayPractice({ bankCodes: [bank.code], daily: false }), { tab: "banks", bankCode: bank.code, resumeAction: "start_essay" }) : openPaywall("second_bank", () => startPractice("mixed", [bank.code], { kind: "bank" }), { tab: "banks", bankCode: bank.code, resumeAction: "start_practice", mode: "mixed", bankCodes: [bank.code], practiceOptions: { kind: "bank" } })}>开通后继续</button> : bank.added && bank.subject !== "申论" ? <button className="start-bank" disabled={bank.questionCount === 0} onClick={() => void startPractice("mixed", [bank.code], { kind: "bank" })}>{bank.questionCount ? "本题库练习" : "待上架"}</button> : bank.added && <button className="start-bank" disabled={bank.questionCount === 0} onClick={() => void startEssayPractice({ bankCodes: [bank.code], daily: false })}>{bank.questionCount ? "真题微练" : "待上架"}</button>}</div></footer>
                </div>
              </article>;
            })}</section>
            {filteredBanks.length === 0 && bankFilter !== "申论" && <div className="empty-state compact"><span>库</span><h3>该分类暂无已发布题库</h3><p>可切换分类或稍后查看。</p></div>}
          </div>}

          {tab === "resources" && <div className="page-content subpage resources-page">
            <div className="subpage-heading resources-heading"><div><span>备考资料</span><h1>高频资料集中查询</h1><p>集中查询申论真题答案及常用备考资料。</p></div></div>

            {primaryResourceCard ? <section className={`resource-primary-card tone-${primaryResourceCard.tone}`} aria-labelledby={`resource-${primaryResourceCard.id}`}>
              <div className="resource-primary-topline"><span>{primaryResourceCard.eyebrow || "资料入口"}</span>{primaryResourceCard.eyebrow !== (primaryResourceCard.accessLevel === "free" ? "免费开放" : "会员资料") && <small>{primaryResourceCard.accessLevel === "free" ? "免费开放" : "会员资料"}</small>}</div>
              <div className="resource-primary-copy">
                <div className="resource-primary-icon">{primaryResourceCard.icon}</div>
                <div><h2 id={`resource-${primaryResourceCard.id}`}>{primaryResourceCard.title}</h2><p>{primaryResourceCard.summary}</p></div>
              </div>
              {primaryResourceCard.meta && <div className="resource-feature-list" aria-label="资料功能">{primaryResourceCard.meta.split(/[｜|]/).filter(Boolean).slice(0, 4).map((item) => <span key={item}>{item}</span>)}</div>}
              <div className="resource-primary-actions"><button type="button" onClick={() => runConfiguredAction(primaryResourceCard.actionType, primaryResourceCard.actionTarget, `resource:${primaryResourceCard.id}`)}>{primaryResourceCard.actionLabel}</button></div>
            </section> : <div className="empty-state compact"><span>资</span><h3>资料入口暂未开放</h3><p>请稍后查看。</p></div>}

            {resourcesCampaign && isCampaignVisible(resourcesCampaign) && <section className={`configured-campaign-card tone-${resourcesCampaign.tone}`}>
              <div><span>{resourcesCampaign.eyebrow}</span><h2>{resourcesCampaign.title}</h2><p>{resourcesCampaign.summary}</p></div>
              <button onClick={() => { recordCampaignClick(resourcesCampaign); runConfiguredAction(resourcesCampaign.actionType, resourcesCampaign.actionTarget, `campaign:${resourcesCampaign.id}`); }}>{resourcesCampaign.actionLabel}</button>
            </section>}

            <section className="resource-support-section">
              <div className="compact-section-heading"><div><span>辅助工具</span><h2>按需使用</h2></div><small>不计入日练</small></div>
              <div className="resource-support-grid">{supportResourceCards.map((card) => <button key={card.id} type="button" className={`resource-support-card tone-${card.tone}`} onClick={() => runConfiguredAction(card.actionType, card.actionTarget, `resource:${card.id}`)}>
                <span className="resource-support-icon">{card.icon}</span><div><b>{card.title}</b><p>{card.summary}</p></div><em>{card.actionLabel}</em>
              </button>)}</div>
              {!supportResourceCards.length && <div className="empty-state compact"><span>+</span><h3>暂无其他工具</h3><p>请稍后查看。</p></div>}
              <p className="resource-scope-note">报名、缴费等临近事项会在“今日”提醒。</p>
            </section>
          </div>}

          {tab === "essayLibrary" && <>
            {essayLibraryLoading && !essayLibraryLoaded ? <div className="page-content subpage essay-reference-loading"><div className="empty-state compact"><span>查</span><h3>正在加载申论真题答案对比</h3><p>正在整理可公开查询的试卷、材料和参考答案。</p></div></div>
              : essayLibraryError ? <div className="page-content subpage essay-reference-loading"><div className="empty-state compact"><span>!</span><h3>资料库暂时无法加载</h3><p>{essayLibraryError}</p><button className="primary-button" type="button" onClick={() => {
                const paperCode = new URLSearchParams(window.location.search).get("essayPaper")?.trim() ?? "";
                if (paperCode) void loadEssayReferenceDeepLink(paperCode);
                else void loadEssayReferenceLibrary(true, 1);
              }}>重新加载</button><button className="secondary-button" type="button" onClick={closeEssayReferenceLibrary}>返回上一页</button></div></div>
                : <EssayReferenceLibrary
                  papers={essayLibraryPapers}
                  initialPaperId={essayLibraryInitialPaperId}
                  initialQuestionId={essayLibraryInitialQuestionId}
                  onClose={closeEssayReferenceLibrary}
                  onPaperOpen={loadEssayPaperDetail}
                  onPaperExit={clearEssayPaperLink}
                  onSharePaper={shareEssayReferencePaper}
                  todayQuestionIds={todayQueueItems.filter((item) => item.itemType === "essay_reference" && item.status === "scheduled").map((item) => item.sourceId)}
                  completedTodayQuestionIds={todayQueueItems.filter((item) => item.itemType === "essay_reference" && item.status === "completed").map((item) => item.sourceId)}
                  onAddQuestionToToday={addEssayQuestionToToday}
                  onCompleteTodayQuestion={async (_paper, question) => {
                    const item = todayQueueItems.find((candidate) => candidate.itemType === "essay_reference" && candidate.sourceId === String(question.id) && candidate.status === "scheduled");
                    if (!item) return notify("该题不在今日计划中");
                    await updateQueueItem(item.id, "completed");
                    await complete(`${dayKey}-essay`);
                  }}
                  onRemoveTodayQuestion={async (_paper, question) => {
                    const item = todayQueueItems.find((candidate) => candidate.itemType === "essay_reference" && candidate.sourceId === String(question.id) && candidate.status === "scheduled");
                    if (item) await updateQueueItem(item.id, "removed");
                  }}
                  hasMore={essayLibraryPapers.length < essayLibraryTotal}
                  totalCount={essayLibraryTotal}
                  loadingMore={essayLibraryLoadingMore}
                  onLoadMore={() => loadEssayReferenceLibrary(false, essayLibraryPage + 1)}
                />}
          </>}

          {tab === "review" && <div className="page-content subpage">
            <div className="subpage-heading"><span>智能复习</span><h1>每道题都说明为什么复习</h1><p>答错、超时或掌握不稳定的题目会按期复习；记忆周期到期也会标明原因与日期。</p></div>
            <section className="review-hero"><div><span>今日到期</span><h2>{insights.dueCount}<small> 道</small></h2><p>薄弱 {insights.stateCounts.weak} · 学习中 {insights.stateCounts.learning} · 已掌握 {insights.stateCounts.mastered}</p></div><button disabled={busy || insights.dueCount === 0} onClick={() => void startPractice("review", undefined, { kind: "review" })}>{insights.dueCount ? "开始复习" : "今日复习已完成"}</button></section>
            {(bootstrap.reviewQueue ?? []).length > 0 && <section className="review-queue-list" aria-label="今日复习队列">{bootstrap.reviewQueue.slice(0, 8).map((item) => <article className="review-queue-card" key={item.questionCode}><span>{item.module.slice(0, 1)}</span><div><b>{item.knowledge}</b><small>{item.bankName} · 原因：{learnerWrongReason(item.reason)}</small></div><em>{reviewDateLabel(item.nextReviewAt, dayKey)}</em></article>)}</section>}
            <div className="review-rules"><article><span>1天</span><div><b>答错、超时或不稳定</b><p>次日复习</p></div></article><article><span>3天</span><div><b>首次稳定答对</b><p>3天后复习</p></div></article><article><span>7/14/30天</span><div><b>连续稳定掌握</b><p>逐步延长间隔</p></div></article></div>
            {(insights.dueCount === 0 || practiceEmpty) && <div className="empty-state compact review-empty"><span>✓</span><h3>今日没有到期复习题</h3><p>可继续今日新题。</p><button className="primary-button" onClick={() => setTab("today")}>返回今日</button></div>}
          </div>}

          {tab === "calendar" && <div className="page-content subpage calendar-page">
            <div className="subpage-heading calendar-heading"><div><span>公考雷达 · 报考工作台</span><h1>管理公告、职位与报名节点</h1><p>查看公告、筛选职位、管理报名节点。</p></div><button className="primary-button" onClick={() => openEventForm()}>＋ 添加节点</button></div>
            <section className={`reminder-banner${dueReminder ? " urgent" : ""}`}><div><span>{dueReminder ? "有节点进入提醒期" : "报名提醒"}</span><h3>{dueReminder ? `${dueReminder.targetLabel} · ${dueReminder.title}` : "打开应用自动检查"}</h3><p>{dueReminder ? dueReminder.days === 0 ? "今日为截止或办理日期，请优先确认。" : `还有${dueReminder.days}天，请提前准备材料。` : "站内提醒已开启，可选系统通知。"}</p></div><button onClick={() => void enableBrowserReminders()}>{progress.reminderMode === "browser" ? "✓ 系统通知已开" : "开启系统通知"}</button></section>
            <div className="radar-mode-tabs" role="tablist" aria-label="公考雷达模块">
              {[
                ["notices", "公告雷达", `${relevantNotices.length}条`] as const,
                ["positions", "职位筛选", `${matchedPositions.length}岗`] as const,
                ["tasks", "报名待办", `${radarTodoItems.filter((item) => !progress.radarTodoDone[item.id]).length}项`] as const,
              ].map(([mode, label, count]) => <button key={mode} className={radarMode === mode ? "active" : ""} onClick={() => setRadarMode(mode)}><span>{label}</span><b>{count}</b></button>)}
            </div>
            <section className="radar-feature-grid" aria-label="公考雷达能力">
              <button className={radarMode === "notices" ? "active" : ""} onClick={() => setRadarMode("notices")}><span>公告</span><h3>公告雷达</h3><p>集中查看公告、职位表和重要变更。</p></button>
              <button className={radarMode === "positions" ? "active" : ""} onClick={() => setRadarMode("positions")}><span>职位</span><h3>职位筛选</h3><p>按学历、专业和身份初筛职位。</p></button>
              <button className={radarMode === "tasks" ? "active" : ""} onClick={() => setRadarMode("tasks")}><span>待办</span><h3>报名待办</h3><p>将资格核对、报名截止等转为待办。</p></button>
            </section>

            {radarMode === "notices" && <>
              <section className="notice-summary-grid">
                <article><span>已选考试</span><b>{profile.targets.length || 0}</b><small>{profile.targets.length ? profile.targets.map((target) => target.label).slice(0, 3).join(" / ") : "先设置国考或省考目标"}</small></article>
                <article><span>公告/职位表</span><b>{relevantNotices.length}</b><small>按备考组合自动匹配</small></article>
                <article><span>日历节点</span><b>{upcomingCalendarEvents.length}</b><small>{nextCalendarEvent ? `最近：${shortDate(nextCalendarEvent.eventDate)}` : "可手动添加报名节点"}</small></article>
              </section>
              <section className="notice-list"><div className="section-heading"><div><span>公告雷达</span><h2>只看与你备考组合相关的公告</h2></div><button onClick={() => openEventForm(primaryTarget?.code ?? "", "公告发布", "公告发布")}>补充公告节点</button></div>
                {relevantNotices.length ? relevantNotices.map((notice) => <article className="notice-card" key={notice.id}>
                  <div><span>{notice.targetLabel} · {notice.noticeType}</span><h3>{notice.title}</h3><p>{notice.summary || "公告摘要、报名要求和职位表说明暂待补充。"}</p><small>{notice.publishDate ? `${shortDate(notice.publishDate)}发布` : "发布时间待补充"} · {notice.status || "已发布"}</small></div>
                  {notice.sourceUrl ? <a href={notice.sourceUrl} target="_blank" rel="noreferrer" onClick={() => trackEvent("radar_notice_open", { noticeId: notice.id, targetCode: notice.targetCode })}>查看来源</a> : <button onClick={() => openEventForm(notice.targetCode, notice.noticeType, notice.title)}>加节点</button>}
                </article>) : <div className="empty-state compact calendar-empty"><span>告</span><h3>暂未发布相关公告</h3><p>可先手动添加节点，发布后自动匹配。</p><button className="primary-button" onClick={() => openEventForm()}>手动添加公告节点</button></div>}
              </section>
            </>}

            {radarMode === "positions" && <>
              {radarLimited && <section className="reminder-banner"><div><span>免费职位预览</span><h3>当前展示1个考试目标的3个职位样例</h3><p>会员可同时筛选国考和多省考职位，并收藏对比。</p></div><button onClick={() => openPaywall("radar", undefined, { tab: "calendar", radarMode: "positions" })}>解锁完整雷达</button></section>}
              <section className="candidate-panel"><div className="section-heading"><div><span>我的报考条件</span><h2>录入一次，自动初筛</h2></div><button onClick={() => void saveCandidateProfile()}>保存条件档案</button></div>
                <div className="candidate-grid">
                  <label><span>学历</span><select value={progress.candidateProfile.education} onChange={(event) => updateCandidateProfile({ education: event.target.value })}>{candidateOptions.education.map((item) => <option key={item} value={item}>{item || "请选择"}</option>)}</select></label>
                  <label><span>学位</span><select value={progress.candidateProfile.degree} onChange={(event) => updateCandidateProfile({ degree: event.target.value })}>{candidateOptions.degree.map((item) => <option key={item} value={item}>{item || "请选择"}</option>)}</select></label>
                  <label><span>专业名称</span><input value={progress.candidateProfile.major} onChange={(event) => updateCandidateProfile({ major: event.target.value })} placeholder="如：汉语言文学" /></label>
                  <label><span>专业大类</span><input value={progress.candidateProfile.majorCategory} onChange={(event) => updateCandidateProfile({ majorCategory: event.target.value })} placeholder="如：中国语言文学类" /></label>
                  <label><span>应届/往届</span><select value={progress.candidateProfile.freshStatus} onChange={(event) => updateCandidateProfile({ freshStatus: event.target.value })}>{candidateOptions.freshStatus.map((item) => <option key={item} value={item}>{item || "请选择"}</option>)}</select></label>
                  <label><span>政治面貌</span><select value={progress.candidateProfile.politicalStatus} onChange={(event) => updateCandidateProfile({ politicalStatus: event.target.value })}>{candidateOptions.politicalStatus.map((item) => <option key={item} value={item}>{item || "请选择"}</option>)}</select></label>
                  <label><span>户籍/生源地</span><input value={progress.candidateProfile.household} onChange={(event) => updateCandidateProfile({ household: event.target.value })} placeholder="如：广东广州" /></label>
                  <label><span>基层经历</span><select value={progress.candidateProfile.grassrootsYears} onChange={(event) => updateCandidateProfile({ grassrootsYears: event.target.value })}>{candidateOptions.grassrootsYears.map((item) => <option key={item} value={item}>{item || "请选择"}</option>)}</select></label>
                  <label><span>基层项目</span><select value={progress.candidateProfile.grassrootsProject} onChange={(event) => updateCandidateProfile({ grassrootsProject: event.target.value })}>{candidateOptions.grassrootsProject.map((item) => <option key={item} value={item}>{item || "请选择"}</option>)}</select></label>
                  <label><span>性别</span><select value={progress.candidateProfile.gender} onChange={(event) => updateCandidateProfile({ gender: event.target.value })}>{candidateOptions.gender.map((item) => <option key={item} value={item}>{item || "请选择"}</option>)}</select></label>
                  <label className="wide"><span>证书/资格</span><input value={progress.candidateProfile.certificates} onChange={(event) => updateCandidateProfile({ certificates: event.target.value })} placeholder="如：法律职业资格证、英语六级、计算机二级" /></label>
                  <label><span>岗位偏好</span><select value={progress.candidateProfile.acceptRemote} onChange={(event) => updateCandidateProfile({ acceptRemote: event.target.value })}>{candidateOptions.acceptRemote.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
                </div>
                <p className="candidate-note">这是“报名初筛”，不能替代官方资格审查；但能帮考生先排除明显不符、标出需要电话确认的岗位。</p>
              </section>
              <section className="position-list"><div className="section-heading"><div><span>职位筛选</span><h2>按你的备考组合和条件初步排序</h2></div><em>{savedPositionCount} 个备选</em></div>
                <div className="position-search-bar" role="search" aria-label="职位搜索与考试筛选">
                  <label><span>考试范围</span><select value={radarTargetFilter} onChange={(event) => { setRadarTargetFilter(event.target.value); setRadarPage(1); }}><option value="">全部已选考试</option>{profile.targets.map((target) => <option key={target.code} value={target.code}>{target.label}</option>)}</select></label>
                  <label><span>关键词</span><input value={radarKeyword} onChange={(event) => { setRadarKeyword(event.target.value); setRadarPage(1); }} placeholder="部门、单位、地区或职位代码" /></label>
                </div>
                <div className="position-result-note"><span>已筛选 <b>{radarTotal}</b> 个职位</span><small>匹配结果仅供初筛，最终以招录机关资格审查为准</small></div>
                {comparisonPositions.length > 0 && <section className="position-compare" aria-label="备选职位对比">
                  <div className="position-compare-heading"><div><span>横向对比</span><h3>已选 {comparisonPositions.length}/3 个职位</h3></div><button onClick={() => setComparePositions([])}>清空</button></div>
                  <div className="position-compare-scroll"><table><thead><tr><th>对比项</th>{comparisonPositions.map(({ position }) => <th key={position.id}>{position.title}</th>)}</tr></thead><tbody>
                    <tr><th>考试</th>{comparisonPositions.map(({ position }) => <td key={position.id}>{position.targetLabel}</td>)}</tr>
                    <tr><th>部门/地区</th>{comparisonPositions.map(({ position }) => <td key={position.id}>{position.department || "待补充"}<br />{position.region || "地区待补充"}</td>)}</tr>
                    <tr><th>招录</th>{comparisonPositions.map(({ position }) => <td key={position.id}>{position.recruitCount || 1}人</td>)}</tr>
                    <tr><th>学历</th>{comparisonPositions.map(({ position }) => <td key={position.id}>{position.education || "不限"}</td>)}</tr>
                    <tr><th>专业</th>{comparisonPositions.map(({ position }) => <td key={position.id}>{position.majors || "不限"}</td>)}</tr>
                    <tr><th>初筛</th>{comparisonPositions.map(({ position, match }) => <td key={position.id}><b className={`compare-match ${match.level}`}>{match.label}</b></td>)}</tr>
                    <tr><th>操作</th>{comparisonPositions.map(({ position }) => <td key={position.id}><button onClick={() => toggleComparedPosition(position)}>移除</button>{position.sourceUrl && <a href={position.sourceUrl} target="_blank" rel="noreferrer" onClick={() => trackEvent("radar_official_source_open", { positionId: position.id, targetCode: position.targetCode })}>官方来源</a>}</td>)}</tr>
                  </tbody></table></div>
                </section>}
                {radarPositionsLoading ? <div className="empty-state compact calendar-empty"><span>筛</span><h3>正在筛选职位</h3><p>根据报考组合、学历、专业和身份条件进行匹配。</p></div> : matchedPositions.length ? matchedPositions.map(({ position, match, saved }) => <article className={`position-card ${match.level}`} key={position.id}>
                  <header><div><span>{position.targetLabel} · {position.examName || "职位表"}</span><h3>{position.title}</h3><p>{position.department}{position.unit ? ` · ${position.unit}` : ""}</p></div><strong>{position.recruitCount || 1}<small>人</small></strong></header>
                  <div className="position-meta"><span>{position.region || "地区待补充"}</span><span>{position.education || "学历不限"}</span><span>{position.majors || "专业不限"}</span></div>
                  <div className={`position-match ${match.level}`}><b>{match.label}</b><span>{match.reasons.join(" · ")}</span></div>
                  {match.missing.length > 0 && <p className="position-missing"><b>需补资料：</b>{match.missing.join("、")}</p>}
                  <details className="position-basis"><summary>查看判断依据与数据版本</summary><div>{match.basis.map((item) => <span key={item}>{item}</span>)}{position.remote && <span>岗位风险：{position.remote}</span>}<span>数据版本：v{position.dataVersion || 1}{position.updatedAt ? ` · 更新于${shortDate(position.updatedAt)}` : " · 更新时间待补充"}</span></div></details>
                  {position.remarks && <p className="position-remark">{position.remarks}</p>}
                  <footer><button className={saved ? "saved" : ""} onClick={() => void toggleSavedPosition(position)}>{saved ? "✓ 已加入备选" : "+ 加入备选"}</button><button className={comparePositions.some((item) => item.id === position.id) ? "compared" : ""} onClick={() => toggleComparedPosition(position)}>{comparePositions.some((item) => item.id === position.id) ? "✓ 对比中" : "加入对比"}</button>{position.sourceUrl && <a href={position.sourceUrl} target="_blank" rel="noreferrer" onClick={() => trackEvent("radar_official_source_open", { positionId: position.id, targetCode: position.targetCode })}>官方来源</a>}</footer>
                </article>) : <div className="empty-state compact calendar-empty"><span>职</span><h3>{radarKeyword ? "没有匹配当前关键词的职位" : "暂未发布可筛选的职位表"}</h3><p>{radarKeyword ? "可缩短关键词或切换考试范围。" : "发布后显示匹配结果，并支持收藏、对比。"}</p></div>}
                {!radarLimited && radarTotal > 20 && <nav className="position-pagination" aria-label="职位分页"><button disabled={radarPage <= 1 || radarPositionsLoading} onClick={() => setRadarPage((page) => Math.max(1, page - 1))}>上一页</button><span>第 {radarPage} / {Math.max(1, Math.ceil(radarTotal / 20))} 页</span><button disabled={radarPage >= Math.ceil(radarTotal / 20) || radarPositionsLoading} onClick={() => setRadarPage((page) => page + 1)}>下一页</button></nav>}
              </section>
            </>}

            {radarMode === "tasks" && <>
              <section className="radar-todo-list"><div className="section-heading"><div><span>报名待办</span><h2>今天要处理的事项</h2></div><button onClick={() => openEventForm()}>添加自定义待办</button></div>
                {radarTodoItems.length ? radarTodoItems.map((item) => {
                  const done = Boolean(progress.radarTodoDone[item.id]);
                  return <article className={`${item.tone}${done ? " done" : ""}`} key={item.id}>
                    <button className="todo-check" aria-label={`${done ? "取消完成" : "标记完成"}${item.title}`} onClick={() => void toggleRadarTodo(item.id)}>{done ? "✓" : ""}</button>
                    <div><h3>{item.title}</h3><p>{item.detail}</p></div>
                    <button className="todo-action" onClick={() => {
                      if (item.kind === "profile" || item.kind === "position") return setRadarMode("positions");
                      if (item.kind === "notice") return setRadarMode("notices");
                      const eventId = item.id.replace(/^event:/, "");
                      const event = upcomingCalendarEvents.find((entry) => entry.id === eventId);
                      if (event?.id.startsWith("exam-")) { setProfileDraft(profile); setOnboardingOpen(true); return; }
                      if (event?.sourceUrl) { trackEvent("radar_notice_open", { eventId: event.id, targetCode: event.targetCode }); window.open(event.sourceUrl, "_blank", "noopener,noreferrer"); return; }
                      if (event?.id.startsWith("event-")) { openExistingEventForm(event); return; }
                      if (event) { focusCalendarEvent(event, "该官方节点暂未配置来源，已为你定位到时间轴详情"); return; }
                      notify("该节点已更新，请刷新公考雷达后重试");
                    }}>{item.actionLabel}</button>
                  </article>;
                }) : <div className="empty-state compact calendar-empty"><span>✓</span><h3>当前没有待办</h3><p>添加报名、审查等节点后自动生成。</p><button className="primary-button" onClick={() => openEventForm()}>添加第一个节点</button></div>}
              </section>
              <div className="calendar-targets">{profile.targets.map((target, index) => <button key={target.code} onClick={() => openEventForm(target.code)}><span>{index === 0 ? "主攻" : "兼顾"}</span><b>{target.label}</b><small>{target.examDate ? `${shortDate(target.examDate)}笔试` : "补充考试节点"}</small></button>)}</div>
              <section className="calendar-list"><div className="section-heading"><div><span>时间轴</span><h2>公告、职位表与报名节点</h2></div><em>{upcomingCalendarEvents.length} 个节点</em></div>
                {upcomingCalendarEvents.length ? upcomingCalendarEvents.map((event) => {
                  const automatic = event.id.startsWith("exam-");
                  const official = event.id.startsWith("official-");
                  const due = event.reminderEnabled && event.days <= event.reminderDays;
                  return <article id={`calendar-event-${event.id}`} className={`calendar-event${due ? " due" : ""}${focusedEventId === event.id ? " focused" : ""}`} key={event.id}>
                    <time><b>{new Date(`${event.eventDate}T12:00:00+08:00`).getMonth() + 1}</b><span>{new Date(`${event.eventDate}T12:00:00+08:00`).getDate()}日</span></time>
                    <div><span>{event.targetLabel} · {event.eventType}{official ? " · 官方发布" : ""}</span><h3>{event.title}</h3><p>{event.days === 0 ? "今天处理" : `还有${event.days}天`} · 提前{event.reminderDays}天提醒{event.sourceUrl && <> · <a href={event.sourceUrl} target="_blank" rel="noreferrer">查看公告来源</a></>}</p></div>
                    {automatic ? <button aria-label={`修改${event.title}`} onClick={() => { setProfileDraft(profile); setOnboardingOpen(true); }}>修改</button>
                      : official ? event.sourceUrl
                        ? <a className="event-official-action" href={event.sourceUrl} target="_blank" rel="noreferrer" onClick={() => trackEvent("radar_official_source_open", { eventId: event.id, targetCode: event.targetCode })}>官方来源</a>
                        : <button disabled title="暂未提供官方来源链接">暂无来源</button>
                      : <button aria-label={`删除${event.title}`} onClick={() => void removeExamEvent(event.id)}>删除</button>}
                  </article>;
                }) : <div className="empty-state compact calendar-empty"><span>历</span><h3>还没有公考雷达节点</h3><p>建议先添加公告、职位表和报名截止。</p><button className="primary-button" onClick={() => openEventForm()}>添加第一个节点</button></div>}
              </section>
            </>}
            <p className="calendar-disclaimer">时间与资格条件以招录机关官方发布为准。</p>
          </div>}

          {tab === "report" && <div className="page-content subpage">
            <div className="subpage-heading"><span>学习诊断</span><h1>明确下一阶段训练重点</h1><p>结合正确率、薄弱考点和作答用时生成训练建议。</p></div>
            {threeDayReportReady ? <article className="report-card three-day-report ready">
              <div className="three-day-report-heading"><div><span>3天体验报告 · 已生成</span><h2>基于近期作答生成阶段报告</h2></div><em>近7日有效学习 {weeklyMetrics.activeDays} 天</em></div>
              <p className="three-day-report-source">报告依据近7日作答和当前复习状态生成，不提供排名或提分预测。</p>
              <div className="three-day-report-grid">
                <div><span>近7日真题</span><b>{weeklyMetrics.total}</b><small>道</small></div>
                <div><span>近7日正确率</span><b>{weeklyMetrics.accuracy}</b><small>%</small></div>
                <div><span>掌握不稳定/猜测作答</span><b>{insights.uncertainCount}</b><small>道</small></div>
                <div><span>累计超时</span><b>{insights.overtimeCount}</b><small>道</small></div>
                <div><span>当前到期复习</span><b>{insights.dueCount}</b><small>道</small></div>
                <div><span>近7日高频覆盖</span><b>{weeklyMetrics.highFrequencyCoverage}</b><small>个</small></div>
              </div>
              <div className="three-day-report-issues"><b>下一阶段优先训练</b>{threeDayNextIssues.length ? <ol>{threeDayNextIssues.map((issue) => <li key={issue}>{issue}</li>)}</ol> : <p>当前有效样本不足，继续完成训练后自动生成建议。</p>}</div>
              <div className="three-day-report-footer"><small>以上内容依据实际作答记录生成，不含排名或提分预测。</small><button type="button" onClick={() => void shareThreeDayReport()}>分享学习摘要</button></div>
            </article> : <article className="report-card three-day-report progress">
              <div className="three-day-report-heading"><div><span>3天体验报告</span><h2>再完成 {Math.max(0, 3 - threeDayReportProgress)} 个有效学习日</h2></div><em>{threeDayReportProgress}/3 天</em></div>
              <div className="three-day-progress-dots" aria-label={`三天体验进度：已完成${threeDayReportProgress}天`}>{[1, 2, 3].map((dayNumber) => <i key={dayNumber} className={dayNumber <= threeDayReportProgress ? "done" : ""}>{dayNumber <= threeDayReportProgress ? "✓" : dayNumber}</i>)}</div>
              <p>累计3个学习日后生成完整报告，不提供排名或提分预测。</p>
              <button type="button" className="secondary-button" onClick={() => setTab("today")}>继续今日练习</button>
            </article>}
            {insights.total === 0 ? <div className="empty-state report-empty"><span>报</span><h3>完成第一组日练后生成诊断</h3><p>系统分析正确率、用时和薄弱模块；样本不足时不下结论。</p><button className="primary-button" onClick={runDailyAction}>开始今日日练</button></div> : <>
              <div className="stats-grid report-stats"><article><span>累计答题</span><strong>{insights.total}</strong><small>题</small></article><article><span>正确率</span><strong>{insights.accuracy}</strong><small>%</small></article><article><span>掌握不稳定/猜测作答</span><strong>{insights.uncertainCount}</strong><small>题</small></article><article><span>超时作答</span><strong>{insights.overtimeCount}</strong><small>题</small></article><article><span>平均用时</span><strong>{insights.avgSeconds}</strong><small>秒</small></article><article><span>今日到期复习</span><strong>{insights.dueCount}</strong><small>题</small></article></div>
              <article className="report-card weekly-report"><div className="report-title"><h3>本周学习结果</h3><span>最近7个自然日 · 有效作答</span></div><div className="prescription-facts"><span>完成 {weeklyMetrics.total} 道真题</span><span>正确率 {weeklyMetrics.accuracy}%{weeklyMetrics.accuracyDelta !== null ? `（${weeklyMetrics.accuracyDelta >= 0 ? "+" : ""}${weeklyMetrics.accuracyDelta}pp）` : ""}</span><span>学习 {weeklyMetrics.activeDays} 天</span><span>高频考点覆盖 {weeklyMetrics.highFrequencyCoverage} 个</span><span>重复错误率 {weeklyMetrics.repeatErrorRate === null ? "样本积累中" : `${weeklyMetrics.repeatErrorRate}%`}</span><span>平均 {weeklyMetrics.avgSeconds} 秒{weeklyMetrics.avgSecondsDelta !== null ? `（${weeklyMetrics.avgSecondsDelta > 0 ? "慢" : "快"}${Math.abs(weeklyMetrics.avgSecondsDelta)}秒）` : ""}</span></div>
                <p><b>本周已稳定掌握：</b>{weeklyMetrics.masteredPoints.length ? weeklyMetrics.masteredPoints.join("、") : "尚无达到稳定掌握条件的考点"}</p>
                <p><b>下周优先训练：</b>{weeklyMetrics.nextIssues.length ? weeklyMetrics.nextIssues.join("；") : "完成更多有效作答后生成优先训练建议"}</p>
              </article>
              <article className="report-card mastery-card"><div className="report-title"><h3>掌握状态</h3><span>{insights.stateCounts.mastered}题已掌握</span></div><div className="mastery-segments"><i className="mastered" style={{ flex: insights.stateCounts.mastered }} /><i className="learning" style={{ flex: insights.stateCounts.learning }} /><i className="weak" style={{ flex: insights.stateCounts.weak }} /></div><div className="mastery-legend"><span><i className="mastered" />已掌握 {insights.stateCounts.mastered}</span><span><i className="learning" />学习中 {insights.stateCounts.learning}</span><span><i className="weak" />薄弱 {insights.stateCounts.weak}</span></div></article>
              <article className="report-card"><div className="report-title"><h3>模块正确率与速度</h3><span>最近14天</span></div>{insights.modules.map((item) => <div className="module-row" key={item.module}><div><b>{item.module}</b><small>{item.total}题 · 平均{item.avgSeconds}秒</small></div><div><i style={{ width: `${item.accuracy}%` }} /></div><strong>{item.accuracy}%</strong></div>)}</article>
              <article className="report-card suggestion tomorrow-prescription"><span>明日安排</span><h3>{tomorrowPlan.focusModule ? `先完成到期复习，再训练${tomorrowPlan.focusModule}` : "先完成到期复习，再按主攻题库练习新题"}</h3><p>{tomorrowPlan.taskText}</p><div className="prescription-facts"><span>预计 {tomorrowPlan.estimatedMinutes} 分钟</span><span>到期 {tomorrowPlan.dueCount} 题</span><span>{primaryTarget?.label ?? "主攻待设置"}</span></div>{tomorrowPlan.focusModule && <button className="secondary-button" onClick={() => void startPractice("mixed", undefined, { kind: "bonus", limit: tomorrowPlan.focusQuestionCount || 5, forceNew: true, focusModule: tomorrowPlan.focusModule ?? undefined })}>进行5题薄弱模块强化</button>}</article>
            </>}
          </div>}

          {tab === "me" && <div className="page-content subpage me-page">
            <div className="profile-card me-profile-card">
              <div className="profile-avatar">练</div>
              <div><span>{bootstrap?.user.displayName ?? "公考日练用户"}</span><h2>{targetSummary}备考中</h2><p>{profile.targets.length}个报考目标 · 每天{profile.dailyMinutes}分钟</p></div>
              <button className="profile-edit" onClick={() => { setProfileDraft(profile); setOnboardingOpen(true); }}>修改</button>
            </div>
            <div className="target-chip-row">{profile.targets.map((target, index) => <span className="target-chip" key={target.code}>{index === 0 ? "主攻 · " : ""}{target.label} · {target.examYear}</span>)}</div>
            <article className={`panel-card redeem-panel redeem-panel-primary${bootstrap?.user.membershipActive ? " member-active" : ""}`} id="redeem-membership">
              <div className="redeem-primary-heading"><div><span>{bootstrap?.user.membershipActive ? "继续兑换" : "已有兑换码"}</span><h3>{bootstrap?.user.membershipActive ? "叠加会员使用时长" : "输入兑换码，立即激活会员"}</h3></div><em>7 / 30 / 365 天 / 终身</em></div>
              <div className="redeem-row"><input aria-label="兑换码" value={redeemCode} onChange={(event) => setRedeemCode(event.target.value.toUpperCase())} placeholder="请输入兑换码" /><button onClick={() => void redeem()} disabled={busy}>{busy ? "处理中" : "立即激活"}</button></div>
              <small>激活后返回今日；时长自动累计，终身权益不被覆盖。</small>
            </article>

            <article className="panel-card invite-panel invite-panel-primary" id="invite-friends">
              <div className="invite-primary-heading"><div><span>邀请有礼</span><h3>分享邀请码，双方得会员时长</h3></div><em>邀请人 +{bootstrap?.inviteConfig.rewardDays ?? 7}天 · 好友 +{bootstrap?.inviteConfig.inviteeRewardDays ?? 3}天</em></div>
              <div className="invite-primary-code"><div><span>我的邀请码</span><strong>{bootstrap?.user.signedIn ? bootstrap.user.inviteCode ?? "生成中" : "登录后生成"}</strong></div>{bootstrap?.user.signedIn ? <button type="button" onClick={() => void copyInvite()}>复制并分享</button> : <a href={signInHref}>登录后生成邀请链接</a>}</div>
              <small>好友完成账号验证和首次有效日练后，双方自动获得时长。</small>
              {bootstrap?.user.signedIn && <div className="invite-primary-stats"><span>已邀请 <b>{bootstrap?.inviteStats.total ?? 0}</b> 人</span><span>待完成 <b>{bootstrap?.inviteStats.pending ?? 0}</b></span><span>已奖励 <b>{bootstrap?.inviteStats.rewarded ?? 0}</b></span></div>}
            </article>

            <section className="me-section" aria-labelledby="me-learning-overview">
              <div className="me-section-heading"><h3 id="me-learning-overview">学习概览</h3><span>进度与报考提醒</span></div>
              <div className="me-overview-card">
                <div className="me-overview-row"><div className="me-overview-icon streak">练</div><div><span>连续打卡</span><h3>{streak}天 · 累计{progress.checkins.length}天</h3><p>完成当日日练自动打卡。</p></div><strong>{streak >= 30 ? "30" : streak >= 7 ? "7" : "✓"}</strong></div>
                <button type="button" className="me-overview-row" onClick={() => setTab("calendar")}><div className="me-overview-icon radar">雷</div><div><span>公考雷达</span><h3>{nextCalendarEvent ? `${nextCalendarEvent.targetLabel} · ${nextCalendarEvent.title}` : "补全公告、职位表与报名节点"}</h3><p>{nextCalendarEvent ? nextCalendarEvent.days === 0 ? "今日需完成关键事项核对。" : `还有${nextCalendarEvent.days}天，已设置提前提醒。` : "管理公告、职位与报名节点。"}</p></div><strong>›</strong></button>
                <button type="button" className="me-overview-row" onClick={() => setTab("report")}><div className="me-overview-icon report">析</div><div><span>学习诊断</span><h3>{insights.total ? `已分析 ${insights.total} 道有效作答` : "完成首轮后生成训练建议"}</h3><p>查看薄弱项和训练建议。</p></div><strong>›</strong></button>
              </div>
            </section>

            <section className="me-section" aria-labelledby="me-account-services">
              <div className="me-section-heading"><h3 id="me-account-services">会员与账户</h3><span>权益状态与数据同步</span></div>
              <div className="me-account-card">
                <article className={`me-account-row membership-summary${bootstrap?.user.membershipActive ? " active" : ""}`}><div><span>{bootstrap?.user.membershipActive ? "会员有效期" : "当前版本"}</span><h3>{bootstrap?.user.membershipActive ? bootstrap.user.membershipType === "lifetime" ? "终身会员" : `会员有效至 ${formatDate(bootstrap.user.membershipEnd)}` : "免费版"}</h3><p>{bootstrap?.user.membershipActive ? "完整题库、复习和职位筛选已启用。" : "激活后解锁完整日练与复习权益。"}</p></div>{bootstrap?.user.membershipActive ? <b>VIP</b> : <button className="profile-edit" onClick={() => openPaywall("value_loop", undefined, { tab: "me" })}>查看权益</button>}</article>
                <article className={`me-account-row sync-summary${bootstrap?.user.signedIn ? " signed" : ""}`}><div><span>{bootstrap?.user.signedIn ? "账号同步已开启" : "当前仅保存在本设备"}</span><h3>{bootstrap?.user.signedIn ? "换设备也能继续学习" : "登录后同步学习记录"}</h3><p>{bootstrap?.user.signedIn ? "目标、题库、记录和会员时长已同步。" : "登录时会自动合并当前进度。"}</p></div>{bootstrap?.user.signedIn ? <b>✓ 已同步</b> : <a href={signInHref}>登录并同步</a>}</article>
              </div>
            </section>

            {meCampaign && isCampaignVisible(meCampaign) && <section className={`configured-campaign-card tone-${meCampaign.tone}`}><div><span>{meCampaign.eyebrow}</span><h2>{meCampaign.title}</h2><p>{meCampaign.summary}</p></div><button onClick={() => { recordCampaignClick(meCampaign); runConfiguredAction(meCampaign.actionType, meCampaign.actionTarget, `campaign:${meCampaign.id}`); }}>{meCampaign.actionLabel}</button></section>}
            <details className="panel-card ledger-card me-fold-card"><summary><div><h3>会员时长记录</h3><span>{bootstrap?.ledger.length ? `${bootstrap.ledger.length} 条变动记录` : "暂无变动记录"}</span></div><strong>展开</strong></summary><div className="me-fold-content">{bootstrap?.ledger.length ? bootstrap.ledger.map((item, index) => <div className="ledger-row" key={item.created_at + "-" + index}><div><b>{item.note}</b><span>{new Date(item.created_at).toLocaleDateString("zh-CN")}</span></div><strong>+{item.delta_days}天</strong></div>) : <p className="muted">激活或获得邀请奖励后，将在这里记录。</p>}</div></details>
            <button type="button" className="about-entry-card" onClick={() => setTab("about")}><div><span>产品与服务说明</span><h3>关于公考日练</h3><p>查看账号售后、内容来源和版权说明。</p></div><strong>›</strong></button>
          </div>}

          {tab === "about" && <div className="page-content subpage about-page">
            <div className="subpage-back-heading"><button type="button" onClick={() => setTab("me")}>‹ 返回</button><span>关于公考日练</span></div>
            <section className="about-intro-card"><div className="brand-mark">公</div><div><h1>公考日练</h1><p>面向公务员考试备考人群的精简日练与资料查询工具。</p></div></section>
            <section className="about-menu" aria-label="关于公考日练">
              <button type="button" onClick={openSupportNotice}><div><b>账号、权益与售后</b><small>账号同步、兑换异常、权益找回与服务联系方式</small></div><strong>›</strong></button>
              <button type="button" onClick={openCopyrightNotice}><div><b>版权与内容来源说明</b><small>内容来源、第三方名称使用及权利投诉方式</small></div><strong>›</strong></button>
            </section>
          </div>}

          {tab === "support" && <div className="page-content subpage legal-page support-page">
            <div className="subpage-back-heading"><button type="button" onClick={() => setTab("about")}>‹ 返回</button><span>账号、权益与售后</span></div>
            <article className="legal-copy">
              <h1>账号、权益与售后</h1>
              <div className="support-status-grid">
                <div><span>当前账号</span><b>{bootstrap?.user.displayName ?? "公考日练用户"}</b><small>账号尾号 {bootstrap?.user.id ? bootstrap.user.id.slice(-6) : "未生成"}</small></div>
                <div><span>同步状态</span><b>{bootstrap?.user.signedIn ? "已登录并同步" : "仅当前设备"}</b><small>{bootstrap?.user.signedIn ? "目标、题库、记录和权益以服务端账号为准" : "登录后会合并当前学习进度"}</small></div>
                <div><span>会员权益</span><b>{bootstrap?.user.membershipActive ? bootstrap.user.membershipType === "lifetime" ? "终身有效" : `有效至 ${formatDate(bootstrap.user.membershipEnd)}` : "当前未激活"}</b><small>兑换时长自动累计，终身权益不会被覆盖</small></div>
              </div>
              <h2>遇到兑换或权益问题</h2>
              <p>请准备当前账号尾号、兑换码后4位、购买时间和问题截图。请勿发送完整兑换码、登录凭证或任何账号密码。</p>
              <ul>
                <li><b>兑换到错误账号：</b>{supportInfo?.wrongAccountPolicy || "需核验购买凭证和两个账号后人工处理。"}</li>
                <li><b>未使用兑换码：</b>{supportInfo?.unusedCodePolicy || "按购买渠道公示规则人工核验。"}</li>
                <li><b>账号合并：</b>{supportInfo?.accountMergePolicy || "核验账号归属后处理，权益变更会留痕。"}</li>
                <li><b>兑换码转让：</b>{supportInfo?.codeTransferPolicy || "激活后不得转让，未激活码请妥善保管。"}</li>
              </ul>
              <div className="legal-contact">
                <span>售后联系</span>
                <b>{supportInfoLoading ? "正在读取配置" : supportInfo?.supportWechat ? `微信：${supportInfo.supportWechat}` : supportInfo?.supportEmail ? <a href={`mailto:${supportInfo.supportEmail}`}>{supportInfo.supportEmail}</a> : "请通过购买公众号联系"}</b>
                <small>{supportInfo?.officialAccountName ? `公众号：${supportInfo.officialAccountName} · ` : ""}{supportInfo?.serviceHours || "工作日 9:00—18:00"}</small>
              </div>
              <div className="support-purchase-note">
                <b>购买与激活</b>
                <p>{supportInfo?.purchaseInstructions || "在官方公众号完成购买并领取兑换码，再返回“我的”页面激活。"}</p>
                {supportInfo?.purchaseUrl && <a href={supportInfo.purchaseUrl} target="_blank" rel="noreferrer">查看购买说明</a>}
              </div>
              <p className="support-mini-note">微信小程序正在准备中。上线后将采用账号绑定方式承接既有学习记录和权益；在完成真机验收前，本产品不会宣称已支持微信登录或订阅消息。</p>
            </article>
          </div>}

          {tab === "copyright" && <div className="page-content subpage legal-page">
            <div className="subpage-back-heading"><button type="button" onClick={() => setTab("about")}>‹ 返回</button><span>版权与内容来源说明</span></div>
            <article className="legal-copy">
              <h1>版权与内容来源说明</h1>
              <p>“公考日练”提供公务员考试相关资料的分类、整理与查询服务。除本平台原创内容外，部分试题、材料及参考答案整理自公开可访问的网络资料，相关著作权归原作者或权利人所有。</p>
              <p>页面中的机构或作者名称仅用于说明资料来源，不代表本平台与相关机构存在合作、推荐或背书关系。除明确标注为官方内容外，平台所展示的答案均为第三方参考答案，不属于官方标准答案，仅供备考查询参考。</p>
              <p>如您是相关内容的著作权人或合法授权代理人，并认为平台展示的内容侵犯了您的合法权益，请将以下信息发送至版权联系邮箱：</p>
              <ul>
                <li>权利人姓名或主体名称及联系方式；</li>
                <li>相关权属证明或授权证明；</li>
                <li>涉及内容的页面、试卷名称及题号；</li>
                <li>需要删除、修改或断开链接的具体内容。</li>
              </ul>
              <p>平台收到完整通知后，将及时核验，并根据实际情况采取隐藏、删除或断开链接等必要措施。</p>
              <div className="legal-contact"><span>版权联系邮箱</span><b>{copyrightContactEmail ? <a href={`mailto:${copyrightContactEmail}`}>{copyrightContactEmail}</a> : copyrightContactLoading ? "正在读取配置" : "暂未配置"}</b><small>处理时间：工作日9:00—18:00</small></div>
            </article>
          </div>}
        </>}

        <AudioHub active={!activeModule && tab === "audio"} tracks={bootstrap?.content.audioTracks ?? []} wrongQuestions={audioWrongQuestions} notify={notify} trackEvent={trackEvent} authorizePlayback={authorizeAudioPlayback} />

        {paywall && bootstrap && <CommercePaywall
          reason={paywall.reason}
          copyOverride={paywall.copy}
          policyId={paywall.policyId}
          triggerEvent={paywall.triggerEvent}
          signedIn={bootstrap.user.signedIn}
          returnContext={paywall.returnContext}
          value={{
            completedQuestions: insights.total,
            wrongQuestions: insights.stateCounts.weak,
            tomorrowDue: tomorrowPlan.dueCount,
            tomorrowMinutes: tomorrowPlan.estimatedMinutes,
            bankCount: addedBanks.length,
          }}
          request={api}
          trackEvent={trackEvent}
          notify={notify}
          onClose={closePaywall}
          onActivated={finishPaywallActivation}
          loginHref={signInHref}
          onLogin={preparePaywallLogin}
          onOpenRedemption={() => {
            setPaywall(null);
            setActiveModule(null);
            setTab("me");
            window.setTimeout(() => document.getElementById("redeem-membership")?.scrollIntoView({ behavior: "smooth", block: "center" }), 0);
          }}
        />}

        {!activeModule && <nav className="bottom-nav" aria-label="主导航"><button className={tab === "today" ? "active" : ""} onClick={() => navigateFromBottom("today")}><span>今</span>今日</button><button className={tab === "banks" ? "active" : ""} onClick={() => navigateFromBottom("banks")}><span>库</span>题库</button><button className={tab === "review" ? "active" : ""} onClick={() => navigateFromBottom("review")}><span>复</span>复习</button><button className={tab === "resources" || tab === "essayLibrary" || tab === "audio" ? "active" : ""} onClick={() => navigateFromBottom("resources")}><span>资</span>资料</button><button className={tab === "me" || tab === "report" || tab === "calendar" || tab === "about" || tab === "support" || tab === "copyright" ? "active" : ""} onClick={() => navigateFromBottom("me")}><span>我</span>我的</button></nav>}

        {eventFormOpen && bootstrap && (
          <div className="onboarding-backdrop" role="dialog" aria-modal="true" aria-labelledby="event-form-title" aria-describedby="event-form-description">
            <section className="event-form-card">
              <div className="event-form-top"><div><span>公考雷达</span><h2 id="event-form-title">{editingEventId ? "编辑考试节点" : "添加公告、职位或报名节点"}</h2><p id="event-form-description">先记录最容易错过的截止时间，系统会按提前天数提醒。</p></div><button aria-label="关闭考试节点弹窗" onClick={() => { setEventFormOpen(false); setEditingEventId(""); }}>×</button></div>
              <div className="event-form-grid">
                <label><span>对应考试</span><select value={eventDraft.targetCode} onChange={(event) => setEventDraft({ ...eventDraft, targetCode: event.target.value })}><option value="">请选择</option>{profile.targets.map((target) => <option key={target.code} value={target.code}>{target.label}</option>)}</select></label>
                <label><span>节点类型</span><select value={eventDraft.eventType} onChange={(event) => { const eventType = event.target.value; setEventDraft({ ...eventDraft, eventType, title: eventDraft.title === eventDraft.eventType ? eventType : eventDraft.title }); }}>{examEventTypes.map((type) => <option key={type}>{type}</option>)}</select></label>
                <label className="wide"><span>节点名称</span><input value={eventDraft.title} maxLength={40} onChange={(event) => setEventDraft({ ...eventDraft, title: event.target.value })} placeholder="如：广东省考职位表发布" /></label>
                <label><span>日期</span><input type="date" value={eventDraft.eventDate} onChange={(event) => setEventDraft({ ...eventDraft, eventDate: event.target.value })} /></label>
                <label><span>提前提醒</span><select value={eventDraft.reminderDays} onChange={(event) => setEventDraft({ ...eventDraft, reminderDays: Number(event.target.value) })}>{[0, 1, 3, 7, 14].map((days) => <option key={days} value={days}>{days === 0 ? "当天" : `提前${days}天`}</option>)}</select></label>
                <label className="wide"><span>官方公告链接（选填）</span><input type="url" value={eventDraft.sourceUrl} onChange={(event) => setEventDraft({ ...eventDraft, sourceUrl: event.target.value })} placeholder="https://…" /></label>
              </div>
              <button className="primary-button full-button" onClick={() => void saveExamEvent()}>{editingEventId ? "保存节点修改" : "保存并开启提醒"}</button>
              <small className="event-form-note">站内提醒将在每次打开时自动检查；系统通知能力以当前设备授权情况为准。</small>
            </section>
          </div>
        )}

        {onboardingOpen && bootstrap && (
          <div className="onboarding-backdrop" role="dialog" aria-modal="true" aria-labelledby="onboarding-title" aria-describedby="onboarding-description">
            <section className="onboarding-card">
              <div className="onboarding-top">
                <span>支持同时备考</span>
                <h2 id="onboarding-title">{profile.onboarded ? "调整你的多个报考目标" : "你准备参加哪些公务员考试？"}</h2>
                <p id="onboarding-description">国考和多个省考都可以同时选择；排在首位的是主攻考试，保存后可在公考雷达补充公告、职位表、报名和准考证节点。</p>
              </div>

              <div className="target-picker">
                <label>国考（可与省考同时选择）</label>
                <button className="target-option" aria-pressed={profileDraft.targets.some((target) => target.code === "national")} onClick={() => toggleTarget("国考")}>
                  <span><b>国家公务员考试</b><small>加入国考题库推荐与倒计时</small></span>
                </button>
              </div>

              <div className="province-picker">
                <label>省考地区（可多选）</label>
                <div className="province-grid">
                  {availableProvinces.map((province) => {
                    const selected = profileDraft.targets.some((target) => target.code === `province:${province}`);
                    return <button key={province} className="province-option" aria-pressed={selected} onClick={() => toggleTarget("省考", province)}>{province}</button>;
                  })}
                </div>
              </div>

              <div className="selected-target-note">
                {profileDraft.targets.length
                  ? `已选择 ${profileDraft.targets.length} 项：${profileDraft.targets.map((target) => target.label).join("、")}`
                  : "尚未选择。请至少选择国考或一个省考地区。"}
              </div>

              {profileDraft.targets.map((target, index) => (
                <div className="choice-group" key={target.code}>
                  <label>{target.label} · 考试年份与日期 {index === 0 && <span className="primary-badge">主攻考试</span>}</label>
                  {index > 0 && <button className="onboarding-cancel" onClick={() => setPrimaryTarget(target.code)}>设为主攻考试</button>}
                  <div className="onboarding-grid">
                    <select aria-label={`${target.label}考试年份`} value={target.examYear} onChange={(event) => updateTarget(target.code, { examYear: Number(event.target.value) })}>
                      {[new Date().getFullYear(), new Date().getFullYear() + 1, new Date().getFullYear() + 2, new Date().getFullYear() + 3].map((year) => <option key={year}>{year}</option>)}
                    </select>
                    <input aria-label={`${target.label}考试日期`} type="date" value={target.examDate ?? ""} onChange={(event) => updateTarget(target.code, { examDate: event.target.value || null })} />
                  </div>
                </div>
              ))}

              <div className="choice-group">
                <label>每天计划学习</label>
                <div className="minute-choice">{[10, 30, 45, 60].map((minutes) => <button key={minutes} className={normalizePlanMinutes(profileDraft.dailyMinutes) === minutes ? "active" : ""} onClick={() => setProfileDraft({ ...profileDraft, dailyMinutes: minutes })}>{minutes}分钟</button>)}</div>
              </div>
              {!profile.onboarded && (() => {
                const choices = bootstrap.questionBanks.filter((bank) =>
                  (bank.subject === "行测" || bank.subject === "综合") && bank.questionCount >= 5
                  && profileDraft.targets.some((target) => targetMatchesBank(target, bank) && bankYearSupportsTarget(bank.examYear, target.examYear)));
                return <div className="choice-group onboarding-bank-choice"><label>选择首套可练真题库</label>{choices.length ? <div>{choices.slice(0, 8).map((bank) => <button key={bank.code} className={onboardingBankCode === bank.code ? "active" : ""} onClick={() => setOnboardingBankCode(bank.code)}><b>{bank.name}</b><small>{bank.province}-{bank.examYear ?? "近年"} · {bank.questionCount}题 · 当前可用</small></button>)}</div> : <p>当前目标暂时没有可用的行测真题库。可以先保存目标；有适配题库后，首页将提示完善配置，在此之前不会生成无题目的训练任务。</p>}</div>;
              })()}
              <div className="province-isolation-note">10/30/45/60分钟分别安排5/10/15/20道行测题；报考目标用于推荐和倒计时，只有主动加入且地区、年份匹配并已有真题的题库才会进入智能练习。</div>
              <button className="primary-button full-button onboarding-submit" disabled={busy || !profileDraft.targets.length} onClick={() => void saveProfile()}>{busy ? "正在保存…" : profile.onboarded ? `保存 ${profileDraft.targets.length} 个报考目标` : onboardingBankCode ? "完成配置并加入真题库" : "保存目标"}</button>
              {profile.onboarded && <button className="onboarding-cancel" onClick={() => setOnboardingOpen(false)}>取消修改</button>}
            </section>
          </div>
        )}
        {diagnosticPromptOpen && <div className="onboarding-backdrop" role="dialog" aria-modal="true" aria-labelledby="diagnostic-title" aria-describedby="diagnostic-description"><section className="onboarding-card diagnostic-prompt"><div className="onboarding-top"><span>首次体验</span><h2 id="diagnostic-title">完成5道真题，建立首份学习记录</h2><p id="diagnostic-description">系统将根据答错、掌握不稳定、猜测作答和超时情况生成后续复习安排，也可稍后从今日页开始。</p></div><button className="primary-button full-button" onClick={() => { const bankCode = onboardingBankCode; setDiagnosticPromptOpen(false); void startPractice("mixed", bankCode ? [bankCode] : undefined, { kind: "diagnostic", limit: 5 }); }}>开始5题体验</button><button className="onboarding-cancel" onClick={() => { setDiagnosticPromptOpen(false); setTab("today"); }}>稍后开始</button></section></div>}
        {toast && <div className="toast" role="status">{toast}</div>}
      </div>
    </main>
  );
}
