function safeStringArray(value) {
  try {
    const parsed = Array.isArray(value) ? value : JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * Revalidate a server-issued session at answer time. A session snapshot never
 * freezes membership: expiration, bank removal and the China-date boundary all
 * take effect before another question can be applied or consume free quota.
 */
export function practiceSessionSubmissionPolicy({ session, today, questionCode, bankCode, effectiveBankCodes }) {
  if (!session || session.status !== "active") return { allowed: false, code: "PRACTICE_SESSION_INVALIDATED" };
  if (session.dateKey !== today) return { allowed: false, code: "PRACTICE_SESSION_EXPIRED" };
  if (!safeStringArray(session.questionCodes).includes(questionCode)) {
    return { allowed: false, code: "PRACTICE_SESSION_INVALIDATED" };
  }
  const allowedBanks = new Set((effectiveBankCodes ?? []).map(String));
  if (!allowedBanks.has(bankCode)) return { allowed: false, code: "PRACTICE_SESSION_ENTITLEMENT_CHANGED" };
  return { allowed: true, code: "OK" };
}
