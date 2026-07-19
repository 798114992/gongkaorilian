import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  isEssayAnswerPubliclyVisible,
  sanitizePublicEssayAnswer,
  validateEssayAnswerPublication,
} from "../app/api/app/essay-library-policy.mjs";

const routeFile = new URL("../app/api/app/route.ts", import.meta.url);
const libraryFile = new URL("../app/EssayReferenceLibrary.tsx", import.meta.url);
const learnerAppFile = new URL("../app/DailyPracticeApp.tsx", import.meta.url);
const schemaFile = new URL("../db/schema.ts", import.meta.url);
const adminPageFile = new URL("../app/admin/(secure)/essay-library/page.tsx", import.meta.url);

const fullAnswer = {
  id: 101,
  sourceName: "示例原创来源",
  displayMode: "full",
  copyrightStatus: "original",
  publicationStatus: "published",
  sourceActive: true,
  content: "这是用于自动化测试的原创示例答案，不对应任何真实第三方内容。",
  excerpt: "原创示例答案节选。",
  sourceUrl: "https://example.com/essay/answer-101",
};

function functionSection(source, name) {
  const start = source.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `missing ${name}`);
  const nextAsync = source.indexOf("\nasync function ", start + 1);
  const nextSync = source.indexOf("\nfunction ", start + 1);
  const candidates = [nextAsync, nextSync].filter((index) => index > start);
  return source.slice(start, candidates.length ? Math.min(...candidates) : source.length);
}

test("unlicensed full answers cannot pass the server publication gate", () => {
  for (const copyrightStatus of ["fair_quote", "link_only", "pending_verification"]) {
    const issues = validateEssayAnswerPublication({ ...fullAnswer, copyrightStatus });
    assert.ok(issues.length > 0, `${copyrightStatus} must not authorize a full answer`);
  }

  assert.deepEqual(validateEssayAnswerPublication(fullAnswer), []);
  assert.deepEqual(validateEssayAnswerPublication({ ...fullAnswer, copyrightStatus: "authorized" }), []);
});

test("a verified HTTPS link-only record may publish without copied answer text", () => {
  const linkOnly = {
    ...fullAnswer,
    displayMode: "link_only",
    copyrightStatus: "link_only",
    content: "",
    excerpt: "",
  };

  assert.deepEqual(validateEssayAnswerPublication(linkOnly), []);
  assert.ok(isEssayAnswerPubliclyVisible(linkOnly));
  assert.ok(validateEssayAnswerPublication({ ...linkOnly, sourceUrl: "http://example.com/insecure" }).length > 0);
  assert.ok(validateEssayAnswerPublication({ ...linkOnly, sourceUrl: "" }).length > 0);
  assert.ok(validateEssayAnswerPublication({ ...linkOnly, copyrightStatus: "pending_verification" }).length > 0);
});

test("public answer projection strips content that its display mode cannot expose", () => {
  const linkOnly = sanitizePublicEssayAnswer({
    ...fullAnswer,
    displayMode: "link_only",
    copyrightStatus: "link_only",
  });
  assert.equal(linkOnly.content, "");
  assert.equal(linkOnly.excerpt, "");
  assert.equal(linkOnly.sourceUrl, fullAnswer.sourceUrl);

  const excerpt = sanitizePublicEssayAnswer({
    ...fullAnswer,
    displayMode: "excerpt",
    copyrightStatus: "fair_quote",
  });
  assert.equal(excerpt.content, "");
  assert.equal(excerpt.excerpt, fullAnswer.excerpt);

  const full = sanitizePublicEssayAnswer(fullAnswer);
  assert.equal(full.content, fullAnswer.content);
});

test("public visibility requires published state, an active source and a compliant display policy", () => {
  assert.ok(isEssayAnswerPubliclyVisible(fullAnswer));
  assert.equal(isEssayAnswerPubliclyVisible({ ...fullAnswer, publicationStatus: "draft" }), false);
  assert.equal(isEssayAnswerPubliclyVisible({ ...fullAnswer, publicationStatus: "archived" }), false);
  assert.equal(isEssayAnswerPubliclyVisible({ ...fullAnswer, sourceActive: false }), false);
  assert.equal(isEssayAnswerPubliclyVisible({ ...fullAnswer, copyrightStatus: "pending_verification" }), false);
});

test("the public library API applies the policy before returning answers", async () => {
  const route = await readFile(routeFile, "utf8");
  const handler = functionSection(route, "getEssayReferenceLibrary");

  assert.match(route, /getEssayReferenceLibrary/);
  assert.match(route, /action === "getEssayReferenceLibrary"/);
  assert.match(handler, /essayPaperConditions\(payload, true\)/);
  assert.match(route, /library_status = 'published'/);
  assert.match(handler, /WHERE a\.publication_status = 'published' AND s\.status = 'active'/);
  assert.match(handler, /isEssayAnswerPubliclyVisible/);
  assert.match(handler, /sanitizePublicEssayAnswer/);
  assert.match(handler, /publication_status/);
  assert.match(handler, /source_active/);
  assert.match(handler, /contactEmail/);
});

