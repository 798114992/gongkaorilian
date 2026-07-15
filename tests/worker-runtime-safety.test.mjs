import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Cloudflare Worker module initialization performs no random or request-only operation", async () => {
  const route = await readFile(new URL("../app/api/app/route.ts", import.meta.url), "utf8");
  const signatureAt = route.indexOf("async function anonymousSessionSignature");
  assert.ok(signatureAt > 0, "missing anonymous signature boundary");
  const moduleInitialization = route.slice(0, signatureAt);
  const signature = route.slice(signatureAt, route.indexOf("async function signedAnonymousSession", signatureAt));
  assert.doesNotMatch(moduleInitialization, /crypto\.getRandomValues\(/,
    "Workers reject random generation while evaluating the module global scope");
  assert.match(moduleInitialization, /let processAnonymousSecret: Uint8Array \| null = null/);
  assert.match(signature, /if \(!configured && !processAnonymousSecret\) processAnonymousSecret = crypto\.getRandomValues/);
  assert.match(signature, /USER_SESSION_SECRET/);
});
