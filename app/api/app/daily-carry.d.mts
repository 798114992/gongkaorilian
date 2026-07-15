export type DailyCarryRow = {
  question_code: string;
  is_correct: number;
  uncertain: number;
  confidence: string;
  overtime: number;
  duration_ms: number;
};
export const ABANDONED_DAILY_CARRY_SQL: string;
export function summarizeDailyCarry(rows: DailyCarryRow[], maxQuestions?: number): {
  answered: number;
  correct: number;
  reviewAdded: number;
  elapsedSeconds: number;
  questionCodes: string[];
};
