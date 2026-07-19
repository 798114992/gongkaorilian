import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const routeFile = new URL("../app/api/app/route.ts", import.meta.url);

function functionBody(source, name) {
  const start = source.indexOf(`async function ${name}`);
  assert.notEqual(start, -1, `missing function ${name}`);
  const signatureLineEnd = source.indexOf("\n", start);
  const opening = source.lastIndexOf("{", signatureLineEnd);
  assert.ok(opening > start, `missing function body ${name}`);
  let depth = 0;
  for (let index = opening; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(opening + 1, index);
  }
  throw new Error(`unterminated function ${name}`);
}

function preparedSql(source, marker) {
  const prefix = `prepare(\`${marker}`;
  const start = source.indexOf(prefix);
  assert.notEqual(start, -1, `missing SQL ${marker}`);
  const sqlStart = start + "prepare(`".length;
  const end = source.indexOf("`)", sqlStart);
  assert.notEqual(end, -1, `unterminated SQL ${marker}`);
  const sql = source.slice(sqlStart, end);
  assert.doesNotMatch(sql, /\$\{/, `SQL ${marker} must be directly executable`);
  return sql;
}

function atomic(db, operation) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

test("invite-code collision fallback creates a real user before any session can be issued", async () => {
  const route = await readFile(routeFile, "utf8");
  const identityRows = functionBody(route, "ensureIdentityRows");
  const ensureUser = functionBody(route, "ensureUser");
  const sessionLookup = preparedSql(functionBody(route, "sessionUserId"), "SELECT s.user_id FROM user_sessions s");
  const identityUpsert = preparedSql(identityRows, "INSERT INTO users");

  assert.match(identityRows, /attempt < 3/);
  assert.match(identityRows, /compactId\.slice\(0, 16\)/);
  assert.match(identityRows, /crypto\.randomUUID/);
  assert.match(identityUpsert, /ON CONFLICT\(id\) DO UPDATE SET invite_code = users\.invite_code/);
  assert.match(identityUpsert, /RETURNING id/);
  assert.match(identityRows, /throw new Error\("IDENTITY_USER_ROW_NOT_CREATED"\)/);
  assert.ok(ensureUser.indexOf("await ensureIdentityRows(identity.userId)") < ensureUser.indexOf("grantWelcomeTrial(identity.userId)"));
  assert.ok(ensureUser.indexOf("await ensureIdentityRows(identity.userId)") < ensureUser.indexOf("issueUserSession(identity.userId)"));

  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, invite_code TEXT NOT NULL UNIQUE);
    CREATE TABLE user_states (user_id TEXT PRIMARY KEY, progress_json TEXT NOT NULL);
    CREATE TABLE user_sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at TEXT NOT NULL,
      revoked_at TEXT, last_seen_at TEXT
    );
  `);
  const userId = "acct_11111111111111111111111111111111";
  const firstCandidate = "GK1111111111111111";
  const fallbackCandidate = "GK11111111ABCDEF12";
  db.prepare("INSERT INTO users (id, invite_code) VALUES (?, ?)").run("acct_other", firstCandidate);

  for (const candidate of [firstCandidate, fallbackCandidate]) {
    try {
      const ready = db.prepare(identityUpsert).get(userId, candidate);
      if (ready?.id !== userId) continue;
      db.prepare("INSERT OR IGNORE INTO user_states (user_id, progress_json) SELECT id, '{}' FROM users WHERE id = ?").run(userId);
      break;
    } catch (error) {
      assert.match(String(error), /UNIQUE constraint failed: users\.invite_code/);
    }
  }
  assert.equal(db.prepare("SELECT invite_code FROM users WHERE id = ?").get(userId).invite_code, fallbackCandidate);
  assert.deepEqual({ ...db.prepare("SELECT progress_json FROM user_states WHERE user_id = ?").get(userId) }, { progress_json: "{}" });
  assert.equal(db.prepare(identityUpsert).get(userId, "GKSHOULDNOTREPLACE").id, userId);
  assert.equal(db.prepare("SELECT invite_code FROM users WHERE id = ?").get(userId).invite_code, fallbackCandidate,
    "repeated initialization must preserve an already-shared invite code");

  db.prepare(`INSERT INTO user_sessions (token_hash, user_id, expires_at)
    VALUES ('orphan', 'acct_missing', datetime('now', '+1 day'))`).run();
  assert.equal(db.prepare(sessionLookup).get("orphan"), undefined, "orphan sessions must not authenticate");
  db.prepare(`INSERT INTO user_sessions (token_hash, user_id, expires_at)
    VALUES ('valid', ?, datetime('now', '+1 day'))`).run(userId);
  assert.equal(db.prepare(sessionLookup).get("valid").user_id, userId);
});

test("signed device state survives logout without replacing the user credential cookie", async () => {
  const route = await readFile(routeFile, "utf8");
  const ensureUser = functionBody(route, "ensureUser");
  const deviceParser = functionBody(route, "deviceSessionValue");
  const linkDevice = functionBody(route, "linkDeviceAccount");
  const appendCookies = route.slice(route.indexOf("function appendCookies"), route.indexOf("function cookieHeaders"));

  assert.match(route, /const DEVICE_COOKIE = "gkrl_device"/);
  assert.match(route, /const DEVICE_SESSION_PREFIX = "device2"/);
  assert.match(route, /const LEGACY_DEVICE_SESSION_PREFIX = "device1"/);
  assert.match(route, /type DeviceSession = \{ deviceId: string; lastAccountId: string \| null; token: string; linked: boolean \}/);
  assert.match(deviceParser, /anonymousSessionSignature\(value\)/);
  assert.match(deviceParser, /constantTimeStringEqual\(expected, parts\[4\]\)/);
  assert.match(ensureUser, /const deviceSwitchedAccountId[\s\S]*?deviceSession\?\.lastAccountId/);
  assert.match(ensureUser, /signedOutAccountSession[\s\S]*?deviceSession\?\.lastAccountId \?\? null/);
  assert.match(ensureUser, /signal: "signed_device_account_switch"/);
  assert.match(ensureUser, /shouldLinkDeviceAccount[\s\S]*?linkDeviceAccount\(deviceHash, identity\.userId\)/);
  assert.match(linkDevice, /ON CONFLICT\(device_hash, user_id\) DO UPDATE SET last_seen_at = CURRENT_TIMESTAMP/);
  assert.match(appendCookies, /headers\.append\("set-cookie", cookie\)/);
  assert.doesNotMatch(route, /headers\.set\("set-cookie", identity\.setCookie\)/);
  assert.match(route, /setCookie\?: string\[\]/);
});

test("the invite rolling-24-hour cap and same-device gate are authoritative SQL predicates", async () => {
  const route = await readFile(routeFile, "utf8");
  const bindInvite = functionBody(route, "bindInvite");
  const rewardInvite = functionBody(route, "rewardInvite");
  const inviteSql = preparedSql(bindInvite, "INSERT OR IGNORE INTO invite_relations");
  const rewardRiskSql = preparedSql(rewardInvite, "UPDATE invite_relations SET risk_status = 'blocked_same_browser'");
  assert.match(inviteSql, /account_switch_detected/);
  assert.match(inviteSql, /device_account_links invitee_device/);
  assert.match(inviteSql, /datetime\('now', '-1 day'\)/);
  assert.match(inviteSql, /\) < 10/);
  assert.match(rewardRiskSql, /device_account_links invitee_device/);
  assert.match(bindInvite, /Number\(bound\.meta\?\.changes \?\? 0\) === 0/);

  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE invite_relations (
      invitee_id TEXT PRIMARY KEY, inviter_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      bound_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, verified_at TEXT, risk_status TEXT NOT NULL DEFAULT 'clear'
    );
    CREATE TABLE analytics_events (user_id TEXT NOT NULL, event_name TEXT NOT NULL, event_data TEXT NOT NULL);
    CREATE TABLE device_account_links (
      device_hash TEXT NOT NULL, user_id TEXT NOT NULL,
      first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(device_hash, user_id)
    );
  `);
  const inviter = "acct_inviter";
  for (let index = 0; index < 9; index += 1) {
    db.prepare("INSERT INTO invite_relations (invitee_id, inviter_id) VALUES (?, ?)").run(`existing_${index}`, inviter);
  }
  const bind = (invitee, targetInviter = inviter) => db.prepare(inviteSql)
    .run(invitee, targetInviter, invitee, targetInviter, targetInviter, invitee,
      invitee, targetInviter, targetInviter).changes;
  assert.equal(bind("invitee_10"), 1);
  assert.equal(bind("invitee_11"), 0, "the eleventh rolling-24-hour bind must be rejected at write time");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM invite_relations WHERE inviter_id = ?").get(inviter).count, 10);

  db.prepare("INSERT INTO analytics_events (user_id, event_name, event_data) VALUES (?, 'account_switch_detected', ?)")
    .run("risky_invitee", JSON.stringify({ otherUserId: inviter, signal: "signed_device_account_switch" }));
  assert.equal(bind("risky_invitee"), 0, "same signed device must remain blocked after logout/account switch");

  // A -> B -> C on one browser previously produced only direct A-B and B-C
  // events. Durable device links must also make the transitive C -> A attempt
  // fail even though there is no direct analytics event for that pair.
  db.prepare("INSERT INTO device_account_links (device_hash, user_id) VALUES (?, ?)").run("device_chain", "bridge_a");
  db.prepare("INSERT INTO device_account_links (device_hash, user_id) VALUES (?, ?)").run("device_chain", "bridge_b");
  db.prepare("INSERT INTO device_account_links (device_hash, user_id) VALUES (?, ?)").run("device_chain", "bridge_c");
  assert.equal(bind("bridge_c", "bridge_a"), 0, "a three-account same-device bridge must not bind");

  db.prepare("INSERT INTO invite_relations (invitee_id, inviter_id) VALUES ('late_c', 'late_a')").run();
  db.prepare("INSERT INTO device_account_links (device_hash, user_id) VALUES ('late_device', 'late_a'), ('late_device', 'late_c')").run();
  db.prepare(rewardRiskSql).run("late_c");
  assert.deepEqual({ ...db.prepare("SELECT status, risk_status FROM invite_relations WHERE invitee_id = 'late_c'").get() },
    { status: "pending", risk_status: "blocked_same_browser" },
    "a device shared after binding must still be blocked before reward");
});

