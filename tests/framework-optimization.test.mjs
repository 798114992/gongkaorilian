import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validatePublishableContent } from "../app/api/app/content-publishability.mjs";

const files = Promise.all([
  readFile(new URL("../app/api/app/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/DailyPracticeApp.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/admin/AdminContentManager.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/admin/(secure)/page.tsx", import.meta.url), "utf8"),
]);

test("资料、营销位和权益策略共用受审核的内容配置体系", async () => {
  const [route, app, admin] = await files;
  for (const type of ["resource_card", "campaign_slot", "paywall_policy"]) {
    assert.match(route, new RegExp(`"${type}"`));
    assert.match(admin, new RegExp(`"${type}"`));
  }
  assert.match(route, /resourceCards: resourceCards\.sort/);
  assert.match(route, /campaignSlots: campaignSlots\.sort/);
  assert.match(route, /paywallPolicies: paywallPolicies\.sort/);
  assert.match(app, /runConfiguredAction/);
  assert.match(app, /isCampaignVisible/);
});

test("新配置类型具有服务端发布门禁", () => {
  assert.deepEqual(validatePublishableContent("resource_card", { title: "资料", summary: "说明", actionLabel: "查看", actionType: "tab" }), []);
  assert.ok(validatePublishableContent("resource_card", { title: "资料", actionType: "javascript" }).length >= 2);
  assert.deepEqual(validatePublishableContent("campaign_slot", { title: "活动", summary: "说明", actionLabel: "参与", slot: "today_after_alerts", actionType: "quiz", maxPerDay: 1, cooldownHours: 24 }), []);
  assert.deepEqual(validatePublishableContent("paywall_policy", { title: "权益", detail: "说明", triggerEvent: "second_bank_attempt", reason: "second_bank", maxPerDay: 1, cooldownHours: 24 }), []);
});

test("权益触发按事件配置且登录、兑换后能够恢复原操作", async () => {
  const [route, app] = await files;
  assert.match(app, /"daily_limit", "second_bank", "essay", "radar", "value_loop"/);
  assert.match(app, /resumeAction === "save_position"/);
  assert.match(app, /resumeAction === "compare_position"/);
  assert.match(app, /const resume = resumeAfterPaywallRef\.current/);
  assert.doesNotMatch(app, /onOpenRedemption=\{\(\) => \{\s*resumeAfterPaywallRef\.current = null/);
  assert.match(route, /resumeAction: new Set\(\["toggle_bank"/);
  assert.match(route, /paywallEvent: trimmed\(source\.paywallEvent/);
});

test("统一运营工作台同时展示转化漏斗和框架配置健康度", async () => {
  const [route, , , dashboard] = await files;
  assert.match(route, /funnel7d:/);
  assert.match(route, /frameworkConfig: configCounts/);
  assert.match(route, /content_imports WHERE status/);
  assert.match(route, /questions WHERE review_status = 'pending'/);
  assert.match(dashboard, /关键转化漏斗/);
  assert.match(dashboard, /框架配置运行状态/);
});
