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
