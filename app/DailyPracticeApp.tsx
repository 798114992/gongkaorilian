"use client";

/* eslint-disable react-hooks/refs -- session snapshots and queued saves intentionally use refs inside event handlers */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PracticeDay, Question } from "./data/content";
import type { AudioTrack } from "./data/audio";
import AudioHub from "./AudioHub";

type Tab = "today" | "banks" | "audio" | "review" | "report" | "me";
type Module = "morning" | "practice" | "affairs" | "essay" | null;
type PracticeMode = "mixed" | "review";
type PlanMinutes = 10 | 30 | 45 | 60;
type PracticeKind = "daily" | "review" | "bank" | "bonus";
type AnswerConfidence = "" | "confident" | "hesitant" | "guessed";

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
  content: { practiceDays: PracticeDay[]; audioTracks: AudioTrack[]; access: "premium" | "preview" };
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
  tomorrowPlan: { dueCount: 0, focusModule: null, focusQuestionCount: 0, estimatedMinutes: 5, taskText: "完成首轮日练后生成明日处方。" },
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

const provinces = [
  "北京", "天津", "上海", "重庆", "河北", "山西", "内蒙古", "辽宁", "吉林", "黑龙江",
  "江苏", "浙江", "安徽", "福建", "江西", "山东", "河南", "湖北", "湖南", "广东",
  "广西", "海南", "四川", "贵州", "云南", "西藏", "陕西", "甘肃", "青海", "宁夏", "新疆",
];
const reasonOptions = ["知识点不会", "方法没想到", "计算失误", "审题错误", "时间不足"];
const essayRubric = ["观点准确", "表达规范", "结构清晰", "语言简洁"];

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
  };
}

function normalizePlanMinutes(value: unknown): PlanMinutes {
  return value === 10 || value === 45 || value === 60 ? value : 30;
}

function buildDailyPlan(value: unknown, preview = false) {
  const minutes = normalizePlanMinutes(value);
  const plans = {
    10: { minutes: 10 as const, morningMinutes: 0, practiceMinutes: 10, essayMinutes: 0, questionCount: 5 },
    30: { minutes: 30 as const, morningMinutes: 5, practiceMinutes: 20, essayMinutes: 5, questionCount: 10 },
    45: { minutes: 45 as const, morningMinutes: 5, practiceMinutes: 30, essayMinutes: 10, questionCount: 15 },
    60: { minutes: 60 as const, morningMinutes: 10, practiceMinutes: 35, essayMinutes: 15, questionCount: 20 },
  };
  return { ...plans[minutes], questionCount: preview ? 5 : plans[minutes].questionCount };
}

