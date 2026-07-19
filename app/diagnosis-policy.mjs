export const FORMAL_DIAGNOSIS_POLICY = Object.freeze({
  minimumAnswers: 30,
  highConfidenceAnswers: 40,
  minimumModules: 4,
  minimumActiveDays: 3,
  minimumDurationMs: 3_000,
});

export function buildDiagnosisSummary(raw) {
  const validAnswers = Math.max(0, Number(raw.validAnswers) || 0);
  const moduleCount = Math.max(0, Number(raw.moduleCount) || 0);
  const activeDays = Math.max(0, Number(raw.activeDays) || 0);
  const correct = Math.max(0, Number(raw.correct) || 0);
  const accuracy = validAnswers ? Math.round(correct * 100 / validAnswers) : 0;
  const avgSeconds = validAnswers ? Math.round((Number(raw.avgDurationMs) || 0) / 1000) : 0;
  const uncertainRate = validAnswers ? Number(raw.uncertain || 0) / validAnswers : 0;
  const overtimeRate = validAnswers ? Number(raw.overtime || 0) / validAnswers : 0;
  const methodRate = validAnswers ? Number(raw.methodErrors || 0) / validAnswers : 0;
  const ready = validAnswers >= FORMAL_DIAGNOSIS_POLICY.minimumAnswers
    && moduleCount >= FORMAL_DIAGNOSIS_POLICY.minimumModules
    && activeDays >= FORMAL_DIAGNOSIS_POLICY.minimumActiveDays;
  const confidence = !ready ? "样本不足"
    : validAnswers >= FORMAL_DIAGNOSIS_POLICY.highConfidenceAnswers ? "较高" : "初步可信";
  const problemType = accuracy < 60 ? "知识"
    : methodRate >= 0.15 ? "方法"
      : overtimeRate >= 0.2 || avgSeconds >= 80 ? "速度"
        : uncertainRate >= 0.2 ? "稳定性" : "综合巩固";
  const requirements = [];
  if (validAnswers < FORMAL_DIAGNOSIS_POLICY.minimumAnswers) requirements.push(`再完成${FORMAL_DIAGNOSIS_POLICY.minimumAnswers - validAnswers}道有效作答`);
  if (moduleCount < FORMAL_DIAGNOSIS_POLICY.minimumModules) requirements.push(`再覆盖${FORMAL_DIAGNOSIS_POLICY.minimumModules - moduleCount}个模块`);
  if (activeDays < FORMAL_DIAGNOSIS_POLICY.minimumActiveDays) requirements.push(`再完成${FORMAL_DIAGNOSIS_POLICY.minimumActiveDays - activeDays}个学习日`);
  return {
    ready, confidence, validAnswers, excludedFastAnswers: Math.max(0, Number(raw.excludedFastAnswers) || 0),
    moduleCount, activeDays, accuracy, avgSeconds, problemType,
    nextRequirement: requirements.length ? requirements.join("、") : `累计到${FORMAL_DIAGNOSIS_POLICY.highConfidenceAnswers}道有效作答后更新置信度`,
  };
}
