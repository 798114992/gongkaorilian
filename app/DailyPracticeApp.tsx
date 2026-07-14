"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { practiceDays, type Question } from "./data/content";

type Tab = "today" | "wrong" | "report" | "me";
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
  user: { id: string; inviteCode: string; membershipEnd: string | null; membershipActive: boolean };
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

function findQuestion(id: string) {
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

  const day = practiceDays.find((item) => item.day === progress.currentDay) ?? practiceDays[0];
  const currentQuestion = day.questions[questionIndex];
  const dayKey = `d${day.day}`;
  const doneCount = [
    progress.completed[`${dayKey}-morning`],
    progress.submittedDays[dayKey],
    progress.completed[`${dayKey}-essay`],
  ].filter(Boolean).length;
  const allQuestions = useMemo(() => practiceDays.flatMap((item) => item.questions), []);
  const wrongQuestions = progress.wrongIds.map(findQuestion).filter(Boolean) as Question[];

  const notify = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2600);
  }, []);

  const loadBootstrap = useCallback(async () => {
    try {
      const response = await fetch("/api/app", { cache: "no-store" });
      const data = (await response.json()) as Bootstrap & { error?: string };
      if (!response.ok) throw new Error(data.error || "加载失败");
      setBootstrap(data);
      setProgress(mergeProgress(data.progress));
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
    void loadBootstrap();
  }, [loadBootstrap]);

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
          <button className="member-chip" onClick={() => setTab("me")}>{bootstrap?.user.membershipActive ? "会员有效" : "3天体验"}</button>
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

                <section className="today-plan">
                  <div className="section-heading"><div><span>今日安排</span><h2>20 分钟完成三个动作</h2></div><em>{doneCount === 3 ? "今日已完成" : `还剩 ${3 - doneCount} 项`}</em></div>
                  <button className="plan-item" onClick={() => setActiveModule("morning")}><span className="plan-icon blue">早</span><div><b>晨读与表达</b><p>{day.morning.title}</p></div><i>{progress.completed[`${dayKey}-morning`] ? "✓" : "5分钟"}</i></button>
                  <button className="plan-item" onClick={() => setActiveModule("quiz")}><span className="plan-icon orange">练</span><div><b>行测 10 题</b><p>{day.label} · 记录正确率与错题</p></div><i>{progress.submittedDays[dayKey] ? "✓" : "10分钟"}</i></button>
                  <button className="plan-item" onClick={() => setActiveModule("essay")}><span className="plan-icon green">写</span><div><b>申论微练</b><p>3 条表达＋1 道短写作</p></div><i>{progress.completed[`${dayKey}-essay`] ? "✓" : "5分钟"}</i></button>
                </section>

                <section className="tool-section">
                  <div className="section-heading"><div><span>随时巩固</span><h2>今日学习工具</h2></div></div>
                  <div className="tool-grid">
                    <button onClick={() => setActiveModule("affairs")}><span>政</span><b>时政常识</b><small>5张知识卡</small></button>
                    <button onClick={() => setTab("wrong")}><span>错</span><b>错题回炉</b><small>{wrongQuestions.length} 道待复习</small></button>
                  </div>
                </section>
              </div>
            )}

            {tab === "wrong" && (
              <div className="page-content subpage">
                <div className="subpage-heading"><span>个人错题本</span><h1>错过的题，再遇见一次</h1><p>当前 {wrongQuestions.length} 道错题，已复习 {progress.reviewedIds.length} 道。</p></div>
                {wrongQuestions.length === 0 ? <div className="empty-state"><span>✓</span><h3>暂时没有错题</h3><p>完成行测练习后，错题会自动归集到这里。</p><button className="primary-button" onClick={() => { setTab("today"); setActiveModule("quiz"); }}>开始今日练习</button></div> : wrongQuestions.map((question) => <article className="wrong-card" key={question.id}><div className="wrong-card-top"><span>{question.module}</span><em>{progress.reviewedIds.includes(question.id) ? "已复习" : "待回炉"}</em></div><h3>{question.stem}</h3><p><b>正确答案：</b>{String.fromCharCode(65 + question.answer)} · {question.options[question.answer]}</p><p className="wrong-explain">{question.explanation}</p><label>这次为什么错？<select value={progress.wrongReasons[question.id] ?? ""} onChange={(event) => void persist({ ...progress, wrongReasons: { ...progress.wrongReasons, [question.id]: event.target.value } })}><option value="">选择错因</option>{reasonOptions.map((reason) => <option key={reason}>{reason}</option>)}</select></label><button className="secondary-button" onClick={() => reviewed(question.id)}>标记已复习</button></article>)}
              </div>
            )}

            {tab === "report" && (
              <div className="page-content subpage">
                <div className="subpage-heading"><span>学习报告</span><h1>看见自己的每一步</h1><p>完成三天体验后，你会得到一张清晰的薄弱项图谱。</p></div>
                <div className="stats-grid"><article><span>完成天数</span><strong>{progress.checkins.length}</strong><small>天</small></article><article><span>累计答题</span><strong>{Object.keys(progress.answers).length}</strong><small>题</small></article><article><span>错题数量</span><strong>{wrongQuestions.length}</strong><small>题</small></article><article><span>表达收藏</span><strong>{progress.favorites.length}</strong><small>条</small></article></div>
                <article className="report-card"><div className="report-title"><h3>三日学习进度</h3><span>{Math.round((progress.checkins.length / 3) * 100)}%</span></div>{practiceDays.map((item) => { const key = `d${item.day}`; const value = [progress.completed[`${key}-morning`], progress.submittedDays[key], progress.completed[`${key}-essay`]].filter(Boolean).length; return <div className="bar-row" key={key}><span>Day {item.day}</span><div><i style={{ width: `${value / 3 * 100}%` }} /></div><em>{value}/3</em></div>; })}</article>
                <article className="report-card suggestion"><span>下一个建议</span><h3>{wrongQuestions.length ? "先把错题原因标清楚" : "完成第一组行测训练"}</h3><p>{wrongQuestions.length ? "知道“为什么错”，比只记正确答案更有价值。" : "完成后系统会自动生成你的第一批错题。"}</p></article>
              </div>
            )}

            {tab === "me" && (
              <div className="page-content subpage">
                <div className="profile-card"><div className="profile-avatar">练</div><div><span>公考日练用户</span><h2>{bootstrap?.user.membershipActive ? "会员学习中" : "免费体验中"}</h2><p>用户编号 {bootstrap?.user.id.slice(0, 8) ?? "正在生成"}</p></div></div>
                <article className="membership-card"><div><span>会员有效期</span><h3>{formatDate(bootstrap?.user.membershipEnd ?? null)}</h3><p>{bootstrap?.user.membershipActive ? "全部学习功能已解锁" : "兑换会员码后解锁长期使用"}</p></div><b>VIP</b></article>
                <article className="panel-card"><div className="panel-title"><h3>兑换码激活</h3><span>支持 7 / 30 / 365 天</span></div><div className="redeem-row"><input value={redeemCode} onChange={(event) => setRedeemCode(event.target.value.toUpperCase())} placeholder="请输入兑换码" /><button onClick={redeem} disabled={busy}>{busy ? "激活中" : "立即激活"}</button></div><small>内测可使用：DEMO-7DAYS-2026</small></article>
                <article className="panel-card invite-panel"><div className="panel-title"><h3>邀请备考搭子</h3><span>双方各得 {bootstrap?.inviteConfig.rewardDays ?? 3} 天</span></div><p>好友通过你的链接进入，并首次激活会员后，你们双方都会获得额外时长。</p><div className="invite-code"><span>我的邀请码</span><strong>{bootstrap?.user.inviteCode ?? "生成中"}</strong></div><button className="primary-button full-button" onClick={copyInvite}>复制专属邀请链接</button><div className="invite-stats"><span><b>{bootstrap?.inviteStats.total ?? 0}</b>已邀请</span><span><b>{bootstrap?.inviteStats.pending ?? 0}</b>待激活</span><span><b>{bootstrap?.inviteStats.rewarded ?? 0}</b>已奖励</span></div></article>
                <article className="panel-card ledger-card"><div className="panel-title"><h3>会员时长记录</h3><a href="/admin">管理后台</a></div>{bootstrap?.ledger.length ? bootstrap.ledger.map((item, index) => <div className="ledger-row" key={`${item.created_at}-${index}`}><div><b>{item.note}</b><span>{new Date(item.created_at).toLocaleDateString("zh-CN")}</span></div><strong>+{item.delta_days}天</strong></div>) : <p className="muted">暂无时长变动记录</p>}</article>
              </div>
            )}
          </>
        )}

        {!activeModule && <nav className="bottom-nav" aria-label="主导航"><button className={tab === "today" ? "active" : ""} onClick={() => setTab("today")}><span>今</span>今日</button><button className={tab === "wrong" ? "active" : ""} onClick={() => setTab("wrong")}><span>错</span>错题</button><button className={tab === "report" ? "active" : ""} onClick={() => setTab("report")}><span>报</span>报告</button><button className={tab === "me" ? "active" : ""} onClick={() => setTab("me")}><span>我</span>我的</button></nav>}
        {toast && <div className="toast" role="status">{toast}</div>}
      </div>
    </main>
  );
}
