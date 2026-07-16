import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const clientFile = new URL("../app/DailyPracticeApp.tsx", import.meta.url);
const routeFile = new URL("../app/api/app/route.ts", import.meta.url);

test("failed practice answers stay pending locally and retry with a stable idempotency key", async () => {
  const [client, route] = await Promise.all([
    readFile(clientFile, "utf8"),
    readFile(routeFile, "utf8"),
  ]);

  assert.match(client, /gongkao-rilian:pending-practice-attempts:v1/);
  assert.match(client, /attemptKey: `\$\{sessionIdentity\}:\$\{currentPractice\.id\}`/);
  assert.match(client, /isRetryablePracticeError\(error\)/);
  assert.match(client, /upsertPendingPracticeAttempt\(\{/);
  assert.match(client, /removePendingPracticeAttempt\(answerPayload\.attemptKey\)/);
  assert.match(client, /const isNewAttempt = Boolean\(queuedAttempt\) \|\| result\.duplicate !== true/);
  assert.match(client, /恢复联网后自动重试/);
  assert.match(client, /成功前不计入进度/);
  assert.match(client, /当前不能查看解析/);

  assert.match(route, /const attemptKey = `\$\{practiceSessionId\}:\$\{questionCode\}`/);
  assert.match(route, /INSERT OR IGNORE INTO practice_attempts/);
});

test("offline UI never claims an unconfirmed answer was saved", async () => {
  const client = await readFile(clientFile, "utf8");

  assert.match(client, /本题尚未同步/);
  assert.match(client, /待同步记录不会计入进度/);
  assert.match(client, /本次答案尚未保存/);
  assert.match(client, /pendingQueueDurable/);
});
