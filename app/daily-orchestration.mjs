const STATES = new Set([
  "needs_target", "needs_bank", "resume_session", "first_practice", "first_result", "needs_login", "sync_checkin",
  "due_review", "morning", "practice", "essay", "complete",
]);

/**
 * Resolve the learner's single highest-priority action for Today.
 * This module deliberately accepts facts only. Marketing slots and optional
 * bonus exercises never participate in the learning-task priority chain.
 */
export function resolveDailyPrimaryTask(input) {
  const activeToday = input.activeSessionKind
    && (!input.activeSessionDateKey || input.activeSessionDateKey === input.todayKey);
  let state = "complete";
  if (!input.onboarded || input.targetCount < 1) state = "needs_target";
  else if (!input.dailyReady) state = "needs_bank";
  else if (activeToday && input.activeSessionKind === "diagnostic") state = "resume_session";
  else if (!input.firstCompletedSessionId) state = "first_practice";
  else if (input.firstCompletedSessionId !== input.firstResultSeenSessionId) state = "first_result";
  else if (!input.signedIn) state = "needs_login";
  else if (activeToday) state = "resume_session";
  else if (input.dailyTasksDone && !input.checkinDone) state = "sync_checkin";
  else if (input.dueCount > 0 && input.practiceEnabled && !input.practiceDone) state = "due_review";
  else if (input.morningEnabled && !input.morningDone) state = "morning";
  else if (input.practiceEnabled && !input.practiceDone) state = "practice";
  else if (input.essayEnabled && !input.essayDone) state = "essay";
  return { state: STATES.has(state) ? state : "complete", activeSessionKind: activeToday ? input.activeSessionKind : null };
}

export function prioritizeTodayItems(items, excludedId = "", limit = 2) {
  const priority = { blocking: 0, urgent: 1, review: 2, learning: 3, info: 4 };
  return [...items]
    .filter((item) => item && item.id !== excludedId)
    .sort((a, b) => (priority[a.priority] ?? 99) - (priority[b.priority] ?? 99))
    .slice(0, Math.max(0, limit));
}

/**
 * Apply the same local frequency rule to every configurable marketing slot.
 * The caller owns persistence and records an impression only when `visible`
 * is true. Keeping this pure also makes the boundary cases easy to verify.
 */
export function resolveCampaignDisplay(record, policy, now, dayKey) {
  const current = record && typeof record === "object" ? record : {};
  const dayCount = current.day === dayKey ? Math.max(0, Number(current.dayCount) || 0) : 0;
  const lastAt = Math.max(0, Number(current.lastAt) || 0);
  const completedAt = Math.max(0, Number(current.completedAt) || 0);
  const maxPerDay = Math.max(1, Number(policy.maxPerDay) || 1);
  const cooldownMs = Math.max(0, Number(policy.cooldownHours) || 0) * 3_600_000;
  const completedCooldownMs = Math.max(0, Number(policy.hideAfterCompleteDays) || 0) * 86_400_000;
  const visible = dayCount < maxPerDay
    && (!lastAt || now - lastAt >= cooldownMs)
    && (!completedAt || now - completedAt >= completedCooldownMs);
  return {
    visible,
    nextRecord: visible
      ? { ...current, day: dayKey, dayCount: dayCount + 1, lastAt: now }
      : current,
  };
}
