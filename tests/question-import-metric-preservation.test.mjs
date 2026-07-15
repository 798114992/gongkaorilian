import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const routeFile = new URL("../app/api/app/route.ts", import.meta.url);
const managerFile = new URL("../app/admin/QuestionBankManager.tsx", import.meta.url);
const schemaFile = new URL("../db/schema.ts", import.meta.url);

function section(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `missing section ${start}`);
  return source.slice(from, to);
}

test("question imports preserve existing behavior samples unless external replacement is explicit", async () => {
  const [route, manager, schema] = await Promise.all([
    readFile(routeFile, "utf8"), readFile(managerFile, "utf8"), readFile(schemaFile, "utf8"),
  ]);
  const processor = section(route, "async function processQuestionImportChunk", "const INTERNAL_IMPORT_HEADER");
  assert.match(schema, /duplicateStrategy: text\("duplicate_strategy"\).*default\("reject"\)/);
  assert.match(route, /QUESTION_IMPORT_DUPLICATE_STRATEGIES/);
  assert.match(route, /duplicate_strategy, total_rows/);
  assert.match(processor, /duplicateStrategy === "preserve_metrics"/);
  assert.match(processor, /scoreRateAttempts: Number\(existing\.score_rate_attempts/);
  assert.match(processor, /score_rate = CASE WHEN \? = 'replace_external_metrics' THEN excluded\.score_rate ELSE questions\.score_rate END/);
  assert.match(processor, /score_rate_correct = CASE WHEN \? = 'replace_external_metrics'/);
  assert.match(processor, /score_rate_attempts = CASE WHEN \? = 'replace_external_metrics'/);
  assert.match(processor, /可追溯HTTPS来源及有效样本/);
  assert.match(processor, /review_status = 'pending_review'/);
  assert.match(manager, /拒绝覆盖（推荐）/);
  assert.match(manager, /保留现有拿分率样本/);
  assert.match(manager, /replace_external_metrics/);
  assert.match(manager, /平台真实作答样本不会被默认值覆盖/);
});
