export type LearnerStateKey = "guest" | "signed_in_no_target" | "no_bank" | "partial_coverage" | "full_coverage"
  | "free" | "trial" | "member" | "expiring" | "expired" | "invited" | "redeemed" | "cross_device" | "load_error";

export const LEARNER_STATE_KEYS: readonly LearnerStateKey[];
export function resolveLearnerState(input: {
  signedIn: boolean; onboarded: boolean; targetCount: number; coveredTargetCount: number;
  membershipActive: boolean; membershipEnd?: string | null; membershipSource?: "trial" | "member" | string;
  hadMembership?: boolean; invited?: boolean; redeemed?: boolean; crossDevice?: boolean; loadError?: boolean; now?: number;
}): { primary: LearnerStateKey; flags: LearnerStateKey[]; daysLeft: number | null; title: string; restriction: string; action: string; destination: string };
