"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PracticeDay, Question } from "./data/content";
import type { AudioTrack } from "./data/audio";
import AudioHub from "./AudioHub";

type Tab = "today" | "banks" | "audio" | "review" | "report" | "me";
type Module = "morning" | "practice" | "affairs" | "essay" | null;
type PracticeMode = "mixed" | "review";

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
};

type ExamProfile = {
  onboarded: boolean;
  examType: "国考" | "省考";
  province: string;
  examYear: number;
  examDate: string | null;
  dailyMinutes: number;
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
  added: boolean;
};

type StudyInsights = {
  total: number;
  accuracy: number;
  avgSeconds: number;
  dueCount: number;
  stateCounts: { learning: number; weak: number; mastered: number };
  modules: Array<{ module: string; total: number; accuracy: number; avgSeconds: number }>;
  recent: Array<{ day: string; total: number; accuracy: number }>;
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
};

type AnswerFeedback = {
  correct: boolean;
  correctAnswer: number;
  explanation: string;
  technique: string;
  state: "learning" | "weak" | "mastered";
  nextReviewAt: string;
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
};

const emptyInsights: StudyInsights = {
  total: 0,
  accuracy: 0,
  avgSeconds: 0,
  dueCount: 0,
  stateCounts: { learning: 0, weak: 0, mastered: 0 },
  modules: [],
  recent: [],
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
  essay: { expressions: [], prompt: "正在加载今日申论微练", reference: "" },
};

const provinces = ["北京", "上海", "广东", "江苏", "浙江", "山东", "河南", "河北", "湖北", "湖南", "四川", "重庆", "福建", "安徽", "江西", "陕西", "云南", "广西"];
const reasonOptions = ["知识点不会", "方法没想到", "计算失误", "审题错误", "时间不足", "蒙对了"];
const essayRubric = ["观点准确", "表达规范", "结构清晰", "语言简洁"];

function mergeProgress(input?: Partial<Progress>): Progress {
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
  };
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

function membershipText(user?: Bootstrap["user"], extended = false) {
  if (!user?.membershipActive) return "免费版";
  if (extended) return "会员有效";
  if (!user.membershipEnd) return "体验中";
  const days = Math.max(1, Math.ceil((Date.parse(user.membershipEnd) - Date.now()) / 86_400_000));
  return `体验剩${days}天`;
}

