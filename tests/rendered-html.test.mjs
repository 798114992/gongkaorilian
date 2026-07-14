import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the 公考日练 product shell replaces the starter", async () => {
  const [page, app, layout, css] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/DailyPracticeApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(page, /公考日练/);
  assert.match(app, /今日安排/);
  assert.match(app, /错题回炉/);
  assert.match(app, /DEMO-7DAYS-2026/);
  assert.match(layout, /lang="zh-CN"/);
  assert.match(css, /--navy:\s*#163861/);
  assert.doesNotMatch(`${page}\n${app}\n${layout}`, /codex-preview|react-loading-skeleton|Your site is taking shape/i);
});

test("the admin surface contains code and invitation controls without exposing a secret", async () => {
  const [admin, envExample] = await Promise.all([
    readFile(new URL("../app/admin/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../.env.example", import.meta.url), "utf8"),
  ]);
  assert.match(admin, /运营管理后台/);
  assert.match(admin, /adminCreateCodes/);
  assert.match(admin, /adminUpdateConfig/);
  assert.match(envExample, /replace-with-a-long-random-admin-secret/);
  assert.doesNotMatch(admin, /gkrl-admin-7pX2mQ9vL4sN8cK6/);
});

test("database migrations include durable membership and redemption records", async () => {
  const migration = await readFile(new URL("../drizzle/0000_sweet_may_parker.sql", import.meta.url), "utf8");
  assert.match(migration, /CREATE TABLE `redemption_codes`/);
  assert.match(migration, /CREATE TABLE `membership_ledger`/);
  assert.match(migration, /CREATE TABLE `invite_relations`/);
  assert.match(migration, /redemptions_code_user_uq/);
});

test("the 日练电台 supports the requested listening controls", async () => {
  const [hub, audioData, serviceWorker] = await Promise.all([
    readFile(new URL("../app/AudioHub.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/data/audio.ts", import.meta.url), "utf8"),
    readFile(new URL("../public/sw.js", import.meta.url), "utf8"),
  ]);
  assert.match(hub, /时政电台/);
  assert.match(hub, /申论晨读/);
  assert.match(hub, /错题语音朗读/);
  assert.match(hub, /0\.75/);
  assert.match(hub, /1\.5/);
  assert.match(hub, /循环中/);
  assert.match(hub, /定时/);
  assert.match(hub, /gongkao-audio-v1/);
  assert.match(audioData, /新法解读/);
  assert.match(serviceWorker, /caches\.open/);
});
