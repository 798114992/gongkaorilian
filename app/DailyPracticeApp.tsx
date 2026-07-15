"use client";

/* eslint-disable react-hooks/refs -- session snapshots and queued saves intentionally use refs inside event handlers */
/* eslint-disable @next/next/no-img-element -- operator-uploaded question media can come from runtime-configured sources */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PracticeDay, Question } from "./data/content";
import type { AudioTrack } from "./data/audio";
import AudioHub from "./AudioHub";

type Tab = "today" | "banks" | "audio" | "review" | "report" | "calendar" | "me";
type Module = "morning" | "practice" | "affairs" | "essay" | null;
type PracticeMode = "mixed" | "review";
type PlanMinutes = 10 | 30 | 45 | 60;
type PracticeKind = "daily" | "review" | "bank" | "bonus";
type AnswerConfidence = "" | "confident" | "hesitant" | "guessed";
type ReminderMode = "in_app" | "browser";
type RadarMode = "notices" | "positions" | "tasks";
type DailyStep = "morning" | "practice" | "essay";

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

type ContentEntry<T = Record<string, unknown>> = {
  id?: string;
  contentKey?: string;
  title?: string;
  payload?: T;
} & Partial<T>;

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
  imageUrl: string;
  resourceUrl: string;
  truthLabel: string;
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
  checkins: string[];
  primaryBankCode: string;
  planOverrides: Record<string, PlanMinutes>;
  activePractice: ActivePracticeSession | null;
  examEvents: ExamEvent[];
  reminderMode: ReminderMode;
  candidateProfile: CandidateProfile;
  savedPositionIds: string[];
  radarTodoDone: Record<string, boolean>;
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
  studiedCount: number;
  masteredCount: number;
  weakCount: number;
  dueCount: number;
  added: boolean;
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
  recent: Array<{ day: string; total: number; accuracy: number }>;
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
  suggestedSeconds?: number;
  imageUrl?: string;
  resourceUrl?: string;
  truthLabel?: string;
};

type AnswerFeedback = {
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

type PracticeSummary = {
  kind: PracticeKind;
  mode: PracticeMode;
  answered: number;
  correct: number;
  reviewAdded: number;
  elapsedSeconds: number;
  bankCodes: string[];
};

type Bootstrap = {
  user: {
    id: string;
    inviteCode: string;
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
    access: "premium" | "preview";
  };
  progress: Partial<Progress>;
  examProfile: ExamProfile;
  questionBanks: QuestionBank[];
  studyInsights: StudyInsights;
  ledger: Array<{ delta_days: number; source_type: string; note: string; created_at: string }>;
  inviteStats: { total: number; rewarded: number; pending: number };
  inviteConfig: { rewardDays: number; monthlyCap: number };
  wrongAudioQuestions: Question[];
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
  checkins: [],
  primaryBankCode: "",
  planOverrides: {},
  activePractice: null,
  examEvents: [],
  reminderMode: "in_app",
  candidateProfile: emptyCandidateProfile,
  savedPositionIds: [],
  radarTodoDone: {},
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
  recent: [],
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
const reasonOptions = ["知识点不会", "方法没想到", "计算失误", "审题错误", "时间不足"];
const defaultEssayRubric = ["观点准确", "表达规范", "结构清晰", "语言简洁"];
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
    && ["daily", "review", "bank", "bonus"].includes(activePractice.kind)
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
    checkins: Array.isArray(input?.checkins) ? input.checkins : [],
    primaryBankCode: typeof input?.primaryBankCode === "string" ? input.primaryBankCode : "",
    planOverrides: { ...emptyProgress.planOverrides, ...(input?.planOverrides ?? {}) },
    activePractice: validSession ? { ...validSession, reviewAdded: Number(validSession.reviewAdded ?? 0) } : null,
    examEvents: safeExamEvents(input?.examEvents),
    reminderMode: input?.reminderMode === "browser" ? "browser" : "in_app",
    candidateProfile: safeCandidateProfile(input?.candidateProfile),
    savedPositionIds: safeStringList(input?.savedPositionIds, 120),
    radarTodoDone: { ...emptyProgress.radarTodoDone, ...(input?.radarTodoDone ?? {}) },
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

function starText(value?: number | null) {
  const stars = boundedNumber(value, 0, 0, 5);
  return stars ? `${"★".repeat(stars)}${"☆".repeat(5 - stars)}` : "";
}

function frequencyText(value?: string | null) {
  const frequency = value?.trim();
  if (!frequency) return "";
  return frequency.includes("考频") ? frequency : `考频：${frequency}`;
}

function scoreRateText(value?: number | null) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "";
  const percent = Number(value) <= 1 ? Number(value) * 100 : Number(value);
  return `拿分率${Math.max(0, Math.min(100, Math.round(percent)))}%`;
}

function bankTruthLabel(bank: QuestionBank) {
  const region = bank.examType === "国考" ? "国考" : bank.province || bank.scopeLabel || bank.examType;
  return normalizeTruthLabel(region, bank.examYear, bank.scopeLabel || bank.name);
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
    imageUrl: safeText(item.imageUrl, 500),
    resourceUrl: safeText(item.resourceUrl, 500),
    truthLabel: normalizeTruthLabel(region, examYear, safeText(item.truthLabel ?? item.source, 100)),
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
    return { level: "risk" as const, label: "先完善条件", reasons: ["学历、专业、身份至少补全后再筛"], score: 1 };
  }
  if (fails.length) return { level: "fail" as const, label: "明显不符", reasons: fails.slice(0, 3), score: 0 };
  if (risks.length) return { level: "risk" as const, label: "条件存疑", reasons: risks.slice(0, 3), score: 2 };
  return { level: "fit" as const, label: "初步符合", reasons: reasons.slice(0, 3), score: 3 };
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
    signals.push("基础保底日练");
  }
  if (isSpecial && !bank.added && !hasLearningSignal) {
    score = 0;
    signals.length = 0;
  }

  const show = score > 0;
  const badge = bank.code === primaryBankCode
    ? "✓ 主攻精选"
    : matchedTarget
      ? `✓ ${matchedTarget.label}匹配`
      : bank.added
        ? "✓ 已在我的组合"
        : hasLearningSignal
          ? "✓ 按薄弱/到期推荐"
          : bank.scopeLabel;
  const reason = signals.slice(0, 2).join(" · ") || (show ? "有真实学习信号" : bank.mismatchReason || bank.scopeLabel);
  const tone: BankFit["tone"] = bank.code === primaryBankCode || matchedTarget
    ? "recommended"
    : bank.added || hasLearningSignal || isStarter
      ? "generic"
      : "mismatch";
  return { show, score, badge, reason, tone };
}

function membershipText(user?: Bootstrap["user"], extended = false) {
  if (!user?.membershipActive) return "免费版";
  if (extended) return "会员有效";
  if (!user.membershipEnd) return "体验中";
  const days = Math.max(1, Math.ceil((Date.parse(user.membershipEnd) - Date.now()) / 86_400_000));
  return `体验剩${days}天`;
}