function redemptionHarness(route) {
  const body = functionBody(route, "redeem");
  return {
    body,
    cleanup: preparedSql(body, "DELETE FROM redemptions"),
    claim: preparedSql(body, "INSERT OR IGNORE INTO redemptions"),
    ledger: preparedSql(body, "INSERT OR IGNORE INTO membership_ledger"),
    extend: preparedSql(body, "UPDATE users SET membership_type = 'duration'"),
    complete: preparedSql(body, "UPDATE redemptions SET status = 'completed'"),
    recount: preparedSql(body, "UPDATE redemption_codes SET used_count = ("),
  };
}

function runRedemptionBatch(db, sql, userId, { fail = false, codeId = 1 } = {}) {
  const sourceId = `redeem:${codeId}:${userId}`;
  return atomic(db, () => {
    db.prepare(sql.cleanup).run(codeId);
    db.prepare(sql.claim).run(userId, userId, codeId);
    const ledger = db.prepare(sql.ledger).run(userId, 7, sourceId, "兑换 7 天会员", codeId, userId);
    db.prepare(sql.extend).run("+7 days", userId);
    db.prepare(sql.complete).run(userId, userId, codeId, userId, userId, sourceId);
    db.prepare(sql.recount).run(codeId, codeId);
    if (fail) db.exec("INSERT INTO table_that_does_not_exist VALUES (1)");
    return ledger.changes;
  });
}

