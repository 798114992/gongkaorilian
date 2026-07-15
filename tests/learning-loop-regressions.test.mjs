import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { effectiveDailyPlanMinutes, requiredDailyQuestionCount } from "../app/api/app/daily-plan-policy.mjs";
import { practiceSessionSubmissionPolicy } from "../app/api/app/practice-session-policy.mjs";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

test("10-minute fallback can only reduce a member prescription and always means five questions", () => {
  const strategy = { timePlans: {
    10: { questionCount: 5 },
    30: { questionCount: 10 },
    45: { questionCount: 15 },
    60: { questionCount: 20 },
  } };
  const fallback = effectiveDailyPlanMinutes(60, 10, true);
  assert.equal(fallback, 10);
  assert.equal(requiredDailyQuestionCount(strategy, fallback, true), 5);

  const forgedExpansion = effectiveDailyPlanMinutes(30, 60, true);
  assert.equal(forgedExpansion, 30, "an untrusted request cannot enlarge the saved profile prescription");
  assert.equal(requiredDailyQuestionCount(strategy, forgedExpansion, true), 10);

  const free = effectiveDailyPlanMinutes(60, 60, false);
  assert.equal(free, 10);
  assert.equal(requiredDailyQuestionCount(strategy, free, false), 5);
});

test("daily practice completion advances the step before the full-day check-in", () => {
  const app = readFileSync(join(root, "app/DailyPracticeApp.tsx"), "utf8");
  const route = readFileSync(join(root, "app/api/app/route.ts"), "utf8");
  const runtime = readFileSync(join(root, "db/runtime.ts"), "utf8");
  const bootstrapBody = route.slice(route.indexOf("async function bootstrap"), route.indexOf("async function saveProgress"));

  assert.match(app, /const practiceDone = serverDailyPracticeCompleted/);
  assert.match(app, /enabledDailySteps\.every\(\(step\) => step === "practice" \|\| Boolean\(completed/);
  assert.match(route, /dailyPracticeCompleted: Boolean\(dailyPractice\?\.completed\)/);
  assert.doesNotMatch(bootstrapBody, /INSERT OR IGNORE INTO daily_checkins/,
    "bootstrap must not turn a completed practice step into a full-day check-in");
  assert.doesNotMatch(runtime, /INSERT OR IGNORE INTO daily_checkins/,
    "runtime repair must not create a check-in before the remaining daily steps are complete");
});

test("confidence is one-shot in the UI and duplicate replies return server truth", () => {
  const app = readFileSync(join(root, "app/DailyPracticeApp.tsx"), "utf8");
  const route = readFileSync(join(root, "app/api/app/route.ts"), "utf8");
  assert.match(app, /if \(answerConfidence\) return notify\("\u638c\u63e1\u7a0b\u5ea6\u5df2\u4fdd\u5b58/);
  assert.match(app, /disabled=\{busy \|\| Boolean\(answerConfidence\)\}/);
  assert.match(app, /const serverConfidence = result\.confidence/);
  assert.match(route, /duplicate: true,[\s\S]*?confidence: serverConfidence,[\s\S]*?needsReview:/);
});

test("answer-time entitlement revalidation locks only the banks no longer available", () => {
  const base = {
    today: "2026-07-15",
    questionCode: "gd-2024-001",
    bankCode: "guangdong-2024",
    effectiveBankCodes: ["national-2025"],
  };

  const lockedAfterExpiry = practiceSessionSubmissionPolicy({
    ...base,
    session: {
      status: "active",
      dateKey: "2026-07-15",
      questionCodes: ["gd-2024-001"],
    },
  });
  assert.equal(lockedAfterExpiry.allowed, false);
  assert.equal(lockedAfterExpiry.code, "PRACTICE_SESSION_ENTITLEMENT_CHANGED");

  const stillEntitledSession = practiceSessionSubmissionPolicy({
    ...base,
    questionCode: "national-2025-001",
    bankCode: "national-2025",
    session: {
      status: "active",
      dateKey: "2026-07-15",
      questionCodes: ["national-2025-001"],
    },
  });
  assert.equal(stillEntitledSession.allowed, true,
    "another active session for the free effective bank remains usable after membership expiry");

  const staleDay = practiceSessionSubmissionPolicy({
    ...base,
    bankCode: "national-2025",
    effectiveBankCodes: ["national-2025"],
    session: {
      status: "active",
      dateKey: "2026-07-14",
      questionCodes: ["gd-2024-001"],
    },
  });
  assert.equal(staleDay.code, "PRACTICE_SESSION_EXPIRED");

  const forgedQuestion = practiceSessionSubmissionPolicy({
    ...base,
    bankCode: "national-2025",
    effectiveBankCodes: ["national-2025"],
    session: {
      status: "active",
      dateKey: "2026-07-15",
      questionCodes: ["national-2025-001"],
    },
  });
  assert.equal(forgedQuestion.code, "PRACTICE_SESSION_INVALIDATED");
});

test("submit rejects an invalidated entitlement before any quota or attempt write", () => {
  const route = readFileSync(join(root, "app/api/app/route.ts"), "utf8");
  const body = route.slice(route.indexOf("async function submitPracticeAnswer"), route.indexOf("async function updateQuestionMeta"));
  const policyIndex = body.indexOf("practiceSessionSubmissionPolicy({");
  const rejectIndex = body.indexOf("PRACTICE_SESSION_ENTITLEMENT_CHANGED");
  const quotaIndex = body.indexOf("INSERT OR IGNORE INTO user_daily_usage");
  const attemptIndex = body.indexOf("INSERT OR IGNORE INTO practice_attempts");

  assert.ok(policyIndex >= 0 && rejectIndex > policyIndex, "the session must be revalidated at answer time");
  assert.ok(quotaIndex > rejectIndex, "entitlement rejection must happen before free quota is touched");
  assert.ok(attemptIndex > rejectIndex, "entitlement rejection must happen before an attempt is inserted");
  assert.match(body, /UPDATE practice_sessions SET status = 'abandoned'[\s\S]*?PRACTICE_SESSION_ENTITLEMENT_CHANGED/);
});
