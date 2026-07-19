import assert from "node:assert/strict";
import test from "node:test";
import { prioritizeTodayItems, resolveCampaignDisplay, resolveDailyPrimaryTask } from "../app/daily-orchestration.mjs";

const ready = {
  onboarded: true, targetCount: 1, dailyReady: true, signedIn: true,
  activeSessionKind: null, activeSessionDateKey: null, todayKey: "2026-07-17",
  firstCompletedSessionId: "first-1", firstResultSeenSessionId: "first-1",
  dailyTasksDone: false, checkinDone: false, dueCount: 0,
  morningEnabled: true, morningDone: false, practiceEnabled: true, practiceDone: false,
  essayEnabled: true, essayDone: false,
};

for (const [name, overrides, expected] of [
  ["未建目标", { onboarded: false, targetCount: 0 }, "needs_target"],
  ["题库不可执行", { dailyReady: false }, "needs_bank"],
  ["中断首次体验可恢复", { activeSessionKind: "diagnostic", activeSessionDateKey: "2026-07-17", firstCompletedSessionId: null }, "resume_session"],
  ["未完成首轮5题", { firstCompletedSessionId: null }, "first_practice"],
  ["首次结果尚未查看", { firstCompletedSessionId: "first-2", firstResultSeenSessionId: "" }, "first_result"],
  ["游客完成快照后先登录", { signedIn: false }, "needs_login"],
  ["完成任务后同步打卡", { dailyTasksDone: true, checkinDone: false }, "sync_checkin"],
  ["到期复习优先于晨读", { dueCount: 3 }, "due_review"],
  ["晨读", {}, "morning"],
  ["行测新题", { morningDone: true }, "practice"],
  ["申论", { morningDone: true, practiceDone: true }, "essay"],
  ["今日完成", { morningDone: true, practiceDone: true, essayDone: true, dailyTasksDone: true, checkinDone: true }, "complete"],
]) test(name, () => assert.equal(resolveDailyPrimaryTask({ ...ready, ...overrides }).state, expected));

test("辅助事项按优先级排序、排除主任务且最多两项", () => {
  const items = [
    { id: "info", priority: "info" },
    { id: "review", priority: "review" },
    { id: "urgent", priority: "urgent" },
  ];
  assert.deepEqual(prioritizeTodayItems(items, "urgent", 2).map((item) => item.id), ["review", "info"]);
});

test("所有营销槽位共用每日上限、冷却和完成后隐藏规则", () => {
  const now = Date.parse("2026-07-17T08:00:00+08:00");
  const policy = { maxPerDay: 1, cooldownHours: 24, hideAfterCompleteDays: 30 };
  const first = resolveCampaignDisplay({}, policy, now, "2026-07-17");
  assert.equal(first.visible, true);
  assert.equal(resolveCampaignDisplay(first.nextRecord, policy, now + 60_000, "2026-07-17").visible, false);
  assert.equal(resolveCampaignDisplay({ completedAt: now }, policy, now + 29 * 86_400_000, "2026-08-15").visible, false);
  assert.equal(resolveCampaignDisplay({ completedAt: now }, policy, now + 31 * 86_400_000, "2026-08-17").visible, true);
});
