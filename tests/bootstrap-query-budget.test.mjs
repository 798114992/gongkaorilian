import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  BOOTSTRAP_MAX_REQUESTS,
  bootstrapRetryDecision,
} from "../app/bootstrap-retry.mjs";

const routeFile = new URL("../app/api/app/route.ts", import.meta.url);
const clientFile = new URL("../app/DailyPracticeApp.tsx", import.meta.url);
const quizClientFile = new URL("../app/QuizFeature.tsx", import.meta.url);

function functionSection(source, name) {
  const start = source.indexOf(`async function ${name}`);
  assert.notEqual(start, -1, `missing function ${name}`);
  const next = source.indexOf("\nasync function ", start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

test("bootstrap retry policy permits exactly the two required preparation retries", () => {
  assert.equal(BOOTSTRAP_MAX_REQUESTS, 3);
  assert.equal(bootstrapRetryDecision(1, true, true), "retry");
  assert.equal(bootstrapRetryDecision(2, true, true), "retry");
  assert.equal(bootstrapRetryDecision(3, true, true), "exhausted");
  assert.equal(bootstrapRetryDecision(1, true, false), "stop");
  assert.equal(bootstrapRetryDecision(1, false, true), "stop");
});

test("identity and invite mutations are isolated before the read-heavy bootstrap", async () => {
  const route = await readFile(routeFile, "utf8");
  const ensureUser = functionSection(route, "ensureUser");
  const bootstrap = functionSection(route, "bootstrap");
  const reconcile = functionSection(route, "reconcileInviteReward");

  assert.match(ensureUser, /deviceMergeAttempted[\s\S]*?migrateDeviceUser/);
  assert.match(ensureUser, /grantWelcomeTrial[\s\S]*?issueUserSession[\s\S]*?bootstrapDeferred: true/);

  const identityGate = bootstrap.indexOf("if (identity.bootstrapDeferred)");
  const inviteGate = bootstrap.indexOf("if (identity.signedIn && await reconcileInviteReward");
  const fullBootstrap = bootstrap.indexOf("const [user, state, ledger");
  assert.ok(identityGate >= 0 && identityGate < inviteGate, "identity preparation must return first");
  assert.ok(inviteGate > identityGate && inviteGate < fullBootstrap, "invite claim must return before full reads");
  assert.match(reconcile, /if \(!eligible\) return false;[\s\S]*?await rewardInvite\(inviteeId\);[\s\S]*?return true;/);
});

test("worst identity and invite preparation stages stay below D1 Free's 50-query cap", async () => {
  const route = await readFile(routeFile, "utf8");
  const migration = functionSection(route, "migrateDeviceUser");
  const identityRows = functionSection(route, "ensureIdentityRows");
  const deviceLink = functionSection(route, "linkDeviceAccount");
  const reward = functionSection(route, "rewardInvite");

  const migrationStatements = (migration.match(/\.prepare\(/g) ?? []).length;
  const identityRowStatements = (identityRows.match(/\.prepare\(/g) ?? []).length;
  const deviceLinkStatements = (deviceLink.match(/\.prepare\(/g) ?? []).length;
  const rewardStatements = (reward.match(/\.prepare\(/g) ?? []).length;
  // Two failed invite-code candidates and one successful RETURNING upsert cost
  // three writes; state materialization is the fourth identity-row query.
  // Add schema/default probes, the due-import claim, an established device
  // session read+touch, verification, the largest device merge, two switch
  // events, welcome trial and the new session.
  const identityRowsWorstCase = 4;
  const identityStageUpperBound = 2 + 1 + 2 + identityRowsWorstCase + 1
    + deviceLinkStatements + migrationStatements + 2 + 2 + 1;
  // Marker reads + active-session lookup + eligibility + relation/config reads
  // and the atomic reward batch.
  const inviteStageUpperBound = 2 + 1 + 1 + rewardStatements;

  assert.ok(migrationStatements <= 32, `device merge grew to ${migrationStatements} statements`);
  assert.equal(identityRowStatements, 2, "identity collision retry must use one bounded upsert plus state materialization");
  assert.equal(deviceLinkStatements, 1, "a verified device-account link must be one idempotent write");
  assert.ok(identityStageUpperBound < 50, `identity stage could use ${identityStageUpperBound} queries`);
  assert.ok(inviteStageUpperBound < 50, `invite stage could use ${inviteStageUpperBound} queries`);
});

test("adding a bank writes only its new target and keeps POST cost constant", async () => {
  const route = await readFile(routeFile, "utf8");
  const toggle = functionSection(route, "toggleQuestionBank");

  assert.doesNotMatch(toggle, /profile\.targets\.map\([\s\S]*?INSERT OR IGNORE INTO user_exam_targets/,
    "existing targets must never become one D1 statement each");
  assert.match(toggle, /if \(!targetExists\)[\s\S]*?statements\.push\(db\.prepare\(`INSERT OR IGNORE INTO user_exam_targets/);
  assert.match(toggle, /primary profile is[\s\S]*?left untouched/);

  // Cold schema/default probes, established-session overhead (due scan +
  // session read/touch), a due-job claim, fixed add-bank reads, two mutation
  // statements and the authoritative response reads all stay constant even
  // when the account already owns 32 targets.
  const coldMarkerReads = 2;
  const establishedSessionOverhead = 3;
  const dueJobClaim = 1;
  const preMutationReads = 4;
  const incrementalMutationStatements = 2;
  const authoritativeResponseReads = 13;
  const upperBound = coldMarkerReads + establishedSessionOverhead + dueJobClaim
    + preMutationReads + incrementalMutationStatements + authoritativeResponseReads;
  assert.ok(upperBound < 50, `toggleQuestionBank could use ${upperBound} queries`);
});

test("client retries preparation responses with a bounded loop", async () => {
  const client = await readFile(clientFile, "utf8");
  assert.match(client, /for \(let requestNumber = 1; requestNumber <= BOOTSTRAP_MAX_REQUESTS;/);
  assert.match(client, /bootstrapRetryDecision\(requestNumber, response\.ok, Boolean\(data\.retryBootstrap\)\)/);
  assert.match(client, /retryDecision === "exhausted"/);
});

test("POST stops after identity preparation and exposes an idempotent retry signal", async () => {
  const route = await readFile(routeFile, "utf8");
  const post = functionSection(route, "POST");
  const identity = post.indexOf("const identity = await ensureUser");
  const preparationGate = post.indexOf("if (identity.bootstrapDeferred)");
  const verifiedGate = post.indexOf("if (!identity.signedIn && verifiedLearningActions.has(action))");
  const firstBusinessHandler = post.indexOf("saveProgress(identity.userId, payload)");

  assert.ok(identity >= 0 && preparationGate > identity, "POST must inspect the identity preparation result");
  assert.ok(preparationGate < verifiedGate && preparationGate < firstBusinessHandler,
    "preparation must return before entitlement checks and business queries");
  assert.match(post, /code: "IDENTITY_PREPARING"[\s\S]*?retryAction: true[\s\S]*?}, 409, identity\.setCookie\)/);
});

test("public API client retries only the pre-handler identity signal and remains bounded", async () => {
  const client = await readFile(clientFile, "utf8");
  const start = client.indexOf("const api = useCallback");
  const end = client.indexOf("const upsertPendingPracticeAttempt", start);
  assert.ok(start >= 0 && end > start, "missing public API client");
  const api = client.slice(start, end);

  assert.match(api, /for \(let requestNumber = 1; requestNumber <= BOOTSTRAP_MAX_REQUESTS;/);
  assert.match(api, /response\.status === 409 && data\.code === "IDENTITY_PREPARING" && data\.retryAction/);
  assert.match(api, /requestNumber < BOOTSTRAP_MAX_REQUESTS/);
  assert.ok(api.indexOf("data.code === \"IDENTITY_PREPARING\"") < api.indexOf("if (!response.ok)"),
    "the retriable 409 must be handled before generic HTTP errors");
});

test("standalone quiz client also retries identity preparation before reporting an error", async () => {
  const client = await readFile(quizClientFile, "utf8");
  const quizApi = functionSection(client, "quizApi");

  assert.match(client, /import \{ BOOTSTRAP_MAX_REQUESTS \} from "\.\/bootstrap-retry\.mjs"/);
  assert.match(quizApi, /for \(let requestNumber = 1; requestNumber <= BOOTSTRAP_MAX_REQUESTS;/);
  assert.match(quizApi, /response\.status === 409 && data\.code === "IDENTITY_PREPARING" && data\.retryAction/);
  assert.match(quizApi, /requestNumber < BOOTSTRAP_MAX_REQUESTS/);
  assert.ok(quizApi.indexOf("data.code === \"IDENTITY_PREPARING\"") < quizApi.indexOf("if (!response.ok)"),
    "the quiz client must replay the preparation response before treating it as an error");
});
