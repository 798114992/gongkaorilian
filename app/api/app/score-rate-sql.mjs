const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Platform score rate is based on one eligible first answer per user and
// question. Both the live counter and the review/rebuild paths import this
// predicate so a retry or later review can never change the denominator.
export function eligibleFirstAttemptSql(attemptAlias = "metric_attempt", userAlias = "metric_user", status = "applied") {
  if (!IDENTIFIER.test(attemptAlias) || !IDENTIFIER.test(userAlias)) throw new Error("invalid SQL alias");
  if (!new Set(["applied", "applying"]).has(status)) throw new Error("invalid attempt status");
  return `${attemptAlias}.apply_status = '${status}'
    AND ${userAlias}.analytics_eligible = 1
    AND NOT EXISTS (
      SELECT 1 FROM practice_attempts prior_metric_attempt
      WHERE prior_metric_attempt.user_id = ${attemptAlias}.user_id
        AND prior_metric_attempt.question_code = ${attemptAlias}.question_code
        AND prior_metric_attempt.apply_status = 'applied'
        AND prior_metric_attempt.id < ${attemptAlias}.id
    )`;
}

export function platformScoreRateIncrementSql(eligibilitySql) {
  if (typeof eligibilitySql !== "string" || !eligibilitySql.trim()) throw new Error("missing eligibility SQL");
  return `UPDATE questions SET
    score_rate_correct = score_rate_correct + ?, score_rate_attempts = score_rate_attempts + 1,
    score_rate = ROUND((score_rate_correct + ?) * 100.0 / (score_rate_attempts + 1)),
    score_rate_scope = ?, score_rate_source = 'platform', score_rate_updated_at = CURRENT_TIMESTAMP,
    updated_at = CURRENT_TIMESTAMP
    WHERE question_code = ? AND score_rate_source IN ('', 'platform')
      AND EXISTS (
        SELECT 1 FROM practice_attempts metric_attempt
        JOIN users metric_user ON metric_user.id = metric_attempt.user_id
        WHERE metric_attempt.user_id = ? AND metric_attempt.attempt_key = ?
          AND ${eligibilitySql}
      )`;
}
