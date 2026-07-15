export const CLAIM_DAILY_FREE_AUDIO_SQL = `INSERT OR IGNORE INTO user_daily_audio_access
  (user_id, date_key, asset_id, granted_at)
  SELECT ?, ?, ?, CURRENT_TIMESTAMP
  WHERE EXISTS (SELECT 1 FROM users WHERE id = ?)`;

export const COUNT_DAILY_FREE_AUDIO_SQL = `INSERT INTO user_daily_usage
  (user_id, date_key, practice_count, audio_count, updated_at)
  SELECT ?, ?, 0, 1, CURRENT_TIMESTAMP WHERE changes() = 1
  ON CONFLICT(user_id, date_key) DO UPDATE SET
    audio_count = user_daily_usage.audio_count + 1,
    updated_at = CURRENT_TIMESTAMP`;

export function dailyAudioPreviewIndex(dateKey, count) {
  if (!Number.isInteger(count) || count < 1) return -1;
  const dayNumber = Number(String(dateKey).replace(/\D/g, ""));
  return Number.isFinite(dayNumber) ? dayNumber % count : 0;
}