export default function DailyPracticeApp() {
  const [tab, setTab] = useState<Tab>("today");
  const [activeModule, setActiveModule] = useState<Module>(null);
  const [progress, setProgress] = useState<Progress>(emptyProgress);
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [toast, setToast] = useState("");
  const [busy, setBusy] = useState(false);
  const [redeemCode, setRedeemCode] = useState("");
  const [essayReference, setEssayReference] = useState(false);
  const [hideKeywords, setHideKeywords] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [profileDraft, setProfileDraft] = useState<ExamProfile>({ onboarded: false, dailyMinutes: 30, targets: [] });
  const [bankFilter, setBankFilter] = useState("适合我");
  const [practiceQuestions, setPracticeQuestions] = useState<PracticeQuestion[]>([]);
  const [practiceIndex, setPracticeIndex] = useState(0);
  const [practiceMode, setPracticeMode] = useState<PracticeMode>("mixed");
  const [selectedAnswer, setSelectedAnswer] = useState<number | null>(null);
  const [feedback, setFeedback] = useState<AnswerFeedback | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [answerConfidence, setAnswerConfidence] = useState<AnswerConfidence>("");
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
  const [sessionElapsedSeconds, setSessionElapsedSeconds] = useState(0);
  const [eventFormOpen, setEventFormOpen] = useState(false);
  const [eventDraft, setEventDraft] = useState({ targetCode: "", eventType: "报名截止", title: "报名截止", eventDate: "", reminderDays: 3, sourceUrl: "" });
  const [radarMode, setRadarMode] = useState<RadarMode>("notices");
  const [essayPracticeQuestions, setEssayPracticeQuestions] = useState<EssayPracticeQuestion[]>([]);
  const [essayPracticeIndex, setEssayPracticeIndex] = useState(0);
  const [essayPracticeLoading, setEssayPracticeLoading] = useState(false);
  const [essayCompletesDaily, setEssayCompletesDaily] = useState(true);
  const trackedUserRef = useRef("");
  const reminderShownRef = useRef("");
  const progressRef = useRef<Progress>(emptyProgress);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());

  const practiceDays = bootstrap?.content.practiceDays ?? [];
  const dayKey = bootstrap?.todayKey ?? localChinaDateKey();
  const scheduledDay = practiceDays.find((item) => item.date === dayKey);
  const day = scheduledDay ?? practiceDays[contentDayIndex(dayKey, practiceDays.length)] ?? practiceDays[0] ?? (bootstrap ? emptyPublishedDay : loadingDay);
  const insights = bootstrap?.studyInsights ?? emptyInsights;
  const profile = bootstrap?.examProfile ?? profileDraft;
  const examNotices = bootstrap?.content.examNotices ?? [];
  const jobPositions = bootstrap?.content.jobPositions ?? [];
  const strategyConfig = bootstrap?.content.strategyConfig;
  const drillPresets = normalizeDrillPresets(bootstrap?.content.drillPresets);
  const activeTargetCodes = new Set(profile.targets.map((target) => target.code));
  const relevantNotices = examNotices
    .filter((notice) => !profile.targets.length || activeTargetCodes.has(notice.targetCode))
    .sort((a, b) => b.publishDate.localeCompare(a.publishDate));
  const relevantPositions = jobPositions
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
    ...(bootstrap?.questionBanks ?? []).map((bank) => bank.province).filter(Boolean),
    ...profile.targets.map((target) => target.province).filter(Boolean),
  ]));
  const activeLearningBanks = addedBanks.filter((bank) => bank.subject !== "申论");
  const activeEssayBanks = addedBanks.filter((bank) => bank.subject === "申论");
  const hasMorningContent = day.morning.paragraphs.length > 0 || Boolean(day.morning.lead.trim());
  const hasEssayContent = activeEssayBanks.some((bank) => bank.questionCount > 0) || Boolean(day.essay.prompt.trim());
  const primaryTarget = profile.targets[0] ?? null;
  const savedPrimaryBank = addedBanks.find((bank) => bank.code === progress.primaryBankCode && bank.subject !== "申论");
  const primaryBank = savedPrimaryBank
    ?? addedBanks.find((bank) => bank.subject !== "申论" && primaryTarget && targetMatchesBank(primaryTarget, bank))
    ?? activeLearningBanks[0]
    ?? null;
  const orderedBankCodes = activeLearningBanks.map((bank) => bank.code).sort((a, b) => Number(b === primaryBank?.code) - Number(a === primaryBank?.code));
  const missingTargets = profile.targets.filter((target) => !addedBanks.some((bank) => bank.code !== "starter-gk" && targetMatchesBank(target, bank)));
  const targetSummary = profile.targets.length
    ? `${profile.targets.slice(0, 3).map((target) => target.label).join("＋")}${profile.targets.length > 3 ? `等${profile.targets.length}项` : ""}`
    : "尚未设置报考目标";
  const practiceDone = Boolean(progress.completed[`${dayKey}-practice`]);
  const enabledDailySteps: DailyStep[] = [
    ...(dailyPlan.morningMinutes > 0 && hasMorningContent ? ["morning" as const] : []),
    ...(dailyPlan.questionCount > 0 ? ["practice" as const] : []),
    ...(dailyPlan.essayMinutes > 0 && hasEssayContent ? ["essay" as const] : []),
  ];
  const stepDone = {
    morning: Boolean(progress.completed[`${dayKey}-morning`]),
    practice: practiceDone,
    essay: Boolean(progress.completed[`${dayKey}-essay`]),
  };
  const doneCount = enabledDailySteps.filter((step) => stepDone[step]).length;
  const allDailyDone = doneCount === enabledDailySteps.length;
  const nextDailyStep = enabledDailySteps.find((step) => !stepDone[step]) ?? null;
  const essayQuestion = essayPracticeQuestions[essayPracticeIndex] ?? null;
  const essayDraftKey = essayQuestion ? `essay:${essayQuestion.id}` : dayKey;
  const essayRubric = strategyConfig?.essayRubric?.filter((item) => typeof item === "string" && item.trim()).slice(0, 8) ?? defaultEssayRubric;
  const audioWrongQuestions = Array.from(new Map([...(bootstrap?.wrongAudioQuestions ?? []), ...sessionWrongQuestions].map((question) => [question.id, question])).values());
  const currentPractice = practiceQuestions[practiceIndex];
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
  const savedPositions = relevantPositions.filter((position) => progress.savedPositionIds.includes(position.id));
  const matchedPositions = relevantPositions
    .map((position) => ({ position, match: matchPosition(position, progress.candidateProfile), saved: progress.savedPositionIds.includes(position.id) }))
    .sort((a, b) => b.match.score - a.match.score || Number(b.saved) - Number(a.saved) || b.position.recruitCount - a.position.recruitCount);
  const candidateProfileMissing = !progress.candidateProfile.education || !progress.candidateProfile.major || !progress.candidateProfile.freshStatus;
  const radarTodoItems = [
    ...(candidateProfileMissing ? [{ id: "profile:complete", kind: "profile" as const, title: "完善我的报考条件", detail: "至少补全学历、专业、应届/往届，职位筛选才会更准。", tone: "urgent" as const, actionLabel: "去完善" }] : []),
    ...upcomingCalendarEvents.slice(0, 4).map((event) => ({
      id: `event:${event.id}`,
      kind: "event" as const,
      title: `${event.targetLabel} · ${event.title}`,
      detail: event.days === 0 ? "今天处理，优先级最高。" : `${shortDate(event.eventDate)} · 还有${event.days}天 · 提前${event.reminderDays}天提醒`,
      tone: event.days <= event.reminderDays ? "urgent" as const : "normal" as const,
      actionLabel: event.id.startsWith("exam-") ? "修改日期" : event.sourceUrl ? "看来源" : "查看",
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
      actionLabel: "去核对",
    })),
  ].slice(0, 8);
  const streak = checkinStreak(progress.checkins, dayKey);
  const currentWeekCheckinKeys = weekDateKeys(dayKey);
  const nextStreakMilestone = [7, 14, 30, 60, 100, 180, 365].find((value) => value > streak) ?? Math.ceil((streak + 1) / 100) * 100;

  const notify = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2600);
  }, []);

  const api = useCallback(async <T,>(payload: Record<string, unknown>) => {
    const response = await fetch("/api/app", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    const data = await response.json() as T & { error?: string };
    if (!response.ok) throw new Error(data.error || "操作失败，请稍后再试");
    return data;
  }, []);

  const trackEvent = useCallback((eventName: string, eventData: Record<string, unknown> = {}) => {
    void fetch("/api/app", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "trackEvent", eventName, eventData }), keepalive: true }).catch(() => undefined);
  }, []);

  const loadBootstrap = useCallback(async () => {
    try {
      const response = await fetch("/api/app", { cache: "no-store" });
      const data = await response.json() as Bootstrap & { error?: string };
      if (!response.ok) throw new Error(data.error || "加载失败");
      setBootstrap(data);
      const nextProgress = mergeProgress(data.progress);
      progressRef.current = nextProgress;
      setProgress(nextProgress);
      setProfileDraft({ ...data.examProfile, dailyMinutes: normalizePlanMinutes(data.examProfile.dailyMinutes) });
      setOnboardingOpen(!data.examProfile.onboarded);
      const inviteCode = new URLSearchParams(window.location.search).get("invite");
      if (inviteCode) {
        const result = await api<{ message?: string }>({ action: "bindInvite", inviteCode });
        notify(result.message || "邀请关系已绑定");
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : "学习记录暂时无法加载");
    }
  }, [api, notify]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadBootstrap(), 0);
    return () => window.clearTimeout(timer);
  }, [loadBootstrap]);

  useEffect(() => {
    if (!bootstrap?.user.id || trackedUserRef.current === bootstrap.user.id) return;
    trackedUserRef.current = bootstrap.user.id;
    trackEvent("app_open", { access: bootstrap.content.access, signedIn: bootstrap.user.signedIn });
  }, [bootstrap, trackEvent]);

  useEffect(() => {
    progressRef.current = progress;
  }, [progress]);

  useEffect(() => {
    if (activeModule !== "practice" || feedback) return;
    const timer = window.setInterval(() => setQuestionSeconds((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [activeModule, feedback, practiceIndex]);

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
    progressRef.current = next;
    setProgress(next);
    saveQueueRef.current = saveQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        try { await api({ action: "saveProgress", progress: next }); }
        catch { notify("当前操作已保留，请稍后再试"); }
      });
    return saveQueueRef.current;
  }, [api, notify]);

  const complete = async (key: string) => {
    const current = progressRef.current;
    const next = { ...current, completed: { ...current.completed, [key]: true } };
    const allDone = enabledDailySteps.every((step) => step === "practice"
      ? Boolean(next.completed[`${dayKey}-practice`])
      : Boolean(next.completed[`${dayKey}-${step}`]));
    if (allDone && !next.checkins.includes(dayKey)) next.checkins = [...next.checkins, dayKey];
    await persist(next);
    notify("完成已记录，继续保持");
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
    if (dailySessionForPlan || practiceDone) return notify("今日行测已经开始，明天可重新选择保底模式");
    const current = progressRef.current;
    const planOverrides = { ...current.planOverrides };
    if (dailyPlan.minutes === 10) {
      delete planOverrides[dayKey];
      notify(`已恢复默认的${normalizePlanMinutes(profile.dailyMinutes)}分钟计划`);
    } else {
      planOverrides[dayKey] = 10;
      notify("已切换为10分钟保底练，今天只完成5道行测");
    }
    void persist({ ...current, planOverrides });
    trackEvent("plan_override", { minutes: dailyPlan.minutes === 10 ? normalizePlanMinutes(profile.dailyMinutes) : 10 });
  };

  const saveProfile = async () => {
    if (!profileDraft.targets.length) return notify("请至少选择国考或一个省考目标");
    setBusy(true);
    try {
      await api({ action: "saveExamProfile", targets: profileDraft.targets, dailyMinutes: normalizePlanMinutes(profileDraft.dailyMinutes) });
      trackEvent("profile_save", { targetCount: profileDraft.targets.length, targets: profileDraft.targets.map((target) => target.code), dailyMinutes: profileDraft.dailyMinutes });
      setOnboardingOpen(false);
      notify("报考目标已保存；已加入题库会继续全部参与组题");
      await loadBootstrap();
    } catch (error) { notify(error instanceof Error ? error.message : "保存失败"); }
    finally { setBusy(false); }
  };

  const openEventForm = (targetCode = primaryTarget?.code ?? profile.targets[0]?.code ?? "", eventType = "报名截止", title = eventType) => {
    setEventDraft({ targetCode, eventType, title, eventDate: "", reminderDays: 3, sourceUrl: "" });
    setEventFormOpen(true);
  };

  const saveExamEvent = async () => {
    const target = profile.targets.find((item) => item.code === eventDraft.targetCode);
    if (!target) return notify("请先选择一个报考目标");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDraft.eventDate)) return notify("请选择节点日期");
    const title = eventDraft.title.trim().slice(0, 40);
    if (!title) return notify("请填写节点名称");
    const event: ExamEvent = {
      id: `event-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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
    await persist({ ...current, examEvents: [...current.examEvents, event].slice(-96) });
    setEventFormOpen(false);
    trackEvent("calendar_event_save", { targetCode: target.code, eventType: event.eventType, reminderDays: event.reminderDays });
    notify("考试节点已加入日历，打开应用时会检查提醒");
  };

  const removeExamEvent = async (eventId: string) => {
    if (eventId.startsWith("exam-")) return notify("笔试日期来自报考目标，请在目标设置中修改");
    if (eventId.startsWith("official-")) return notify("这是后台发布的官方节点，可通过公告来源核对");
    const current = progressRef.current;
    await persist({ ...current, examEvents: current.examEvents.filter((event) => event.id !== eventId) });
    notify("节点已删除");
  };

  const updateCandidateProfile = (patch: Partial<CandidateProfile>) => {
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

  const toggleSavedPosition = async (position: JobPosition) => {
    const current = progressRef.current;
    const exists = current.savedPositionIds.includes(position.id);
    const savedPositionIds = exists
      ? current.savedPositionIds.filter((id) => id !== position.id)
      : [...current.savedPositionIds, position.id].slice(-120);
    await persist({ ...current, savedPositionIds });
    trackEvent("position_save", { positionId: position.id, targetCode: position.targetCode, saved: !exists });
    notify(exists ? "已从备选岗位移除" : "已加入备选岗位，报名待办会提醒你核对");
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

  const toggleBank = async (bank: QuestionBank) => {
    setBusy(true);
    try {
      const result = await api<{ banks: QuestionBank[]; profile: ExamProfile }>({ action: "toggleQuestionBank", bankCode: bank.code, added: !bank.added });
      setBootstrap((current) => current ? { ...current, questionBanks: result.banks, examProfile: result.profile } : current);
      setProfileDraft(result.profile);
      trackEvent("bank_toggle", { bankCode: bank.code, added: !bank.added });
      const nextBank = result.banks.find((item) => item.code === bank.code);
      notify(bank.added
        ? nextBank?.added ? "至少保留一套可练题库，基础题库已继续保留" : "已取消加入；报考目标和本题库进度仍会保留"
        : bank.targetMatch ? "已加入我的题库" : `已加入题库，并同步加入${bank.examType === "省考" ? bank.province : "国考"}备考目标`);
    } catch (error) { notify(error instanceof Error ? error.message : "题库操作失败"); }
    finally { setBusy(false); }
  };

  const openPracticeSummary = (session: ActivePracticeSession) => {
    setPracticeKind(session.kind);
    setPracticeBankCodes(session.bankCodes);
    setPracticeSummary({
      kind: session.kind,
      mode: session.mode,
      answered: session.answered,
      correct: session.correct,
      reviewAdded: session.reviewAdded ?? 0,
      elapsedSeconds: session.elapsedSeconds,
      bankCodes: session.bankCodes,
    });
    setPracticeQuestions([]);
    setActiveModule("practice");
  };

  const startPractice = async (
    mode: PracticeMode = "mixed",
    bankCodes?: string[],
    options: { kind?: PracticeKind; limit?: number; forceNew?: boolean; focusModule?: string; focusSubTypes?: string[]; strictFocus?: boolean; focusLabel?: string; frequency?: string; importanceStars?: number; scoreRateMin?: number; scoreRateMax?: number } = {},
  ) => {
    let kind = options.kind ?? (mode === "review" ? "review" : bankCodes?.length === 1 ? "bank" : "daily");
    let activeSession = progressRef.current.activePractice;
    if (!options.forceNew && kind !== "daily" && activeSession?.kind === "daily" && activeSession.dateKey === dayKey
      && activeSession.answered < activeSession.questionTarget) {
      notify("今日训练还没完成，先从断点继续；完成后再单独加练");
      kind = "daily";
      mode = activeSession.mode;
      bankCodes = activeSession.bankCodes;
    }
    activeSession = !options.forceNew && kind === "daily" && activeSession?.kind === "daily" && activeSession.dateKey === dayKey
      ? activeSession
      : null;
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
      const requestedLimit = activeSession?.questionTarget
        ?? options.limit
        ?? (kind === "bonus" ? 5 : kind === "review" ? Math.min(dailyPlan.questionCount, Math.max(1, insights.dueCount)) : dailyPlan.questionCount);
      const result = await api<{ questions: PracticeQuestion[]; composition: PracticeComposition }>({
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
      });
      if (!result.questions.length) {
        setPracticeEmpty(true);
        setTab(mode === "review" ? "review" : "banks");
        return notify(mode === "review" ? "今天没有到期题，去学习一组新题吧" : options.focusLabel ? `${options.focusLabel}题目还没上传，先去题库选择其他专项` : "这本题库暂时没有可练的行测题");
      }
      const effectiveBanks = Array.from(new Set(result.questions.map((question) => question.bankCode)));
      const nextSession: ActivePracticeSession = {
        version: 1,
        dateKey: dayKey,
        kind,
        mode,
        planMinutes: activeSession?.planMinutes ?? (kind === "daily" ? dailyPlan.minutes : normalizePlanMinutes(profile.dailyMinutes)),
        questionTarget: activeSession?.questionTarget ?? result.questions.length,
        bankCodes: requestedBankCodes.length ? requestedBankCodes : effectiveBanks,
        questionIds: result.questions.map((question) => question.id),
        cursor: 0,
        answered: activeSession?.answered ?? 0,
        correct: activeSession?.correct ?? 0,
        reviewAdded: activeSession?.reviewAdded ?? 0,
        elapsedSeconds: activeSession?.elapsedSeconds ?? 0,
      };
      setPracticeQuestions(result.questions);
      setPracticeMode(mode);
      setPracticeKind(kind);
      setPracticeBankCodes(nextSession.bankCodes);
      setPracticeComposition(result.composition ?? { due: 0, weak: 0, new: 0, primary: 0, other: 0, byBank: [] });
      setPracticeIndex(0);
      setSelectedAnswer(null);
      setFeedback(null);
      setUncertain(false);
      setAnswerConfidence("");
      setQuestionSeconds(0);
      setSessionAnswered(nextSession.answered);
      setSessionCorrect(nextSession.correct);
      setSessionReviewAdded(nextSession.reviewAdded);
      setSessionElapsedSeconds(nextSession.elapsedSeconds);
      setActiveModule("practice");
      const current = progressRef.current;
      await persist({ ...current, activePractice: nextSession });
      trackEvent("practice_batch", { mode, kind, count: result.questions.length, target: nextSession.questionTarget, focusModule: options.focusModule ?? "" });
    } catch (error) { notify(error instanceof Error ? error.message : "组题失败"); }
    finally { setBusy(false); }
  };

  const startEssayPractice = async (options: { bankCodes?: string[]; daily?: boolean; focusModule?: string; focusSubTypes?: string[] } = {}) => {
    setEssayPracticeLoading(true);
    setEssayPracticeQuestions([]);
    setEssayPracticeIndex(0);
    setEssayReference(false);
    setEssayCompletesDaily(options.daily !== false);
    setActiveModule("essay");
    try {
      const bankCodes = options.bankCodes?.length ? options.bankCodes : activeEssayBanks.map((bank) => bank.code);
      const result = await api<{ questions?: unknown[] }>({
        action: "getEssayPracticeBatch",
        bankCodes,
        limit: 1,
        focusModule: options.focusModule ?? "",
        focusSubTypes: options.focusSubTypes ?? [],
      });
      const questions = (result.questions ?? []).map(normalizeEssayQuestion).filter((item): item is EssayPracticeQuestion => Boolean(item));
      if (questions.length) {
        setEssayPracticeQuestions(questions);
        trackEvent("essay_practice_open", { bankCodes, questionId: questions[0].id, daily: options.daily !== false });
      } else if (options.daily === false) {
        notify("该申论题库暂时没有已上架真题，先完成今日微练");
      }
    } catch (error) {
      if (options.daily === false) notify(error instanceof Error ? error.message : "申论真题暂时无法加载");
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

  const answerPractice = async (answer: number) => {
    if (!currentPractice || feedback || busy) return;
    setSelectedAnswer(answer);
    setBusy(true);
    try {
      const result = await api<AnswerFeedback>({
        action: "submitPracticeAnswer",
        questionCode: currentPractice.id,
        bankCode: currentPractice.bankCode,
        selectedAnswer: answer,
        uncertain,
        durationMs: questionSeconds * 1000,
      });
      setFeedback(result);
      setAnswerConfidence(uncertain ? "hesitant" : "");
      const nextAnswered = sessionAnswered + 1;
      const nextCorrect = sessionCorrect + (result.correct ? 1 : 0);
      const nextReviewAdded = sessionReviewAdded + (result.needsReview ? 1 : 0);
      const nextElapsed = sessionElapsedSeconds + questionSeconds;
      setSessionAnswered(nextAnswered);
      setSessionCorrect(nextCorrect);
      setSessionReviewAdded(nextReviewAdded);
      setSessionElapsedSeconds(nextElapsed);
      if (!result.correct) setSessionWrongQuestions((items) => [...items, {
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
          cursor: Math.min(activeSession.questionIds.length, activeSession.cursor + 1),
          answered: nextAnswered,
          correct: nextCorrect,
          reviewAdded: nextReviewAdded,
          elapsedSeconds: nextElapsed,
        };
        const current = progressRef.current;
        const completed = isFinal && activeSession.kind === "daily"
          ? { ...current.completed, [`${dayKey}-practice`]: true }
          : current.completed;
        const dailyComplete = enabledDailySteps.every((step) => Boolean(completed[`${dayKey}-${step}`]));
        const checkins = isFinal && activeSession.kind === "daily" && dailyComplete && !current.checkins.includes(dayKey)
          ? [...current.checkins, dayKey]
          : current.checkins;
        await persist({ ...current, completed, checkins, activePractice: nextSession });
      }
      trackEvent("practice_answer", { module: currentPractice.module, correct: result.correct, uncertain, overtime: result.overtime, seconds: questionSeconds });
    } catch (error) { setSelectedAnswer(null); notify(error instanceof Error ? error.message : "答案提交失败"); }
    finally { setBusy(false); }
  };

  const finishPracticeSession = () => {
    const activeSession = progressRef.current.activePractice;
    const summary: PracticeSummary = activeSession ? {
      kind: activeSession.kind,
      mode: activeSession.mode,
      answered: activeSession.answered,
      correct: activeSession.correct,
      reviewAdded: activeSession.reviewAdded ?? 0,
      elapsedSeconds: activeSession.elapsedSeconds,
      bankCodes: activeSession.bankCodes,
    } : {
      kind: practiceKind,
      mode: practiceMode,
      answered: sessionAnswered,
      correct: sessionCorrect,
      reviewAdded: sessionReviewAdded,
      elapsedSeconds: sessionElapsedSeconds,
      bankCodes: practiceBankCodes,
    };
    setPracticeSummary(summary);
    setPracticeQuestions([]);
    const current = progressRef.current;
    void persist({ ...current, activePractice: null });
  };

  const nextPracticeQuestion = () => {
    if (practiceIndex >= practiceQuestions.length - 1) return finishPracticeSession();
    setPracticeIndex((value) => value + 1);
    setSelectedAnswer(null);
    setFeedback(null);
    setUncertain(false);
    setAnswerConfidence("");
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

  const markConfidence = async (confidence: Exclude<AnswerConfidence, "">) => {
    if (!currentPractice || !feedback || !feedback.correct || busy) return;
    if (uncertain && confidence === "confident") return notify("答题前已标记没把握，这题会按犹豫题回炉");
    setBusy(true);
    try {
      const result = await api<{ state: AnswerFeedback["state"]; nextReviewAt: string | null }>({
        action: "updateQuestionMeta",
        questionCode: currentPractice.id,
        attemptId: feedback.attemptId,
        confidence,
      });
      const newlyAdded = confidence !== "confident" && !feedback.needsReview;
      setAnswerConfidence(confidence);
      if (confidence !== "confident") setFeedback((current) => current ? {
        ...current,
        state: "weak",
        needsReview: true,
        reviewDays: 1,
        nextReviewAt: result.nextReviewAt ?? current.nextReviewAt,
      } : current);
      if (newlyAdded) {
        const nextReviewAdded = sessionReviewAdded + 1;
        setSessionReviewAdded(nextReviewAdded);
        const current = progressRef.current;
        if (current.activePractice) await persist({ ...current, activePractice: { ...current.activePractice, reviewAdded: nextReviewAdded } });
      }
      if (confidence === "guessed") setPracticeQuestions((items) => items.map((item, index) => index === practiceIndex ? { ...item, wrongReason: "蒙对了" } : item));
      trackEvent("practice_confidence", { confidence, module: currentPractice.module });
      notify(confidence === "confident"
        ? feedback.overtime ? "已记录为会做，但因超时仍会回炉" : "已记录为真正掌握"
        : confidence === "hesitant" ? "已加入明日犹豫题回炉" : "蒙对不算掌握，明天再做一次");
    } catch (error) { notify(error instanceof Error ? error.message : "掌握状态保存失败"); }
    finally { setBusy(false); }
  };

  const toggleFavoritePhrase = (phrase: string) => {
    const current = progress;
    const favorites = current.favorites.includes(phrase) ? current.favorites.filter((item) => item !== phrase) : [...current.favorites, phrase];
    void persist({ ...current, favorites });
  };

  const toggleEssayCheck = (item: string) => {
    const currentProgress = progress;
    const current = currentProgress.essayChecks[essayDraftKey] ?? [];
    const nextChecks = current.includes(item) ? current.filter((value) => value !== item) : [...current, item];
    void persist({ ...currentProgress, essayChecks: { ...currentProgress.essayChecks, [essayDraftKey]: nextChecks } });
  };

  const updateEssayDraft = (value: string) => {
    const current = progress;
    const next = { ...current, essayDrafts: { ...current.essayDrafts, [essayDraftKey]: value } };
    progressRef.current = next;
    setProgress(next);
  };

  const submitEssay = async () => {
    if ((progress.essayDrafts[essayDraftKey] ?? "").trim().length < 10) return notify("先完成至少10个字的作答");
    if ((progress.essayChecks[essayDraftKey] ?? []).length < 2) return notify("请按标准完成至少两项自评");
    if (essayCompletesDaily) await complete(`${dayKey}-essay`);
    else notify("本题作答与自评已保存");
    setActiveModule(null);
    setTab(essayCompletesDaily ? "report" : "today");
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
      const result = await api<{ days: number }>({ action: "redeem", code: redeemCode });
      setRedeemCode("");
      notify(`激活成功，会员时长增加 ${result.days} 天`);
      await loadBootstrap();
    } catch (error) { notify(error instanceof Error ? error.message : "兑换失败"); }
    finally { setBusy(false); }
  };

  const copyInvite = async () => {
    if (!bootstrap?.user.inviteCode) return notify("邀请码正在生成");
    const url = `${window.location.origin}/?invite=${bootstrap.user.inviteCode}`;
    try { await navigator.clipboard.writeText(url); notify("邀请链接已复制，好友激活后双方加时长"); }
    catch { notify(url); }
  };

  const dailyActionLabel = activeDailySession
    ? activeDailySession.cursor >= activeDailySession.questionIds.length
      ? "查看今日总结"
      : `继续今日日练 · 还剩${dailyRemaining}题`
    : nextDailyStep === "morning"
      ? `开始今日${dailyPlan.minutes}分钟训练`
      : nextDailyStep === "practice"
        ? `继续今日训练 · 行测${dailyPlan.questionCount}题`
        : nextDailyStep === "essay"
          ? "继续今日训练 · 申论微练"
          : "今天学够了 · 查看明日安排";

  const runDailyAction = () => {
    if (activeDailySession) return void startPractice("mixed", undefined, { kind: "daily" });
    if (nextDailyStep === "morning") return setActiveModule("morning");
    if (nextDailyStep === "practice") return void startPractice("mixed", undefined, { kind: "daily" });
    if (nextDailyStep === "essay") return void startEssayPractice({ daily: true });
    setTab("report");
  };

  const runBonusPractice = () => void startPractice("mixed", orderedBankCodes, { kind: "bonus", limit: 5, forceNew: true });

  const renderPractice = () => {
    if (practiceSummary) {
      const accuracy = practiceSummary.answered ? Math.round((practiceSummary.correct / practiceSummary.answered) * 100) : 0;
      const closeLabel = practiceSummary.kind === "daily"
        ? nextDailyStep === "morning" ? "继续晨读" : nextDailyStep === "essay" ? "继续申论微练" : "今天学够了"
        : practiceSummary.kind === "review" ? "完成回炉" : "结束本轮";
      const closeSummary = () => {
        setPracticeSummary(null);
        setActiveModule(null);
        if (practiceSummary.kind === "daily" && nextDailyStep === "morning") return setActiveModule("morning");
        if (practiceSummary.kind === "daily" && nextDailyStep === "essay") return void startEssayPractice({ daily: true });
        setTab(practiceSummary.kind === "review" ? "review" : practiceSummary.kind === "daily" ? "report" : "today");
        void loadBootstrap();
      };
      return <article className="practice-summary">
        <span>✓</span><h3>{practiceSummary.answered} 题已入账</h3><p>{practiceSummary.kind === "daily" && nextDailyStep ? "行测已完成，继续今日下一个有效动作。" : "本轮任务已完成，进度和复习时间已经自动保存。"}</p>
        <div className="practice-summary-stats"><div><b>{accuracy}%</b><span>正确率</span></div><div><b>{Math.floor(practiceSummary.elapsedSeconds / 60)}:{String(practiceSummary.elapsedSeconds % 60).padStart(2, "0")}</b><span>本轮用时</span></div><div><b>{practiceSummary.reviewAdded}</b><span>加入回炉</span></div></div>
        <div className="practice-summary-actions"><button className="primary-button" onClick={closeSummary}>{closeLabel}</button>{(practiceSummary.kind !== "daily" || !nextDailyStep) && <button className="secondary-button" onClick={() => { const summary = practiceSummary; setPracticeSummary(null); void startPractice("mixed", summary.bankCodes, { kind: "bonus", limit: 5, forceNew: true }); }}>再练10分钟</button>}</div>
      </article>;
    }
    if (!currentPractice) return <div className="empty-state"><span>练</span><h3>正在准备题目</h3></div>;
    const finished = feedback && practiceIndex === practiceQuestions.length - 1;
    const target = progress.activePractice?.questionTarget ?? practiceQuestions.length;
    const targetSeconds = feedback?.targetSeconds ?? currentPractice.suggestedSeconds ?? questionTargetSeconds(currentPractice);
    const truthLabel = normalizeTruthLabel(currentPractice.region, currentPractice.examYear, currentPractice.truthLabel || currentPractice.scopeLabel || currentPractice.source);
    const importance = starText(currentPractice.importanceStars);
    const scoreRate = scoreRateText(currentPractice.scoreRate);
    const valueSignals = [frequencyText(currentPractice.frequency), importance, scoreRate].filter(Boolean);
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
          {valueSignals.length > 0 && <div className="truth-signal-row" aria-label="真题价值标签">{frequencyText(currentPractice.frequency) && <span>{frequencyText(currentPractice.frequency)}</span>}{importance && <span className="importance-stars">{importance}</span>}{scoreRate && <span>{scoreRate}</span>}</div>}
          <div className="question-meta"><span>{currentPractice.module} · {currentPractice.knowledge}</span><em>{currentPractice.difficulty}</em></div>
          <h3>{currentPractice.stem}</h3>
          {currentPractice.imageUrl && <figure className="question-resource"><img src={currentPractice.imageUrl} alt={`${truthLabel || "本题"}配图或图表`} loading="lazy" /></figure>}
          {currentPractice.resourceUrl && <a className="question-resource-link" href={currentPractice.resourceUrl} target="_blank" rel="noreferrer">查看题目原始附件</a>}
          <div className="options-list">
            {currentPractice.options.map((option, index) => {
              const state = feedback && index === feedback.correctAnswer ? " correct" : feedback && index === selectedAnswer && !feedback.correct ? " wrong" : selectedAnswer === index ? " selected" : "";
              return <button key={`${index}-${option}`} disabled={Boolean(feedback) || busy} className={`option${state}`} onClick={() => void answerPractice(index)}><b>{String.fromCharCode(65 + index)}</b><span>{option}</span></button>;
            })}
          </div>
          {!feedback && <button className={`uncertain-button ${uncertain ? "active" : ""}`} aria-pressed={uncertain} onClick={() => setUncertain((value) => !value)}>？ {uncertain ? "已标记不确定（即使答对也会复习）" : "这题没把握，标记为不确定"}</button>}
          {feedback && <div className={`answer-result ${feedback.correct ? "is-correct" : "is-wrong"}`}>
            <div><strong>{feedback.correct ? "回答正确" : `正确答案 ${String.fromCharCode(65 + feedback.correctAnswer)}`}</strong><span>{feedback.needsReview ? `${feedback.overtime ? "超时" : "需巩固"} · ${feedback.reviewDays}天后回炉` : feedback.state === "mastered" ? `已掌握 · ${feedback.reviewDays}天后抽查` : `学习中 · ${feedback.reviewDays}天后复习`}</span></div>
            <p>{feedback.explanation}</p>
            {feedback.technique && <aside><b>解题提示</b>{feedback.technique}</aside>}
            <footer><span>题源：{truthLabel || normalizeTruthLabel(undefined, undefined, currentPractice.source) || "已核验真题"}{currentPractice.reviewedAt ? ` · 校验 ${currentPractice.reviewedAt.slice(0, 10)}` : ""}</span><button onClick={() => void updateQuestionMeta({ favorite: !currentPractice.favorite })}>{currentPractice.favorite ? "★ 已收藏" : "☆ 收藏"}</button></footer>
          </div>}
        </article>
        {feedback && !feedback.correct && <div className="wrong-reason-box"><span>这次为什么错？</span><div>{reasonOptions.map((reason) => <button key={reason} className={currentPractice.wrongReason === reason ? "active" : ""} onClick={() => void updateQuestionMeta({ wrongReason: reason })}>{reason}</button>)}</div></div>}
        {feedback?.correct && <div className="confidence-box"><span>这题是真会，还是只是做对了？</span><div><button disabled={uncertain || busy} className={answerConfidence === "confident" ? "active" : ""} onClick={() => void markConfidence("confident")}>真会</button><button disabled={busy} className={answerConfidence === "hesitant" ? "active" : ""} onClick={() => void markConfidence("hesitant")}>有点犹豫</button><button disabled={busy} className={answerConfidence === "guessed" ? "active" : ""} onClick={() => void markConfidence("guessed")}>蒙对了</button></div><small>犹豫、蒙对或超时做对都不会被当成稳定掌握。</small></div>}
        {feedback && <button className="primary-button full-button practice-next" onClick={nextPracticeQuestion}>{finished ? "查看本轮总结" : "下一题"}</button>}
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
    const essaySignals = essayQuestion ? [frequencyText(essayQuestion.frequency), starText(essayQuestion.importanceStars), scoreRateText(essayQuestion.scoreRate)].filter(Boolean) : [];
    return (
      <section className="module-page" aria-label="学习模块">
        <header className="module-header">
          <button className="icon-button" onClick={() => setActiveModule(null)} aria-label="返回首页">‹</button>
          <div><span className="eyebrow">{activeModule === "practice" ? "智能学习队列" : `第 ${day.day} 组 · ${day.label}`}</span><h2>{activeModule === "morning" ? "晨读训练" : activeModule === "practice" ? "行测智能练习" : activeModule === "affairs" ? "时政常识" : "申论表达"}</h2></div>
          <span className="day-pill">{activeModule === "practice" ? "断点自动保存" : activeModule === "morning" ? `约${dailyPlan.morningMinutes}分钟` : activeModule === "essay" ? `约${dailyPlan.essayMinutes}分钟` : "约5分钟"}</span>
        </header>

        {activeModule === "practice" && renderPractice()}

        {activeModule === "morning" && <div className="reading-card enhanced-reading">
          <div className="reading-steps"><span className="active">1 阅读</span><span>2 记表达</span><span>3 尝试复述</span></div>
          <span className="content-tag">今日晨读</span><h3>{day.morning.title}</h3><p className="lead">{day.morning.lead}</p>
          {day.morning.paragraphs.map((paragraph) => <p key={paragraph}>{hideKeywords ? day.morning.keywords.reduce((text, keyword) => text.replaceAll(keyword, "____"), paragraph) : paragraph}</p>)}
          <div className="keyword-training"><div><b>今天记住这3个表达</b><button onClick={() => setHideKeywords((value) => !value)}>{hideKeywords ? "显示关键词" : "挖空自测"}</button></div><div className="keyword-row">{day.morning.keywords.map((keyword) => <span key={keyword}>{hideKeywords ? "____" : keyword}</span>)}</div></div>
          <div className="button-row reading-actions"><button className="secondary-button" onClick={speakMorning}>▶ 逐段朗读</button>{day.currentAffairs.length > 0 && <button className="secondary-button" onClick={() => setActiveModule("affairs")}>今日时政 {day.currentAffairs.length}条</button>}<button className="primary-button" onClick={async () => { if (progress.completed[`${dayKey}-morning`]) return setActiveModule(null); await complete(`${dayKey}-morning`); setActiveModule(null); await startPractice("mixed", undefined, { kind: "daily" }); }}>{progress.completed[`${dayKey}-morning`] ? "✓ 已完成" : "完成并继续刷题"}</button></div>
        </div>}

        {activeModule === "affairs" && (day.currentAffairs.length ? <div className="affairs-grid">{day.currentAffairs.map((item, index) => <article className="affair-card" key={`${item.title}-${index}`}><div><span>{String(index + 1).padStart(2, "0")}</span><em>{item.tag}</em></div><h3>{item.title}</h3><p>{item.detail}</p></article>)}</div> : <div className="empty-state compact"><span>政</span><h3>今日时政正在更新</h3><p>运营人员发布后会自动出现在这里，无需更新前端版本。</p></div>)}

        {activeModule === "essay" && <div className="essay-wrap">
          {essayPracticeLoading ? <div className="empty-state compact essay-loading"><span>写</span><h3>正在从已加入题库选题</h3><p>优先匹配你的主攻地区、年份和高价值真题。</p></div> : <>
            {!essayQuestion && day.essay.expressions.length > 0 && <div className="expression-list">{day.essay.expressions.map((item) => <article className="expression-card" key={item.phrase}><span>{item.scene}</span><p>{item.phrase}</p><button onClick={() => toggleFavoritePhrase(item.phrase)}>{progress.favorites.includes(item.phrase) ? "★ 已收藏" : "☆ 收藏"}</button></article>)}</div>}
            <article className="writing-card essay-practice-card">
              <div className="essay-source-row"><span className="content-tag">{essayTruthLabel || "今日申论练习"}</span>{essayQuestion?.bankName && <small>{essayQuestion.bankName}</small>}</div>
              {essaySignals.length > 0 && <div className="truth-signal-row">{essaySignals.map((signal) => <span key={signal} className={signal.includes("★") ? "importance-stars" : ""}>{signal}</span>)}</div>}
              {essayMaterial && <section className="essay-material"><b>给定材料</b><p>{essayMaterial}</p></section>}
              {essayQuestion?.imageUrl && <figure className="question-resource"><img src={essayQuestion.imageUrl} alt={`${essayTruthLabel || "申论真题"}材料配图`} loading="lazy" /></figure>}
              {essayQuestion?.resourceUrl && <a className="question-resource-link" href={essayQuestion.resourceUrl} target="_blank" rel="noreferrer">查看完整材料附件</a>}
              <h3>{essayPrompt}</h3>
              <div className="essay-guidance">先独立阅读材料、提炼要点，再作答；提交自评前不展示参考要点。</div>
              <textarea value={progress.essayDrafts[essayDraftKey] ?? ""} onChange={(event) => updateEssayDraft(event.target.value)} onBlur={() => void persist(progressRef.current)} placeholder="根据材料独立作答……" maxLength={essayWordLimit} />
              <div className="writing-meta"><span>{(progress.essayDrafts[essayDraftKey] ?? "").length} / {essayWordLimit}</span><button onClick={() => setEssayReference((value) => !value)}>{essayReference ? "收起参考" : "查看参考要点"}</button></div>
              {essayReference && <div className="reference-answer"><b>参考要点</b>{essayScoringPoints.length ? <ol>{essayScoringPoints.map((point) => <li key={point}>{point}</li>)}</ol> : null}{essayReferenceText && <p>{essayReferenceText}</p>}<small>按采分点核对，不要求逐字一致。</small></div>}
              <div className="essay-rubric"><span>按标准自评（至少选择2项）</span><div>{essayRubric.map((item) => <button key={item} className={(progress.essayChecks[essayDraftKey] ?? []).includes(item) ? "active" : ""} onClick={() => toggleEssayCheck(item)}>{(progress.essayChecks[essayDraftKey] ?? []).includes(item) ? "✓ " : ""}{item}</button>)}</div></div>
              <button className="primary-button full-button" onClick={() => void submitEssay()}>{essayCompletesDaily && progress.completed[`${dayKey}-essay`] ? "✓ 已完成申论练习" : "完成作答与自评"}</button>
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
  const tomorrowPlan = insights.tomorrowPlan;
  const nextStepText = nextDailyStep === "morning" ? `晨读 ${dailyPlan.morningMinutes}分钟` : nextDailyStep === "practice" ? `行测日练 ${dailyPlan.practiceMinutes}分钟` : nextDailyStep === "essay" ? `申论真题 ${dailyPlan.essayMinutes}分钟` : "今日已完成";
  const primaryTaskTitle = allDailyDone
    ? "今日已完成，可以安心收工"
    : activeDailySession
      ? `继续行测日练，还剩${dailyRemaining}题`
      : nextDailyStep === "morning"
        ? "先完成晨读，进入学习状态"
        : nextDailyStep === "practice"
          ? `智能刷题${dailyPlan.questionCount}道`
          : nextDailyStep === "essay"
          ? "申论真题微练"
            : "今日已完成";
  const primaryTaskDetail = allDailyDone
    ? `已完成${doneCount}/${enabledDailySteps.length}个有效动作，明日建议：${tomorrowPlan.taskText}`
    : nextDailyStep === "morning"
      ? `读完《${day.morning.title}》，记住3个规范表达。`
      : nextDailyStep === "practice"
        ? `${primaryBank ? `主攻${primaryBank.name}` : "按已加入题库"} · 到期复习优先 · 主攻与兼顾均衡。`
        : nextDailyStep === "essay"
          ? "根据材料独立作答，再按采分点与标准自评。"
          : "完成今天的训练闭环。";
  const dailyStepItems = [
    ...(dailyPlan.morningMinutes > 0 && hasMorningContent ? [{ key: "morning" as const, icon: "读", title: "晨读", minutes: dailyPlan.morningMinutes, detail: "记住3个规范表达", done: stepDone.morning, action: () => setActiveModule("morning") }] : []),
    { key: "practice" as const, icon: "练", title: "行测日练", minutes: dailyPlan.practiceMinutes, detail: activeDailySession ? `断点已保存，还剩${dailyRemaining}题` : `${dailyPlan.questionCount}道 · 到期错题优先`, done: stepDone.practice, action: runDailyAction },
    ...(dailyPlan.essayMinutes > 0 && hasEssayContent ? [{ key: "essay" as const, icon: "写", title: "申论真题", minutes: dailyPlan.essayMinutes, detail: activeEssayBanks.length ? "材料作答 · 采分点自评" : "今日表达练习", done: stepDone.essay, action: () => void startEssayPractice({ daily: true }) }] : []),
  ];
  const todayAlertItems = [
    nextCalendarEvent ? { id: "radar", label: dueReminder ? "报名提醒" : "公考雷达", title: `${nextCalendarEvent.targetLabel} · ${nextCalendarEvent.title}`, detail: nextCalendarEvent.days === 0 ? "今天处理" : `还有${nextCalendarEvent.days}天 · ${shortDate(nextCalendarEvent.eventDate)}`, action: () => setTab("calendar") } : { id: "radar", label: "公考雷达", title: "补全公告、职位表和报名节点", detail: "多考试报名别只记笔试日期", action: () => setTab("calendar") },
    ...(insights.dueCount > dailyPlan.questionCount ? [{ id: "review-backlog", label: "复习积压", title: `${insights.dueCount}道到期题等待回炉`, detail: `今日先按价值清理${Math.min(insights.dueCount, dailyPlan.questionCount)}道，其余自动顺延`, action: () => setTab("review") }] : []),
    ...(profile.onboarded && missingTargets.length > 0 ? [{ id: "banks", label: "题库提醒", title: `${missingTargets[0].label}题库未加入`, detail: missingTargets.length > 1 ? `还有${missingTargets.length}个目标待补题库` : "加入后才会进入综合练习", action: () => setTab("banks") }] : []),
    { id: "streak", label: "连续打卡", title: `${streak}天 · 完成今日任务自动打卡`, detail: allDailyDone ? "今日已打卡，明天继续" : `距${nextStreakMilestone}天还差${nextStreakMilestone - streak}天`, action: () => setTab("today") },
  ].slice(0, 3);
  const quickBank = activeLearningBanks.find((bank) => bank.questionCount > 0);

  return (
    <main className="app-shell">
      <div className="app-frame">
        <header className="topbar"><div className="brand-mark">公</div><div className="brand-copy"><strong>公考日练</strong><span>每天30–60分钟，高效完成今日训练</span></div><button className="member-chip" onClick={() => setTab("me")}>{membershipText(bootstrap?.user, hasExtendedMembership)}</button></header>

        {activeModule ? renderModule() : <>
          {tab === "today" && <div className="page-content today-redesign">
            <section className="today-focus-strip">
              <div><span>我的备考组合</span><b>{primaryTarget?.label ?? "尚未设置主攻考试"}{profile.targets.length > 1 ? ` · 兼顾${profile.targets.length - 1}项` : ""}</b><small>{nextExam ? `最近考试：${nextExam.target.label}，还有${nextExam.days}天` : "设置目标后自动安排主攻与兼顾"}</small></div>
              <button onClick={() => { setProfileDraft(profile); setOnboardingOpen(true); }}>调整</button>
            </section>

            <section className={`today-command-card${allDailyDone ? " completed" : ""}`}>
              <div className="today-command-top"><span>{dailyPlan.minutes === 10 ? "忙碌保底" : "今日最该做"}</span><em>{new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "long", day: "numeric", weekday: "short" }).format(new Date())}</em></div>
              <div className="today-command-main">
                <div><p>{nextStepText}</p><h1>{primaryTaskTitle}</h1><small>{primaryTaskDetail}</small></div>
                <div className="today-progress-orb" style={{ "--progress": `${doneCount * (360 / enabledDailySteps.length)}deg` } as React.CSSProperties}><strong>{doneCount}/{enabledDailySteps.length}</strong><span>完成</span></div>
              </div>
              <button className="today-primary-action" disabled={busy} onClick={runDailyAction}>{dailyActionLabel}<span>{allDailyDone ? "可查看明日安排" : `预计${dailyPlan.minutes}分钟 · 练完自动打卡`}</span></button>
              <div className="today-secondary-row"><button disabled={Boolean(dailySessionForPlan) || practiceDone} onClick={toggleBusyMode}>{dailyPlan.minutes === 10 ? `恢复${normalizePlanMinutes(profile.dailyMinutes)}分钟` : "今天太忙？10分钟保底"}</button>{allDailyDone && <button onClick={runBonusPractice}>再练10分钟</button>}{quickBank && <button onClick={() => void startPractice("mixed", [quickBank.code], { kind: "bank" })}>单本加练</button>}</div>
            </section>

            {bootstrap?.content.access === "preview" && <section className="access-card compact-access"><div><span>当前为免费版</span><h3>每天可练5题，完整体验学习闭环</h3></div><button onClick={() => setTab("me")}>去激活</button></section>}

            <section className="daily-timeline-card"><div className="compact-section-heading"><div><span>今日三步</span><h2>{allDailyDone ? "已完成，明天继续" : "按顺序做，不用自己想"}</h2></div><em>{allDailyDone ? "收工" : `还剩${enabledDailySteps.length - doneCount}步`}</em></div>
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

            <section className="today-alert-card"><div className="compact-section-heading"><div><span>今日提醒</span><h2>只保留会影响今天决策的事</h2></div></div>
              <div className="today-alert-list">{todayAlertItems.map((item) => <button key={item.id} className={(item.id === "radar" && dueReminder) || item.id === "review-backlog" ? "urgent" : ""} onClick={item.action}><span>{item.label}</span><div><b>{item.title}</b><small>{item.detail}</small>{item.id === "streak" && <div className="streak-dot-row" aria-label="本周打卡进度">{currentWeekCheckinKeys.map((key, index) => <em key={key} className={progress.checkins.includes(key) ? "checked" : key === dayKey ? "today" : ""} title={`${weekLabels[index]} ${key}`}>{weekLabels[index]}</em>)}</div>}</div><i>›</i></button>)}</div>
            </section>

            <section className="quick-practice-card"><div className="compact-section-heading"><div><span>加练一下</span><h2>有余力再点，不打断今日主线</h2></div><button onClick={() => setTab("banks")}>题库书架</button></div>
              <div className="quick-practice-grid">{drillPresets.map((drill) => <button key={drill.id} onClick={() => startMicroDrill(drill)} title={drill.subtitle}><span style={{ color: drill.color, background: `${drill.color}18` }}>{drill.icon}</span><b>{drill.title}</b><small>{drill.minutes}分钟 · {drill.questionCount}{drill.subject === "申论" ? "题" : "道"}</small></button>)}</div>
              {!drillPresets.length && <div className="inline-empty-note">专项微练发布后会自动出现在这里。</div>}
              <div className="quick-tool-row"><button onClick={() => setTab("audio")}><span>听</span><b>日练电台</b><small>通勤/睡前</small></button><button onClick={() => setTab("review")}><span>复</span><b>到期回炉</b><small>{insights.dueCount}道</small></button><button onClick={() => insights.total ? setTab("report") : void startPractice("mixed", undefined, { kind: "bonus", limit: 5, forceNew: true })}><span>报</span><b>{insights.total ? "提分诊断" : "首次诊断"}</b><small>{weakestModule ? weakestModule.module : "先做5题建基线"}</small></button>{day.currentAffairs.length > 0 && <button onClick={() => setActiveModule("affairs")}><span>政</span><b>今日时政</b><small>{day.currentAffairs.length}条速记</small></button>}</div>
            </section>
          </div>}

          {tab === "banks" && <div className="page-content subpage">
            <div className="subpage-heading bank-heading"><div><span>题库书架</span><h1>像选词书一样，组合你的全部考试</h1><p>国考、多个省考、公安岗、行政执法和事业单位可同时加入；各地区题目独立维护。</p></div><strong>{addedBanks.length} 本已添加</strong></div>
            <div className="target-scope-note"><b>主攻优先 · 其余混练</b><span>{primaryBank ? `主攻《${primaryBank.name}》；其余已加入题库也会参与` : "请先添加一套行测题库"}</span><button onClick={() => { setProfileDraft(profile); setOnboardingOpen(true); }}>管理目标</button></div>
            <div className="bank-filters">{["适合我", "我的", "全部", "国考", "省考", "专项", "申论"].map((item) => <button key={item} className={bankFilter === item ? "active" : ""} onClick={() => setBankFilter(item)}>{item}</button>)}</div>
            {bankFilter === "适合我" && <div className="fit-rule-note"><b>精选标准</b><span>只按主攻考试、已选省份、已加入题库、到期复习和薄弱题出现；没有这些信号的专项不会乱推荐。</span></div>}
            <section className="bank-list">{filteredBanks.map((bank) => {
              const percent = bank.questionCount ? Math.round((bank.studiedCount / bank.questionCount) * 100) : 0;
              const estimatedDays = bank.questionCount ? Math.max(1, Math.ceil(Math.max(0, bank.questionCount - bank.studiedCount) / dailyPlan.questionCount)) : 0;
              const isPrimary = bank.code === primaryBank?.code;
              const fit = bankFitMap.get(bank.code) ?? resolveBankFit(bank, profile, primaryTarget, primaryBank?.code);
              return <article className={`bank-card bank-${bank.coverColor}${isPrimary ? " is-primary" : ""}`} key={bank.code}>
                <div className="bank-cover"><span>{bank.examType}</span><b>{bank.subject}</b><small>{bankTruthLabel(bank)}</small></div>
                <div className="bank-copy"><div><span>{bankTruthLabel(bank)} · {bank.questionCount}题</span><h3>{bank.name}</h3>{isPrimary && <div className="primary-bank-badge">主攻题库</div>}<p>{bank.description}</p><div className={`scope-badge ${fit.tone}`}>{fit.badge}</div>{bankFilter === "适合我" && <small className="fit-reason">推荐依据：{[fit.reason, frequencyText(bank.frequency), starText(bank.importanceStars), scoreRateText(bank.scoreRate)].filter(Boolean).join(" · ")}</small>}</div>
                  <div className="bank-progress"><div><i style={{ width: `${percent}%` }} /></div><span>{percent}%</span></div>
                  <footer><small>{bank.questionCount === 0 ? "题库框架已建，等待后台上传题目；加入后不会影响基础日练" : bank.added ? `已掌握${bank.masteredCount} · 薄弱${bank.weakCount} · 到期${bank.dueCount} · 约${estimatedDays}天过一轮` : fit.show ? fit.reason : bank.mismatchReason}</small><div>{bank.added ? <><button disabled className="added-state">✓ 已加入</button><button disabled={busy} className="cancel-bank" onClick={() => void toggleBank(bank)}>取消</button></> : <button disabled={busy} onClick={() => void toggleBank(bank)}>{bank.targetMatch ? "+ 添加" : "+ 添加并备考"}</button>}{bank.added && bank.subject !== "申论" && !isPrimary && <button className="primary-bank-button" onClick={() => setPrimaryBank(bank.code)}>设为主攻</button>}{bank.added && bank.subject !== "申论" ? <button className="start-bank" disabled={bank.questionCount === 0} onClick={() => void startPractice("mixed", [bank.code], { kind: "bank" })}>{bank.questionCount ? "单本练" : "待上架"}</button> : bank.added && <button className="start-bank" disabled={bank.questionCount === 0} onClick={() => void startEssayPractice({ bankCodes: [bank.code], daily: false })}>{bank.questionCount ? "真题微练" : "待上架"}</button>}</div></footer>
                </div>
              </article>;
            })}</section>
            {filteredBanks.length === 0 && <div className="empty-state compact"><span>库</span><h3>这个分类的题库正在整理</h3><p>在后台按考试类型和省份创建并发布后，会自动显示在这里。</p></div>}
          </div>}

          {tab === "review" && <div className="page-content subpage"><div className="subpage-heading"><span>智能复习</span><h1>不是重看答案，而是再次做对</h1><p>只呈现今天真正到期的题；超时、答错和没把握都会进入回炉。</p></div><section className="review-hero"><div><span>今日到期</span><h2>{insights.dueCount}<small> 道</small></h2><p>薄弱 {insights.stateCounts.weak} · 学习中 {insights.stateCounts.learning} · 已掌握 {insights.stateCounts.mastered}</p></div><button disabled={busy || insights.dueCount === 0} onClick={() => void startPractice("review", undefined, { kind: "review" })}>{insights.dueCount ? "开始回炉" : "今日已清空"}</button></section><div className="review-rules"><article><span>1天</span><div><b>错题、超时与没把握</b><p>次日重新作答，不让“看懂了”冒充“会做了”。</p></div></article><article><span>3天</span><div><b>首次稳定答对</b><p>跨天再次做对，才开始进入长期记忆。</p></div></article><article><span>7/14/30天</span><div><b>连续稳定掌握</b><p>只在到期日抽查，稳定后逐步拉长间隔。</p></div></article></div>{(insights.dueCount === 0 || practiceEmpty) && <div className="empty-state compact review-empty"><span>✓</span><h3>今天没有到期题</h3><p>复习队列已经清空，可以完成今日新题后安心收工。</p><button className="primary-button" onClick={() => setTab("today")}>回到今日</button></div>}</div>}

          {tab === "calendar" && <div className="page-content subpage calendar-page">
            <div className="subpage-heading calendar-heading"><div><span>公考雷达 · 报考工作台</span><h1>公告、职位表和报名节点，一个都不漏</h1><p>围绕公告发布、职位表、岗位条件筛选和报名截止，帮多考试考生守住关键动作。</p></div><button className="primary-button" onClick={() => openEventForm()}>＋ 添加节点</button></div>
            <section className={`reminder-banner${dueReminder ? " urgent" : ""}`}><div><span>{dueReminder ? "有节点进入提醒期" : "报名提醒已工作"}</span><h3>{dueReminder ? `${dueReminder.targetLabel} · ${dueReminder.title}` : "每次打开自动检查全部考试节点"}</h3><p>{dueReminder ? dueReminder.days === 0 ? "今天就是截止或办理日期，请优先确认。" : `还有${dueReminder.days}天，请提前准备材料。` : "站内提醒默认开启；浏览器通知开启后，会在打开应用时同步弹出。"}</p></div><button onClick={() => void enableBrowserReminders()}>{progress.reminderMode === "browser" ? "✓ 系统通知已开" : "开启系统通知"}</button></section>
            <div className="radar-mode-tabs" role="tablist" aria-label="公考雷达模块">
              {[
                ["notices", "公告雷达", `${relevantNotices.length}条`] as const,
                ["positions", "职位筛选", `${matchedPositions.length}岗`] as const,
                ["tasks", "报名待办", `${radarTodoItems.filter((item) => !progress.radarTodoDone[item.id]).length}项`] as const,
              ].map(([mode, label, count]) => <button key={mode} className={radarMode === mode ? "active" : ""} onClick={() => setRadarMode(mode)}><span>{label}</span><b>{count}</b></button>)}
            </div>
            <section className="radar-feature-grid" aria-label="公考雷达能力">
              <button className={radarMode === "notices" ? "active" : ""} onClick={() => setRadarMode("notices")}><span>公告</span><h3>公告雷达</h3><p>招录公告、补充公告、职位表发布和重要变更统一收口。</p></button>
              <button className={radarMode === "positions" ? "active" : ""} onClick={() => setRadarMode("positions")}><span>职位</span><h3>职位筛选</h3><p>按学历、专业、应届身份、政治面貌等条件初步匹配岗位。</p></button>
              <button className={radarMode === "tasks" ? "active" : ""} onClick={() => setRadarMode("tasks")}><span>待办</span><h3>报名动作</h3><p>把公告查看、职位收藏、资格核对、报名截止变成可勾选清单。</p></button>
            </section>

            {radarMode === "notices" && <>
              <section className="notice-summary-grid">
                <article><span>已选考试</span><b>{profile.targets.length || 0}</b><small>{profile.targets.length ? profile.targets.map((target) => target.label).slice(0, 3).join(" / ") : "先设置国考或省考目标"}</small></article>
                <article><span>公告/职位表</span><b>{relevantNotices.length}</b><small>后台发布后自动匹配到你的备考组合</small></article>
                <article><span>日历节点</span><b>{upcomingCalendarEvents.length}</b><small>{nextCalendarEvent ? `最近：${shortDate(nextCalendarEvent.eventDate)}` : "可手动添加报名节点"}</small></article>
              </section>
              <section className="notice-list"><div className="section-heading"><div><span>公告雷达</span><h2>只看与你备考组合相关的公告</h2></div><button onClick={() => openEventForm(primaryTarget?.code ?? "", "公告发布", "公告发布")}>补充公告节点</button></div>
                {relevantNotices.length ? relevantNotices.map((notice) => <article className="notice-card" key={notice.id}>
                  <div><span>{notice.targetLabel} · {notice.noticeType}</span><h3>{notice.title}</h3><p>{notice.summary || "后台可配置公告摘要、报名要求和职位表说明。"}</p><small>{notice.publishDate ? `${shortDate(notice.publishDate)}发布` : "发布时间待补充"} · {notice.status || "已发布"}</small></div>
                  {notice.sourceUrl ? <a href={notice.sourceUrl} target="_blank" rel="noreferrer" onClick={() => trackEvent("radar_notice_open", { noticeId: notice.id, targetCode: notice.targetCode })}>查看来源</a> : <button onClick={() => openEventForm(notice.targetCode, notice.noticeType, notice.title)}>加节点</button>}
                </article>) : <div className="empty-state compact calendar-empty"><span>告</span><h3>后台还没有发布相关公告</h3><p>你可以先手动添加公告、职位表和报名截止节点；等后台导入公告后，这里会按国考/省份自动显示。</p><button className="primary-button" onClick={() => openEventForm()}>手动添加公告节点</button></div>}
              </section>
            </>}

            {radarMode === "positions" && <>
              <section className="candidate-panel"><div className="section-heading"><div><span>我的报考条件</span><h2>先录入一次，后面按岗位自动初筛</h2></div><button onClick={() => void saveCandidateProfile()}>保存条件档案</button></div>
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
              <section className="position-list"><div className="section-heading"><div><span>职位筛选</span><h2>按你的备考组合和条件初步排序</h2></div><em>{savedPositions.length} 个备选</em></div>
                {matchedPositions.length ? matchedPositions.map(({ position, match, saved }) => <article className={`position-card ${match.level}`} key={position.id}>
                  <header><div><span>{position.targetLabel} · {position.examName || "职位表"}</span><h3>{position.title}</h3><p>{position.department}{position.unit ? ` · ${position.unit}` : ""}</p></div><strong>{position.recruitCount || 1}<small>人</small></strong></header>
                  <div className="position-meta"><span>{position.region || "地区待补充"}</span><span>{position.education || "学历不限"}</span><span>{position.majors || "专业不限"}</span></div>
                  <div className={`position-match ${match.level}`}><b>{match.label}</b><span>{match.reasons.join(" · ")}</span></div>
                  {position.remarks && <p className="position-remark">{position.remarks}</p>}
                  <footer><button className={saved ? "saved" : ""} onClick={() => void toggleSavedPosition(position)}>{saved ? "✓ 已加入备选" : "+ 加入备选"}</button>{position.sourceUrl && <a href={position.sourceUrl} target="_blank" rel="noreferrer">查看职位来源</a>}</footer>
                </article>) : <div className="empty-state compact calendar-empty"><span>职</span><h3>后台还没有导入职位表</h3><p>导入职位表后，考生会看到“初步符合 / 条件存疑 / 明显不符”，并能把岗位加入备选清单。</p></div>}
              </section>
            </>}

            {radarMode === "tasks" && <>
              <section className="radar-todo-list"><div className="section-heading"><div><span>报名待办</span><h2>今天打开后，先知道该处理什么</h2></div><button onClick={() => openEventForm()}>添加自定义待办</button></div>
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
                      setRadarMode("tasks");
                    }}>{item.actionLabel}</button>
                  </article>;
                }) : <div className="empty-state compact calendar-empty"><span>✓</span><h3>当前没有待办</h3><p>添加报名截止、资格审查、准考证打印等节点后，这里会自动生成待办。</p><button className="primary-button" onClick={() => openEventForm()}>添加第一个节点</button></div>}
              </section>
              <div className="calendar-targets">{profile.targets.map((target, index) => <button key={target.code} onClick={() => openEventForm(target.code)}><span>{index === 0 ? "主攻" : "兼顾"}</span><b>{target.label}</b><small>{target.examDate ? `${shortDate(target.examDate)}笔试` : "补充考试节点"}</small></button>)}</div>
              <section className="calendar-list"><div className="section-heading"><div><span>时间轴</span><h2>按时间排好的公告、职位表与报名任务</h2></div><em>{upcomingCalendarEvents.length} 个节点</em></div>
                {upcomingCalendarEvents.length ? upcomingCalendarEvents.map((event) => <article className={event.reminderEnabled && event.days <= event.reminderDays ? "calendar-event due" : "calendar-event"} key={event.id}><time><b>{new Date(`${event.eventDate}T12:00:00+08:00`).getMonth() + 1}</b><span>{new Date(`${event.eventDate}T12:00:00+08:00`).getDate()}日</span></time><div><span>{event.targetLabel} · {event.eventType}{event.id.startsWith("official-") ? " · 官方发布" : ""}</span><h3>{event.title}</h3><p>{event.days === 0 ? "今天处理" : `还有${event.days}天`} · 提前{event.reminderDays}天提醒{event.sourceUrl && <> · <a href={event.sourceUrl} target="_blank" rel="noreferrer">查看公告来源</a></>}</p></div><button aria-label={`${event.id.startsWith("event-") ? "删除" : "查看"}${event.title}`} onClick={() => { if (event.id.startsWith("exam-")) { setProfileDraft(profile); setOnboardingOpen(true); return; } void removeExamEvent(event.id); }}>{event.id.startsWith("exam-") ? "修改" : event.id.startsWith("official-") ? "官方" : "删除"}</button></article>) : <div className="empty-state compact calendar-empty"><span>历</span><h3>还没有公考雷达节点</h3><p>建议先添加“公告发布”“职位表发布”和“报名截止”，比只记笔试日期更有用。</p><button className="primary-button" onClick={() => openEventForm()}>添加第一个节点</button></div>}
              </section>
            </>}
            <p className="calendar-disclaimer">日期由你保存或从报考目标带入。公告、职位表和报名资格请以招录机关官方发布为准；来源链接可随节点一并保存。</p>
          </div>}

          {tab === "report" && <div className="page-content subpage">
            <div className="subpage-heading"><span>学习诊断</span><h1>告诉你下一步练什么</h1><p>数量只是记录，薄弱项和速度才决定提分方向。</p></div>
            {insights.total === 0 ? <div className="empty-state report-empty"><span>报</span><h3>完成第一组日练后生成诊断</h3><p>先有真实答题数据，再分析正确率、速度和薄弱模块；这里不会用假数据填满。</p><button className="primary-button" onClick={runDailyAction}>开始今日日练</button></div> : <>
              <div className="stats-grid report-stats"><article><span>累计答题</span><strong>{insights.total}</strong><small>题</small></article><article><span>正确率</span><strong>{insights.accuracy}</strong><small>%</small></article><article><span>犹豫/蒙对</span><strong>{insights.uncertainCount}</strong><small>题</small></article><article><span>超时做题</span><strong>{insights.overtimeCount}</strong><small>题</small></article><article><span>平均用时</span><strong>{insights.avgSeconds}</strong><small>秒</small></article><article><span>今日到期</span><strong>{insights.dueCount}</strong><small>题</small></article></div>
              <article className="report-card mastery-card"><div className="report-title"><h3>掌握状态</h3><span>{insights.stateCounts.mastered}题已掌握</span></div><div className="mastery-segments"><i className="mastered" style={{ flex: insights.stateCounts.mastered }} /><i className="learning" style={{ flex: insights.stateCounts.learning }} /><i className="weak" style={{ flex: insights.stateCounts.weak }} /></div><div className="mastery-legend"><span><i className="mastered" />已掌握 {insights.stateCounts.mastered}</span><span><i className="learning" />学习中 {insights.stateCounts.learning}</span><span><i className="weak" />薄弱 {insights.stateCounts.weak}</span></div></article>
              <article className="report-card"><div className="report-title"><h3>模块正确率与速度</h3><span>最近14天</span></div>{insights.modules.map((item) => <div className="module-row" key={item.module}><div><b>{item.module}</b><small>{item.total}题 · 平均{item.avgSeconds}秒</small></div><div><i style={{ width: `${item.accuracy}%` }} /></div><strong>{item.accuracy}%</strong></div>)}</article>
              <article className="report-card suggestion tomorrow-prescription"><span>明日安排</span><h3>{tomorrowPlan.focusModule ? `先回炉，再练${tomorrowPlan.focusModule}` : "先回炉，再按主攻题库补新题"}</h3><p>{tomorrowPlan.taskText}</p><div className="prescription-facts"><span>预计 {tomorrowPlan.estimatedMinutes} 分钟</span><span>到期 {tomorrowPlan.dueCount} 题</span><span>{primaryTarget?.label ?? "主攻待设置"}</span></div>{tomorrowPlan.focusModule && <button className="secondary-button" onClick={() => void startPractice("mixed", undefined, { kind: "bonus", limit: tomorrowPlan.focusQuestionCount || 5, forceNew: true, focusModule: tomorrowPlan.focusModule ?? undefined })}>按薄弱模块加练5题</button>}</article>
            </>}
          </div>}

          {tab === "me" && <div className="page-content subpage">
            <div className="profile-card">
              <div className="profile-avatar">练</div>
              <div><span>{bootstrap?.user.displayName ?? "公考日练用户"}</span><h2>{targetSummary}备考中</h2><p>{profile.targets.length}个报考目标 · 每天{profile.dailyMinutes}分钟</p></div>
              <button className="profile-edit" onClick={() => { setProfileDraft(profile); setOnboardingOpen(true); }}>修改</button>
            </div>
            <div className="target-chip-row">{profile.targets.map((target, index) => <span className="target-chip" key={target.code}>{index === 0 ? "主攻 · " : ""}{target.label} · {target.examYear}</span>)}</div>
            <article className="panel-card streak-panel"><div><span>连续打卡</span><h3>{streak}天 · 累计{progress.checkins.length}天</h3><p>完成当日日练即自动打卡，10分钟保底练也算坚持。</p></div><div className="streak-medal">{streak >= 30 ? "30" : streak >= 7 ? "7" : "✓"}<small>日练</small></div></article>
            <article className="panel-card account-panel radar-account"><div><span>公考雷达</span><h3>{nextCalendarEvent ? `${nextCalendarEvent.targetLabel} · ${nextCalendarEvent.title}` : "补全公告、职位表与报名节点"}</h3><p>{nextCalendarEvent ? nextCalendarEvent.days === 0 ? "今天处理，别错过关键节点。" : `还有${nextCalendarEvent.days}天，已提前${nextCalendarEvent.reminderDays}天提醒。` : "统一管理多个考试的公告、职位表、筛选和报名日期。"}</p></div><button className="profile-edit" onClick={() => setTab("calendar")}>打开雷达</button></article>
            <article className="panel-card account-panel synced"><div><span>学习诊断</span><h3>{insights.total ? `已分析 ${insights.total} 道真实答题` : "完成首轮后生成提分建议"}</h3><p>查看正确率、答题速度、掌握状态和下一步训练方向。</p></div><button className="profile-edit" onClick={() => setTab("report")}>查看报告</button></article>
            <article className={bootstrap?.user.signedIn ? "panel-card account-panel synced" : "panel-card account-panel"}><div><span>{bootstrap?.user.signedIn ? "账号同步已开启" : "当前仅保存在本设备"}</span><h3>{bootstrap?.user.signedIn ? "换设备也能继续学习" : "登录后同步学习记录"}</h3><p>{bootstrap?.user.signedIn ? "报考目标、题库、掌握状态和会员时长均已同步。" : "登录时会自动合并当前进度。"}</p></div>{bootstrap?.user.signedIn ? <b>✓ 已同步</b> : <a href="/signin-with-chatgpt?return_to=%2F">登录并同步</a>}</article>
            <article className="membership-card"><div><span>会员有效期</span><h3>{formatDate(bootstrap?.user.membershipEnd ?? null)}</h3><p>{bootstrap?.user.membershipActive ? "题库、解析、电台全部解锁" : "激活后解锁长期使用"}</p></div><b>VIP</b></article>
            <article className="panel-card"><div className="panel-title"><h3>兑换码激活</h3><span>支持 7 / 30 / 365 天</span></div><div className="redeem-row"><input value={redeemCode} onChange={(event) => setRedeemCode(event.target.value.toUpperCase())} placeholder="请输入兑换码" /><button onClick={() => void redeem()} disabled={busy}>{busy ? "处理中" : "立即激活"}</button></div><small>激活后的时长自动累计，不会覆盖现有会员时间。</small></article>
            <article className="panel-card invite-panel"><div className="panel-title"><h3>邀请备考搭子</h3><span>双方各得 {bootstrap?.inviteConfig.rewardDays ?? 3} 天</span></div><p>好友通过你的链接进入，并首次激活会员后，双方都会获得额外时长。</p><div className="invite-code"><span>我的邀请码</span><strong>{bootstrap?.user.inviteCode ?? "生成中"}</strong></div><button className="primary-button full-button" onClick={() => void copyInvite()}>复制专属邀请链接</button><div className="invite-stats"><span><b>{bootstrap?.inviteStats.total ?? 0}</b>已邀请</span><span><b>{bootstrap?.inviteStats.pending ?? 0}</b>待激活</span><span><b>{bootstrap?.inviteStats.rewarded ?? 0}</b>已奖励</span></div></article>
            <article className="panel-card ledger-card"><div className="panel-title"><h3>会员时长记录</h3><span>自动累计</span></div>{bootstrap?.ledger.length ? bootstrap.ledger.map((item, index) => <div className="ledger-row" key={item.created_at + "-" + index}><div><b>{item.note}</b><span>{new Date(item.created_at).toLocaleDateString("zh-CN")}</span></div><strong>+{item.delta_days}天</strong></div>) : <p className="muted">暂无时长变动记录</p>}</article>
          </div>}
        </>}

        <AudioHub active={!activeModule && tab === "audio"} tracks={bootstrap?.content.audioTracks ?? []} wrongQuestions={audioWrongQuestions} notify={notify} trackEvent={trackEvent} />

        {!activeModule && <nav className="bottom-nav" aria-label="主导航"><button className={tab === "today" ? "active" : ""} onClick={() => setTab("today")}><span>今</span>今日</button><button className={tab === "banks" ? "active" : ""} onClick={() => setTab("banks")}><span>库</span>题库</button><button className={tab === "review" ? "active" : ""} onClick={() => setTab("review")}><span>复</span>复习</button><button className={tab === "audio" ? "active" : ""} onClick={() => setTab("audio")}><span>台</span>电台</button><button className={tab === "me" || tab === "report" || tab === "calendar" ? "active" : ""} onClick={() => setTab("me")}><span>我</span>我的</button></nav>}

        {eventFormOpen && bootstrap && (
          <div className="onboarding-backdrop" role="dialog" aria-modal="true" aria-label="添加考试节点">
            <section className="event-form-card">
              <div className="event-form-top"><div><span>公考雷达</span><h2>添加公告、职位或报名节点</h2><p>先记录最容易错过的截止时间，系统会按提前天数提醒。</p></div><button aria-label="关闭" onClick={() => setEventFormOpen(false)}>×</button></div>
              <div className="event-form-grid">
                <label><span>对应考试</span><select value={eventDraft.targetCode} onChange={(event) => setEventDraft({ ...eventDraft, targetCode: event.target.value })}><option value="">请选择</option>{profile.targets.map((target) => <option key={target.code} value={target.code}>{target.label}</option>)}</select></label>
                <label><span>节点类型</span><select value={eventDraft.eventType} onChange={(event) => { const eventType = event.target.value; setEventDraft({ ...eventDraft, eventType, title: eventDraft.title === eventDraft.eventType ? eventType : eventDraft.title }); }}>{examEventTypes.map((type) => <option key={type}>{type}</option>)}</select></label>
                <label className="wide"><span>节点名称</span><input value={eventDraft.title} maxLength={40} onChange={(event) => setEventDraft({ ...eventDraft, title: event.target.value })} placeholder="如：广东省考职位表发布" /></label>
                <label><span>日期</span><input type="date" value={eventDraft.eventDate} onChange={(event) => setEventDraft({ ...eventDraft, eventDate: event.target.value })} /></label>
                <label><span>提前提醒</span><select value={eventDraft.reminderDays} onChange={(event) => setEventDraft({ ...eventDraft, reminderDays: Number(event.target.value) })}>{[0, 1, 3, 7, 14].map((days) => <option key={days} value={days}>{days === 0 ? "当天" : `提前${days}天`}</option>)}</select></label>
                <label className="wide"><span>官方公告链接（选填）</span><input type="url" value={eventDraft.sourceUrl} onChange={(event) => setEventDraft({ ...eventDraft, sourceUrl: event.target.value })} placeholder="https://…" /></label>
              </div>
              <button className="primary-button full-button" onClick={() => void saveExamEvent()}>保存并开启提醒</button>
              <small className="event-form-note">站内提醒会在每次打开时自动检查。完全关闭H5后能否后台推送，取决于浏览器或后续小程序订阅消息能力。</small>
            </section>
          </div>
        )}

        {onboardingOpen && bootstrap && (
          <div className="onboarding-backdrop" role="dialog" aria-modal="true" aria-label="设置备考目标">
            <section className="onboarding-card">
              <div className="onboarding-top">
                <span>支持同时备考</span>
                <h2>{profile.onboarded ? "调整你的多个报考目标" : "你准备参加哪些公务员考试？"}</h2>
                <p>国考和多个省考都可以同时选择；排在首位的是主攻考试，保存后可在公考雷达补充公告、职位表、报名和准考证节点。</p>
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
                    <select value={target.examYear} onChange={(event) => updateTarget(target.code, { examYear: Number(event.target.value) })}>
                      {[new Date().getFullYear(), new Date().getFullYear() + 1, new Date().getFullYear() + 2, new Date().getFullYear() + 3].map((year) => <option key={year}>{year}</option>)}
                    </select>
                    <input aria-label={`${target.label}考试日期`} type="date" value={target.examDate ?? ""} onChange={(event) => updateTarget(target.code, { examDate: event.target.value || null })} />
                  </div>
                </div>
              ))}

              <div className="choice-group">
                <label>每天计划学习</label>
                <div className="minute-choice">{[30, 45, 60].map((minutes) => <button key={minutes} className={normalizePlanMinutes(profileDraft.dailyMinutes) === minutes ? "active" : ""} onClick={() => setProfileDraft({ ...profileDraft, dailyMinutes: minutes })}>{minutes}分钟</button>)}</div>
              </div>
              <div className="province-isolation-note">30/45/60分钟分别安排10/15/20道行测题；报考目标用于推荐和倒计时，只有主动加入的题库才会进入智能练习。</div>
              <button className="primary-button full-button onboarding-submit" disabled={busy || !profileDraft.targets.length} onClick={() => void saveProfile()}>{busy ? "正在保存…" : `保存 ${profileDraft.targets.length} 个报考目标`}</button>
              {profile.onboarded && <button className="onboarding-cancel" onClick={() => setOnboardingOpen(false)}>取消修改</button>}
            </section>
          </div>
        )}
        {toast && <div className="toast" role="status">{toast}</div>}
      </div>
    </main>
  );
}
