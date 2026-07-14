"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PracticeDay, Question } from "./data/content";
import type { AudioTrack } from "./data/audio";
import AudioHub from "./AudioHub";

type Tab = "today" | "audio" | "wrong" | "report" | "me";
type Module = "morning" | "quiz" | "affairs" | "essay" | null;

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
  checkins: string[];
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
  checkins: [],
};

const reasonOptions = ["知识点不会", "方法没想到", "计算失误", "审题错误", "时间不足", "蒙对了"];

const loadingQuestion: Question = {
  id: "loading",
  module: "加载中",
  stem: "正在准备今日练习……",
  options: ["请稍候"],
  answer: 0,
  explanation: "",
  knowledge: "",
};

const loadingDay: PracticeDay = {
  day: 1,
  label: "今日练习",
  morning: { title: "正在加载今日晨读", lead: "", paragraphs: [], keywords: [] },
  questions: [loadingQuestion],
  currentAffairs: [],
  essay: { expressions: [], prompt: "正在加载今日申论微练", reference: "" },
};

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
    checkins: Array.isArray(input?.checkins) ? input.checkins : [],
  };
}

function formatDate(value: string | null) {
  if (!value) return "体验用户";
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
}

function findQuestion(id: string, practiceDays: PracticeDay[]) {
  return practiceDays.flatMap((day) => day.questions).find((question) => question.id === id);
}

