"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type QuizMeta = {
  id: string;
  slug: string;
  title: string;
  description: string;
  questionCount: number;
  availableQuestionCount: number;
  shareTitle: string;
  disclaimer: string;
};

type QuizChallenge = {
  attemptId: string;
  correctCount: number;
  resultTitle: string;
  resultTheme: string;
};

type QuizQuestion = {
  id: string;
  stem: string;
  category: string;
  difficulty: string;
  options: string[];
  selectedIndex: number | null;
};

type QuizAttempt = {
  id: string;
  quiz: QuizMeta;
  challengeId: string;
  questions: QuizQuestion[];
  answered: Record<string, number>;
};

type QuizResult = {
  attemptId: string;
  quiz: QuizMeta | null;
  correctCount: number;
  total: number;
  scorePercent: number;
  result: {
    key: string;
    title: string;
    theme: string;
    badgeLabel: string;
    description: string;
    shareText: string;
  };
  notableChoice: string;
  review: Array<{
    number: number;
    id: string;
    stem: string;
    selectedOption: string;
    correctOption: string;
    correct: boolean;
    explanation: string;
    category: string;
  }>;
};

type Props = {
  notify: (message: string) => void;
  trackEvent: (eventName: string, eventData?: Record<string, unknown>) => void;
};

async function quizApi<T>(payload: Record<string, unknown>) {
  const response = await fetch("/api/app", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error || "测试暂时不可用");
  return data;
}

function shareTitleFor(result: QuizResult) {
  if (result.correctCount === 0) return "我精准避开了全部正确答案，你能复制吗？";
  if (result.result.key === "director") return `我答对${result.correctCount}题，测出了“局长”思维，你能超过我吗？`;
  return result.result.shareText || `我测出了${result.result.title}，你来试试？`;
}

function safeChallengeUrl(attemptId: string) {
  const url = new URL(window.location.origin);
  url.searchParams.set("quiz", "juzhang-thinking");
  url.searchParams.set("challenge", attemptId);
  return url.toString();
}

function avatarClassFor(result: QuizResult) {
  if (result.result.key === "director") return "director";
  if (result.result.key === "section_chief") return "section-chief";
  if (result.result.key === "staff") return "staff";
  if (result.correctCount === 0 || result.result.key === "free_soul") return "free-soul";
  return "staff";
}

function avatarTitleFor(result: QuizResult) {
  const key = avatarClassFor(result);
  if (key === "director") return "低调，统筹感已经藏不住了";
  if (key === "section-chief") return "会听话，也会把事办明白";
  if (key === "staff") return "先稳住基本盘，办公室语感上线";
  return "体制外自由灵魂，反向满分也很稀有";
}

function resultTaglineFor(result: QuizResult) {
  const key = avatarClassFor(result);
  if (key === "director") return "你不是来答题的，你像是来主持会议的。";
  if (key === "section-chief") return "差一点就开始安排别人写材料了。";
  if (key === "staff") return "能听懂暗号，但偶尔还会被“原则上”绕一下。";
  return "你精准避开了所有标准答案，这何尝不是一种天赋。";
}

