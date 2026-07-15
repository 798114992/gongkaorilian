export const ABANDONED_DAILY_CARRY_SQL = `SELECT pa.question_code, pa.is_correct, pa.uncertain,
    pa.confidence, pa.overtime, pa.duration_ms
  FROM practice_attempts pa
  JOIN practice_sessions ps ON ps.id = pa.practice_session_id AND ps.user_id = pa.user_id
  WHERE pa.user_id = ? AND ps.date_key = ? AND ps.kind = 'daily' AND ps.mode = 'mixed'
    AND ps.status = 'abandoned' AND pa.apply_status = 'applied'
  ORDER BY pa.id DESC LIMIT 100`;

export function summarizeDailyCarry(rows, maxQuestions = 20) {
  const unique = new Map();
  for (const row of rows) if (!unique.has(String(row.question_code))) unique.set(String(row.question_code), row);
  const carried = Array.from(unique.values()).slice(0, Math.max(1, Math.min(20, maxQuestions)));
  return {
    answered: carried.length,
    correct: carried.reduce((sum, row) => sum + Number(Boolean(row.is_correct)), 0),
    reviewAdded: carried.reduce((sum, row) => sum
      + Number(!row.is_correct || row.uncertain || row.overtime || row.confidence !== "confident"), 0),
    elapsedSeconds: carried.reduce((sum, row) => sum + Math.round(Math.max(0, Number(row.duration_ms ?? 0)) / 1000), 0),
    questionCodes: carried.map((row) => String(row.question_code)),
  };
}