export default function DailyPracticeApp() {
  const [tab, setTab] = useState<Tab>("today");
  const [activeModule, setActiveModule] = useState<Module>(null);
  const [progress, setProgress] = useState<Progress>(emptyProgress);
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [questionIndex, setQuestionIndex] = useState(0);
  const [redeemCode, setRedeemCode] = useState("");
  const [essayReference, setEssayReference] = useState(false);
  const [toast, setToast] = useState("");
  const [busy, setBusy] = useState(false);
  const trackedUserRef = useRef("");
  const paywallTrackedRef = useRef(false);

  const practiceDays = bootstrap?.content.practiceDays ?? [];
  const day = practiceDays.find((item) => item.day === progress.currentDay) ?? practiceDays[0] ?? loadingDay;
  const currentQuestion = day.questions[questionIndex] ?? loadingQuestion;
  const dayKey = `d${day.day}`;
  const doneCount = [
    progress.completed[`${dayKey}-morning`],
    progress.submittedDays[dayKey],
    progress.completed[`${dayKey}-essay`],
  ].filter(Boolean).length;
  const wrongQuestions = progress.wrongIds.map((id) => findQuestion(id, practiceDays)).filter(Boolean) as Question[];
  const hasExtendedMembership = Boolean(bootstrap?.ledger.some((item) => item.source_type !== "trial"));
  const membershipLabel = bootstrap?.user.membershipActive
    ? hasExtendedMembership ? "会员有效" : "体验中"
    : "免费版";

  const notify = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2600);
  }, []);

  const trackEvent = useCallback((eventName: string, eventData: Record<string, unknown> = {}) => {
    void fetch("/api/app", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "trackEvent", eventName, eventData }),
      keepalive: true,
    }).catch(() => undefined);
  }, []);

  const loadBootstrap = useCallback(async () => {
    try {
      const response = await fetch("/api/app", { cache: "no-store" });
      const data = (await response.json()) as Bootstrap & { error?: string };
      if (!response.ok) throw new Error(data.error || "加载失败");
      setBootstrap(data);
      const merged = mergeProgress(data.progress);
      if (!data.content.practiceDays.some((item) => item.day === merged.currentDay)) merged.currentDay = data.content.practiceDays[0]?.day ?? 1;
      setProgress(merged);
      const inviteCode = new URLSearchParams(window.location.search).get("invite");
      if (inviteCode) {
        const inviteResponse = await fetch("/api/app", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "bindInvite", inviteCode }),
        });
        const inviteResult = (await inviteResponse.json()) as { message?: string; error?: string };
        notify(inviteResult.message || inviteResult.error || "邀请关系已处理");
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : "学习记录暂时无法加载");
    }
  }, [notify]);

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
    if (bootstrap?.content.access !== "preview" || paywallTrackedRef.current) return;
    paywallTrackedRef.current = true;
    trackEvent("paywall_view", { placement: "today" });
  }, [bootstrap?.content.access, trackEvent]);

  const persist = useCallback(async (next: Progress) => {
    setProgress(next);
    try {
      await fetch("/api/app", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "saveProgress", progress: next }),
      });
    } catch {
      notify("已保留当前操作，网络恢复后请再试");
    }
  }, [notify]);

  const switchDay = (nextDay: number) => {
    const next = { ...progress, currentDay: nextDay };
    setQuestionIndex(0);
    setEssayReference(false);
    void persist(next);
  };

  const openModule = (module: Exclude<Module, null>) => {
    setActiveModule(module);
    trackEvent("module_open", { module, day: day.day, access: bootstrap?.content.access ?? "loading" });
  };

  const addCheckinWhenDayIsComplete = (next: Progress, key: string) => {
    const allDone = next.completed[`${key}-morning`] && next.submittedDays[key] && next.completed[`${key}-essay`];
    return allDone && !next.checkins.includes(key)
      ? { ...next, checkins: [...next.checkins, key] }
      : next;
  };

  const complete = (key: string) => {
    const next = addCheckinWhenDayIsComplete(
      { ...progress, completed: { ...progress.completed, [key]: true } },
      dayKey,
    );
    void persist(next);
    notify("完成已记录，继续保持");
  };

  const chooseAnswer = (answer: number) => {
    if (progress.submittedDays[dayKey]) return;
    void persist({ ...progress, answers: { ...progress.answers, [currentQuestion.id]: answer } });
  };

  const submitQuiz = () => {
    const unanswered = day.questions.filter((question) => progress.answers[question.id] === undefined);
    if (unanswered.length) {
      notify(`还有 ${unanswered.length} 道题未作答`);
      return;
    }
    const wrong = day.questions.filter((question) => progress.answers[question.id] !== question.answer).map((question) => question.id);
    const nextWrong = Array.from(new Set([...progress.wrongIds, ...wrong]));
    const next = addCheckinWhenDayIsComplete({
      ...progress,
      submittedDays: { ...progress.submittedDays, [dayKey]: true },
      wrongIds: nextWrong,
    }, dayKey);
    void persist(next);
    trackEvent("quiz_submit", { day: day.day, correct: day.questions.length - wrong.length, total: day.questions.length });
    notify(`提交成功，本次答对 ${day.questions.length - wrong.length} 题`);
  };

  const speakMorning = () => {
    if (!("speechSynthesis" in window)) {
      notify("当前浏览器暂不支持语音朗读");
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance([day.morning.title, day.morning.lead, ...day.morning.paragraphs].join("。"));
    utterance.lang = "zh-CN";
    utterance.rate = 0.92;
    window.speechSynthesis.speak(utterance);
    notify("开始朗读，离开页面前可再次点击停止");
  };

  const toggleFavorite = (phrase: string) => {
    const exists = progress.favorites.includes(phrase);
    const favorites = exists ? progress.favorites.filter((item) => item !== phrase) : [...progress.favorites, phrase];
    void persist({ ...progress, favorites });
  };

  const redeem = async () => {
    if (!redeemCode.trim()) return notify("请输入兑换码");
    setBusy(true);
    try {
      const response = await fetch("/api/app", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "redeem", code: redeemCode }),
      });
      const result = (await response.json()) as { error?: string; days?: number };
      if (!response.ok) throw new Error(result.error || "兑换失败");
      setRedeemCode("");
      trackEvent("redeem_success", { days: result.days ?? 0 });
      notify(`激活成功，会员时长增加 ${result.days} 天`);
      await loadBootstrap();
    } catch (error) {
      notify(error instanceof Error ? error.message : "兑换失败");
    } finally {
      setBusy(false);
    }
  };

  const copyInvite = async () => {
    if (!bootstrap?.user.inviteCode) return notify("邀请码正在生成，请稍后");
    const url = `${window.location.origin}/?invite=${bootstrap.user.inviteCode}`;
    try {
      await navigator.clipboard.writeText(url);
      trackEvent("invite_copy");
      notify("邀请链接已复制，好友激活后双方加时长");
    } catch {
      notify(url);
    }
  };

  const reviewed = (id: string) => {
    const reviewedIds = progress.reviewedIds.includes(id) ? progress.reviewedIds : [...progress.reviewedIds, id];
    void persist({ ...progress, reviewedIds });
    notify("已标记复习，下次会继续回炉");
  };

  const renderModule = () => {
    if (!activeModule) return null;
    return (
      <section className="module-page" aria-label="学习模块">
        <header className="module-header">
          <button className="icon-button" onClick={() => setActiveModule(null)} aria-label="返回首页">‹</button>
          <div>
            <span className="eyebrow">第 {day.day} 天 · {day.label}</span>
            <h2>{activeModule === "morning" ? "每日晨读" : activeModule === "quiz" ? "行测小题" : activeModule === "affairs" ? "时政常识" : "申论表达"}</h2>
          </div>
          <span className="day-pill">约 {activeModule === "quiz" ? 10 : 5} 分钟</span>
        </header>

        {activeModule === "morning" && (
          <div className="reading-card">
            <span className="content-tag">今日晨读</span>
            <h3>{day.morning.title}</h3>
            <p className="lead">{day.morning.lead}</p>
            {day.morning.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
            <div className="keyword-row">{day.morning.keywords.map((keyword) => <span key={keyword}>{keyword}</span>)}</div>
            <div className="button-row">
              <button className="secondary-button" onClick={speakMorning}>▶ 音频朗读</button>
              <button className="primary-button" onClick={() => complete(`${dayKey}-morning`)}>{progress.completed[`${dayKey}-morning`] ? "✓ 已完成" : "完成晨读"}</button>
            </div>
          </div>
        )}

        {activeModule === "quiz" && (
          <div className="quiz-wrap">
            <div className="question-progress">
              <span>{currentQuestion.module}</span>
              <strong>{questionIndex + 1} / {day.questions.length}</strong>
            </div>
            <article className="question-card">
              <p className="question-knowledge">{currentQuestion.knowledge}</p>
              <h3>{currentQuestion.stem}</h3>
              <div className="options-list">
                {currentQuestion.options.map((option, index) => {
                  const selected = progress.answers[currentQuestion.id] === index;
                  const submitted = progress.submittedDays[dayKey];
                  const stateClass = submitted && index === currentQuestion.answer ? " correct" : submitted && selected ? " wrong" : selected ? " selected" : "";
                  return <button key={option} className={`option${stateClass}`} onClick={() => chooseAnswer(index)}><b>{String.fromCharCode(65 + index)}</b><span>{option}</span></button>;
                })}
              </div>
              {progress.submittedDays[dayKey] && <div className="explanation"><b>解析</b><p>{currentQuestion.explanation}</p></div>}
            </article>
            <div className="quiz-actions">
              <button className="secondary-button" disabled={questionIndex === 0} onClick={() => setQuestionIndex((value) => value - 1)}>上一题</button>
              {questionIndex < day.questions.length - 1 ? <button className="primary-button" onClick={() => setQuestionIndex((value) => value + 1)}>下一题</button> : <button className="primary-button" onClick={submitQuiz}>{progress.submittedDays[dayKey] ? "已提交" : "交卷查看结果"}</button>}
            </div>
          </div>
        )}

        {activeModule === "affairs" && (
          <div className="affairs-grid">
            {day.currentAffairs.map((item, index) => <article className="affair-card" key={item.title}><div><span>{String(index + 1).padStart(2, "0")}</span><em>{item.tag}</em></div><h3>{item.title}</h3><p>{item.detail}</p></article>)}
            <button className="primary-button full-button" onClick={() => complete(`${dayKey}-affairs`)}>{progress.completed[`${dayKey}-affairs`] ? "✓ 今日卡片已读" : "完成今日时政卡"}</button>
          </div>
        )}

        {activeModule === "essay" && (
          <div className="essay-wrap">
            <div className="expression-list">
              {day.essay.expressions.map((item) => <article className="expression-card" key={item.phrase}><span>{item.scene}</span><p>{item.phrase}</p><button onClick={() => toggleFavorite(item.phrase)}>{progress.favorites.includes(item.phrase) ? "★ 已收藏" : "☆ 收藏"}</button></article>)}
            </div>
            <article className="writing-card">
              <span className="content-tag">今日微练</span>
              <h3>{day.essay.prompt}</h3>
              <textarea value={progress.essayDrafts[dayKey] ?? ""} onChange={(event) => void persist({ ...progress, essayDrafts: { ...progress.essayDrafts, [dayKey]: event.target.value } })} placeholder="在这里写下你的答案……" maxLength={120} />
              <div className="writing-meta"><span>{(progress.essayDrafts[dayKey] ?? "").length} / 120</span><button onClick={() => setEssayReference((value) => !value)}>{essayReference ? "收起参考" : "查看参考"}</button></div>
              {essayReference && <div className="reference-answer">{day.essay.reference}</div>}
              <button className="primary-button full-button" onClick={() => complete(`${dayKey}-essay`)}>{progress.completed[`${dayKey}-essay`] ? "✓ 已完成微练" : "提交今日微练"}</button>
            </article>
          </div>
        )}
      </section>
    );
  };

  return (
    <main className="app-shell">
      <div className="app-frame">
        <header className="topbar">
          <div className="brand-mark">公</div>
          <div className="brand-copy"><strong>公考日练</strong><span>每天进步一点点</span></div>
          <button className="member-chip" onClick={() => {
            setTab("me");
            if (bootstrap?.content.access === "preview") trackEvent("paywall_action", { placement: "topbar" });
          }}>{membershipLabel}</button>
        </header>

        {activeModule ? renderModule() : (
          <>
            {tab === "today" && (
              <div className="page-content">
                <section className="hero-card">
                  <div className="hero-top"><span>今日学习</span><span>{new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "short" }).format(new Date())}</span></div>
                  <div className="hero-main">
                    <div><p>连续学习</p><h1>{progress.checkins.length}<small> 天</small></h1><span>完成今天，节奏就不会断</span></div>
                    <div className="progress-ring" style={{ "--progress": `${doneCount * 120}deg` } as React.CSSProperties}><strong>{doneCount}/3</strong><span>今日任务</span></div>
                  </div>
                  <div className="day-switcher">{practiceDays.map((item) => <button key={item.day} className={item.day === day.day ? "active" : ""} onClick={() => switchDay(item.day)}>Day {item.day}</button>)}</div>
                </section>

                {bootstrap?.content.access === "preview" && (
                  <section className="access-card">
                    <div><span>当前为免费版</span><h3>今日可练 5 题、试听 1 条音频</h3><p>激活会员后解锁全部日练、完整解析和电台内容。</p></div>
                    <button onClick={() => { setTab("me"); trackEvent("paywall_action", { placement: "today" }); }}>去激活</button>
                  </section>
                )}

                <section className="today-plan">
                  <div className="section-heading"><div><span>今日安排</span><h2>20 分钟完成三个动作</h2></div><em>{doneCount === 3 ? "今日已完成" : `还剩 ${3 - doneCount} 项`}</em></div>
                  <button className="plan-item" onClick={() => openModule("morning")}><span className="plan-icon blue">早</span><div><b>晨读与表达</b><p>{day.morning.title}</p></div><i>{progress.completed[`${dayKey}-morning`] ? "✓" : "5分钟"}</i></button>
                  <button className="plan-item" onClick={() => openModule("quiz")}><span className="plan-icon orange">练</span><div><b>行测 {day.questions.length} 题</b><p>{day.label} · 记录正确率与错题</p></div><i>{progress.submittedDays[dayKey] ? "✓" : `${Math.max(5, day.questions.length)}分钟`}</i></button>
                  <button className="plan-item" onClick={() => openModule("essay")}><span className="plan-icon green">写</span><div><b>申论微练</b><p>{day.essay.expressions.length} 条表达＋1 道短写作</p></div><i>{progress.completed[`${dayKey}-essay`] ? "✓" : "5分钟"}</i></button>
                </section>

                <section className="tool-section">
                  <div className="section-heading"><div><span>随时巩固</span><h2>今日学习工具</h2></div></div>
                  <div className="tool-grid">
                    <button className="audio-tool" onClick={() => { setTab("audio"); trackEvent("module_open", { module: "audio" }); }}><span>听</span><b>日练电台</b><small>通勤也能练</small></button>
                    <button onClick={() => openModule("affairs")}><span>政</span><b>时政常识</b><small>{day.currentAffairs.length} 张知识卡</small></button>
                    <button onClick={() => setTab("wrong")}><span>错</span><b>错题回炉</b><small>{wrongQuestions.length} 道待复习</small></button>
                  </div>
                </section>
              </div>
            )}

            {tab === "wrong" && (
              <div className="page-content subpage">
                <div className="subpage-heading"><span>个人错题本</span><h1>错过的题，再遇见一次</h1><p>当前 {wrongQuestions.length} 道错题，已复习 {progress.reviewedIds.length} 道。</p></div>
                {wrongQuestions.length === 0 ? <div className="empty-state"><span>✓</span><h3>暂时没有错题</h3><p>完成行测练习后，错题会自动归集到这里。</p><button className="primary-button" onClick={() => { setTab("today"); openModule("quiz"); }}>开始今日练习</button></div> : wrongQuestions.map((question) => <article className="wrong-card" key={question.id}><div className="wrong-card-top"><span>{question.module}</span><em>{progress.reviewedIds.includes(question.id) ? "已复习" : "待回炉"}</em></div><h3>{question.stem}</h3><p><b>正确答案：</b>{String.fromCharCode(65 + question.answer)} · {question.options[question.answer]}</p><p className="wrong-explain">{question.explanation}</p><label>这次为什么错？<select value={progress.wrongReasons[question.id] ?? ""} onChange={(event) => void persist({ ...progress, wrongReasons: { ...progress.wrongReasons, [question.id]: event.target.value } })}><option value="">选择错因</option>{reasonOptions.map((reason) => <option key={reason}>{reason}</option>)}</select></label><button className="secondary-button" onClick={() => reviewed(question.id)}>标记已复习</button></article>)}
              </div>
            )}

            {tab === "report" && (
              <div className="page-content subpage">
                <div className="subpage-heading"><span>学习报告</span><h1>看见自己的每一步</h1><p>持续完成日练，你会得到一张清晰的薄弱项图谱。</p></div>
                <div className="stats-grid"><article><span>完成天数</span><strong>{progress.checkins.length}</strong><small>天</small></article><article><span>累计答题</span><strong>{Object.keys(progress.answers).length}</strong><small>题</small></article><article><span>错题数量</span><strong>{wrongQuestions.length}</strong><small>题</small></article><article><span>表达收藏</span><strong>{progress.favorites.length}</strong><small>条</small></article></div>
                <article className="report-card"><div className="report-title"><h3>{practiceDays.length} 日学习进度</h3><span>{Math.min(100, Math.round((progress.checkins.length / Math.max(1, practiceDays.length)) * 100))}%</span></div>{practiceDays.map((item) => { const key = `d${item.day}`; const value = [progress.completed[`${key}-morning`], progress.submittedDays[key], progress.completed[`${key}-essay`]].filter(Boolean).length; return <div className="bar-row" key={key}><span>Day {item.day}</span><div><i style={{ width: `${value / 3 * 100}%` }} /></div><em>{value}/3</em></div>; })}</article>
                <article className="report-card suggestion"><span>下一个建议</span><h3>{wrongQuestions.length ? "先把错题原因标清楚" : "完成第一组行测训练"}</h3><p>{wrongQuestions.length ? "知道“为什么错”，比只记正确答案更有价值。" : "完成后系统会自动生成你的第一批错题。"}</p></article>
              </div>
            )}

            {tab === "me" && (
              <div className="page-content subpage">
                <div className="profile-card"><div className="profile-avatar">练</div><div><span>{bootstrap?.user.displayName ?? "公考日练用户"}</span><h2>{bootstrap?.user.membershipActive ? hasExtendedMembership ? "会员学习中" : "体验学习中" : "免费版学习中"}</h2><p>用户编号 {bootstrap?.user.id.slice(0, 8) ?? "正在生成"}</p></div></div>
                <article className={`panel-card account-panel ${bootstrap?.user.signedIn ? "synced" : ""}`}>
                  <div><span>{bootstrap?.user.signedIn ? "账号同步已开启" : "当前仅保存在本设备"}</span><h3>{bootstrap?.user.signedIn ? "换设备也能继续学习" : "登录后同步进度和会员时长"}</h3><p>{bootstrap?.user.signedIn ? "当前学习记录已绑定平台账号。" : "登录时会自动合并本设备已有记录。"}</p></div>
                  {bootstrap?.user.signedIn ? <b>✓ 已同步</b> : <a href="/signin-with-chatgpt?return_to=%2F">登录并同步</a>}
                </article>
                <article className="membership-card"><div><span>会员有效期</span><h3>{formatDate(bootstrap?.user.membershipEnd ?? null)}</h3><p>{bootstrap?.user.membershipActive ? "全部学习功能已解锁" : "兑换会员码后解锁长期使用"}</p></div><b>VIP</b></article>
                <article className="panel-card"><div className="panel-title"><h3>兑换码激活</h3><span>支持 7 / 30 / 365 天</span></div><div className="redeem-row"><input value={redeemCode} onChange={(event) => setRedeemCode(event.target.value.toUpperCase())} placeholder="请输入兑换码" /><button onClick={redeem} disabled={busy}>{busy ? "激活中" : "立即激活"}</button></div><small>购买后输入商家发放的兑换码，时长将自动累计。</small></article>
                <article className="panel-card invite-panel"><div className="panel-title"><h3>邀请备考搭子</h3><span>双方各得 {bootstrap?.inviteConfig.rewardDays ?? 3} 天</span></div><p>好友通过你的链接进入，并首次激活会员后，你们双方都会获得额外时长。</p><div className="invite-code"><span>我的邀请码</span><strong>{bootstrap?.user.inviteCode ?? "生成中"}</strong></div><button className="primary-button full-button" onClick={copyInvite}>复制专属邀请链接</button><div className="invite-stats"><span><b>{bootstrap?.inviteStats.total ?? 0}</b>已邀请</span><span><b>{bootstrap?.inviteStats.pending ?? 0}</b>待激活</span><span><b>{bootstrap?.inviteStats.rewarded ?? 0}</b>已奖励</span></div></article>
                <article className="panel-card ledger-card"><div className="panel-title"><h3>会员时长记录</h3><span>自动累计</span></div>{bootstrap?.ledger.length ? bootstrap.ledger.map((item, index) => <div className="ledger-row" key={`${item.created_at}-${index}`}><div><b>{item.note}</b><span>{new Date(item.created_at).toLocaleDateString("zh-CN")}</span></div><strong>+{item.delta_days}天</strong></div>) : <p className="muted">暂无时长变动记录</p>}</article>
              </div>
            )}
          </>
        )}

        <AudioHub
          active={!activeModule && tab === "audio"}
          tracks={bootstrap?.content.audioTracks ?? []}
          wrongQuestions={wrongQuestions}
          notify={notify}
          trackEvent={trackEvent}
        />

        {!activeModule && <nav className="bottom-nav" aria-label="主导航"><button className={tab === "today" ? "active" : ""} onClick={() => setTab("today")}><span>今</span>今日</button><button className={tab === "audio" ? "active" : ""} onClick={() => setTab("audio")}><span>听</span>听练</button><button className={tab === "wrong" ? "active" : ""} onClick={() => setTab("wrong")}><span>错</span>错题</button><button className={tab === "report" ? "active" : ""} onClick={() => setTab("report")}><span>报</span>报告</button><button className={tab === "me" ? "active" : ""} onClick={() => setTab("me")}><span>我</span>我的</button></nav>}
        {toast && <div className="toast" role="status">{toast}</div>}
      </div>
    </main>
  );
}
