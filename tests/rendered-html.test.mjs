import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

test("the 公考日练 product shell has a real preview boundary", async () => {
  const [page, app, layout, css, route] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/DailyPracticeApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/api/app/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(page, /公考日练/);
  assert.match(app, /今日重点任务/);
  assert.match(app, /today-command-card/);
  assert.match(app, /daily-timeline-card/);
  assert.match(app, />资料<\/button>/);
  assert.match(app, /当前为免费版/);
  assert.match(app, /signin-with-chatgpt/);
  assert.doesNotMatch(app, /DEMO-/);
  assert.match(route, /access: "premium"/);
  assert.match(route, /access: "preview"/);
  assert.match(route, /cache-control": "no-store, private"/);
  assert.match(layout, /lang="zh-CN"/);
  assert.match(css, /--navy:\s*#163861/);
  assert.doesNotMatch(`${page}\n${app}\n${layout}`, /codex-preview|react-loading-skeleton|Your site is taking shape/i);
});

test("the primary navigation keeps the learning loop in the intended order", async () => {
  const app = await readFile(new URL("../app/DailyPracticeApp.tsx", import.meta.url), "utf8");
  const navStart = app.indexOf('<nav className="bottom-nav"');
  const navEnd = app.indexOf("</nav>", navStart);

  assert.notEqual(navStart, -1, "missing primary navigation");
  assert.notEqual(navEnd, -1, "primary navigation is not closed");

  const nav = app.slice(navStart, navEnd + "</nav>".length);
  assert.match(nav, />今日<\/button>[\s\S]*>题库<\/button>[\s\S]*>复习<\/button>[\s\S]*>资料<\/button>[\s\S]*>我的<\/button>/);
  assert.doesNotMatch(nav, />电台<\/button>/);
  assert.match(app, /tab === "resources"/);
  assert.match(app, /申论真题答案对比/);
});

test("the learner flow includes goal onboarding, question banks and spaced review", async () => {
  const [app, route, migration] = await Promise.all([
    readFile(new URL("../app/DailyPracticeApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/app/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0003_clammy_rick_jones.sql", import.meta.url), "utf8"),
  ]);
  assert.match(app, /题库书架/);
  assert.match(app, /resolveBankFit/);
  assert.match(app, /bankCanPowerDailyPractice/);
  assert.match(app, /可练题库待补全/);
  assert.match(app, /bank\.questionCount > 0/);
  assert.match(app, /bankYearSupportsTarget\(bank\.examYear, target\.examYear\)/);
  assert.doesNotMatch(app, /label: "题库提醒"/);
  assert.match(app, /推荐标准/);
  assert.match(app, /取消/);
  assert.match(app, /buildDailyPlan/);
  assert.match(app, /答错、超时或掌握不稳定/);
  assert.match(app, /把握不足（答对后仍会复习）/);
  assert.match(route, /getPracticeBatch/);
  assert.match(route, /submitPracticeAnswer/);
  assert.match(route, /nextReviewAt/);
  assert.match(migration, /CREATE TABLE `user_exam_profiles`/);
  assert.match(migration, /CREATE TABLE `user_question_progress`/);
  assert.match(migration, /CREATE TABLE `practice_attempts`/);
});

test("daily practice supports a 10-minute fallback plus 30, 45 or 60-minute defaults and survives refreshes", async () => {
  const [page, layout, app, route, content, schema, dailyPolicy] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/DailyPracticeApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/app/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/data/content.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/app/daily-plan-policy.mjs", import.meta.url), "utf8"),
  ]);

  assert.match(`${page}\n${layout}`, /10–60\s*分钟/);
  assert.doesNotMatch(`${page}\n${layout}`, /每天\s*20\s*分钟/);
  assert.match(schema, /dailyMinutes:[\s\S]*?\.default\(30\)/);

  assert.match(app, /buildDailyPlan/);
  assert.match(app, /dailyPlanContract/);
  for (const questionCount of [5, 10, 15, 20]) {
    assert.match(dailyPolicy, new RegExp(`questionCount:\\s*${questionCount}\\b`));
  }
  assert.match(app, /planOverrides/);
  assert.match(app, /10分钟精简/);
  assert.match(app, /todayKey/);
  assert.match(route, /chinaDateKey/);
  assert.match(route, /resumeQuestionCodes/);
  assert.match(app, /activePractice/);

  assert.match(content, /wordLimit\?: number/);
  assert.match(content, /wordLimit: 60/);
  assert.match(app, /wordLimit/);
});