test("free and member essay resources share one catalog while member bodies stay server protected", async () => {
  const [route, schema, library, learnerApp, adminPage] = await Promise.all([
    readFile(routeFile, "utf8"),
    readFile(schemaFile, "utf8"),
    readFile(libraryFile, "utf8"),
    readFile(learnerAppFile, "utf8"),
    readFile(adminPageFile, "utf8"),
  ]);
  const handler = functionSection(route, "getEssayReferenceLibrary");

  assert.match(schema, /libraryAccessLevel: text\("library_access_level"\)\.notNull\(\)\.default\("free"\)/);
  assert.match(handler, /membershipIsActive\(membership\)/);
  assert.match(handler, /accessLevel: row\.library_access_level === "member" \? "member" : "free"/);
  assert.match(handler, /locked: row\.library_access_level === "member" && !memberAccess/);
  assert.match(handler, /code: "PAYWALL_RESOURCE"/);
  assert.match(route, /getEssayReferenceLibrary\(identity\.userId, payload\)/);
  assert.match(library, /paper\.accessLevel === "member"/);
  assert.match(library, /onUnlockPaper\?\.\(targetPaper\)/);
  assert.match(library, /"会员" : "免费"/);
  assert.match(learnerApp, /memberAccess=\{Boolean\(bootstrap\?\.user\.membershipActive\)\}/);
  assert.match(learnerApp, /openPaywall\("resource"/);
  assert.match(adminPage, /name="accessLevel" label="查看权益"/);
  assert.match(adminPage, /value: "member", label: "会员专享"/);
});

test("answer sources can be disabled at the persistence and RBAC boundaries", async () => {
  const [route, schema] = await Promise.all([
    readFile(routeFile, "utf8"),
    readFile(schemaFile, "utf8"),
  ]);
  const handler = functionSection(route, "adminSetEssayAnswerSourceStatus");

  assert.match(schema, /export const essayAnswerSources[\s\S]*?"essay_answer_sources"[\s\S]{0,1000}?status: text\("status"\)\.notNull\(\)\.default\("active"\)/);
  assert.match(handler, /active/);
  assert.match(handler, /disabled/);
  assert.match(handler, /UPDATE essay_answer_sources SET status = \?/);
  assert.match(route, /adminSetEssayAnswerSourceStatus:\s*\["content\.write"\]/);
  assert.match(route, /action === "adminSetEssayAnswerSourceStatus"/);
});

test("the learner library identifies itself as a reference lookup tool", async () => {
  const library = await readFile(libraryFile, "utf8");
  assert.match(library, /useEffect/);
  assert.match(library, /import \{[\s\S]{0,100}?useEffect/);
  assert.match(library, /申论真题答案对比/);
  assert.match(library, /同一道题，多来源参考答案集中查看/);
  assert.match(library, /来源/);
  assert.match(library, /link_only/);
});

test("copyright contact configuration is reserved for publishing administrators", async () => {
  const route = await readFile(routeFile, "utf8");
  const handler = functionSection(route, "adminUpdateEssayLibrarySettings");
  assert.match(handler, /canAdmin\(payload, "content\.publish"\)/);
  assert.match(route, /adminUpdateEssayLibrarySettings:\s*\["content\.publish"\]/);
});

test("copyright notice is reachable under My > About and contains the approved disclosure", async () => {
  const learnerApp = await readFile(learnerAppFile, "utf8");

  assert.match(learnerApp, /type Tab = [^;]*"me"[^;]*"about"[^;]*"copyright"/);
  assert.match(learnerApp, /onClick=\{\(\) => setTab\("about"\)\}/);
  assert.match(learnerApp, /<b>版权与内容来源说明<\/b>/);
  assert.match(learnerApp, /“公考日练”提供公务员考试相关资料的分类、整理与查询服务/);
  assert.match(learnerApp, /部分试题、材料及参考答案整理自公开可访问的网络资料/);
  assert.match(learnerApp, /相关著作权归原作者或权利人所有/);
  assert.match(learnerApp, /不代表本平台与相关机构存在合作、推荐或背书关系/);
  assert.match(learnerApp, /第三方参考答案，不属于官方标准答案，仅供备考查询参考/);
  assert.match(learnerApp, /权利人姓名或主体名称及联系方式/);
  assert.match(learnerApp, /相关权属证明或授权证明/);
  assert.match(learnerApp, /涉及内容的页面、试卷名称及题号/);
  assert.match(learnerApp, /需要删除、修改或断开链接的具体内容/);
  assert.match(learnerApp, /采取隐藏、删除或断开链接等必要措施/);
  assert.match(learnerApp, /版权联系邮箱/);
  assert.match(learnerApp, /处理时间：工作日9:00—18:00/);
});
