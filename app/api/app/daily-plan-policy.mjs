const ALLOWED_PLAN_MINUTES = new Set([10, 30, 45, 60]);

function normalizedPlanMinutes(value) {
  const minutes = Number(value);
  return ALLOWED_PLAN_MINUTES.has(minutes) ? minutes : 30;
}

/**
 * The persisted profile owns the normal prescription. A client may only ask
 * to reduce today's member prescription to the 10-minute fallback; it cannot
 * use an untrusted request or progress payload to enlarge its entitlement.
 */
export function effectiveDailyPlanMinutes(profileMinutes, requestedMinutes, membershipActive) {
  const profile = normalizedPlanMinutes(profileMinutes);
  if (!membershipActive) return 10;
  return Number(requestedMinutes) === 10 && profile > 10 ? 10 : profile;
}

export function requiredDailyQuestionCount(strategy, planMinutes, membershipActive) {
  if (!membershipActive) return 5;
  const plans = strategy?.timePlans && typeof strategy.timePlans === "object" ? strategy.timePlans : {};
  const plan = plans[String(normalizedPlanMinutes(planMinutes))];
  const configured = Math.floor(Number(plan?.questionCount));
  return Math.max(5, Math.min(20, configured || 5));
}

export function dailyPlanContract(strategy, requestedMinutes, membershipActive) {
  const defaults = {
    10: { morning: 0, practice: 10, essay: 0, questionCount: 5 },
    30: { morning: 5, practice: 20, essay: 5, questionCount: 10 },
    45: { morning: 5, practice: 30, essay: 10, questionCount: 15 },
    60: { morning: 10, practice: 35, essay: 15, questionCount: 20 },
  };
  const minutes = effectiveDailyPlanMinutes(requestedMinutes, requestedMinutes, membershipActive);
  const source = strategy?.timePlans?.[String(minutes)] ?? defaults[minutes];
  const fallback = defaults[minutes];
  const bounded = (value, defaultValue, min, max) => {
    const number = Math.round(Number(value));
    return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : defaultValue;
  };
  return {
    minutes,
    morningMinutes: membershipActive ? bounded(source?.morning, fallback.morning, 0, minutes) : 0,
    practiceMinutes: membershipActive ? bounded(source?.practice, fallback.practice, 0, minutes) : 10,
    essayMinutes: membershipActive ? bounded(source?.essay, fallback.essay, 0, minutes) : 0,
    questionCount: requiredDailyQuestionCount(strategy, minutes, membershipActive),
  };
}
