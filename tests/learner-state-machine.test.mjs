import assert from "node:assert/strict";
import test from "node:test";
import { LEARNER_STATE_KEYS, resolveLearnerState } from "../app/learner-state.mjs";

const ready = {
  signedIn: true, onboarded: true, targetCount: 2, coveredTargetCount: 2,
  membershipActive: false, hadMembership: false, now: Date.parse("2026-07-19T00:00:00Z"),
};

const cases = [
  ["guest", { signedIn: false }],
  ["signed_in_no_target", { onboarded: false, targetCount: 0, coveredTargetCount: 0 }],
  ["no_bank", { coveredTargetCount: 0 }],
  ["partial_coverage", { coveredTargetCount: 1 }],
  ["full_coverage", { membershipActive: true, membershipSource: "member", membershipEnd: null }],
  ["free", {}],
  ["trial", { membershipActive: true, membershipSource: "trial", membershipEnd: "2026-08-19T00:00:00Z" }],
  ["member", { membershipActive: true, membershipSource: "member", membershipEnd: "2026-08-19T00:00:00Z" }],
  ["expiring", { membershipActive: true, membershipSource: "member", membershipEnd: "2026-07-22T00:00:00Z" }],
  ["expired", { hadMembership: true }],
  ["invited", { invited: true }],
  ["redeemed", { redeemed: true }],
  ["cross_device", { crossDevice: true }],
  ["load_error", { loadError: true }],
];

test("14 learner states have one explicit home action and restriction explanation", () => {
  assert.equal(LEARNER_STATE_KEYS.length, 14);
  for (const [expected, overrides] of cases) {
    const state = resolveLearnerState({ ...ready, ...overrides });
    assert.ok(state.primary === expected || state.flags.includes(expected), `${expected} must be represented by primary or flags`);
    assert.ok(state.action);
    assert.ok(state.destination);
    assert.equal(typeof state.restriction, "string");
  }
});

test("partial target coverage never blocks targets that can already train", () => {
  const state = resolveLearnerState({ ...ready, coveredTargetCount: 1 });
  assert.equal(state.primary, "partial_coverage");
  assert.equal(state.destination, "today");
  assert.match(state.restriction, /不影响其他目标训练/);
});
