export function effectiveDailyPlanMinutes(profileMinutes: unknown, requestedMinutes: unknown, membershipActive: boolean): number;
export function requiredDailyQuestionCount(strategy: Record<string, unknown> | null | undefined, planMinutes: number, membershipActive: boolean): number;
export function dailyPlanContract(strategy: Record<string, unknown> | null | undefined, requestedMinutes: unknown, membershipActive: boolean): {
  minutes: 10 | 30 | 45 | 60; morningMinutes: number; practiceMinutes: number; essayMinutes: number; questionCount: number;
};