test("redemption claim, ledger, membership and completed capacity commit or roll back together", async () => {
  const route = await readFile(routeFile, "utf8");
  const sql = redemptionHarness(route);
  assert.ok(sql.body.indexOf('existing?.status === "completed"') < sql.body.indexOf('row.status !== "active"'),
    "a committed redemption retry must succeed even after code disable/expiry");
  assert.match(sql.body, /new Set\(\[7, 30, 365\]\)/);
  assert.match(sql.cleanup, /datetime\(redeemed_at\) <= datetime\('now', '-15 minutes'\)/);
  assert.match(sql.claim, /c\.status = 'active'/);
  assert.match(sql.claim, /valid_from[\s\S]*?valid_until/);
  assert.match(sql.recount, /status = 'completed'/);

  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, membership_type TEXT NOT NULL DEFAULT 'duration', membership_end TEXT);
    CREATE TABLE redemption_codes (
      id INTEGER PRIMARY KEY, status TEXT NOT NULL, valid_from TEXT, valid_until TEXT,
      max_uses INTEGER NOT NULL, used_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE redemptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, code_id INTEGER NOT NULL, user_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      membership_before_type TEXT, membership_before_end TEXT,
      membership_after_type TEXT, membership_after_end TEXT,
      completed_at TEXT, redeemed_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(code_id, user_id)
    );
    CREATE TABLE membership_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, delta_days INTEGER NOT NULL,
      source_type TEXT NOT NULL, source_id TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
      UNIQUE(user_id, source_type, source_id)
    );
    INSERT INTO users (id) VALUES ('user_a'), ('user_b'), ('old_user'), ('new_user');
    INSERT INTO redemption_codes (id, status, max_uses) VALUES (1, 'active', 1);
  `);

  assert.throws(() => runRedemptionBatch(db, sql, "user_a", { fail: true }), /table_that_does_not_exist/);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM redemptions").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM membership_ledger").get().count, 0);
  assert.equal(db.prepare("SELECT membership_end FROM users WHERE id = 'user_a'").get().membership_end, null);

  assert.equal(runRedemptionBatch(db, sql, "user_a"), 1);
  const firstEnd = db.prepare("SELECT membership_end FROM users WHERE id = 'user_a'").get().membership_end;
  assert.equal(db.prepare("SELECT status FROM redemptions WHERE user_id = 'user_a'").get().status, "completed");
  assert.deepEqual({ ...db.prepare(`SELECT membership_before_type, membership_before_end,
    membership_after_type, membership_after_end FROM redemptions WHERE user_id = 'user_a'`).get() }, {
    membership_before_type: "duration",
    membership_before_end: null,
    membership_after_type: "duration",
    membership_after_end: firstEnd,
  });
  assert.equal(db.prepare("SELECT used_count FROM redemption_codes WHERE id = 1").get().used_count, 1);
  assert.equal(runRedemptionBatch(db, sql, "user_a"), 0);
  assert.equal(db.prepare("SELECT membership_end FROM users WHERE id = 'user_a'").get().membership_end, firstEnd,
    "an idempotent retry must not add another seven days");

  assert.equal(runRedemptionBatch(db, sql, "user_b"), 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM redemptions WHERE user_id = 'user_b'").get().count, 0,
    "a second user cannot consume a max_uses=1 code");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM membership_ledger").get().count, 1);

  // Rolling deploy regression: an old build may have committed a fresh pending
  // claim just before the new build starts. The new cleanup must not delete and
  // steal that live claim before the old grant batch drains.
  db.prepare("INSERT INTO redemption_codes (id, status, max_uses) VALUES (2, 'active', 1)").run();
  db.prepare("INSERT INTO redemptions (code_id, user_id, status) VALUES (2, 'old_user', 'pending')").run();
  assert.equal(runRedemptionBatch(db, sql, "new_user", { codeId: 2 }), 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM redemptions WHERE code_id = 2 AND user_id = 'new_user'").get().count, 0);
  assert.equal(db.prepare("SELECT membership_end FROM users WHERE id = 'new_user'").get().membership_end, null);

  const oldSource = "redeem:2:old_user";
  atomic(db, () => {
    db.prepare(`INSERT OR IGNORE INTO membership_ledger
      (user_id, delta_days, source_type, source_id, note) VALUES (?, 7, 'redeem', ?, '旧版本在途发放')`)
      .run("old_user", oldSource);
    db.prepare(sql.extend).run("+7 days", "old_user");
    db.prepare(sql.complete).run("old_user", "old_user", 2, "old_user", "old_user", oldSource);
    db.prepare(sql.recount).run(2, 2);
  });
  assert.equal(db.prepare("SELECT used_count FROM redemption_codes WHERE id = 2").get().used_count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM membership_ledger WHERE source_type = 'redeem' AND source_id LIKE 'redeem:2:%'").get().count, 1);
  assert.notEqual(db.prepare("SELECT membership_end FROM users WHERE id = 'old_user'").get().membership_end, null);
});

function paymentHarness(route) {
  const body = functionBody(route, "completeTestPayment");
  return {
    body,
    transaction: preparedSql(body, "INSERT OR IGNORE INTO payment_transactions"),
    grant: preparedSql(body, "INSERT OR IGNORE INTO entitlement_grants"),
    ledger: preparedSql(body, "INSERT OR IGNORE INTO membership_ledger"),
    extend: preparedSql(body, "UPDATE users SET membership_type = 'duration'"),
    order: preparedSql(body, "UPDATE orders SET status = 'paid'"),
    processed: preparedSql(body, "UPDATE payment_transactions SET status = 'processed'"),
  };
}

function runPaymentBatch(db, sql, order, callbackId, { fail = false } = {}) {
  const transactionId = `ptx_${order.id}`;
  const grantId = `grant_${order.id}`;
  return atomic(db, () => {
    db.prepare(sql.transaction).run(transactionId, order.id, `test_${order.id}`, callbackId, 2980, "CNY", "{}");
    const grant = db.prepare(sql.grant).run(grantId, order.userId, "duration-product", order.id, "duration", 7,
      order.id, transactionId, order.id, callbackId);
    db.prepare(sql.ledger).run(order.userId, 7, order.id, "测试订单权益", grantId, order.userId, transactionId, callbackId);
    db.prepare(sql.extend).run("+7 days", order.userId);
    db.prepare(sql.order).run(grantId, order.id, order.userId, transactionId, order.id, callbackId,
      grantId, order.userId, order.id);
    db.prepare(sql.processed).run(transactionId, order.id, callbackId);
    if (fail) db.exec("INSERT INTO table_that_does_not_exist VALUES (1)");
    return grant.changes;
  });
}

test("a test-payment callback can grant only the order that owns its unique transaction", async () => {
  const route = await readFile(routeFile, "utf8");
  const sql = paymentHarness(route);
  assert.match(sql.grant, /WHERE EXISTS[\s\S]*?payment_transactions[\s\S]*?id = \?[\s\S]*?order_id = \?[\s\S]*?callback_id = \?/);
  assert.match(sql.order, /status IN \('created', 'awaiting_test_payment'\)/);
  assert.match(sql.processed, /id = \? AND order_id = \?[\s\S]*?callback_id = \?/);
  const ownershipCheck = sql.body.indexOf("if (!callbackOwner || callbackOwner.order_id !== order.id)");
  const successAnalytics = sql.body.indexOf("VALUES (?, 'test_payment_completed'", ownershipCheck);
  assert.ok(ownershipCheck >= 0 && successAnalytics > ownershipCheck,
    "success analytics must follow authoritative callback ownership");

  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, membership_type TEXT NOT NULL DEFAULT 'duration', membership_end TEXT);
    CREATE TABLE orders (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'awaiting_test_payment',
      entitlement_grant_id TEXT, paid_at TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE payment_transactions (
      id TEXT PRIMARY KEY, order_id TEXT NOT NULL, provider TEXT NOT NULL,
      provider_transaction_id TEXT NOT NULL, callback_id TEXT NOT NULL, event_type TEXT NOT NULL,
      amount_cents INTEGER NOT NULL, currency TEXT NOT NULL, status TEXT NOT NULL,
      raw_payload_json TEXT NOT NULL, processed_at TEXT,
      UNIQUE(provider, provider_transaction_id), UNIQUE(provider, callback_id)
    );
    CREATE TABLE entitlement_grants (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, product_id TEXT, order_id TEXT,
      grant_type TEXT NOT NULL, duration_days INTEGER NOT NULL, source_type TEXT NOT NULL,
      source_id TEXT NOT NULL, status TEXT NOT NULL,
      UNIQUE(user_id, source_type, source_id)
    );
    CREATE TABLE membership_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, delta_days INTEGER NOT NULL,
      source_type TEXT NOT NULL, source_id TEXT NOT NULL, note TEXT NOT NULL,
      UNIQUE(user_id, source_type, source_id)
    );
    INSERT INTO users (id) VALUES ('user_1'), ('user_2'), ('user_3');
    INSERT INTO orders (id, user_id) VALUES ('order_1', 'user_1'), ('order_2', 'user_2'), ('order_3', 'user_3');
  `);

  const callback = "callback-shared-0001";
  assert.equal(runPaymentBatch(db, sql, { id: "order_1", userId: "user_1" }, callback), 1);
  assert.equal(runPaymentBatch(db, sql, { id: "order_2", userId: "user_2" }, callback), 0);
  assert.deepEqual(db.prepare("SELECT id, status FROM orders ORDER BY id").all().map((row) => ({ ...row })), [
    { id: "order_1", status: "paid" },
    { id: "order_2", status: "awaiting_test_payment" },
    { id: "order_3", status: "awaiting_test_payment" },
  ]);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM payment_transactions").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM entitlement_grants").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM membership_ledger").get().count, 1);
  assert.notEqual(db.prepare("SELECT membership_end FROM users WHERE id = 'user_1'").get().membership_end, null);
  assert.equal(db.prepare("SELECT membership_end FROM users WHERE id = 'user_2'").get().membership_end, null);

  assert.throws(() => runPaymentBatch(db, sql, { id: "order_3", userId: "user_3" }, "callback-unique-0003", { fail: true }),
    /table_that_does_not_exist/);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM payment_transactions WHERE order_id = 'order_3'").get().count, 0);
  assert.equal(db.prepare("SELECT status FROM orders WHERE id = 'order_3'").get().status, "awaiting_test_payment");
  assert.equal(db.prepare("SELECT membership_end FROM users WHERE id = 'user_3'").get().membership_end, null);
});