test("the compact loop exposes review, honest bank states and a finite session summary", async () => {
  const [app, route] = await Promise.all([
    readFile(new URL("../app/DailyPracticeApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/app/route.ts", import.meta.url), "utf8"),
  ]);

  assert.match(app, /tab === "review"/);
  assert.match(app, /setTab\("review"\)/);
  assert.match(app, /今日任务已完成/);
  assert.match(app, /startEssayPractice/);
  assert.match(app, /材料作答 · 采分点自评/);
  assert.match(route, /getEssayPracticeBatch/);
  assert.doesNotMatch(app, /申论微练建设中/);
  assert.match(route, /wrongAudioQuestions/);
  assert.match(app, /wrongAudioQuestions/);
});

test("learners can combine national and multiple provincial exam targets and banks", async () => {
  const [app, route, manager] = await Promise.all([
    readFile(new URL("../app/DailyPracticeApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/app/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/admin/QuestionBankManager.tsx", import.meta.url), "utf8"),
  ]);
  const saveProfile = route.slice(route.indexOf("async function saveExamProfile"), route.indexOf("async function toggleQuestionBank"));
  const toggleBank = route.slice(route.indexOf("async function toggleQuestionBank"), route.indexOf("async function dbQuestionCandidates"));
  const practiceBatch = route.slice(route.indexOf("async function getPracticeBatch"), route.indexOf("async function resolveQuestion"));

  assert.match(app, /targets/);
  assert.match(saveProfile, /Array\.isArray\(payload\.targets\)/);
  assert.match(saveProfile, /payload\.targets\.slice\(0, 32\)/);
  assert.match(saveProfile, /请至少选择一个报考目标/);
  assert.match(saveProfile, /DELETE FROM user_exam_targets WHERE user_id = \?/);
  assert.match(saveProfile, /targets\.map\(\(target\) => db\.prepare/);

  assert.match(toggleBank, /INSERT OR IGNORE INTO user_question_banks/);
  assert.match(toggleBank, /INSERT OR IGNORE INTO user_exam_targets/);
  assert.match(toggleBank, /targetCode/);
  assert.doesNotMatch(toggleBank, /请先切换目标考试再添加这套题库/);

  assert.match(practiceBatch, /const \[selected, membership\] = await Promise\.all\(\[selectedBankCodes\(userId\), userMembership\(userId\)\]\)/);
  assert.match(practiceBatch, /effectivePracticeBankCodes\(userId, selected, active\)/);
  assert.match(practiceBatch, /requested\.length \? requested : selected/);
  assert.match(practiceBatch, /loadExamProfile\(userId\)/);
  assert.match(practiceBatch, /urgentTargets/);
  assert.match(practiceBatch, /takeBalanced/);
  assert.match(route, /共通题可复用编号/);
  assert.match(route, /importedQuestionIdentityMatches/);
  assert.match(manager, /国省共通题可复用同一题目编号/);
});

test("the differentiated daily prescription records confidence, balances banks and produces a next-day action", async () => {
  const [app, route, migration, css] = await Promise.all([
    readFile(new URL("../app/DailyPracticeApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/app/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0005_free_silk_fever.sql", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(app, /今日日练/);
  assert.match(app, /nextDailyStep/);
  assert.match(app, /timeZone: "Asia\/Shanghai"/);
  assert.match(app, /确定掌握/);
  assert.match(app, /掌握不稳定/);
  assert.match(app, /猜测作答/);
  assert.match(app, /明日安排/);
  assert.match(route, /takeBalanced/);
  assert.match(route, /questionFingerprint/);
  assert.match(route, /reviewAtAfterChinaDays/);
  assert.match(route, /practice_confidence/);
  assert.match(route, /tomorrowPlan/);
  assert.match(migration, /ADD `confidence`/);
  assert.match(migration, /ADD `review_stage`/);
  assert.match(css, /safe-area-inset-top/);
  assert.match(css, /confidence-box/);
});

test("exam radar, registration reminders, streaks and focused micro drills are part of the daily loop", async () => {
  const [app, route, css] = await Promise.all([
    readFile(new URL("../app/DailyPracticeApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/app/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(app, /公考雷达 · 报考工作台/);
  assert.match(app, /职位表发布/);
  assert.match(app, /报考筛选/);
  assert.match(app, /站内提醒已开启/);
  assert.match(app, /公告发布/);
  assert.match(app, /准考证打印/);
  assert.match(app, /candidateProfile/);
  assert.match(app, /matchPosition/);
  assert.match(app, /savedPositionIds/);
  assert.match(app, /radarTodoDone/);
  assert.match(route, /exam_notice/);
  assert.match(route, /job_position/);
  assert.match(route, /candidate_profile_save/);
  assert.match(app, /连续打卡/);
  assert.match(app, /checkinStreak/);
  assert.match(app, /weekDateKeys/);
  assert.match(app, /weekLabels/);
  assert.match(app, /资料分析速算/);
  assert.match(app, /图形判断/);
  assert.match(app, /言语易错成语/);
  assert.match(app, /常识时政/);
  assert.match(app, /申论规范表达/);
  assert.match(route, /strictFocus/);
  assert.match(route, /广东省考行测/);
  assert.match(route, /公安岗专项/);
  assert.match(route, /行政执法专项/);
  assert.match(route, /事业单位职测/);
  assert.match(css, /retention-strip/);
  assert.match(css, /radar-feature-grid/);
  assert.match(css, /radar-mode-tabs/);
  assert.match(css, /position-card/);
  assert.match(css, /candidate-panel/);
  assert.match(css, /calendar-event/);
  assert.match(css, /micro-grid/);
});

test("account sync and redemption protections are server side", async () => {
  const route = await readFile(new URL("../app/api/app/route.ts", import.meta.url), "utf8");
  assert.match(route, /oai-authenticated-user-email/);
  assert.match(route, /acct_/);
  assert.match(route, /INSERT OR IGNORE INTO redemptions/);
  assert.match(route, /SELECT COUNT\(\*\) FROM redemptions r WHERE r\.code_id = c\.id/);
  assert.match(route, /UPDATE redemptions SET status = 'completed'/);
  assert.match(route, /INSERT OR IGNORE INTO membership_ledger/);
  assert.doesNotMatch(route, /used_count = MAX\(0, used_count - 1\)/);
});

test("the protected admin console includes routed operations, review, imports and analytics", async () => {
  const [shell, login, dashboard, growth, analytics, system, contentManager, bankManager, envExample, adminAuth, route] = await Promise.all([
    readFile(new URL("../app/admin/AdminShell.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/admin/login/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/admin/(secure)/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/admin/(secure)/growth/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/admin/(secure)/analytics/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/admin/(secure)/system/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/admin/AdminContentManager.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/admin/QuestionBankManager.tsx", import.meta.url), "utf8"),
    readFile(new URL("../.env.example", import.meta.url), "utf8"),
    readFile(new URL("../app/api/app/admin-auth.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/app/route.ts", import.meta.url), "utf8"),
  ]);
  const adminSurface = `${shell}\n${dashboard}\n${growth}\n${system}\n${contentManager}`;
  assert.match(shell, /运营管理后台/);
  assert.match(shell, /\/admin\/question-banks/);
  assert.match(shell, /\/admin\/imports/);
  assert.match(shell, /\/admin\/radar/);
  assert.match(shell, /\/admin\/analytics/);
  assert.match(login, /管理员登录/);
  assert.match(login, /账号使用 admin，密码使用原管理口令/);
  assert.match(login, /credentials: "include"/);
  assert.match(growth, /adminCreateCodes/);
  assert.match(growth, /adminUpdateConfig/);
  assert.match(adminSurface, /adminUpsertContentBatch/);
  assert.match(adminSurface, /adminDisableContent/);
  assert.match(adminSurface, /adminListContentVersions/);
  assert.match(adminSurface, /adminRollbackContent/);
  assert.match(adminSurface, /adminUploadMedia/);
  assert.match(adminSurface, /adminSubmitContentReview/);
  assert.match(adminSurface, /adminReviewContent/);
  assert.match(adminSurface, /定时发布/);
  assert.match(adminSurface, /职位表/);
  assert.match(dashboard, /7日活跃/);
  assert.match(analytics, /adminListAnalytics/);
  assert.match(analytics, /近14天/);
  assert.match(analytics, /核心转化漏斗/);
  assert.match(system, /操作日志/);
  assert.match(system, /users\.manage/);
  assert.match(bankManager, /下载Excel模板/);
  assert.match(bankManager, /\.xlsx,\.xls,\.csv/);
  assert.match(bankManager, /选择题库与文件/);
  assert.match(bankManager, /校验预览/);
  assert.match(bankManager, /查看结果/);
  assert.match(bankManager, /adminUpsertQuestionBank/);
  assert.match(bankManager, /adminStartQuestionImport/);
  assert.match(bankManager, /adminImportQuestionBatch/);
  assert.match(bankManager, /const IMPORT_CHUNK_SIZE = 80/);
  assert.match(bankManager, /buildPersistentImportChunks\(rows\)/);
  assert.match(bankManager, /chunkIndex < persistentChunks\.length/);
  assert.match(bankManager, /adminPreviewQuestionImportDuplicates/);
  assert.match(bankManager, /adminCancelQuestionImport/);
  assert.match(bankManager, /adminRetryQuestionImport/);
  assert.match(bankManager, /adminDownloadQuestionImportErrors/);
  assert.match(bankManager, /adminRollbackQuestionVersion/);
  assert.match(bankManager, /fileHash: selectedFileHash/);
  assert.match(adminAuth, /PBKDF2/);
  assert.match(adminAuth, /createBootstrapAdmin/);
  assert.match(adminAuth, /SELECT COUNT\(\*\) AS count FROM admin_users/);
  assert.match(adminAuth, /if \(Number\(existingCount\?\.count \?\? 0\) > 0\) return false/);
  assert.match(adminAuth, /WHERE username = \?/);
  assert.doesNotMatch(adminAuth, /UPDATE admin_users SET password_hash/);
  assert.match(adminAuth, /HttpOnly; Secure; SameSite=Strict/);
  assert.match(adminAuth, /ADMIN_SESSION_SECONDS = 60 \* 60 \* 12/);
  assert.match(route, /admin_audit_logs/);
  assert.match(route, /async function adminListAnalytics/);
  assert.match(route, /pending_review/);
  assert.doesNotMatch(adminSurface, /sessionStorage/);
  assert.match(envExample, /replace-with-a-long-random-admin-secret/);
  assert.doesNotMatch(adminSurface, /gkrl-admin-7pX2mQ9vL4sN8cK6/);
});

test("database migrations include durable product, content, analytics and question bank records", async () => {
  const migrationDirectory = new URL("../drizzle/", import.meta.url);
  const migrationFiles = (await readdir(migrationDirectory)).filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
  const [baseMigration, contentMigration, questionMigration, schema, runtime, ...allMigrationFiles] = await Promise.all([
    readFile(new URL("../drizzle/0000_sweet_may_parker.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0001_even_azazel.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0002_lyrical_goblin_queen.sql", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/runtime.ts", import.meta.url), "utf8"),
    ...migrationFiles.map((name) => readFile(new URL(`../drizzle/${name}`, import.meta.url), "utf8")),
  ]);
  const allMigrations = allMigrationFiles.join("\n");
  assert.match(baseMigration, /CREATE TABLE `redemption_codes`/);
  assert.match(baseMigration, /CREATE TABLE `membership_ledger`/);
  assert.match(baseMigration, /CREATE TABLE `invite_relations`/);
  assert.match(baseMigration, /redemptions_code_user_uq/);
  assert.match(contentMigration, /CREATE TABLE `content_items`/);
  assert.match(contentMigration, /CREATE TABLE `analytics_events`/);
  assert.match(contentMigration, /analytics_events_name_time_idx/);
  assert.match(questionMigration, /CREATE TABLE `question_banks`/);
  assert.match(questionMigration, /CREATE TABLE `questions`/);
  assert.match(questionMigration, /CREATE TABLE `question_bank_items`/);
  assert.match(questionMigration, /CREATE TABLE `question_imports`/);
  assert.match(questionMigration, /question_bank_items_bank_question_uq/);
  assert.match(schema, /export const userExamTargets = sqliteTable/);
  assert.match(schema, /"user_exam_targets"/);
  assert.match(schema, /user_exam_targets_user_target_uq/);
  assert.match(runtime, /CREATE TABLE IF NOT EXISTS user_exam_targets/);
  assert.match(runtime, /user_exam_targets_user_target_uq/);
  assert.match(allMigrations, /CREATE TABLE `user_exam_targets`/);
  assert.match(allMigrations, /CREATE UNIQUE INDEX `user_exam_targets_user_target_uq`/);
  assert.match(allMigrations, /ADD `confidence`/);
  assert.match(allMigrations, /ADD `review_stage`/);
  assert.match(allMigrations, /CREATE TABLE `admin_users`/);
  assert.match(allMigrations, /CREATE TABLE `admin_sessions`/);
  assert.match(allMigrations, /CREATE TABLE `admin_audit_logs`/);
  assert.match(allMigrations, /ADD `submitted_at`/);
  assert.match(allMigrations, /ADD `reviewed_at`/);
});

test("the 日练电台 supports dynamic series, protected audio fallback and the requested controls", async () => {
  const [hub, audioData, serviceWorker, publicFiles] = await Promise.all([
    readFile(new URL("../app/AudioHub.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/data/audio.ts", import.meta.url), "utf8"),
    readFile(new URL("../public/sw.js", import.meta.url), "utf8"),
    readdir(new URL("../public/", import.meta.url)),
  ]);
  assert.match(hub, /时政电台/);
  assert.match(hub, /申论晨读/);
  assert.match(hub, /错题语音朗读/);
  assert.match(hub, /audio-category-board/);
  assert.match(hub, /builtInCategoryMeta/);
  assert.match(hub, /trackSeriesId/);
  assert.match(hub, /tracksBySeries/);
  assert.match(hub, /音频精选分类/);
  assert.match(hub, /请先暂停十秒/);
  assert.match(hub, /0\.75/);
  assert.match(hub, /1\.5/);
  assert.match(hub, /循环中/);
  assert.match(hub, /定时/);
  assert.match(hub, /新闻男声/);
  assert.match(hub, /稳重磁性播报/);
  assert.match(hub, /pickNewsMaleVoice/);
  assert.doesNotMatch(hub, /新闻女|青年男|青年女|aria-label="朗读音色"/);
  assert.match(hub, /speechFallbackIds/);
  assert.match(hub, /录制音频未能播放，已自动切换为系统朗读/);
  assert.match(hub, /native-audio-control/);
  assert.match(hub, /当前设备暂不支持系统朗读，请更换设备或浏览器后重试/);
  assert.match(hub, /<audio/);
  assert.match(hub, /audio-floating-player/);
  assert.match(hub, /关闭播放/);
  assert.match(hub, /播放进度/);
  assert.match(hub, /悬浮播放器进度/);
  assert.match(hub, /speechCursorFromProgress/);
  assert.match(hub, /formatPlaybackTime/);
  assert.match(hub, /MediaMetadata/);
  assert.match(hub, /gongkao-audio-v3/);
  assert.match(hub, /track\.accessLevel === "free"/);
  assert.match(hub, /该节目需在线收听；免费试听音频支持离线缓存/);
  assert.match(audioData, /audioUrl/);
  assert.match(audioData, /新法解读/);
  assert.equal(publicFiles.includes("audio"), false);
  assert.doesNotMatch(audioData, /audioUrl:\s*["']\/audio\//);
  assert.match(serviceWorker, /pathname\.startsWith\("\/api\/"\)/);
  assert.match(serviceWorker, /gongkao-audio-v3/);
  assert.doesNotMatch(serviceWorker, /request\.destination === "audio"/);
  assert.doesNotMatch(serviceWorker, /pathname\.startsWith\("\/audio\/"\)/);
  assert.doesNotMatch(serviceWorker, /responseFromCachedRange/);
});
