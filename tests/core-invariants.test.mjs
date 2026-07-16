import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const files = {
  route: new URL("../app/api/app/route.ts", import.meta.url),
  runtime: new URL("../db/runtime.ts", import.meta.url),
  schema: new URL("../db/schema.ts", import.meta.url),
  audio: new URL("../app/AudioHub.tsx", import.meta.url),
  commerce: new URL("../app/CommercePaywall.tsx", import.meta.url),
  daily: new URL("../app/DailyPracticeApp.tsx", import.meta.url),
  adminContent: new URL("../app/admin/(secure)/content/page.tsx", import.meta.url),
};

function functionBody(source, name) {
  const start = source.indexOf(`async function ${name}`);
  assert.notEqual(start, -1, `missing function ${name}`);
  const nextAsync = source.indexOf("\nasync function ", start + 1);
  const nextSync = source.indexOf("\nfunction ", start + 1);
  const candidates = [nextAsync, nextSync].filter((index) => index > start);
  const end = candidates.length ? Math.min(...candidates) : source.length;
  return source.slice(start, end);
}

test("user identity is backed by an opaque hashed server session", async () => {
  const route = await readFile(files.route, "utf8");
  const ensureUser = functionBody(route, "ensureUser");
  const issueSession = functionBody(route, "issueUserSession");
  const verifyAnonymousSession = functionBody(route, "anonymousSessionUserId");
  const submitPractice = functionBody(route, "submitPracticeAnswer");
  const updateMeta = functionBody(route, "updateQuestionMeta");
  const getPractice = functionBody(route, "getPracticeBatch");

  assert.match(route, /const USER_COOKIE = "gkrl_uid"/);
  assert.match(route, /HttpOnly; SameSite=Lax/);
  assert.match(issueSession, /randomSessionToken\(\)/);
  assert.match(issueSession, /digestText\(`gongkao-session:\$\{token\}`\)/);
  assert.match(issueSession, /INSERT INTO user_sessions/);
  assert.doesNotMatch(issueSession, /INSERT INTO user_sessions[\s\S]*?\.bind\(token,/);
  assert.doesNotMatch(route, /function validLegacyDeviceId/);
  assert.doesNotMatch(ensureUser, /legacyDeviceId/);
  assert.match(ensureUser, /activeSession\?\.userId \?\? anonymousSession\?\.userId \?\? null/);
  assert.match(verifyAnonymousSession, /anonymousSessionSignature\(value\)/);
  assert.match(verifyAnonymousSession, /constantTimeStringEqual\(expected, parts\[3\]\)/);
  assert.match(ensureUser, /signedOutAccountSession/);
  assert.match(ensureUser, /revoked_at = CURRENT_TIMESTAMP/);
  assert.match(ensureUser, /oai-authenticated-user-email/);
  assert.match(route, /verifiedLearningActions = new Set\(\[[\s\S]*?"saveEssayAttempt"[\s\S]*?"redeem"[\s\S]*?"bindInvite"/);
  assert.match(submitPractice, /const diagnosticSession = session\?\.kind === "diagnostic"/);
  assert.match(submitPractice, /if \(!signedIn && !diagnosticSession\)[\s\S]*?VERIFIED_ACCOUNT_REQUIRED/);
  assert.match(updateMeta, /JOIN practice_sessions ps ON ps\.id = pa\.practice_session_id AND ps\.user_id = pa\.user_id/);
  assert.match(updateMeta, /ps\.kind = 'diagnostic'/);
  assert.match(getPractice, /Math\.min\(active \? 20 : isDiagnostic \? 10 : 5/);
  assert.match(getPractice, /kind = 'diagnostic' AND status = 'completed'/);
  assert.match(getPractice, /diagnostic_used/);
  assert.match(route, /VERIFIED_ACCOUNT_REQUIRED/);
});

test("passive anonymous bootstrap is signed, rate-limited and does not persist a user", async () => {
  const [route, runtime] = await Promise.all([readFile(files.route, "utf8"), readFile(files.runtime, "utf8")]);
  const ensureUser = functionBody(route, "ensureUser");
  const bootstrap = functionBody(route, "bootstrap");
  const anonymousSignature = functionBody(route, "anonymousSessionSignature");
  const post = functionBody(route, "POST");

  assert.match(bootstrap, /ensureUser\(request, \{ persist: false \}\)/);
  assert.match(bootstrap, /if \(!identity\.persistent && !identity\.signedIn\)/);
  assert.match(ensureUser, /if \(!shouldPersist && !identity\.signedIn && !identity\.persistent\)/);
  assert.match(ensureUser, /issueAnonymousSession\(identity\.userId\)/);
  assert.match(anonymousSignature, /name: "HMAC", hash: "SHA-256"/);
  assert.match(route, /if \(!mediaId && !allowPassiveBootstrap\(request\)\)/);
  assert.match(route, /code: "RATE_LIMITED"/);
  assert.match(route, /const PUBLIC_ACTIONS = new Set/);
  assert.match(route, /const PASSIVE_PUBLIC_ACTIONS = new Set/);
  assert.match(post, /!PUBLIC_ACTIONS\.has\(action\)[\s\S]*?return json\(\{ error: "未知操作" \}, 400\)/);
  assert.match(post, /const payload = \(await request\.json\(\)\)[\s\S]*?!PUBLIC_ACTIONS\.has\(action\)[\s\S]*?await ensureSchema\(\)/);
  assert.ok(post.indexOf("!PUBLIC_ACTIONS.has(action)") < post.indexOf("ensureUser(request"),
    "unknown public actions must be rejected before identity persistence");
  assert.match(post, /ensureUser\(request, \{ persist: !PASSIVE_PUBLIC_ACTIONS\.has\(action\) \}\)/);
  assert.match(route, /consume\(`\$\{client\}:\*`, 240\)/);
  assert.match(route, /let defaultsPromise: Promise<void> \| null = null/);
  assert.match(route, /default_system_seed_version[\s\S]*?marker\?\.value !== DEFAULT_SEED_VERSION[\s\S]*?seedDefaults\(\)/);
  assert.match(runtime, /DELETE FROM user_sessions[\s\S]*?datetime\(expires_at\) <= CURRENT_TIMESTAMP/);
});

test("only reviewed and truth-verified questions can enter learner flows", async () => {
  const [route, runtime, schema] = await Promise.all([
    readFile(files.route, "utf8"),
    readFile(files.runtime, "utf8"),
    readFile(files.schema, "utf8"),
  ]);

  assert.match(schema, /reviewStatus: text\("review_status"\)\.notNull\(\)\.default\("pending_review"\)/);
  assert.match(runtime, /review_status TEXT NOT NULL DEFAULT 'pending_review'/);
  assert.match(route, /q\.truth_verified = 1 AND q\.review_status = 'approved'/);
  assert.match(route, /decision === "approve"/);
  assert.match(route, /truth_verified = \?[\s\S]*?truth_verified_at = CASE WHEN \? = 1 THEN CURRENT_TIMESTAMP ELSE NULL END/);
  assert.match(route, /source_batch = ''/);
  assert.doesNotMatch(runtime, /SET truth_verified\s*=\s*1[\s\S]*?WHERE/);
});

test("daily sessions and answers are resumable and idempotent", async () => {
  const [route, schema, runtime] = await Promise.all([
    readFile(files.route, "utf8"),
    readFile(files.schema, "utf8"),
    readFile(files.runtime, "utf8"),
  ]);
  const getBatch = functionBody(route, "getPracticeBatch");
  const submit = functionBody(route, "submitPracticeAnswer");
  const updateMeta = functionBody(route, "updateQuestionMeta");

  assert.match(schema, /practice_sessions_active_uq/);
  assert.match(schema, /practice_attempts_session_question_uq/);
  assert.match(schema, /daily_checkins_user_date_uq/);
  assert.match(runtime, /CREATE TABLE IF NOT EXISTS daily_checkins/);
  assert.match(getBatch, /status = 'active'/);
  assert.match(getBatch, /confidence === "pending"/);
  assert.match(getBatch, /pendingAttempt:/);
  assert.match(submit, /const attemptKey = `\$\{practiceSessionId\}:\$\{questionCode\}`/);
  assert.match(submit, /INSERT OR IGNORE INTO practice_attempts/);
  assert.match(submit, /apply_status = 'applying'/);
  assert.match(submit, /await db\.batch\(statements\)/);
  assert.match(submit, /practice_count < 5/);
  assert.match(updateMeta, /confidence = 'pending' AND apply_status = 'applied'/);
  assert.match(updateMeta, /duplicate: true/);
  assert.match(route, /INSERT OR IGNORE INTO daily_checkins/);
  assert.match(route, /SELECT date_key FROM daily_checkins WHERE user_id = \?/);
  assert.doesNotMatch(route, /legacyCheckins/);
  assert.match(runtime, /ps\.kind = 'daily' AND ps\.mode = 'mixed' AND ps\.status = 'completed'[\s\S]*?ps\.target_count >= 5 AND ps\.answered_count >= ps\.target_count/);
  assert.match(runtime, /DELETE FROM daily_checkins[\s\S]*?NOT EXISTS[\s\S]*?ps\.mode = 'mixed'/);
  assert.match(route, /FROM practice_sessions[\s\S]*?WHERE user_id = \? AND date_key = \? AND kind = 'daily' AND mode = 'mixed'[\s\S]*?status = 'completed'/);
  assert.match(getBatch, /const resumeQuestionCodes = existingSession \? serverResumeCodes : \[\]/);
  assert.doesNotMatch(getBatch, /serverResumeCodes\.length \? serverResumeCodes : clientResumeCodes/);
  assert.match(getBatch, /requiredNewDailyQuestions[\s\S]*?dailyTargetCount - dailyCarry\.answered/);
  assert.match(getBatch, /sessionKind === "daily" && !existingSession && sessionItems\.length < requiredNewDailyQuestions/);
  assert.match(route, /status = 'completed' AND target_count >= 5 AND answered_count >= target_count/);
  assert.match(route, /reviewIntervals: \[1, 3, 7, 14, 30\]/);
});

test("redemption, invitation and commerce grants use idempotency ledgers", async () => {
  const [route, schema] = await Promise.all([
    readFile(files.route, "utf8"),
    readFile(files.schema, "utf8"),
  ]);
  const redeem = functionBody(route, "redeem");
  const invite = functionBody(route, "rewardInvite");
  const reconcileInvite = functionBody(route, "reconcileInviteReward");
  const trial = functionBody(route, "grantWelcomeTrial");

  assert.match(schema, /membership_ledger_source_uq/);
  assert.match(schema, /redemptions_code_user_uq/);
  assert.match(redeem, /INSERT OR IGNORE INTO redemptions/);
  assert.match(redeem, /SELECT COUNT\(\*\) FROM redemptions r WHERE r\.code_id = c\.id/);
  assert.match(redeem, /status = 'completed'/);
  assert.match(redeem, /grantType === "lifetime"/);
  assert.match(invite, /WHERE invitee_id = \? AND status = 'pending' AND risk_status = 'clear'/);
  assert.match(route, /account_switch_detected/);
  assert.match(route, /INVITE_SAME_DEVICE_RISK/);
  assert.match(route, /INVITE_RATE_RISK/);
  assert.match(invite, /risk_status = 'blocked_same_browser'/);
  assert.match(invite, /datetime\(ps\.completed_at\) >= datetime\(invite_relations\.bound_at\)/);
  assert.match(reconcileInvite, /datetime\(ps\.completed_at\) >= datetime\(ir\.bound_at\)/);
  assert.match(invite, /datetime\(created_at\) >= datetime\('now', '\+8 hours', 'start of month', '-8 hours'\)/);
  assert.match(invite, /INSERT OR IGNORE INTO membership_ledger/);
  assert.match(invite, /source_type = 'invite_reward'/);
  assert.match(trial, /INSERT OR IGNORE INTO membership_ledger/);
  assert.match(trial, /AND changes\(\) = 1/);
  assert.doesNotMatch(redeem, /used_count = MAX\(0, used_count - 1\)/);
});

test("commerce preserves the public lifetime offer and keeps payment in explicit test mode", async () => {
  const [route, schema, commerce] = await Promise.all([
    readFile(files.route, "utf8"),
    readFile(files.schema, "utf8"),
    readFile(files.commerce, "utf8"),
  ]);
  for (const table of ["products", "orders", "payment_transactions", "refunds", "entitlement_grants"])
    assert.match(schema, new RegExp(`"${table}"`));
  assert.match(route, /'gkrl-lifetime-2980'/);
  assert.match(route, /2980, 'CNY', 'lifetime'/);
  assert.match(route, /29\.8元开通终身会员/);
  assert.match(route, /PAYMENT_TEST_MODE/);
  assert.match(route, /TEST_PAYMENT_DISABLED/);
  assert.match(schema, /orders_user_idempotency_uq/);
  assert.match(route, /INSERT OR IGNORE INTO payment_transactions/);
  assert.match(route, /INSERT OR IGNORE INTO entitlement_grants/);
  assert.match(commerce, /createTestOrder/);
  assert.match(commerce, /completeTestPayment/);
  assert.match(commerce, /测试支付/);
  assert.doesNotMatch(route, /wechatpay|alipay/i);
});

test("uploaded media is authorized per user and never becomes a public membership token", async () => {
  const [route, runtime] = await Promise.all([
    readFile(files.route, "utf8"),
    readFile(files.runtime, "utf8"),
  ]);
  const serveMedia = functionBody(route, "serveMedia");
  const authorizeMedia = functionBody(route, "serveAuthorizedMedia");

  assert.match(route, /if \(mediaId\) return serveAuthorizedMedia\(mediaId, request\)/);
  assert.match(authorizeMedia, /membershipIsActive\(membership\)/);
  assert.match(authorizeMedia, /entitlement\.access_level === "free"/);
  assert.match(authorizeMedia, /ci\.access_level = 'free'/);
  assert.match(authorizeMedia, /published_free_reference/);
  assert.match(authorizeMedia, /instr\(ci\.payload_json, json_quote\(\?\)\) > 0/);
  assert.match(authorizeMedia, /PAYWALL_MEDIA/);
  assert.match(serveMedia, /publiclyCacheable \? "public, max-age=60, must-revalidate" : "private, no-store"/);
  assert.match(serveMedia, /public, max-age=60, must-revalidate/);
  assert.match(serveMedia, /"x-content-type-options": "nosniff"/);
  assert.match(serveMedia, /row\.content_type === "application\/pdf" \? "attachment" : "inline"/);
  assert.match(route, /function safeUploadedMediaType[\s\S]*?%PDF-[\s\S]*?return ""/);
  assert.match(route, /code: "UNSAFE_MEDIA_TYPE"/);
  assert.doesNotMatch(route, /type === "image\/svg\+xml"/);
  assert.match(runtime, /UPDATE media_assets SET status = 'disabled'[\s\S]*?lower\(content_type\) NOT IN/);
});

test("login return intents and radar controls never degrade into fake actions", async () => {
  const [daily, commerce] = await Promise.all([
    readFile(files.daily, "utf8"),
    readFile(files.commerce, "utf8"),
  ]);

  assert.match(daily, /PENDING_INVITE_SESSION_KEY/);
  assert.match(daily, /PAYWALL_LOGIN_INTENT_KEY/);
  assert.match(daily, /inviteCode && !data\.user\.signedIn[\s\S]*?sessionStorage\.setItem\(PENDING_INVITE_SESSION_KEY/);
  assert.match(daily, /inviteCode && data\.user\.signedIn[\s\S]*?CONSUMED_INVITE_SESSION_KEY[\s\S]*?bindInvite/);
  assert.match(daily, /bootstrap\?\.user\.signedIn \? <button[\s\S]*?登录后生成邀请链接/);
  assert.match(commerce, /href=\{loginHref\} onClick=\{onLogin\}/);
  assert.match(daily, /readPaywallLoginIntent\(\)[\s\S]*?removeItem\(PAYWALL_LOGIN_INTENT_KEY\)/);
  assert.match(daily, /const controller = new AbortController\(\)/);
  assert.match(daily, /radarRequestSequenceRef\.current !== requestSequence/);
  assert.match(daily, /openExistingEventForm\(event\)/);
  assert.match(daily, /event\.sourceUrl[\s\S]*?event-official-action[\s\S]*?暂无来源/);
  assert.doesNotMatch(daily, /event\?\.sourceUrl[\s\S]{0,500}setRadarMode\("tasks"\);\s*\}/);
});

test("essay practice enforces membership, staged reveal and a server-owned three-day rewrite", async () => {
  const route = await readFile(files.route, "utf8");
  const batch = functionBody(route, "getEssayPracticeBatch");
  const save = functionBody(route, "saveEssayAttempt");

  assert.match(batch, /membershipIsActive\(await userMembership\(userId\)\)/);
  assert.match(batch, /q\.truth_verified = 1 AND q\.review_status = 'approved'/);
  assert.match(batch, /scoringPoints: attemptStageIndex >= 2/);
  assert.match(batch, /reference: attemptStageIndex >= 3/);
  assert.match(save, /membershipIsActive\(await userMembership\(userId\)\)/);
  assert.match(save, /chinaDateKeyAfter\(dateKey, 3\)/);
  assert.match(save, /dueDate > chinaDateKey\(\)/);
  assert.match(save, /rewriteDraft\.length < 10/);
});

test("question import is durable, resumable and versioned", async () => {
  const [route, runtime, schema] = await Promise.all([
    readFile(files.route, "utf8"),
    readFile(files.runtime, "utf8"),
    readFile(files.schema, "utf8"),
  ]);
  for (const table of [
    "question_import_chunks",
    "question_import_codes",
    "question_import_row_results",
    "question_import_errors",
    "question_versions",
  ]) {
    assert.match(schema, new RegExp(`"${table}"`));
    assert.match(runtime, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(schema, /leaseToken: text\("lease_token"\)/);
  assert.match(schema, /cancelRequested: integer\("cancel_requested"\)/);
  assert.match(schema, /fileHash: text\("file_hash"\)\.notNull\(\)\.default\(""\)/);
  assert.match(route, /adminStartQuestionImport/);
  assert.match(route, /question_import_chunks/);
  assert.match(route, /question_import_row_results/);
  assert.match(route, /question_versions/);
  assert.match(route, /lease_token/);
  assert.match(route, /cancel_requested/);
  assert.match(route, /文件指纹不一致/);
  assert.match(route, /pending_review/);
  assert.match(route, /INTERNAL_JOB_SECRET/);
  assert.match(route, /continueQuestionImportInternal/);
  assert.match(route, /requestQuestionImportContinuation\(importId, continuationOrigin\)/);
  assert.match(route, /processQuestionImport\(importId, 24_000, new URL\(request\.url\)\.origin\)/);
  assert.match(route, /payload\.rows\.length > QUESTION_IMPORT_CHUNK_ROWS/);
  assert.match(route, /1—80道题/);
});

test("expired trials cannot retain multi-bank practice access and code dates include the selected China day", async () => {
  const [route, daily] = await Promise.all([readFile(files.route, "utf8"), readFile(files.daily, "utf8")]);
  const getBatch = functionBody(route, "getPracticeBatch");
  const effectiveBanks = functionBody(route, "effectivePracticeBankCodes");
  const loadBanks = functionBody(route, "loadQuestionBanks");
  const loadContent = functionBody(route, "loadContent");
  const createCodes = functionBody(route, "adminCreateCodes");

  assert.match(getBatch, /effectivePracticeBankCodes\(userId, selected, active\)/);
  assert.match(effectiveBanks, /if \(membershipActive\) return selected/);
  assert.match(effectiveBanks, /ORDER BY uqb\.added_at, uqb\.bank_code LIMIT 1/);
  assert.match(effectiveBanks, /truth_verified = 1 AND q\.review_status = 'approved'/);
  assert.match(effectiveBanks, /qb\.subject <> '申论' AND q\.subject = '行测'/);
  assert.match(getBatch, /lockedRequestedBankCodes[\s\S]*?code: "FREE_BANK_LIMIT"/);
  assert.match(loadBanks, /practiceAvailable[\s\S]*?locked: added && !practiceAvailable/);
  assert.match(loadContent, /morningReads: \[\][\s\S]*?currentAffairs: \[\][\s\S]*?essayMicros: \[\]/);
  assert.match(loadContent, /questions: \[\][\s\S]*?essay: \{ \.\.\.day\.essay, material: "", prompt: "", reference: "", scoringPoints: \[\] \}/);
  assert.match(loadContent, /const previewDays = practiceDays\.map[\s\S]*?essay: \{ expressions: \[\], material: "", prompt: "", reference: "", scoringPoints: \[\], wordLimit: 0 \}/);
  assert.match(daily, /activeLearningBanks = addedBanks\.filter\(\(bank\) => bank\.subject !== "申论" && bank\.practiceAvailable !== false\)/);
  assert.match(daily, /const hasEssayContent = activeEssayBanks\.some\(\(bank\) => \(bank\.availableEssayCount \?\? bank\.questionCount\) > 0\)/);
  assert.match(daily, /bootstrap\?\.dueEssayRewrites\?\.length/);
  assert.doesNotMatch(daily, /hasEssayContent = [^;]*day\.essay\.prompt/);
  assert.match(createCodes, /T23:59:59\.999\+08:00/);
});

test("content reports are user-scoped, deduplicated, rate-limited and auditable", async () => {
  const [route, runtime, schema, daily, adminContent] = await Promise.all([
    readFile(files.route, "utf8"),
    readFile(files.runtime, "utf8"),
    readFile(files.schema, "utf8"),
    readFile(files.daily, "utf8"),
    readFile(files.adminContent, "utf8"),
  ]);
  const submit = functionBody(route, "submitContentReport");
  const resolve = functionBody(route, "adminResolveContentReport");

  assert.match(schema, /"content_reports"/);
  assert.match(schema, /content_reports_open_uq/);
  assert.match(runtime, /CREATE TABLE IF NOT EXISTS content_reports/);
  assert.match(runtime, /WHERE status = 'pending'/);
  assert.match(submit, /JOIN user_question_banks uqb ON uqb\.bank_code = qb\.bank_code AND uqb\.user_id = \?/);
  assert.match(submit, /WHERE user_id = \? AND content_type = 'question' AND content_key = \? AND reason_code = \? AND status = 'pending'/);
  assert.match(submit, /created_at >= datetime\('now','-24 hours'\)/);
  assert.match(submit, /CONTENT_REPORT_RATE_LIMIT/);
  assert.match(submit, /INSERT OR IGNORE INTO content_reports/);
  assert.match(route, /verifiedLearningActions = new Set\(\[[\s\S]*?"submitContentReport"/);
  assert.match(route, /adminResolveContentReport: \["content\.write", "content\.review"\]/);
  assert.match(route, /ADMIN_WRITE_ACTIONS[\s\S]*?"adminResolveContentReport"/);
  assert.match(resolve, /resolved_by = \?/);
  assert.match(resolve, /WHERE id = \? AND status = 'pending'/);
  assert.match(daily, /题目有误？反馈/);
  assert.match(daily, /本题仍可继续作答/);
  assert.match(adminContent, /用户内容报错/);
  assert.match(adminContent, /标记已修正/);
});

test("audio player exposes four voice presets and recoverable playback state", async () => {
  const audio = await readFile(files.audio, "utf8");
  for (const preset of ["新闻男", "新闻女", "青年男", "青年女"]) assert.match(audio, new RegExp(preset));
  assert.match(audio, /pickSpeechVoice/);
  assert.match(audio, /speechSynthesis\.pause\(\)/);
  assert.match(audio, /speechSynthesis\.resume\(\)/);
  assert.match(audio, /speechSynthesis\.cancel\(\)/);
  assert.match(audio, /audio-floating-player/);
  assert.match(audio, /关闭播放/);
  assert.match(audio, /playbackRate = safeSpeed/);
  assert.match(audio, /loopRef\.current/);
  assert.match(audio, /gongkao-audio-v2/);
  assert.match(audio, /navigator\.mediaSession/);
});

test("three-day experience report uses real insights and shares without a paywall", async () => {
  const [daily, route] = await Promise.all([
    readFile(files.daily, "utf8"),
    readFile(files.route, "utf8"),
  ]);
  const reportStart = daily.indexOf('{tab === "report"');
  const reportEnd = daily.indexOf('{tab === "me"', reportStart);
  assert.notEqual(reportStart, -1);
  assert.notEqual(reportEnd, -1);
  const reportView = daily.slice(reportStart, reportEnd);

  assert.match(daily, /weeklyMetrics\.activeDays >= 3/);
  assert.match(daily, /threeDayReportShareText\(report\)/);
  assert.match(daily, /window\.navigator\.share/);
  assert.match(daily, /window\.navigator\.clipboard\?\.writeText/);
  assert.match(reportView, /近7日真题/);
  assert.match(reportView, /掌握不稳定\/猜测作答/);
  assert.match(reportView, /当前到期复习/);
  assert.match(reportView, /近7日高频覆盖/);
  assert.match(reportView, /下一阶段优先训练/);
  assert.match(reportView, /累计3个学习日后生成完整报告/);
  assert.match(reportView, /不含排名或提分预测/);
  assert.doesNotMatch(reportView, /openPaywall/);
  assert.match(route, /"three_day_report_view"/);
  assert.match(route, /"three_day_report_share"/);
});
