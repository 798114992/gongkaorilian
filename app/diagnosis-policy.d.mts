export const FORMAL_DIAGNOSIS_POLICY: Readonly<{ minimumAnswers: number; highConfidenceAnswers: number; minimumModules: number; minimumActiveDays: number; minimumDurationMs: number }>;
export function buildDiagnosisSummary(raw: { validAnswers?: number; excludedFastAnswers?: number; moduleCount?: number; activeDays?: number; correct?: number; avgDurationMs?: number; uncertain?: number; overtime?: number; methodErrors?: number }): {
  ready: boolean; confidence: string; validAnswers: number; excludedFastAnswers: number; moduleCount: number; activeDays: number;
  accuracy: number; avgSeconds: number; problemType: string; nextRequirement: string;
};