export default function QuizFeature({ notify, trackEvent }: Props) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"intro" | "question" | "result" | "review">("intro");
  const [meta, setMeta] = useState<QuizMeta | null>(null);
  const [challenge, setChallenge] = useState<QuizChallenge | null>(null);
  const [challengeId, setChallengeId] = useState("");
  const [attempt, setAttempt] = useState<QuizAttempt | null>(null);
  const [result, setResult] = useState<QuizResult | null>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const currentQuestion = attempt?.questions[currentIndex] ?? null;
  const progressText = attempt ? `${Math.min(currentIndex + 1, attempt.questions.length)}/${attempt.questions.length}` : "10题";
  const answeredCount = useMemo(() => attempt ? Object.keys(attempt.answered ?? {}).length : 0, [attempt]);

  const loadMeta = useCallback(async (incomingChallengeId = "") => {
    setError("");
    try {
      const data = await quizApi<{ quiz: QuizMeta; challenge: QuizChallenge | null }>({
        action: "getQuiz",
        slug: "juzhang-thinking",
        challengeId: incomingChallengeId,
      });
      setMeta(data.quiz);
      setChallenge(data.challenge);
      trackEvent(incomingChallengeId ? "quiz_challenge_open" : "quiz_view", { challengeId: incomingChallengeId });
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "测试暂时不可用");
    }
  }, [trackEvent]);

  const openQuiz = useCallback((incomingChallengeId = "") => {
    setOpen(true);
    setView("intro");
    setAttempt(null);
    setResult(null);
    setCurrentIndex(0);
    setSelectedIndex(null);
    setChallengeId(incomingChallengeId);
    void loadMeta(incomingChallengeId);
  }, [loadMeta]);

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const queryChallenge = String(query.get("challenge") ?? "").slice(0, 80);
    const queryQuiz = query.get("quiz");
    if (queryChallenge || queryQuiz === "juzhang-thinking") openQuiz(queryChallenge);
  }, [openQuiz]);

  const closeQuiz = () => {
    setOpen(false);
    setView("intro");
    const query = new URLSearchParams(window.location.search);
    if (query.has("quiz") || query.has("challenge")) {
      query.delete("quiz");
      query.delete("challenge");
      const nextQuery = query.toString();
      window.history.replaceState(null, "", `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ""}${window.location.hash}`);
    }
  };

  const start = async (sameChallenge = true) => {
    setBusy(true);
    setError("");
    try {
      const data = await quizApi<{ attempt: QuizAttempt }>({
        action: "startQuizAttempt",
        slug: "juzhang-thinking",
        challengeId: sameChallenge ? challengeId : "",
      });
      setAttempt(data.attempt);
      setMeta(data.attempt.quiz);
      setCurrentIndex(0);
      setSelectedIndex(null);
      setView("question");
      trackEvent("quiz_start", { challengeId: sameChallenge ? challengeId : "" });
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : "测试暂时无法开始");
    } finally {
      setBusy(false);
    }
  };

  const submitCurrent = async () => {
    if (!attempt || !currentQuestion || selectedIndex === null || busy) return;
    setBusy(true);
    try {
      await quizApi<{ ok: boolean }>({
        action: "submitQuizAnswer",
        attemptId: attempt.id,
        questionId: currentQuestion.id,
        selectedIndex,
      });
      const nextAttempt: QuizAttempt = {
        ...attempt,
        answered: { ...attempt.answered, [currentQuestion.id]: selectedIndex },
        questions: attempt.questions.map((question) => question.id === currentQuestion.id ? { ...question, selectedIndex } : question),
      };
      setAttempt(nextAttempt);
      if (currentIndex >= attempt.questions.length - 1) {
        const completed = await quizApi<QuizResult>({ action: "completeQuizAttempt", attemptId: attempt.id });
        setResult(completed);
        setView("result");
        trackEvent("quiz_complete", { correctCount: completed.correctCount, resultKey: completed.result.key });
      } else {
        setCurrentIndex((value) => value + 1);
        setSelectedIndex(nextAttempt.questions[currentIndex + 1]?.selectedIndex ?? null);
      }
    } catch (submitError) {
      notify(submitError instanceof Error ? submitError.message : "答案提交失败");
    } finally {
      setBusy(false);
    }
  };

  const restart = () => {
    setResult(null);
    void start(false);
  };

  const shareResult = async () => {
    if (!result) return;
    const url = safeChallengeUrl(result.attemptId);
    const title = shareTitleFor(result);
    const text = `${title}\n${result.result.title}｜答对${result.correctCount}/${result.total}题\n${result.result.shareText}`;
    try {
      await quizApi({ action: "recordQuizShare", attemptId: result.attemptId, eventName: "share_panel" });
      if (typeof window.navigator.share === "function") {
        await window.navigator.share({ title, text, url });
        await quizApi({ action: "recordQuizShare", attemptId: result.attemptId, eventName: "native_share" });
        notify("同题挑战已发出");
        return;
      }
      await window.navigator.clipboard.writeText(`${text}\n${url}`);
      await quizApi({ action: "recordQuizShare", attemptId: result.attemptId, eventName: "copy_link" });
      notify("结果和同题挑战链接已复制");
    } catch (shareError) {
      if (shareError instanceof DOMException && shareError.name === "AbortError") return;
      try {
        await window.navigator.clipboard.writeText(`${text}\n${url}`);
        notify("结果链接已复制");
      } catch {
        notify("当前浏览器暂时无法分享");
      }
    }
  };

  return (
    <>
      <section className="quiz-teaser-card" aria-label="趣味测试">
        <div>
          <span>1分钟趣味测试</span>
          <h2>测测你有没有“局长”思维？</h2>
          <p>随机10道题，每次都不一样。答完生成段位卡，还能发起同题挑战。</p>
        </div>
        <div className="quiz-teaser-visual" aria-hidden="true">
          <i />
          <b>局</b>
          <em />
        </div>
        <button onClick={() => openQuiz()}>开始测试</button>
      </section>

      {open && <div className="quiz-overlay" role="dialog" aria-modal="true" aria-labelledby="quiz-title">
        <section className={`quiz-panel ${result ? `theme-${result.result.theme}` : ""}`}>
          <button className="quiz-close" aria-label="关闭测试" onClick={closeQuiz}>×</button>

          {view === "intro" && <div className="quiz-intro">
            <span className="quiz-kicker">公考日练 · 趣味测试</span>
            <h1 id="quiz-title">{meta?.title ?? "测测你有没有“局长”思维？"}</h1>
            <p>{meta?.description ?? "随机10道题，测一测你的体制内语感。"}</p>
            {challenge && <div className={`quiz-challenge-card theme-${challenge.resultTheme}`}>
              <span>好友向你发起同题挑战</span>
              <b>{challenge.resultTitle}</b>
              <small>好友答对 {challenge.correctCount}/10 题。你将回答同一套题，结果更有可比性。</small>
            </div>}
            {error && <div className="quiz-error">{error}</div>}
            <div className="quiz-intro-facts">
              <div><b>{meta?.questionCount ?? 10}</b><span>随机题</span></div>
              <div><b>约1分钟</b><span>碎片化</span></div>
              <div><b>{meta?.availableQuestionCount ?? 0}</b><span>题池</span></div>
            </div>
            <button className="primary-button full-button" disabled={busy || Boolean(error)} onClick={() => void start(true)}>{busy ? "正在准备题目…" : challenge ? "接受同题挑战" : "开始测试"}</button>
            {challenge && <button className="secondary-button full-button" disabled={busy} onClick={() => void start(false)}>不用同题，随机测一组</button>}
            <small className="quiz-disclaimer">{meta?.disclaimer ?? "纯属趣味测试，不构成公务员录用、任职或晋升预测。"}</small>
          </div>}

          {view === "question" && attempt && currentQuestion && <div className="quiz-question-view">
            <div className="quiz-progress-line"><span>{progressText}</span><i style={{ width: `${((currentIndex + 1) / attempt.questions.length) * 100}%` }} /></div>
            <div className="quiz-question-bubble">
              <b>办公室暗号识别中</b>
              <span>{answeredCount} 道已锁定，看看你的语感能不能一路稳住</span>
            </div>
            <div className="quiz-question-head">
              <span>{currentQuestion.category}</span>
              <b>{currentQuestion.difficulty === "hard" ? "稍有难度" : currentQuestion.difficulty === "easy" ? "热身题" : "标准题"}</b>
            </div>
            <h2>{currentQuestion.stem}</h2>
            <div className="quiz-option-list">
              {currentQuestion.options.map((option, index) => <button
                key={`${currentQuestion.id}-${index}`}
                className={selectedIndex === index ? "selected" : ""}
                onClick={() => setSelectedIndex(index)}
              >
                <b>{String.fromCharCode(65 + index)}</b>
                <span>{option}</span>
              </button>)}
            </div>
            <button className="primary-button full-button" disabled={selectedIndex === null || busy} onClick={() => void submitCurrent()}>{busy ? "保存中…" : currentIndex >= attempt.questions.length - 1 ? "提交并看结果" : "下一题"}</button>
            <small className="quiz-disclaimer">答题中不显示解析，结果页统一看答案。</small>
          </div>}

          {view === "result" && result && <div className="quiz-result-view">
            <div className={`quiz-result-card theme-${result.result.theme}`}>
              <div className={`quiz-avatar-stage avatar-${avatarClassFor(result)}`} aria-hidden="true">
                <div className="quiz-avatar-burst"><i /><i /><i /></div>
                <div className="quiz-anime-avatar">
                  <i className="avatar-hair" />
                  <i className="avatar-face">
                    <span className="avatar-eye left" />
                    <span className="avatar-eye right" />
                    <span className="avatar-blush left" />
                    <span className="avatar-blush right" />
                    <span className="avatar-mouth" />
                  </i>
                  <i className="avatar-body" />
                  <i className="avatar-prop" />
                </div>
                <div className="quiz-avatar-badge">{result.result.badgeLabel || "测试结果"}</div>
              </div>
              <span>{result.result.badgeLabel || "测试结果"}</span>
              <h1>{result.result.title}</h1>
              <p className="quiz-result-tagline">{resultTaglineFor(result)}</p>
              <div className="quiz-score-ring"><b>{result.scorePercent}%</b><small>局长思维指数</small></div>
              <p>{result.result.description}</p>
              <div className="quiz-result-mini-stats">
                <div><b>{result.correctCount}/{result.total}</b><span>答对题数</span></div>
                <div><b>{avatarTitleFor(result)}</b><span>头像判词</span></div>
              </div>
              <em>{result.notableChoice}</em>
              <small>公考日练 · 测测你有没有“局长”思维？</small>
            </div>
            {challenge && <div className="quiz-duel-row">
              <div><span>好友</span><b>{challenge.correctCount}/10</b><small>{challenge.resultTitle}</small></div>
              <div><span>你</span><b>{result.correctCount}/{result.total}</b><small>{result.result.title}</small></div>
            </div>}
            <div className="quiz-result-actions">
              <button className="primary-button" onClick={() => void shareResult()}>发起同题挑战</button>
              <button className="secondary-button" onClick={() => setView("review")}>查看全部答案</button>
              <button className="secondary-button" onClick={restart}>不服，再测10道</button>
            </div>
            <button className="quiz-learn-more" onClick={closeQuiz}>回到今日训练</button>
            <small className="quiz-disclaimer">{result.quiz?.disclaimer ?? meta?.disclaimer}</small>
          </div>}

          {view === "review" && result && <div className="quiz-review-view">
            <div className="quiz-review-head"><button onClick={() => setView("result")}>‹ 返回结果</button><h2>全部答案</h2><span>{result.correctCount}/{result.total}</span></div>
            <div className="quiz-review-list">
              {result.review.map((item) => <article key={item.id} className={item.correct ? "correct" : "wrong"}>
                <span>第{item.number}题 · {item.category}</span>
                <h3>{item.stem}</h3>
                <p><b>你选：</b>{item.selectedOption || "未选择"}</p>
                <p><b>正解：</b>{item.correctOption}</p>
                <small>{item.explanation}</small>
              </article>)}
            </div>
          </div>}
        </section>
      </div>}
    </>
  );
}
