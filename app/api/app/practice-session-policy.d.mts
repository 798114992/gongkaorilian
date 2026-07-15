export type PracticeSessionSubmission = {
  session: { status: string; dateKey: string; questionCodes: string | string[] } | null;
  today: string;
  questionCode: string;
  bankCode: string;
  effectiveBankCodes: string[];
};
export function practiceSessionSubmissionPolicy(input: PracticeSessionSubmission): { allowed: boolean; code: string };
