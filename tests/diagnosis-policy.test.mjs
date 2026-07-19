import assert from "node:assert/strict";
import test from "node:test";
import { buildDiagnosisSummary } from "../app/diagnosis-policy.mjs";

test("formal diagnosis requires 30 answers, four modules and three learning days", () => {
  const insufficient = buildDiagnosisSummary({ validAnswers: 29, moduleCount: 4, activeDays: 3, correct: 20 });
  assert.equal(insufficient.ready, false);
  assert.match(insufficient.nextRequirement, /再完成1道/);
  const ready = buildDiagnosisSummary({ validAnswers: 30, moduleCount: 4, activeDays: 3, correct: 20, avgDurationMs: 50_000 });
  assert.equal(ready.ready, true);
  assert.equal(ready.confidence, "初步可信");
});

test("abnormally fast answers are disclosed but excluded by the server aggregate", () => {
  const result = buildDiagnosisSummary({ validAnswers: 40, excludedFastAnswers: 6, moduleCount: 5, activeDays: 4, correct: 30 });
  assert.equal(result.confidence, "较高");
  assert.equal(result.excludedFastAnswers, 6);
});
