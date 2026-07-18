import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("加入今日使用云端队列表，并由日练组题读取优先题库", async () => {
  const [schema, runtime, route, app] = await Promise.all([
    read("db/schema.ts"),
    read("db/runtime.ts"),
    read("app/api/app/route.ts"),
    read("app/DailyPracticeApp.tsx"),
  ]);
  assert.match(schema, /userDailyQueueItems/);
  assert.match(runtime, /RUNTIME_SCHEMA_VERSION = "21"/);
  assert.match(runtime, /upgradeRuntimeSchemaFrom20/);
  assert.match(route, /async function addTodayItem/);
  assert.match(route, /async function updateTodayItem/);
  assert.match(route, /loadTodayBankFocusCodes/);
  assert.match(route, /todayFocusCodes\.filter/);
  assert.match(app, />加入今日</);
  assert.match(app, /plan-basis-disclosure/);
});

test("复习原因日期和申论并排对比已经进入前端闭环", async () => {
  const [route, app, library, css] = await Promise.all([
    read("app/api/app/route.ts"),
    read("app/DailyPracticeApp.tsx"),
    read("app/EssayReferenceLibrary.tsx"),
    read("app/EssayReferenceLibrary.module.css"),
  ]);
  assert.match(route, /async function loadReviewQueue/);
  assert.match(route, /记忆周期到期/);
  assert.match(app, /reviewDateLabel/);
  assert.match(app, /原因：\{learnerWrongReason\(item\.reason\)\}/);
  assert.match(library, /并排对比/);
  assert.match(library, /选择2—3个来源/);
  assert.match(library, /Array\.from\(String\(source\.content/);
  assert.match(css, /\.comparisonGrid/);
});

test("我的页面将兑换与邀请入口置顶，并只折叠低频账户内容", async () => {
  const [app, css] = await Promise.all([
    read("app/DailyPracticeApp.tsx"),
    read("app/globals.css"),
  ]);
  const meStart = app.indexOf('{tab === "me"');
  const redeem = app.indexOf('id="redeem-membership"', meStart);
  const invite = app.indexOf('id="invite-friends"', meStart);
  const overview = app.indexOf('id="me-learning-overview"', meStart);
  assert.ok(meStart >= 0 && redeem > meStart && invite > redeem && overview > invite);
  assert.match(app, /分享邀请码，双方得会员时长/);
  assert.match(app, /邀请码和邀请链接已复制/);
  assert.match(app, /<details className="panel-card ledger-card me-fold-card"/);
  assert.match(css, /\.redeem-panel-primary/);
  assert.match(css, /\.invite-panel-primary/);
  assert.match(css, /\.me-overview-card/);
});
