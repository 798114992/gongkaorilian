import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const importComponent = await readFile(new URL("../app/admin/(secure)/essay-library/EssayLibraryBulkImport.tsx", import.meta.url), "utf8");
const adminPage = await readFile(new URL("../app/admin/(secure)/essay-library/page.tsx", import.meta.url), "utf8");

test("申论资料库后台提供模板、上传与预检入口", () => {
  assert.match(adminPage, /EssayLibraryBulkImport/);
  assert.match(importComponent, /下载Excel模板/);
  assert.match(importComponent, /accept="\.xlsx,\.xls,\.csv"/);
  assert.match(importComponent, /MAX_FILE_BYTES = 10 \* 1024 \* 1024/);
  assert.match(importComponent, /MAX_IMPORT_ROWS = 500/);
  assert.match(importComponent, /validateRelations/);
  assert.match(importComponent, /"查看权益"/);
  assert.match(importComponent, /accessLevel: \["会员", "会员专享", "member"\]/);
});

test("申论资料批量导入按依赖顺序复用受保护的既有动作", () => {
  const paper = importComponent.indexOf('action: "adminUpsertEssayPaper"');
  const source = importComponent.indexOf('action: "adminUpsertEssayAnswerSource"');
  const material = importComponent.indexOf('action: "adminUpsertEssayMaterial"');
  const question = importComponent.indexOf('action: "adminUpsertEssayLibraryQuestion"');
  const answer = importComponent.indexOf('action: "adminUpsertEssayReferenceAnswer"');
  assert.ok(paper > 0 && paper < source && source < material && material < question && question < answer);
  assert.match(importComponent, /importBatchId: batchId/);
  assert.match(importComponent, /importFileName: fileName/);
  assert.match(importComponent, /importRow: row\.row/);
});

test("批量导入强制答案草稿且不调用任何发布动作", () => {
  assert.match(importComponent, /publicationStatus: "draft"/);
  assert.doesNotMatch(importComponent, /adminSetEssayPaperStatus/);
  assert.doesNotMatch(importComponent, /adminSetEssayReferenceAnswerStatus/);
  assert.match(importComponent, /全部保存为草稿\/待审核/);
});

test("申论资料库按整套试卷组织连续录入", () => {
  assert.match(adminPage, /试卷工作台/);
  assert.match(adminPage, /保存并继续录入/);
  assert.match(adminPage, /focusPaper\(savedPaperId\)/);
  assert.match(adminPage, /批量导入整套试卷/);
});

test("题目下可以直接维护多来源参考答案", () => {
  assert.match(adminPage, /题目与参考答案/);
  assert.match(adminPage, /renderQuestionAnswers/);
  assert.match(adminPage, /添加参考答案/);
  assert.match(adminPage, /同一道题可以分别添加粉笔、华图等多个来源/);
});

test("前端展示完整度并在缺项时阻止发布", () => {
  assert.match(adminPage, /paperReadiness/);
  assert.match(adminPage, /发布完整度/);
  assert.match(adminPage, /disabled=\{selectedReadiness\.blockers\.length > 0\}/);
  assert.match(adminPage, /发布整套试卷/);
});
