import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
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
  assert.match(app, /今日安排/);
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

test("the learner flow includes goal onboarding, question banks and spaced review", async () => {
  const [app, route, migration] = await Promise.all([
    readFile(new URL("../app/DailyPracticeApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/app/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0003_clammy_rick_jones.sql", import.meta.url), "utf8"),
  ]);
  assert.match(app, /题库中心/);
  assert.match(app, /智能刷题10道/);
  assert.match(app, /按1、3、7天节奏/);
  assert.match(app, /不确定（即使答对也会复习）/);
  assert.match(route, /getPracticeBatch/);
  assert.match(route, /submitPracticeAnswer/);
  assert.match(route, /nextReviewAt/);
  assert.match(migration, /CREATE TABLE `user_exam_profiles`/);
  assert.match(migration, /CREATE TABLE `user_question_progress`/);
  assert.match(migration, /CREATE TABLE `practice_attempts`/);
});

test("provincial question banks are isolated by the learner target province", async () => {
  const [app, route, manager] = await Promise.all([
    readFile(new URL("../app/DailyPracticeApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/app/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/admin/QuestionBankManager.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(app, /不会跨省混题/);
  assert.match(app, /只练目标考试，不混入其他省份/);
  assert.match(route, /bankMatchesProfile/);
  assert.match(route, /当前目标是.*请先切换目标考试再添加这套题库/);
  assert.match(route, /不同省份题库必须使用独立编号/);
  assert.match(manager, /省考必须按省份单独建库/);
});

test("account sync and redemption protections are server side", async () => {
  const route = await readFile(new URL("../app/api/app/route.ts", import.meta.url), "utf8");
  assert.match(route, /oai-authenticated-user-email/);
  assert.match(route, /acct_/);
  assert.match(route, /used_count < max_uses/);
  assert.match(route, /used_count = MAX\(0, used_count - 1\)/);
  assert.match(route, /UPDATE OR IGNORE redemptions/);
});

test("the admin surface includes codes, content publishing and analytics", async () => {
  const [admin, bankManager, envExample] = await Promise.all([
    readFile(new URL("../app/admin/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/admin/QuestionBankManager.tsx", import.meta.url), "utf8"),
    readFile(new URL("../.env.example", import.meta.url), "utf8"),
  ]);
  assert.match(admin, /运营管理后台/);
  assert.match(admin, /adminCreateCodes/);
  assert.match(admin, /adminUpdateConfig/);
  assert.match(admin, /adminUpsertContentBatch/);
  assert.match(admin, /adminDisableContent/);
  assert.match(admin, /7日活跃用户/);
  assert.match(bankManager, /下载Excel模板/);
  assert.match(bankManager, /\.xlsx,\.xls,\.csv/);
  assert.match(bankManager, /adminUpsertQuestionBank/);
  assert.match(bankManager, /adminStartQuestionImport/);
  assert.match(bankManager, /adminImportQuestionBatch/);
  assert.match(bankManager, /offset \+= 40/);
  assert.match(envExample, /replace-with-a-long-random-admin-secret/);
  assert.doesNotMatch(admin, /gkrl-admin-7pX2mQ9vL4sN8cK6/);
});

test("database migrations include durable product, content, analytics and question bank records", async () => {
  const [baseMigration, contentMigration, questionMigration] = await Promise.all([
    readFile(new URL("../drizzle/0000_sweet_may_parker.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0001_even_azazel.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0002_lyrical_goblin_queen.sql", import.meta.url), "utf8"),
  ]);
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
});

test("the 日练电台 uses fixed audio and supports the requested controls", async () => {
  const [hub, audioData, serviceWorker, audioFile] = await Promise.all([
    readFile(new URL("../app/AudioHub.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/data/audio.ts", import.meta.url), "utf8"),
    readFile(new URL("../public/sw.js", import.meta.url), "utf8"),
    stat(new URL("../public/audio/july-flood-resilience.wav", import.meta.url)),
  ]);
  assert.match(hub, /时政电台/);
  assert.match(hub, /申论晨读/);
  assert.match(hub, /错题语音朗读/);
  assert.match(hub, /0\.75/);
  assert.match(hub, /1\.5/);
  assert.match(hub, /循环中/);
  assert.match(hub, /定时/);
  assert.match(hub, /<audio/);
  assert.match(hub, /MediaMetadata/);
  assert.match(hub, /gongkao-audio-v2/);
  assert.match(audioData, /audioUrl/);
  assert.match(audioData, /新法解读/);
  assert.ok(audioFile.size > 100_000);
  assert.match(serviceWorker, /pathname\.startsWith\("\/api\/"\)/);
  assert.match(serviceWorker, /request\.destination === "audio"/);
});
