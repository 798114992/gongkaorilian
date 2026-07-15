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
