import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const routeUrl = new URL("../app/api/app/route.ts", import.meta.url);
const managerUrl = new URL("../app/admin/AdminContentManager.tsx", import.meta.url);
const schemaUrl = new URL("../db/schema.ts", import.meta.url);
const publishabilityUrl = new URL("../app/api/app/content-publishability.mjs", import.meta.url);

function asyncFunctionBody(source, name) {
  const start = source.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `missing ${name}`);
  const candidates = [source.indexOf("\nasync function ", start + 1), source.indexOf("\nfunction ", start + 1)]
    .filter((value) => value > start);
  return source.slice(start, candidates.length ? Math.min(...candidates) : source.length);
}

test("content identity and optimistic versions cannot cross admin domains", async () => {
  const [route, manager] = await Promise.all([readFile(routeUrl, "utf8"), readFile(managerUrl, "utf8")]);
  const upsert = asyncFunctionBody(route, "adminUpsertContentBatch");
  assert.match(upsert, /existingType !== contentType[\s\S]*?CONTENT_IDENTITY_CONFLICT/);
  assert.match(upsert, /existingWritePermission[\s\S]*?hasAdminPermission\(admin, existingWritePermission\)/);
  assert.match(upsert, /expectedVersion[\s\S]*?CONTENT_VERSION_CONFLICT/);
  assert.match(upsert, /WHERE id = \? AND version = \?/);
  assert.match(upsert, /payload\.items\.length !== 1[\s\S]*?DURABLE_IMPORT_REQUIRED/);
  assert.doesNotMatch(upsert, /UPDATE content_items SET content_type =/);
  assert.match(manager, /disabled=\{Boolean\(editingId\)\}/);
  assert.match(manager, /expectedVersion: editingVersion/);
});

test("content mutation and version history commit in the same D1 batch", async () => {
  const route = await readFile(routeUrl, "utf8");
  const upsert = asyncFunctionBody(route, "adminUpsertContentBatch");
  const setStatus = asyncFunctionBody(route, "adminSetContentStatus");
  const rollback = asyncFunctionBody(route, "adminRollbackContent");
  const duplicate = asyncFunctionBody(route, "adminDuplicateContent");
  for (const [name, source] of [["upsert", upsert], ["set status", setStatus], ["rollback", rollback]]) {
    assert.match(source, /await db\.batch\(\[/, `${name} must atomically mutate content and write its version`);
    assert.match(source, /INSERT OR IGNORE INTO content_item_versions/);
    assert.match(source, /INSERT OR REPLACE INTO content_item_versions[\s\S]*?SELECT id, version/);
  }
  assert.match(upsert, /const updated = batchResults\[1\][\s\S]*?updated\.meta\.changes/);
  assert.match(setStatus, /const updated = batchResults\[1\][\s\S]*?updated\.meta\.changes/);
  assert.match(rollback, /const updated = batchResults\[1\][\s\S]*?updated\.meta\.changes/);
  assert.match(duplicate, /await db\.batch\(\[[\s\S]*?INSERT INTO content_item_versions[\s\S]*?SELECT id, 1/);
});

test("free and member content are operator-configurable and media uses the same policy", async () => {
  const [route, manager, schema] = await Promise.all([
    readFile(routeUrl, "utf8"), readFile(managerUrl, "utf8"), readFile(schemaUrl, "utf8"),
  ]);
  const loadContent = asyncFunctionBody(route, "loadContent");
  const media = asyncFunctionBody(route, "serveAuthorizedMedia");
  assert.match(schema, /accessLevel: text\("access_level"\)\.notNull\(\)\.default\("member"\)/);
  assert.match(loadContent, /\? = 1 OR access_level = 'free'/);
  assert.match(media, /entitlement\.access_level === "free"/);
  assert.match(media, /ci\.access_level = 'free'/);
  assert.match(media, /published_free_reference/);
  assert.match(manager, /访问权益/);
  assert.match(manager, /adminSetMediaAccess/);
  assert.match(route, /adminSetMediaAccess: \["media\.upload"\]/);
});

test("audio publication requires reviewed managed media with matching access", async () => {
  const [route, manager, audioData] = await Promise.all([
    readFile(routeUrl, "utf8"),
    readFile(managerUrl, "utf8"),
    readFile(new URL("../app/data/audio.ts", import.meta.url), "utf8"),
  ]);
  const upload = asyncFunctionBody(route, "adminUploadMedia");
  const changeAccess = asyncFunctionBody(route, "adminSetMediaAccess");
  const review = asyncFunctionBody(route, "adminReviewContent");
  assert.match(upload, /const accessLevel = "member" as const/);
  assert.match(changeAccess, /MEDIA_REVIEW_REQUIRED/);
  assert.match(review, /db\.batch\(statements\)/);
  assert.match(review, /content_items SET status/);
  assert.match(review, /media_assets AS ma SET access_level = 'free'/);
  assert.match(review, /json_each\(\?\)/);
  assert.match(review, /json_tree\(ci\.payload_json\)/);
  assert.doesNotMatch(review, /for \(const assetId/);
  assert.match(review, /ci\.version = \?/);
  assert.match(review, /reviewedMediaCondition/);
  assert.match(review, /mediaValidation\.referencedAssetIds/);
  assert.match(route, /validateContentMediaAssets/);
  assert.match(route, /MANAGED_MEDIA_REQUIRED/);
  assert.match(manager, /上传文件默认是会员私有媒体/);
  assert.match(manager, /免费试听需关联免费内容并通过审核/);
  assert.doesNotMatch(audioData, /audioUrl:\s*["']\/audio\//);
});

test("source integrity is a server-side review and release gate", async () => {
  const [route, publishability] = await Promise.all([readFile(routeUrl, "utf8"), readFile(publishabilityUrl, "utf8")]);
  const upsert = asyncFunctionBody(route, "adminUpsertContentBatch");
  const setStatus = asyncFunctionBody(route, "adminSetContentStatus");
  const rollback = asyncFunctionBody(route, "adminRollbackContent");
  assert.match(route, /import \{ validatePublishableContent \} from "\.\/content-publishability\.mjs"/);
  assert.match(route, /CONTENT_SOURCE_INCOMPLETE/);
  assert.match(publishability, /requiredHttps\("sourceUrl"/);
  assert.match(publishability, /requiredDate\("updatedAt"/);
  assert.match(publishability, /referenceAnswer/);
  assert.match(publishability, /scoringPoints/);
  assert.match(upsert, /publishabilityError\(contentType, contentKey/);
  assert.match(setStatus, /publishabilityError\(String\(current\.content_type\)/);
  assert.match(rollback, /publishabilityError\(String\(current\.content_type\)/);
  assert.match(route, /id: "source-incomplete"/);
});

test("job radar is server-limited for free users and exposes an explicit upgrade state", async () => {
  const [route, manager] = await Promise.all([
    readFile(routeUrl, "utf8"),
    readFile(new URL("../app/DailyPracticeApp.tsx", import.meta.url), "utf8"),
  ]);
  const search = asyncFunctionBody(route, "searchJobPositions");
  assert.match(search, /membershipIsActive\(membership\)/);
  assert.match(search, /slice\(0, membershipActive \? 32 : 1\)/);
  assert.match(search, /pageSize = membershipActive[\s\S]*?: 3/);
  assert.match(search, /personalizedFilters: false, comparison: false/);
  assert.match(manager, /radarLimited/);
  assert.match(manager, /免费职位预览/);
  assert.match(manager, /openPaywall\("radar"/);
});
