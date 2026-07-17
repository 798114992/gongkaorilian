import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("today page prioritizes urgent exam actions and evidence-based point recommendations", async () => {
  const [app, route, css, quiz] = await Promise.all([
    readFile(new URL("../app/DailyPracticeApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/app/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/QuizFeature.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(app, /criticalReminder/);
  assert.match(app, /resolveDailyPrimaryTask/);
  assert.match(app, /primaryTodayState === "critical_exam"/);
  assert.match(app, /recommendationPoint/);
  assert.match(app, /recommendationEvidence/);
  assert.match(app, /today-gain-disclosure/);
  assert.doesNotMatch(app, />加练一下</);
  assert.match(app, /variant="teaser"[\s\S]*?entryVisible/);
  assert.ok(app.indexOf("<QuizFeature") > app.indexOf("smart-bonus-card"),
    "the quiz should be the final lightweight entry on the today page");
  assert.match(app, /campaign_impression/);
  assert.doesNotMatch(app, /unlocked=\{allDailyDone\}/);

  assert.match(quiz, /quiz-teaser-eyebrow[\s\S]*?趣味测试/);
  assert.doesNotMatch(quiz, /不计入日练进度；随机10道/);
  assert.doesNotMatch(quiz, /趣味测试 · 免费开放/);
  assert.doesNotMatch(quiz, /完成今日主线后解锁局长思维小测/);
  assert.doesNotMatch(quiz, /disabled=\{!unlocked\}/);

  assert.match(route, /weakPoints/);
  assert.match(route, /wrong_reasons/);
  assert.match(route, /q\.score_rate_attempts >= 100/);
  assert.match(route, /points: points\.results/);

  assert.match(css, /\.critical-exam-reminder/);
  assert.match(css, /\.recommendation-evidence/);
  assert.match(css, /\.today-gain-disclosure/);
  assert.match(css, /\.practice-summary-points/);
});
