import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const files = {
  route: new URL("../app/api/app/route.ts", import.meta.url),
  shell: new URL("../app/admin/AdminShell.tsx", import.meta.url),
  launch: new URL("../app/admin/(secure)/launch/page.tsx", import.meta.url),
  learner: new URL("../app/DailyPracticeApp.tsx", import.meta.url),
  layout: new URL("../app/layout.tsx", import.meta.url),
};

test("上线中心受后台会话保护并统一登记读取、配置和验收动作", async () => {
  const [route, shell, launch] = await Promise.all([
    readFile(files.route, "utf8"), readFile(files.shell, "utf8"), readFile(files.launch, "utf8"),
  ]);
  assert.match(shell, /label: "上线中心"[\s\S]*?path: "\/admin\/launch"[\s\S]*?permission: "system\.read"/);
  for (const action of ["adminListLaunch", "adminUpdateLaunchPolicy", "adminRunLaunchAudit"]) {
    assert.match(route, new RegExp(`${action}: \\[`), `${action} must be registered in RBAC`);
    assert.match(route, new RegExp(`action === "${action}"`), `${action} must be dispatched`);
  }
  assert.match(launch, /useAdminDomain<LaunchData>\("adminListLaunch"/);
  assert.match(launch, /can\("users\.manage"\)/);
});

test("H5与微信小程序分别验收，微信未接入不会冒充已完成", async () => {
  const [route, launch] = await Promise.all([readFile(files.route, "utf8"), readFile(files.launch, "utf8")]);
  assert.match(route, /const h5Blocking = checks\.filter\(\(check\) => check\.target !== "mini_program" && check\.blocking\)/);
  assert.match(route, /const miniProgramReady = h5Ready && miniBlocking\.every/);
  assert.match(route, /当前仅有H5账号能力，微信openid映射尚未验收/);
  assert.match(route, /未接通前用户端只能承诺站内提醒/);
  assert.match(launch, /这里只记录已实测结果，不保存AppSecret/);
  assert.match(launch, /公众号购买兑换码，小程序内激活/);
});

test("上线门禁覆盖商品、兑换、订单对账、售后和16种典型用户状态", async () => {
  const [route, launch] = await Promise.all([readFile(files.route, "utf8"), readFile(files.launch, "utf8")]);
  for (const id of ["product", "redemption-config", "purchase-entry", "support-contact", "order-reconciliation", "bank-coverage"]) {
    assert.match(route, new RegExp(`id: "${id}"`));
  }
  assert.match(route, /price_cents\) === 2980[\s\S]*?grant_type === "lifetime"/);
  assert.match(route, /const h5Ready = h5Blocking\.every\(\(check\) => check\.state !== "fail"\)/);
  assert.equal((route.match(/user: "/g) ?? []).length >= 16, true);
  assert.match(launch, /用户状态模拟（\$\{data\.scenarios\.length\}）/);
});

test("考生可从我的页面查看账号同步、权益找回和售后规则", async () => {
  const [route, learner, layout] = await Promise.all([
    readFile(files.route, "utf8"), readFile(files.learner, "utf8"), readFile(files.layout, "utf8"),
  ]);
  assert.match(route, /"getSupportInfo"/);
  assert.match(learner, /账号、权益与售后/);
  assert.match(learner, /请勿发送完整兑换码、登录凭证或任何账号密码/);
  assert.match(learner, /在完成真机验收前，本产品不会宣称已支持微信登录或订阅消息/);
  assert.match(layout, /gongkao-rilian-2026\.sanzhu7758\.chatgpt\.site/);
});