function findQuestion(id: string, practiceDays: PracticeDay[]) {
  return practiceDays.flatMap((item) => item.questions).find((question) => question.id === id);
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
  const [profileDraft, setProfileDraft] = useState<ExamProfile>({ onboarded: false, examType: "国考", province: "", examYear: new Date().getFullYear() + 1, examDate: null, dailyMinutes: 20 });
  const [bankFilter, setBankFilter] = useState("全部");
  const [practiceQuestions, setPracticeQuestions] = useState<PracticeQuestion[]>([]);
  const [practiceIndex, setPracticeIndex] = useState(0);
  const [practiceMode, setPracticeMode] = useState<PracticeMode>("mixed");
  const [selectedAnswer, setSelectedAnswer] = useState<number | null>(null);
  const [feedback, setFeedback] = useState<AnswerFeedback | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [questionSeconds, setQuestionSeconds] = useState(0);
  const [sessionAnswered, setSessionAnswered] = useState(0);
  const [sessionCorrect, setSessionCorrect] = useState(0);
  const [sessionWrongQuestions, setSessionWrongQuestions] = useState<Question[]>([]);
  const [practiceEmpty, setPracticeEmpty] = useState(false);
  const trackedUserRef = useRef("");

  const practiceDays = bootstrap?.content.practiceDays ?? [];
  const day = practiceDays.find((item) => item.day === progress.currentDay) ?? practiceDays[0] ?? loadingDay;
  const dayKey = `d${day.day}`;
  const insights = bootstrap?.studyInsights ?? emptyInsights;
  const profile = bootstrap?.examProfile ?? profileDraft;
  const targetDays = daysLeft(profile.examDate);
  const hasExtendedMembership = Boolean(bootstrap?.ledger.some((item) => item.source_type !== "trial"));
  const addedBanks = bootstrap?.questionBanks.filter((bank) => bank.added) ?? [];
  const baseTodayAttempts = insights.recent.find((item) => item.day === new Date().toISOString().slice(0, 10))?.total ?? 0;
  const practiceDone = baseTodayAttempts + sessionAnswered >= 10;
  const doneCount = [progress.completed[`${dayKey}-morning`], practiceDone, progress.completed[`${dayKey}-essay`]].filter(Boolean).length;
  const legacyWrongQuestions = progress.wrongIds.map((id) => findQuestion(id, practiceDays)).filter(Boolean) as Question[];
  const audioWrongQuestions = Array.from(new Map([...legacyWrongQuestions, ...sessionWrongQuestions].map((question) => [question.id, question])).values());
  const currentPractice = practiceQuestions[practiceIndex];

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
      setProgress(mergeProgress(data.progress));
      setProfileDraft(data.examProfile);
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
    if (activeModule !== "practice" || feedback) return;
    const timer = window.setInterval(() => setQuestionSeconds((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [activeModule, feedback, practiceIndex]);

  const persist = useCallback(async (next: Progress) => {
    setProgress(next);
    try { await api({ action: "saveProgress", progress: next }); }
    catch { notify("当前操作已保留，请稍后再试"); }
  }, [api, notify]);

  const complete = (key: string) => {
    const next = { ...progress, completed: { ...progress.completed, [key]: true } };
    const allDone = next.completed[`${dayKey}-morning`] && practiceDone && next.completed[`${dayKey}-essay`];
    if (allDone && !next.checkins.includes(dayKey)) next.checkins = [...next.checkins, dayKey];
    void persist(next);
    notify("完成已记录，继续保持");
  };

  const saveProfile = async () => {
    if (profileDraft.examType === "省考" && !profileDraft.province) return notify("请先选择目标省份");
    setBusy(true);
    try {
      const selectedBanks = bootstrap?.questionBanks.filter((bank) => bank.added).map((bank) => bank.code) ?? ["starter-gk"];
      await api({ action: "saveExamProfile", ...profileDraft, selectedBanks });
      trackEvent("profile_save", { examType: profileDraft.examType, province: profileDraft.province, dailyMinutes: profileDraft.dailyMinutes });
      setOnboardingOpen(false);
      notify("目标已保存，学习队列已为你准备好");
      await loadBootstrap();
    } catch (error) { notify(error instanceof Error ? error.message : "保存失败"); }
    finally { setBusy(false); }
  };

  const toggleBank = async (bank: QuestionBank) => {
    setBusy(true);
    try {
      const result = await api<{ banks: QuestionBank[] }>({ action: "toggleQuestionBank", bankCode: bank.code, added: !bank.added });
      setBootstrap((current) => current ? { ...current, questionBanks: result.banks } : current);
      trackEvent("bank_toggle", { bankCode: bank.code, added: !bank.added });
      notify(bank.added ? "已移出题库；至少会保留一本基础题库" : "已加入我的题库");
    } catch (error) { notify(error instanceof Error ? error.message : "题库操作失败"); }
    finally { setBusy(false); }
  };

  const startPractice = async (mode: PracticeMode = "mixed", bankCodes?: string[]) => {
    setBusy(true);
    setPracticeEmpty(false);
    try {
      const result = await api<{ questions: PracticeQuestion[] }>({ action: "getPracticeBatch", mode, limit: 10, bankCodes });
      if (!result.questions.length) {
        setPracticeEmpty(true);
        setTab(mode === "review" ? "review" : "banks");
        return notify(mode === "review" ? "当前没有到期或薄弱题，去练一组新题吧" : "这本题库暂时没有可练题目");
      }
      setPracticeQuestions(result.questions);
      setPracticeMode(mode);
      setPracticeIndex(0);
      setSelectedAnswer(null);
      setFeedback(null);
      setUncertain(false);
      setQuestionSeconds(0);
      setActiveModule("practice");
      trackEvent("practice_batch", { mode, count: result.questions.length });
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
      setSessionAnswered((value) => value + 1);
      if (result.correct) setSessionCorrect((value) => value + 1);
      else setSessionWrongQuestions((items) => [...items, {
        id: currentPractice.id,
        module: currentPractice.module,
        stem: currentPractice.stem,
        options: currentPractice.options,
        answer: result.correctAnswer,
        explanation: result.explanation,
        knowledge: currentPractice.knowledge,
      }]);
      trackEvent("practice_answer", { module: currentPractice.module, correct: result.correct, uncertain, seconds: questionSeconds });
    } catch (error) { setSelectedAnswer(null); notify(error instanceof Error ? error.message : "答案提交失败"); }
    finally { setBusy(false); }
  };

  const nextPracticeQuestion = () => {
    if (practiceIndex >= practiceQuestions.length - 1) return void startPractice(practiceMode);
    setPracticeIndex((value) => value + 1);
    setSelectedAnswer(null);
    setFeedback(null);
    setUncertain(false);
    setQuestionSeconds(0);
  };

  const updateQuestionMeta = async (values: { favorite?: boolean; wrongReason?: string }) => {
    if (!currentPractice) return;
    try {
      await api({ action: "updateQuestionMeta", questionCode: currentPractice.id, ...values });
      setPracticeQuestions((items) => items.map((item, index) => index === practiceIndex ? { ...item, ...values } : item));
      notify(values.favorite !== undefined ? values.favorite ? "已收藏这道题" : "已取消收藏" : "错因已记录");
    } catch (error) { notify(error instanceof Error ? error.message : "保存失败"); }
  };

  const toggleFavoritePhrase = (phrase: string) => {
    const favorites = progress.favorites.includes(phrase) ? progress.favorites.filter((item) => item !== phrase) : [...progress.favorites, phrase];
    void persist({ ...progress, favorites });
  };

  const toggleEssayCheck = (item: string) => {
    const current = progress.essayChecks[dayKey] ?? [];
    const nextChecks = current.includes(item) ? current.filter((value) => value !== item) : [...current, item];
    void persist({ ...progress, essayChecks: { ...progress.essayChecks, [dayKey]: nextChecks } });
  };

  const submitEssay = () => {
    if ((progress.essayDrafts[dayKey] ?? "").trim().length < 10) return notify("先完成至少10个字的改写");
    if ((progress.essayChecks[dayKey] ?? []).length < 2) return notify("请按标准完成至少两项自评");
    complete(`${dayKey}-essay`);
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

  const renderPractice = () => {
    if (!currentPractice) return <div className="empty-state"><span>练</span><h3>正在准备题目</h3></div>;
    const finished = feedback && practiceIndex === practiceQuestions.length - 1;
    return (
      <div className="smart-practice">
        <div className="practice-overview">
          <div><span>{practiceMode === "review" ? "到期复习" : currentPractice.due ? "今日到期" : currentPractice.state === "new" ? "今日新题" : "巩固练习"}</span><b>{currentPractice.bankName}</b></div>
          <div><strong>{practiceIndex + 1}</strong> / {practiceQuestions.length}<small>{questionSeconds}s{sessionAnswered ? ` · 本轮${Math.round((sessionCorrect / sessionAnswered) * 100)}%` : ""}</small></div>
        </div>
        <div className="practice-progress"><i style={{ width: `${((practiceIndex + (feedback ? 1 : 0)) / practiceQuestions.length) * 100}%` }} /></div>
        <article className="question-card smart-question-card">
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
            <div><strong>{feedback.correct ? "回答正确" : `正确答案 ${String.fromCharCode(65 + feedback.correctAnswer)}`}</strong><span>{feedback.state === "mastered" ? "已掌握 · 7天后巩固" : feedback.state === "weak" ? "薄弱题 · 明天回炉" : "学习中 · 3天后复习"}</span></div>
            <p>{feedback.explanation}</p>
            {feedback.technique && <aside><b>解题提示</b>{feedback.technique}</aside>}
            <footer><span>{currentPractice.source}</span><button onClick={() => void updateQuestionMeta({ favorite: !currentPractice.favorite })}>{currentPractice.favorite ? "★ 已收藏" : "☆ 收藏"}</button></footer>
          </div>}
        </article>
        {feedback && !feedback.correct && <div className="wrong-reason-box"><span>这次为什么错？</span><div>{reasonOptions.map((reason) => <button key={reason} className={currentPractice.wrongReason === reason ? "active" : ""} onClick={() => void updateQuestionMeta({ wrongReason: reason })}>{reason}</button>)}</div></div>}
        {feedback && <button className="primary-button full-button practice-next" onClick={nextPracticeQuestion}>{finished ? "继续刷10题" : "下一题"}</button>}
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
          <span className="day-pill">{activeModule === "practice" ? "自动保存" : "约5分钟"}</span>
        </header>

        {activeModule === "practice" && renderPractice()}

        {activeModule === "morning" && <div className="reading-card enhanced-reading">
          <div className="reading-steps"><span className="active">1 阅读</span><span>2 记表达</span><span>3 尝试复述</span></div>
          <span className="content-tag">今日晨读</span><h3>{day.morning.title}</h3><p className="lead">{day.morning.lead}</p>
          {day.morning.paragraphs.map((paragraph) => <p key={paragraph}>{hideKeywords ? day.morning.keywords.reduce((text, keyword) => text.replaceAll(keyword, "____"), paragraph) : paragraph}</p>)}
          <div className="keyword-training"><div><b>今天记住这3个表达</b><button onClick={() => setHideKeywords((value) => !value)}>{hideKeywords ? "显示关键词" : "挖空自测"}</button></div><div className="keyword-row">{day.morning.keywords.map((keyword) => <span key={keyword}>{hideKeywords ? "____" : keyword}</span>)}</div></div>
          <div className="button-row"><button className="secondary-button" onClick={speakMorning}>▶ 逐段朗读</button><button className="primary-button" onClick={() => complete(`${dayKey}-morning`)}>{progress.completed[`${dayKey}-morning`] ? "✓ 已完成" : "我能复述要点"}</button></div>
        </div>}

        {activeModule === "affairs" && <div className="affairs-grid">{day.currentAffairs.map((item, index) => <article className="affair-card" key={item.title}><div><span>{String(index + 1).padStart(2, "0")}</span><em>{item.tag}</em></div><h3>{item.title}</h3><p>{item.detail}</p></article>)}</div>}

        {activeModule === "essay" && <div className="essay-wrap">
          <div className="expression-list">{day.essay.expressions.map((item) => <article className="expression-card" key={item.phrase}><span>{item.scene}</span><p>{item.phrase}</p><button onClick={() => toggleFavoritePhrase(item.phrase)}>{progress.favorites.includes(item.phrase) ? "★ 已收藏" : "☆ 收藏"}</button></article>)}</div>
          <article className="writing-card"><span className="content-tag">今日微练</span><h3>{day.essay.prompt}</h3>
            <textarea value={progress.essayDrafts[dayKey] ?? ""} onChange={(event) => void persist({ ...progress, essayDrafts: { ...progress.essayDrafts, [dayKey]: event.target.value } })} placeholder="先独立改写，再和参考表达比较……" maxLength={120} />
            <div className="writing-meta"><span>{(progress.essayDrafts[dayKey] ?? "").length} / 120</span><button onClick={() => setEssayReference((value) => !value)}>{essayReference ? "收起参考" : "对比参考表达"}</button></div>
            {essayReference && <div className="reference-answer"><b>参考表达</b><p>{day.essay.reference}</p><small>不要逐字照抄，重点观察动词、逻辑和闭环表达。</small></div>}
            <div className="essay-rubric"><span>按标准自评（至少选择2项）</span><div>{essayRubric.map((item) => <button key={item} className={(progress.essayChecks[dayKey] ?? []).includes(item) ? "active" : ""} onClick={() => toggleEssayCheck(item)}>{(progress.essayChecks[dayKey] ?? []).includes(item) ? "✓ " : ""}{item}</button>)}</div></div>
            <button className="primary-button full-button" onClick={submitEssay}>{progress.completed[`${dayKey}-essay`] ? "✓ 已完成微练" : "完成自评并提交"}</button>
          </article>
        </div>}
      </section>
    );
  };

  const filteredBanks = useMemo(() => {
    const banks = bootstrap?.questionBanks ?? [];
    if (bankFilter === "我的") return banks.filter((bank) => bank.added);
    if (bankFilter === "国考") return banks.filter((bank) => bank.examType === "国考" || bank.examType === "通用");
    if (bankFilter === "省考") return banks.filter((bank) => bank.examType === "省考" || bank.examType === "通用");
    if (bankFilter === "申论") return banks.filter((bank) => bank.subject === "申论");
    return banks;
  }, [bankFilter, bootstrap?.questionBanks]);

  const weakestModule = insights.modules.length ? [...insights.modules].sort((a, b) => a.accuracy - b.accuracy)[0] : null;

  return (
    <main className="app-shell">
      <div className="app-frame">
        <header className="topbar"><div className="brand-mark">公</div><div className="brand-copy"><strong>公考日练</strong><span>每天20分钟，稳住做题手感</span></div><button className="member-chip" onClick={() => setTab("me")}>{membershipText(bootstrap?.user, hasExtendedMembership)}</button></header>

        {activeModule ? renderModule() : <>
          {tab === "today" && <div className="page-content">
            <section className="goal-strip"><div><span>{profile.examType === "省考" ? `${profile.province}省考` : "国家公务员考试"} · {profile.examYear}</span><b>{targetDays === null ? "设置考试日期，开启倒计时" : `距离考试还有 ${targetDays} 天`}</b></div><button onClick={() => { setProfileDraft(profile); setOnboardingOpen(true); }}>调整目标</button></section>
            <section className="hero-card learning-hero"><div className="hero-top"><span>今日学习队列</span><span>{new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "short" }).format(new Date())}</span></div><div className="hero-main"><div><p>今日待复习</p><h1>{insights.dueCount}<small> 题</small></h1><span>{addedBanks.length} 本题库已加入 · 自动安排新题与薄弱题</span></div><div className="progress-ring" style={{ "--progress": `${doneCount * 120}deg` } as React.CSSProperties}><strong>{doneCount}/3</strong><span>今日动作</span></div></div><button className="hero-action" disabled={busy} onClick={() => void startPractice("mixed")}>开始智能练习 <span>复习＋薄弱＋新题</span></button></section>

            {bootstrap?.content.access === "preview" && <section className="access-card"><div><span>当前为免费版</span><h3>每天可练5题，完整体验学习闭环</h3><p>激活后解锁不限题库、完整解析和全部音频。</p></div><button onClick={() => setTab("me")}>去激活</button></section>}

            <section className="today-plan"><div className="section-heading"><div><span>今日安排</span><h2>完成三个有效学习动作</h2></div><em>{doneCount === 3 ? "今日已完成" : `还剩 ${3 - doneCount} 项`}</em></div>
              <button className="plan-item" onClick={() => setActiveModule("morning")}><span className="plan-icon blue">读</span><div><b>晨读：记住3个规范表达</b><p>{day.morning.title}</p></div><i>{progress.completed[`${dayKey}-morning`] ? "✓" : "5分钟"}</i></button>
              <button className="plan-item featured-plan" onClick={() => void startPractice("mixed")}><span className="plan-icon orange">练</span><div><b>智能刷题10道</b><p>到期复习优先，自动补充薄弱题和新题</p></div><i>{practiceDone ? "✓" : "10分钟"}</i></button>
              <button className="plan-item" onClick={() => setActiveModule("essay")}><span className="plan-icon green">写</span><div><b>申论表达微练</b><p>独立改写＋参考对比＋四维自评</p></div><i>{progress.completed[`${dayKey}-essay`] ? "✓" : "5分钟"}</i></button>
            </section>

            <section className="my-banks-preview"><div className="section-heading"><div><span>我的题库</span><h2>按目标持续刷，不再到处找题</h2></div><button onClick={() => setTab("banks")}>管理题库</button></div><div className="mini-bank-row">{addedBanks.slice(0, 2).map((bank) => <button key={bank.code} onClick={() => void startPractice("mixed", [bank.code])}><span>{bank.subject}</span><div><b>{bank.name}</b><small>已练 {bank.studiedCount}/{bank.questionCount} · 掌握 {bank.masteredCount}</small></div><i>开始</i></button>)}</div></section>

            <section className="tool-section"><div className="section-heading"><div><span>随时巩固</span><h2>不浪费碎片时间</h2></div></div><div className="tool-grid refreshed-tools"><button className="audio-tool" onClick={() => setTab("audio")}><span>听</span><b>日练电台</b><small>通勤听时政与申论</small></button><button onClick={() => setTab("review")}><span>复</span><b>到期回炉</b><small>{insights.dueCount} 道今天该复习</small></button><button onClick={() => setTab("report")}><span>报</span><b>提分诊断</b><small>{weakestModule ? `${weakestModule.module}需加强` : "完成练习后生成"}</small></button></div></section>
          </div>}

          {tab === "banks" && <div className="page-content subpage"><div className="subpage-heading bank-heading"><div><span>题库中心</span><h1>选择你的考试题库</h1><p>像添加词书一样添加国考或省考题库，学习进度相互独立。</p></div><strong>{addedBanks.length} 本已添加</strong></div><div className="bank-filters">{["全部", "我的", "国考", "省考", "申论"].map((item) => <button key={item} className={bankFilter === item ? "active" : ""} onClick={() => setBankFilter(item)}>{item}</button>)}</div><section className="bank-list">{filteredBanks.map((bank) => { const percent = bank.questionCount ? Math.round((bank.studiedCount / bank.questionCount) * 100) : 0; return <article className={`bank-card bank-${bank.coverColor}`} key={bank.code}><div className="bank-cover"><span>{bank.examType}</span><b>{bank.subject}</b><small>{bank.province}</small></div><div className="bank-copy"><div><span>{bank.examYear ? `${bank.examYear}年` : "持续更新"} · {bank.questionCount}题</span><h3>{bank.name}</h3><p>{bank.description}</p></div><div className="bank-progress"><div><i style={{ width: `${percent}%` }} /></div><span>{percent}%</span></div><footer><small>已掌握 {bank.masteredCount} 题</small><div><button disabled={busy} className={bank.added ? "remove" : ""} onClick={() => void toggleBank(bank)}>{bank.added ? "已添加" : "+ 添加"}</button>{bank.added && <button className="start-bank" onClick={() => void startPractice("mixed", [bank.code])}>开始练</button>}</div></footer></div></article>; })}</section>{filteredBanks.length === 0 && <div className="empty-state compact"><span>库</span><h3>对应题库正在整理</h3><p>你在后台发布的新题库会自动显示在这里。</p></div>}</div>}

          {tab === "review" && <div className="page-content subpage"><div className="subpage-heading"><span>智能复习</span><h1>不是重看答案，而是再次做对</h1><p>系统按1、3、7天节奏安排错题、蒙对题和到期题。</p></div><section className="review-hero"><div><span>今日到期</span><h2>{insights.dueCount}<small> 道</small></h2><p>薄弱 {insights.stateCounts.weak} · 学习中 {insights.stateCounts.learning} · 已掌握 {insights.stateCounts.mastered}</p></div><button disabled={busy} onClick={() => void startPractice("review")}>开始回炉</button></section><div className="review-rules"><article><span>1天</span><div><b>错题与蒙对题</b><p>趁记忆还新鲜，先把错因说明白。</p></div></article><article><span>3天</span><div><b>学习中题目</b><p>再次做对，才能进入长期记忆。</p></div></article><article><span>7天</span><div><b>已掌握题目</b><p>低频抽查，防止“会过又忘”。</p></div></article></div>{practiceEmpty && <div className="empty-state compact"><span>✓</span><h3>今天没有到期题</h3><p>可以去题库继续学习新题。</p><button className="primary-button" onClick={() => setTab("banks")}>去题库</button></div>}</div>}

          {tab === "report" && <div className="page-content subpage"><div className="subpage-heading"><span>学习诊断</span><h1>告诉你下一步练什么</h1><p>数量只是记录，薄弱项和速度才决定提分方向。</p></div><div className="stats-grid report-stats"><article><span>累计答题</span><strong>{insights.total}</strong><small>题</small></article><article><span>正确率</span><strong>{insights.accuracy}</strong><small>%</small></article><article><span>平均用时</span><strong>{insights.avgSeconds}</strong><small>秒</small></article><article><span>今日到期</span><strong>{insights.dueCount}</strong><small>题</small></article></div><article className="report-card mastery-card"><div className="report-title"><h3>掌握状态</h3><span>{insights.stateCounts.mastered}题已掌握</span></div><div className="mastery-segments"><i className="mastered" style={{ flex: insights.stateCounts.mastered || 0.01 }} /><i className="learning" style={{ flex: insights.stateCounts.learning || 0.01 }} /><i className="weak" style={{ flex: insights.stateCounts.weak || 0.01 }} /></div><div className="mastery-legend"><span><i className="mastered" />已掌握 {insights.stateCounts.mastered}</span><span><i className="learning" />学习中 {insights.stateCounts.learning}</span><span><i className="weak" />薄弱 {insights.stateCounts.weak}</span></div></article><article className="report-card"><div className="report-title"><h3>模块正确率与速度</h3><span>最近累计</span></div>{insights.modules.length ? insights.modules.map((item) => <div className="module-row" key={item.module}><div><b>{item.module}</b><small>{item.total}题 · 平均{item.avgSeconds}秒</small></div><div><i style={{ width: `${item.accuracy}%` }} /></div><strong>{item.accuracy}%</strong></div>) : <p className="muted">完成第一组智能练习后，这里会生成模块诊断。</p>}</article><article className="report-card suggestion"><span>下一步建议</span><h3>{weakestModule ? `优先练习${weakestModule.module}` : "先完成第一组智能练习"}</h3><p>{weakestModule ? `当前正确率 ${weakestModule.accuracy}%，建议先做10题专项，并复习今天到期的薄弱题。` : "完成后系统会分析正确率、速度和掌握状态。"}</p>{weakestModule && <button className="secondary-button" onClick={() => void startPractice("mixed")}>按建议开始练习</button>}</article></div>}

          {tab === "me" && <div className="page-content subpage"><div className="profile-card"><div className="profile-avatar">练</div><div><span>{bootstrap?.user.displayName ?? "公考日练用户"}</span><h2>{profile.examType === "省考" ? `${profile.province}省考` : "国考"}备考中</h2><p>{profile.examYear}年 · 每天{profile.dailyMinutes}分钟</p></div><button className="profile-edit" onClick={() => { setProfileDraft(profile); setOnboardingOpen(true); }}>修改</button></div><article className={`panel-card account-panel ${bootstrap?.user.signedIn ? "synced" : ""}`}><div><span>{bootstrap?.user.signedIn ? "账号同步已开启" : "当前仅保存在本设备"}</span><h3>{bootstrap?.user.signedIn ? "换设备也能继续学习" : "登录后同步学习记录"}</h3><p>{bootstrap?.user.signedIn ? "题库、掌握状态和会员时长均已同步。" : "登录时会自动合并当前进度。"}</p></div>{bootstrap?.user.signedIn ? <b>✓ 已同步</b> : <a href="/signin-with-chatgpt?return_to=%2F">登录并同步</a>}</article><article className="membership-card"><div><span>会员有效期</span><h3>{formatDate(bootstrap?.user.membershipEnd ?? null)}</h3><p>{bootstrap?.user.membershipActive ? "题库、解析、电台全部解锁" : "激活后解锁长期使用"}</p></div><b>VIP</b></article><article className="panel-card"><div className="panel-title"><h3>兑换码激活</h3><span>支持 7 / 30 / 365 天</span></div><div className="redeem-row"><input value={redeemCode} onChange={(event) => setRedeemCode(event.target.value.toUpperCase())} placeholder="请输入兑换码" /><button onClick={() => void redeem()} disabled={busy}>{busy ? "处理中" : "立即激活"}</button></div><small>激活后的时长自动累计，不会覆盖现有会员时间。</small></article><article className="panel-card invite-panel"><div className="panel-title"><h3>邀请备考搭子</h3><span>双方各得 {bootstrap?.inviteConfig.rewardDays ?? 3} 天</span></div><p>好友通过你的链接进入，并首次激活会员后，双方都会获得额外时长。</p><div className="invite-code"><span>我的邀请码</span><strong>{bootstrap?.user.inviteCode ?? "生成中"}</strong></div><button className="primary-button full-button" onClick={() => void copyInvite()}>复制专属邀请链接</button><div className="invite-stats"><span><b>{bootstrap?.inviteStats.total ?? 0}</b>已邀请</span><span><b>{bootstrap?.inviteStats.pending ?? 0}</b>待激活</span><span><b>{bootstrap?.inviteStats.rewarded ?? 0}</b>已奖励</span></div></article><article className="panel-card ledger-card"><div className="panel-title"><h3>会员时长记录</h3><span>自动累计</span></div>{bootstrap?.ledger.length ? bootstrap.ledger.map((item, index) => <div className="ledger-row" key={`${item.created_at}-${index}`}><div><b>{item.note}</b><span>{new Date(item.created_at).toLocaleDateString("zh-CN")}</span></div><strong>+{item.delta_days}天</strong></div>) : <p className="muted">暂无时长变动记录</p>}</article></div>}
        </>}

        <AudioHub active={!activeModule && tab === "audio"} tracks={bootstrap?.content.audioTracks ?? []} wrongQuestions={audioWrongQuestions} notify={notify} trackEvent={trackEvent} />

        {!activeModule && <nav className="bottom-nav" aria-label="主导航"><button className={tab === "today" ? "active" : ""} onClick={() => setTab("today")}><span>今</span>今日</button><button className={tab === "banks" ? "active" : ""} onClick={() => setTab("banks")}><span>库</span>题库</button><button className={tab === "audio" ? "active" : ""} onClick={() => setTab("audio")}><span>听</span>听练</button><button className={tab === "report" || tab === "review" ? "active" : ""} onClick={() => setTab("report")}><span>报</span>报告</button><button className={tab === "me" ? "active" : ""} onClick={() => setTab("me")}><span>我</span>我的</button></nav>}

        {onboardingOpen && bootstrap && <div className="onboarding-backdrop" role="dialog" aria-modal="true" aria-label="设置备考目标"><section className="onboarding-card"><div className="onboarding-top"><span>只需30秒</span><h2>{profile.onboarded ? "调整你的备考目标" : "先告诉我，你在准备哪场考试？"}</h2><p>系统会据此筛选题库、计算倒计时并安排每日题量。</p></div><div className="choice-group"><label>考试类型</label><div className="segmented-choice"><button className={profileDraft.examType === "国考" ? "active" : ""} onClick={() => setProfileDraft({ ...profileDraft, examType: "国考", province: "" })}>国考</button><button className={profileDraft.examType === "省考" ? "active" : ""} onClick={() => setProfileDraft({ ...profileDraft, examType: "省考" })}>省考</button></div></div>{profileDraft.examType === "省考" && <div className="choice-group"><label>目标省份</label><select value={profileDraft.province} onChange={(event) => setProfileDraft({ ...profileDraft, province: event.target.value })}><option value="">请选择省份</option>{provinces.map((province) => <option key={province}>{province}</option>)}</select></div>}<div className="onboarding-grid"><div className="choice-group"><label>考试年份</label><select value={profileDraft.examYear} onChange={(event) => setProfileDraft({ ...profileDraft, examYear: Number(event.target.value) })}>{[new Date().getFullYear(), new Date().getFullYear() + 1, new Date().getFullYear() + 2].map((year) => <option key={year}>{year}</option>)}</select></div><div className="choice-group"><label>考试日期（可选）</label><input type="date" value={profileDraft.examDate ?? ""} onChange={(event) => setProfileDraft({ ...profileDraft, examDate: event.target.value || null })} /></div></div><div className="choice-group"><label>每天计划学习</label><div className="minute-choice">{[10, 20, 30, 45, 60].map((minutes) => <button key={minutes} className={profileDraft.dailyMinutes === minutes ? "active" : ""} onClick={() => setProfileDraft({ ...profileDraft, dailyMinutes: minutes })}>{minutes}分钟</button>)}</div></div><button className="primary-button full-button onboarding-submit" disabled={busy} onClick={() => void saveProfile()}>{busy ? "正在生成学习计划…" : "保存并开始日练"}</button>{profile.onboarded && <button className="onboarding-cancel" onClick={() => setOnboardingOpen(false)}>取消修改</button>}</section></div>}
        {toast && <div className="toast" role="status">{toast}</div>}
      </div>
    </main>
  );
}
