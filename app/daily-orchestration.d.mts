export type DailyPrimaryState =
  | "needs_target" | "needs_bank" | "critical_exam" | "resume_session" | "sync_checkin"
  | "first_practice" | "first_result" | "due_review" | "morning" | "practice" | "essay" | "complete";

export type DailyOrchestrationInput = {
  onboarded: boolean;
  targetCount: number;
  dailyReady: boolean;
  criticalReminderId: string | null;
  activeSessionKind: "daily" | "diagnostic" | null;
  activeSessionDateKey: string | null;
  todayKey: string;
  firstCompletedSessionId: string | null;
  firstResultSeenSessionId: string;
  dailyTasksDone: boolean;
  checkinDone: boolean;
  dueCount: number;
  morningEnabled: boolean;
  morningDone: boolean;
  practiceEnabled: boolean;
  practiceDone: boolean;
  essayEnabled: boolean;
  essayDone: boolean;
};

export function resolveDailyPrimaryTask(input: DailyOrchestrationInput): {
  state: DailyPrimaryState;
  activeSessionKind: "daily" | "diagnostic" | null;
};

export function prioritizeTodayItems<T extends { id: string; priority: "blocking" | "urgent" | "review" | "learning" | "info" }>(items: T[], excludedId?: string, limit?: number): T[];

export type CampaignDisplayRecord = { day?: string; dayCount?: number; lastAt?: number; completedAt?: number };
export function resolveCampaignDisplay(
  record: CampaignDisplayRecord | null | undefined,
  policy: { maxPerDay: number; cooldownHours: number; hideAfterCompleteDays: number },
  now: number,
  dayKey: string,
): { visible: boolean; nextRecord: CampaignDisplayRecord };
