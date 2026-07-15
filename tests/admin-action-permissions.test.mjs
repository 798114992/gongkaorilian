import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const routeFile = new URL("../app/api/app/route.ts", import.meta.url);
const managerFile = new URL("../app/admin/AdminContentManager.tsx", import.meta.url);

function section(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing ${startMarker}`);
  assert.notEqual(end, -1, `missing ${endMarker}`);
  return source.slice(start, end);
}

test("every dispatched admin action is registered in the RBAC boundary", async () => {
  const route = await readFile(routeFile, "utf8");
  const permissionMap = section(route, "const ADMIN_ACTION_PERMISSIONS", "const ADMIN_WRITE_ACTIONS");
  const dispatcher = section(route, "async function dispatchAdminAction", "function adminRequestIsSameOrigin");
  const dispatched = [...dispatcher.matchAll(/action === "(admin[A-Za-z0-9]+)"/g)].map((match) => match[1]);
  assert.ok(dispatched.length > 20, "dispatcher extraction unexpectedly small");
  const missing = [...new Set(dispatched)].filter((action) => !new RegExp(`\\b${action}\\s*:`).test(permissionMap));
  assert.deepEqual(missing, [], `admin actions missing permission registration: ${missing.join(", ")}`);
  assert.match(permissionMap, /adminUpsertContentBatch:\s*\["content\.write", "radar\.write"\]/);
  assert.match(permissionMap, /adminSetContentStatus:\s*\["content\.publish", "content\.write", "radar\.write"\]/);
});

test("reviewer republish is an explicit archived-to-published state transition", async () => {
  const [route, manager] = await Promise.all([readFile(routeFile, "utf8"), readFile(managerFile, "utf8")]);
  const statusHandler = section(route, "async function adminSetContentStatus", "async function adminListContentVersions");
  const republishHandler = section(manager, "const republish", "const openVersions");
  assert.match(statusHandler, /status === "published" && String\(current\.status\) === "archived"/);
  assert.match(republishHandler, /action: "adminSetContentStatus"/);
  assert.doesNotMatch(republishHandler, /adminUpsertContentBatch/);
  assert.match(manager, /item\.status === "archived"/);
  assert.match(manager, />重新发布<\/button>/);
});
