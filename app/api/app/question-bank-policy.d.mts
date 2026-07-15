export type QuestionBankIdentityState = {
  bankCode: string;
  examType: string;
  province: string | null;
  examYear: number | null;
  subject: string;
  status?: string;
  questionCount?: number | string;
  importCount?: number | string;
  selectionCount?: number | string;
  activeSessionCount?: number | string;
};

export function inspectQuestionBankIdentityChange(
  current: QuestionBankIdentityState,
  next: Pick<QuestionBankIdentityState, "bankCode" | "examType" | "province" | "examYear" | "subject">,
): {
  locked: boolean;
  codeChanged: boolean;
  lockedFields: string[];
  changedScopeFields: string[];
  lockReasons: string[];
};

export type QuestionBankScope = {
  examType?: string;
  exam_type?: string;
  province?: string | null;
  examYear?: number | null;
  exam_year?: number | null;
  subject?: string;
};

export type QuestionScope = {
  subject?: string;
  sourceExamType?: string;
  source_exam_type?: string;
  region?: string;
  sourceRegion?: string;
  source_region?: string;
  examYear?: number | null;
  source_year?: number | null;
};

export function questionMatchesQuestionBankScope(bank: QuestionBankScope, question: QuestionScope): boolean;
export const QUESTION_BANK_SCOPE_MATCH_SQL: string;
export const QUESTION_BANK_PUBLISHABLE_ITEM_SQL: string;
export const QUESTION_BANK_CAN_PUBLISH_SQL: string;