function localChinaDateKey() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
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
  const trackedUserRef = useRef("");
  const progressRef = useRef<Progress>(emptyProgress);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());

  const practiceDays = bootstrap?.content.practiceDays ?? [];
  const dayKey = bootstrap?.todayKey ?? localChinaDateKey();
  const day = practiceDays[contentDayIndex(dayKey, practiceDays.length)] ?? practiceDays[0] ?? loadingDay;
  const insights = bootstrap?.studyInsights ?? emptyInsights;
  const profile = bootstrap?.examProfile ?? profileDraft;
  const dailySessionForPlan = progress.activePractice?.dateKey === dayKey && progress.activePractice.kind === "daily"
    ? progress.activePractice
    : null;
  const todayPlanMinutes = dailySessionForPlan?.planMinutes ?? progress.planOverrides[dayKey] ?? profile.dailyMinutes;
  const dailyPlan = buildDailyPlan(todayPlanMinutes, bootstrap?.content.access === "preview");
  const datedTargets = profile.targets
    .map((target) => ({ target, days: daysLeft(target.examDate) }))
    .filter((item): item is { target: ExamTarget; days: number } => item.days !== null)
    .sort((a, b) => a.days - b.days);
  const nextExam = datedTargets[0] ?? null;
  const hasExtendedMembership = Boolean(bootstrap?.ledger.some((item) => item.source_type !== "trial"));
  const addedBanks = bootstrap?.questionBanks.filter((bank) => bank.added) ?? [];
  const activeLearningBanks = addedBanks.filter((bank) => bank.subject === "行测");
  const primaryTarget = profile.targets[0] ?? null;
  const savedPrimaryBank = addedBanks.find((bank) => bank.code === progress.primaryBankCode && bank.subject === "行测");
  const primaryBank = savedPrimaryBank
    ?? addedBanks.find((bank) => bank.subject === "行测" && primaryTarget && targetMatchesBank(primaryTarget, bank))
    ?? activeLearningBanks[0]
    ?? null;
  const orderedBankCodes = activeLearningBanks.map((bank) => bank.code).sort((a, b) => Number(b === primaryBank?.code) - Number(a === primaryBank?.code));
  const missingTargets = profile.targets.filter((target) => !addedBanks.some((bank) => bank.code !== "starter-gk" && targetMatchesBank(target, bank)));
  const targetSummary = profile.targets.length
    ? `${profile.targets.slice(0, 3).map((target) => target.label).join("＋")}${profile.targets.length > 3 ? `等${profile.targets.length}项` : ""}`
    : "尚未设置报考目标";
  const practiceDone = Boolean(progress.completed[`${dayKey}-practice`]);
  const enabledDailySteps = dailyPlan.minutes === 10 ? ["practice"] as const : ["morning", "practice", "essay"] as const;
  const stepDone = {
    morning: Boolean(progress.completed[`${dayKey}-morning`]),
    practice: practiceDone,
    essay: Boolean(progress.completed[`${dayKey}-essay`]),
  };
  const doneCount = enabledDailySteps.filter((step) => stepDone[step]).length;
  const allDailyDone = doneCount === enabledDailySteps.length;
  const nextDailyStep = enabledDailySteps.find((step) => !stepDone[step]) ?? null;
  const audioWrongQuestions = Array.from(new Map([...(bootstrap?.wrongAudioQuestions ?? []), ...sessionWrongQuestions].map((question) => [question.id, question])).values());
  const currentPractice = practiceQuestions[practiceIndex];
  const activeDailySession = dailySessionForPlan;
  const dailyRemaining = activeDailySession
    ? Math.max(0, activeDailySession.questionTarget - activeDailySession.answered)
    : dailyPlan.questionCount;

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

  const toggleBank = async (bank: QuestionBank) => {
    setBusy(true);
    try {
      const result = await api<{ banks: QuestionBank[]; profile: ExamProfile }>({ action: "toggleQuestionBank", bankCode: bank.code, added: !bank.added });
      setBootstrap((current) => current ? { ...current, questionBanks: result.banks, examProfile: result.profile } : current);
      setProfileDraft(result.profile);
      trackEvent("bank_toggle", { bankCode: bank.code, added: !bank.added });
      notify(bank.added
        ? "已移出题库；报考目标和本题库进度仍会保留"
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
    options: { kind?: PracticeKind; limit?: number; forceNew?: boolean; focusModule?: string } = {},
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
      });
      if (!result.questions.length) {
        setPracticeEmpty(true);
        setTab(mode === "review" ? "review" : "banks");
        return notify(mode === "review" ? "今天没有到期题，去学习一组新题吧" : "这本题库暂时没有可练的行测题");
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
    const current = currentProgress.essayChecks[dayKey] ?? [];
    const nextChecks = current.includes(item) ? current.filter((value) => value !== item) : [...current, item];
    void persist({ ...currentProgress, essayChecks: { ...currentProgress.essayChecks, [dayKey]: nextChecks } });
  };

  const updateEssayDraft = (value: string) => {
    const current = progress;
    const next = { ...current, essayDrafts: { ...current.essayDrafts, [dayKey]: value } };
    progressRef.current = next;
    setProgress(next);
  };

  const submitEssay = async () => {
    if ((progress.essayDrafts[dayKey] ?? "").trim().length < 10) return notify("先完成至少10个字的改写");
    if ((progress.essayChecks[dayKey] ?? []).length < 2) return notify("请按标准完成至少两项自评");
    await complete(`${dayKey}-essay`);
    setActiveModule(null);
    setTab("report");
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
          : "今天学够了 · 查看明日处方";

  const runDailyAction = () => {
    if (activeDailySession) return void startPractice("mixed", undefined, { kind: "daily" });
    if (nextDailyStep === "morning") return setActiveModule("morning");
    if (nextDailyStep === "practice") return void startPractice("mixed", undefined, { kind: "daily" });
    if (nextDailyStep === "essay") return setActiveModule("essay");
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
        if (practiceSummary.kind === "daily" && nextDailyStep === "essay") return setActiveModule("essay");
        setTab(practiceSummary.kind === "review" ? "review" : practiceSummary.kind === "daily" ? "report" : "today");
        void loadBootstrap();
      };
      return <article className="practice-summary">
        <span>✓</span><h3>{practiceSummary.answered} 题已入账</h3><p>{practiceSummary.kind === "daily" && nextDailyStep ? "行测已完成，按今日处方继续下一个有效动作。" : "本轮任务已完成，进度和复习时间已经自动保存。"}</p>
        <div className="practice-summary-stats"><div><b>{accuracy}%</b><span>正确率</span></div><div><b>{Math.floor(practiceSummary.elapsedSeconds / 60)}:{String(practiceSummary.elapsedSeconds % 60).padStart(2, "0")}</b><span>本轮用时</span></div><div><b>{practiceSummary.reviewAdded}</b><span>加入回炉</span></div></div>
        <div className="practice-summary-actions"><button className="primary-button" onClick={closeSummary}>{closeLabel}</button>{(practiceSummary.kind !== "daily" || !nextDailyStep) && <button className="secondary-button" onClick={() => { const summary = practiceSummary; setPracticeSummary(null); void startPractice("mixed", summary.bankCodes, { kind: "bonus", limit: 5, forceNew: true }); }}>再练10分钟</button>}</div>
      </article>;
    }
    if (!currentPractice) return <div className="empty-state"><span>练</span><h3>正在准备题目</h3></div>;
    const finished = feedback && practiceIndex === practiceQuestions.length - 1;
    const target = progress.activePractice?.questionTarget ?? practiceQuestions.length;
    const targetSeconds = feedback?.targetSeconds ?? questionTargetSeconds(currentPractice);
    return (
      <div className="smart-practice">
        <div className="practice-overview">
          <div><span>{practiceMode === "review" ? "到期复习" : currentPractice.planReason}</span><b>{currentPractice.bankName}</b></div>
          <div><strong>{Math.min(target, sessionAnswered + (feedback ? 0 : 1))}</strong> / {target}<small>{questionSeconds}s / 建议{targetSeconds}s{sessionAnswered ? ` · 正确率${Math.round((sessionCorrect / sessionAnswered) * 100)}%` : ""}</small></div>
        </div>
        <div className="practice-composition"><span>到期 {practiceComposition.due}</span><span>其中薄弱 {practiceComposition.weak}</span><span>新题 {practiceComposition.new}</span><span>主攻 {practiceComposition.primary} · 兼顾 {practiceComposition.other}</span><b>还剩 {Math.max(0, target - sessionAnswered)} 题</b></div>
        <div className="practice-progress"><i style={{ width: `${Math.min(100, (sessionAnswered / Math.max(1, target)) * 100)}%` }} /></div>
        <article className="question-card smart-question-card">
          <div className="question-context"><span>{currentPractice.scopeLabel}</span><b>推荐理由：{currentPractice.planReason}</b></div>
          <div className="question-meta"><span>{currentPractice.module} · {currentPractice.knowledge}</span><em>{currentPractice.difficulty}</em></div>
          <h3>{currentPractice.stem}</h3>
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
            <footer><span>题源：{currentPractice.source}{currentPractice.reviewedAt ? ` · 校验 ${currentPractice.reviewedAt.slice(0, 10)}` : ""}</span><button onClick={() => void updateQuestionMeta({ favorite: !currentPractice.favorite })}>{currentPractice.favorite ? "★ 已收藏" : "☆ 收藏"}</button></footer>
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
          <div className="button-row"><button className="secondary-button" onClick={speakMorning}>▶ 逐段朗读</button><button className="primary-button" onClick={async () => { if (progress.completed[`${dayKey}-morning`]) return setActiveModule(null); await complete(`${dayKey}-morning`); setActiveModule(null); await startPractice("mixed", undefined, { kind: "daily" }); }}>{progress.completed[`${dayKey}-morning`] ? "✓ 已完成" : "完成并继续刷题"}</button></div>
        </div>}

        {activeModule === "affairs" && <div className="affairs-grid">{day.currentAffairs.map((item, index) => <article className="affair-card" key={item.title}><div><span>{String(index + 1).padStart(2, "0")}</span><em>{item.tag}</em></div><h3>{item.title}</h3><p>{item.detail}</p></article>)}</div>}

          {activeModule === "essay" && <div className="essay-wrap">
            <div className="expression-list">{day.essay.expressions.map((item) => <article className="expression-card" key={item.phrase}><span>{item.scene}</span><p>{item.phrase}</p><button onClick={() => toggleFavoritePhrase(item.phrase)}>{progress.favorites.includes(item.phrase) ? "★ 已收藏" : "☆ 收藏"}</button></article>)}</div>
          <article className="writing-card"><span className="content-tag">今日微练</span><h3>{day.essay.prompt}</h3>
            <div className="essay-guidance">先找问题，再用“动词＋对象＋机制＋结果”完成闭环表达；不要堆砌金句。</div>
            <textarea value={progress.essayDrafts[dayKey] ?? ""} onChange={(event) => updateEssayDraft(event.target.value)} onBlur={() => void persist(progress)} placeholder="先独立改写，再和参考表达比较……" maxLength={day.essay.wordLimit ?? 60} />
            <div className="writing-meta"><span>{(progress.essayDrafts[dayKey] ?? "").length} / {day.essay.wordLimit ?? 60}</span><button onClick={() => setEssayReference((value) => !value)}>{essayReference ? "收起参考" : "对比参考表达"}</button></div>
            {essayReference && <div className="reference-answer"><b>参考表达</b><p>{day.essay.reference}</p><small>不要逐字照抄，重点观察动词、逻辑和闭环表达。</small></div>}
            <div className="essay-rubric"><span>按标准自评（至少选择2项）</span><div>{essayRubric.map((item) => <button key={item} className={(progress.essayChecks[dayKey] ?? []).includes(item) ? "active" : ""} onClick={() => toggleEssayCheck(item)}>{(progress.essayChecks[dayKey] ?? []).includes(item) ? "✓ " : ""}{item}</button>)}</div></div>
            <button className="primary-button full-button" onClick={() => void submitEssay()}>{progress.completed[`${dayKey}-essay`] ? "✓ 已完成微练" : "完成自评并查看明日处方"}</button>
          </article>
        </div>}
      </section>
    );
  };

  const filteredBanks = useMemo(() => {
    const banks = bootstrap?.questionBanks ?? [];
    if (bankFilter === "适合我") return banks.filter((bank) => bank.targetMatch).sort((a, b) => Number(b.recommended) - Number(a.recommended));
    if (bankFilter === "我的") return banks.filter((bank) => bank.added);
    if (bankFilter === "国考") return banks.filter((bank) => bank.examType === "国考");
    if (bankFilter === "省考") return banks.filter((bank) => bank.examType === "省考");
    if (bankFilter === "申论") return banks.filter((bank) => bank.subject === "申论");
    return banks;
  }, [bankFilter, bootstrap?.questionBanks]);

  const weakestModule = insights.modules.length ? [...insights.modules].sort((a, b) => a.accuracy - b.accuracy)[0] : null;
  const tomorrowPlan = insights.tomorrowPlan;

  return (
    <main className="app-shell">
      <div className="app-frame">
        <header className="topbar"><div className="brand-mark">公</div><div className="brand-copy"><strong>公考日练</strong><span>每天30–60分钟，高效完成今日训练</span></div><button className="member-chip" onClick={() => setTab("me")}>{membershipText(bootstrap?.user, hasExtendedMembership)}</button></header>

        {activeModule ? renderModule() : <>
          {tab === "today" && <div className="page-content">
            <section className="goal-strip"><div className="target-summary"><span>主攻考试 · 可随时调整</span><b>{primaryTarget?.label ?? "尚未设置主攻考试"}</b><p>{nextExam ? `最近考试：${nextExam.target.label}，还有 ${nextExam.days} 天` : `${profile.targets.length}个目标可同时备考，主攻目标优先推荐题库`}</p></div><button onClick={() => { setProfileDraft(profile); setOnboardingOpen(true); }}>调整目标</button></section>
            <section className="hero-card learning-hero"><div className="hero-top"><span>今日训练处方</span><span>{new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "long", day: "numeric", weekday: "short" }).format(new Date())}</span></div><div className="hero-main"><div><p>{dailyPlan.minutes === 10 ? "忙碌保底" : "今日计划"}</p><h1>{dailyPlan.minutes}<small> 分钟</small></h1><span>{primaryBank ? `主攻 ${primaryBank.name}` : `${addedBanks.length} 本题库已加入`} · 到期 {insights.dueCount} 题</span></div><div className="progress-ring" style={{ "--progress": `${doneCount * (360 / enabledDailySteps.length)}deg` } as React.CSSProperties}><strong>{doneCount}/{enabledDailySteps.length}</strong><span>有效动作</span></div></div><button className="hero-action" disabled={busy} onClick={runDailyAction}>{dailyActionLabel} <span>{allDailyDone ? "明天练什么已经算好" : "到期优先 · 主攻与兼顾均衡"}</span></button><div className="hero-mode-row"><button disabled={Boolean(dailySessionForPlan) || practiceDone} onClick={toggleBusyMode}>{dailyPlan.minutes === 10 ? `恢复默认${normalizePlanMinutes(profile.dailyMinutes)}分钟` : "今天太忙？切换10分钟保底"}</button>{allDailyDone && <button onClick={runBonusPractice}>再练10分钟</button>}</div></section>

            {bootstrap?.content.access === "preview" && <section className="access-card"><div><span>当前为免费版</span><h3>每天可练5题，完整体验学习闭环</h3><p>激活后解锁完整题量、多考试题库和全部音频。</p></div><button onClick={() => setTab("me")}>去激活</button></section>}

            {profile.onboarded && missingTargets.length > 0 && <section className="province-warning"><div><span>还有目标未加题库</span><h3>把需要备考的题库加入书架</h3><p>综合练习只使用你已添加的题库；未添加的省份不会进入练习队列。</p><ul className="target-missing-list">{missingTargets.map((target) => <li key={target.code}>{target.label}</li>)}</ul></div><button onClick={() => setTab("banks")}>去添加</button></section>}

            <section className="today-plan"><div className="section-heading"><div><span>今日安排</span><h2>{dailyPlan.minutes === 10 ? "忙碌日只完成一个保底动作" : "按顺序完成三个有效动作"}</h2></div><em>{allDailyDone ? "今日已完成" : `还剩 ${enabledDailySteps.length - doneCount} 项`}</em></div>
              {dailyPlan.minutes !== 10 && <button className="plan-item" onClick={() => setActiveModule("morning")}><span className="plan-icon blue">读</span><div><b>晨读：记住3个规范表达</b><p>{day.morning.title}</p></div><i>{progress.completed[`${dayKey}-morning`] ? "✓" : `${dailyPlan.morningMinutes}分钟`}</i></button>}
              <button className="plan-item featured-plan" onClick={runDailyAction}><span className="plan-icon orange">练</span><div><b>智能刷题{dailyPlan.questionCount}道</b><p>{activeDailySession ? `已保存断点，还剩${dailyRemaining}题` : "到期复习优先，自动补充薄弱题和新题"}</p></div><i>{practiceDone ? "✓" : `${dailyPlan.practiceMinutes}分钟`}</i></button>
              {dailyPlan.minutes !== 10 && <button className="plan-item" onClick={() => setActiveModule("essay")}><span className="plan-icon green">写</span><div><b>申论表达微练</b><p>独立改写＋参考对比＋四维自评</p></div><i>{progress.completed[`${dayKey}-essay`] ? "✓" : `${dailyPlan.essayMinutes}分钟`}</i></button>}
            </section>

            <section className="my-banks-preview"><div className="section-heading"><div><span>我的多考试题库 · {addedBanks.length}本</span><h2>主攻优先混练，也可以单本加练</h2></div><button onClick={() => setTab("banks")}>管理题库</button></div><div className="mini-bank-row">{activeLearningBanks.slice(0, 3).map((bank) => <button key={bank.code} onClick={() => void startPractice("mixed", [bank.code], { kind: "bank" })}><span>{bank.subject}</span><div><b>{bank.name}{bank.code === primaryBank?.code ? " · 主攻" : ""}</b><small>{bank.scopeLabel} · 已练 {bank.studiedCount}/{bank.questionCount}</small></div><i>开始</i></button>)}</div></section>

            <section className="tool-section"><div className="section-heading"><div><span>随时巩固</span><h2>不浪费碎片时间</h2></div></div><div className="tool-grid refreshed-tools"><button className="audio-tool" onClick={() => setTab("audio")}><span>听</span><b>日练电台</b><small>通勤听时政与申论</small></button><button onClick={() => setTab("review")}><span>复</span><b>到期回炉</b><small>{insights.dueCount} 道今天该复习</small></button><button onClick={() => setTab("report")}><span>报</span><b>提分诊断</b><small>{weakestModule ? `${weakestModule.module}需加强` : "完成练习后生成"}</small></button></div></section>
          </div>}

          {tab === "banks" && <div className="page-content subpage">
            <div className="subpage-heading bank-heading"><div><span>题库中心</span><h1>国考和多个省考，想加几本就加几本</h1><p>每个地区独立建库、独立记录进度；综合练习只从“我的题库”组题。</p></div><strong>{addedBanks.length} 本已添加</strong></div>
            <div className="target-scope-note"><b>主攻优先 · 其余混练</b><span>{primaryBank ? `主攻《${primaryBank.name}》；其余已加入题库也会参与` : "请先添加一套行测题库"}</span><button onClick={() => { setProfileDraft(profile); setOnboardingOpen(true); }}>管理目标</button></div>
            <div className="bank-filters">{["适合我", "我的", "全部", "国考", "省考", "申论"].map((item) => <button key={item} className={bankFilter === item ? "active" : ""} onClick={() => setBankFilter(item)}>{item}</button>)}</div>
            <section className="bank-list">{filteredBanks.map((bank) => {
              const percent = bank.questionCount ? Math.round((bank.studiedCount / bank.questionCount) * 100) : 0;
              const estimatedDays = Math.max(1, Math.ceil(Math.max(0, bank.questionCount - bank.studiedCount) / dailyPlan.questionCount));
              const isPrimary = bank.code === primaryBank?.code;
              return <article className={`bank-card bank-${bank.coverColor}${isPrimary ? " is-primary" : ""}`} key={bank.code}>
                <div className="bank-cover"><span>{bank.examType}</span><b>{bank.subject}</b><small>{bank.province}</small></div>
                <div className="bank-copy"><div><span>{bank.examYear ? `${bank.examYear}年` : "持续更新"} · {bank.questionCount}题</span><h3>{bank.name}</h3>{isPrimary && <div className="primary-bank-badge">主攻题库</div>}<p>{bank.description}</p><div className={`scope-badge ${bank.recommended ? "recommended" : bank.targetMatch ? "generic" : "mismatch"}`}>{bank.recommended ? "✓ 适合我的报考" : bank.targetMatch ? `✓ 已在目标 · ${bank.scopeLabel}` : bank.scopeLabel}</div></div>
                  <div className="bank-progress"><div><i style={{ width: `${percent}%` }} /></div><span>{percent}%</span></div>
                  <footer><small>{bank.added ? `已掌握${bank.masteredCount} · 薄弱${bank.weakCount} · 到期${bank.dueCount} · 约${estimatedDays}天过一轮` : bank.targetMatch ? "与我的报考目标匹配" : bank.mismatchReason}</small><div><button disabled={busy} className={bank.added ? "remove" : ""} onClick={() => void toggleBank(bank)}>{bank.added ? "已添加" : bank.targetMatch ? "+ 添加" : "+ 添加并备考"}</button>{bank.added && bank.subject === "行测" && !isPrimary && <button className="primary-bank-button" onClick={() => setPrimaryBank(bank.code)}>设为主攻</button>}{bank.added && bank.subject === "行测" ? <button className="start-bank" onClick={() => void startPractice("mixed", [bank.code], { kind: "bank" })}>单本练</button> : bank.added && <span className="primary-bank-badge">申论微练建设中</span>}</div></footer>
                </div>
              </article>;
            })}</section>
            {filteredBanks.length === 0 && <div className="empty-state compact"><span>库</span><h3>这个分类的题库正在整理</h3><p>在后台按考试类型和省份创建并发布后，会自动显示在这里。</p></div>}
          </div>}

          {tab === "review" && <div className="page-content subpage"><div className="subpage-heading"><span>智能复习</span><h1>不是重看答案，而是再次做对</h1><p>只呈现今天真正到期的题；超时、答错和没把握都会进入回炉。</p></div><section className="review-hero"><div><span>今日到期</span><h2>{insights.dueCount}<small> 道</small></h2><p>薄弱 {insights.stateCounts.weak} · 学习中 {insights.stateCounts.learning} · 已掌握 {insights.stateCounts.mastered}</p></div><button disabled={busy || insights.dueCount === 0} onClick={() => void startPractice("review", undefined, { kind: "review" })}>{insights.dueCount ? "开始回炉" : "今日已清空"}</button></section><div className="review-rules"><article><span>1天</span><div><b>错题、超时与没把握</b><p>次日重新作答，不让“看懂了”冒充“会做了”。</p></div></article><article><span>3天</span><div><b>首次稳定答对</b><p>跨天再次做对，才开始进入长期记忆。</p></div></article><article><span>7/14/30天</span><div><b>连续稳定掌握</b><p>只在到期日抽查，稳定后逐步拉长间隔。</p></div></article></div>{(insights.dueCount === 0 || practiceEmpty) && <div className="empty-state compact review-empty"><span>✓</span><h3>今天没有到期题</h3><p>复习队列已经清空，可以完成今日新题后安心收工。</p><button className="primary-button" onClick={() => setTab("today")}>回到今日</button></div>}</div>}

          {tab === "report" && <div className="page-content subpage">
            <div className="subpage-heading"><span>学习诊断</span><h1>告诉你下一步练什么</h1><p>数量只是记录，薄弱项和速度才决定提分方向。</p></div>
            {insights.total === 0 ? <div className="empty-state report-empty"><span>报</span><h3>完成第一组日练后生成诊断</h3><p>先有真实答题数据，再分析正确率、速度和薄弱模块；这里不会用假数据填满。</p><button className="primary-button" onClick={runDailyAction}>开始今日日练</button></div> : <>
              <div className="stats-grid report-stats"><article><span>累计答题</span><strong>{insights.total}</strong><small>题</small></article><article><span>正确率</span><strong>{insights.accuracy}</strong><small>%</small></article><article><span>犹豫/蒙对</span><strong>{insights.uncertainCount}</strong><small>题</small></article><article><span>超时做题</span><strong>{insights.overtimeCount}</strong><small>题</small></article><article><span>平均用时</span><strong>{insights.avgSeconds}</strong><small>秒</small></article><article><span>今日到期</span><strong>{insights.dueCount}</strong><small>题</small></article></div>
              <article className="report-card mastery-card"><div className="report-title"><h3>掌握状态</h3><span>{insights.stateCounts.mastered}题已掌握</span></div><div className="mastery-segments"><i className="mastered" style={{ flex: insights.stateCounts.mastered }} /><i className="learning" style={{ flex: insights.stateCounts.learning }} /><i className="weak" style={{ flex: insights.stateCounts.weak }} /></div><div className="mastery-legend"><span><i className="mastered" />已掌握 {insights.stateCounts.mastered}</span><span><i className="learning" />学习中 {insights.stateCounts.learning}</span><span><i className="weak" />薄弱 {insights.stateCounts.weak}</span></div></article>
              <article className="report-card"><div className="report-title"><h3>模块正确率与速度</h3><span>最近14天</span></div>{insights.modules.map((item) => <div className="module-row" key={item.module}><div><b>{item.module}</b><small>{item.total}题 · 平均{item.avgSeconds}秒</small></div><div><i style={{ width: `${item.accuracy}%` }} /></div><strong>{item.accuracy}%</strong></div>)}</article>
              <article className="report-card suggestion tomorrow-prescription"><span>明日训练处方</span><h3>{tomorrowPlan.focusModule ? `先回炉，再练${tomorrowPlan.focusModule}` : "先回炉，再按主攻题库补新题"}</h3><p>{tomorrowPlan.taskText}</p><div className="prescription-facts"><span>预计 {tomorrowPlan.estimatedMinutes} 分钟</span><span>到期 {tomorrowPlan.dueCount} 题</span><span>{primaryTarget?.label ?? "主攻待设置"}</span></div>{tomorrowPlan.focusModule && <button className="secondary-button" onClick={() => void startPractice("mixed", undefined, { kind: "bonus", limit: tomorrowPlan.focusQuestionCount || 5, forceNew: true, focusModule: tomorrowPlan.focusModule ?? undefined })}>按薄弱模块加练5题</button>}</article>
            </>}
          </div>}

          {tab === "me" && <div className="page-content subpage">
            <div className="profile-card">
              <div className="profile-avatar">练</div>
              <div><span>{bootstrap?.user.displayName ?? "公考日练用户"}</span><h2>{targetSummary}备考中</h2><p>{profile.targets.length}个报考目标 · 每天{profile.dailyMinutes}分钟</p></div>
              <button className="profile-edit" onClick={() => { setProfileDraft(profile); setOnboardingOpen(true); }}>修改</button>
            </div>
            <div className="target-chip-row">{profile.targets.map((target, index) => <span className="target-chip" key={target.code}>{index === 0 ? "主攻 · " : ""}{target.label} · {target.examYear}</span>)}</div>
            <article className="panel-card account-panel synced"><div><span>学习诊断</span><h3>{insights.total ? `已分析 ${insights.total} 道真实答题` : "完成首轮后生成提分建议"}</h3><p>查看正确率、答题速度、掌握状态和下一步训练方向。</p></div><button className="profile-edit" onClick={() => setTab("report")}>查看报告</button></article>
            <article className={bootstrap?.user.signedIn ? "panel-card account-panel synced" : "panel-card account-panel"}><div><span>{bootstrap?.user.signedIn ? "账号同步已开启" : "当前仅保存在本设备"}</span><h3>{bootstrap?.user.signedIn ? "换设备也能继续学习" : "登录后同步学习记录"}</h3><p>{bootstrap?.user.signedIn ? "报考目标、题库、掌握状态和会员时长均已同步。" : "登录时会自动合并当前进度。"}</p></div>{bootstrap?.user.signedIn ? <b>✓ 已同步</b> : <a href="/signin-with-chatgpt?return_to=%2F">登录并同步</a>}</article>
            <article className="membership-card"><div><span>会员有效期</span><h3>{formatDate(bootstrap?.user.membershipEnd ?? null)}</h3><p>{bootstrap?.user.membershipActive ? "题库、解析、电台全部解锁" : "激活后解锁长期使用"}</p></div><b>VIP</b></article>
            <article className="panel-card"><div className="panel-title"><h3>兑换码激活</h3><span>支持 7 / 30 / 365 天</span></div><div className="redeem-row"><input value={redeemCode} onChange={(event) => setRedeemCode(event.target.value.toUpperCase())} placeholder="请输入兑换码" /><button onClick={() => void redeem()} disabled={busy}>{busy ? "处理中" : "立即激活"}</button></div><small>激活后的时长自动累计，不会覆盖现有会员时间。</small></article>
            <article className="panel-card invite-panel"><div className="panel-title"><h3>邀请备考搭子</h3><span>双方各得 {bootstrap?.inviteConfig.rewardDays ?? 3} 天</span></div><p>好友通过你的链接进入，并首次激活会员后，双方都会获得额外时长。</p><div className="invite-code"><span>我的邀请码</span><strong>{bootstrap?.user.inviteCode ?? "生成中"}</strong></div><button className="primary-button full-button" onClick={() => void copyInvite()}>复制专属邀请链接</button><div className="invite-stats"><span><b>{bootstrap?.inviteStats.total ?? 0}</b>已邀请</span><span><b>{bootstrap?.inviteStats.pending ?? 0}</b>待激活</span><span><b>{bootstrap?.inviteStats.rewarded ?? 0}</b>已奖励</span></div></article>
            <article className="panel-card ledger-card"><div className="panel-title"><h3>会员时长记录</h3><span>自动累计</span></div>{bootstrap?.ledger.length ? bootstrap.ledger.map((item, index) => <div className="ledger-row" key={item.created_at + "-" + index}><div><b>{item.note}</b><span>{new Date(item.created_at).toLocaleDateString("zh-CN")}</span></div><strong>+{item.delta_days}天</strong></div>) : <p className="muted">暂无时长变动记录</p>}</article>
          </div>}
        </>}

        <AudioHub active={!activeModule && tab === "audio"} tracks={bootstrap?.content.audioTracks ?? []} wrongQuestions={audioWrongQuestions} notify={notify} trackEvent={trackEvent} />

        {!activeModule && <nav className="bottom-nav" aria-label="主导航"><button className={tab === "today" ? "active" : ""} onClick={() => setTab("today")}><span>今</span>今日</button><button className={tab === "banks" ? "active" : ""} onClick={() => setTab("banks")}><span>库</span>题库</button><button className={tab === "review" ? "active" : ""} onClick={() => setTab("review")}><span>复</span>复习</button><button className={tab === "audio" ? "active" : ""} onClick={() => setTab("audio")}><span>听</span>听练</button><button className={tab === "me" || tab === "report" ? "active" : ""} onClick={() => setTab("me")}><span>我</span>我的</button></nav>}

        {onboardingOpen && bootstrap && (
          <div className="onboarding-backdrop" role="dialog" aria-modal="true" aria-label="设置备考目标">
            <section className="onboarding-card">
              <div className="onboarding-top">
                <span>支持同时备考</span>
                <h2>{profile.onboarded ? "调整你的多个报考目标" : "你准备参加哪些公务员考试？"}</h2>
                <p>国考和多个省考都可以同时选择；排在首位的是主攻考试，其他目标不会被删除。</p>
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
                  {provinces.map((province) => {
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
