import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  CLAIM_DAILY_FREE_AUDIO_SQL,
  COUNT_DAILY_FREE_AUDIO_SQL,
  dailyAudioPreviewIndex,
} from "../app/api/app/audio-quota.mjs";

function claim(db, userId, dateKey, assetId) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(CLAIM_DAILY_FREE_AUDIO_SQL).run(userId, dateKey, assetId, userId);
    db.prepare(COUNT_DAILY_FREE_AUDIO_SQL).run(userId, dateKey);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return db.prepare("SELECT asset_id FROM user_daily_audio_access WHERE user_id=? AND date_key=?")
    .get(userId, dateKey)?.asset_id === assetId;
}

test("free audio grants exactly one asset per verified account and China date", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY);
    CREATE TABLE user_daily_audio_access (
      user_id TEXT NOT NULL, date_key TEXT NOT NULL, asset_id TEXT NOT NULL,
      granted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX user_daily_audio_access_user_date_uq
      ON user_daily_audio_access(user_id,date_key);
    CREATE TABLE user_daily_usage (
      user_id TEXT NOT NULL, date_key TEXT NOT NULL, practice_count INTEGER NOT NULL DEFAULT 0,
      audio_count INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX user_daily_usage_user_date_uq ON user_daily_usage(user_id,date_key);
    INSERT INTO users(id) VALUES ('u1'),('u2');
  `);

  assert.equal(claim(db, "u1", "2026-07-15", "audio-a"), true);
  assert.equal(claim(db, "u1", "2026-07-15", "audio-a"), true, "Range/replay requests keep the same grant");
  assert.equal(claim(db, "u1", "2026-07-15", "audio-b"), false, "a second asset is denied");
  assert.equal(db.prepare("SELECT audio_count FROM user_daily_usage WHERE user_id='u1' AND date_key='2026-07-15'").get().audio_count, 1);
  assert.equal(claim(db, "u2", "2026-07-15", "audio-b"), true, "quota is isolated by account");
  assert.equal(claim(db, "u1", "2026-07-16", "audio-b"), true, "the next China date has a new grant");
  assert.equal(claim(db, "missing", "2026-07-15", "audio-a"), false, "an unverified identity cannot create a grant");
  db.close();
});

test("learner bootstrap exposes only one rotating preview while media enforces the server grant", async () => {
  const route = await readFile(new URL("../app/api/app/route.ts", import.meta.url), "utf8");
  assert.equal(dailyAudioPreviewIndex("2026-07-15", 0), -1);
  assert.notEqual(dailyAudioPreviewIndex("2026-07-15", 4), dailyAudioPreviewIndex("2026-07-16", 4));
  assert.match(route, /audioTracks: previewAudioTracks/);
  assert.match(route, /published_free_audio_reference/);
  assert.match(route, /identity\.signedIn/);
  assert.match(route, /grantDailyFreeAudio\(identity\.userId, assetId\)/);
  assert.match(route, /PAYWALL_AUDIO_DAILY/);
});
