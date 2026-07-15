import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const files = {
  worker: new URL("../worker/index.ts", import.meta.url),
  route: new URL("../app/api/app/route.ts", import.meta.url),
  analytics: new URL("../app/admin/(secure)/analytics/page.tsx", import.meta.url),
};

test("API health metrics are persisted asynchronously without delaying responses", async () => {
  const worker = await readFile(files.worker, "utf8");

  assert.match(worker, /const API_METRIC_EVENT = "api_request_metric"/);
  assert.match(worker, /const API_METRIC_USER = "system"/);
  assert.match(worker, /INSERT INTO analytics_events \(user_id, event_name, event_data\)/);
  assert.match(worker, /status,\s*durationMs:/);
  assert.match(worker, /ctx\.waitUntil\(recordApiRequestMetric\(env, request, responseStatus, durationMs\)\)/);
  assert.match(worker, /catch \(error\) \{[\s\S]*API metric write skipped/);
});

test("admin analytics calculates a 30-day real-sample P95 and 5xx rate", async () => {
  const route = await readFile(files.route, "utf8");

  assert.match(route, /event_name = 'api_request_metric'/);
  assert.match(route, /created_at >= datetime\('now','-30 days'\)/);
  assert.match(route, /Math\.ceil\(apiSampleCount \* 0\.95\) - 1/);
  assert.match(route, /ORDER BY CAST\(json_extract\(event_data, '\$\.durationMs'\) AS REAL\) ASC/);
  assert.match(route, /errorRate5xx: apiSampleCount > 0[\s\S]*: null/);
  assert.match(route, /state: apiSampleCount > 0 && apiP95Ms !== null \? "measured" : "collecting"/);
  assert.match(route, /message: apiSampleCount > 0 && apiP95Ms !== null \? "基于近30天真实接口请求" : "等待真实数据"/);
  assert.match(route, /WHERE user_id <> 'system' AND created_at/);
});

test("analytics UI never substitutes fake health values while collection is empty", async () => {
  const analytics = await readFile(files.analytics, "utf8");

  assert.match(analytics, /title="接口健康"/);
  assert.match(analytics, /"采集中"/);
  assert.match(analytics, /"等待真实数据"/);
  assert.match(analytics, /不以模拟值或默认值代替达标结论/);
  assert.match(analytics, /data\.apiHealth\.p95Ms === null[\s\S]*value="--"/);
  assert.match(analytics, /data\.apiHealth\.errorRate5xx === null[\s\S]*value="--"/);
});

