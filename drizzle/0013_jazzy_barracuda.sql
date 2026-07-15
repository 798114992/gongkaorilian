ALTER TABLE `content_item_versions` ADD `access_level` text DEFAULT 'member' NOT NULL;--> statement-breakpoint
ALTER TABLE `content_items` ADD `access_level` text DEFAULT 'member' NOT NULL;--> statement-breakpoint
ALTER TABLE `media_assets` ADD `access_level` text DEFAULT 'member' NOT NULL;--> statement-breakpoint
UPDATE content_items SET status = 'draft', publish_at = NULL, updated_at = CURRENT_TIMESTAMP
WHERE status IN ('published','scheduled') AND (
  (content_type IN ('morning_read','current_affairs','essay_micro','audio_track') AND (
    COALESCE(json_extract(payload_json,'$.source'),'') = ''
    OR COALESCE(json_extract(payload_json,'$.sourceUrl'),'') NOT LIKE 'https://%'
    OR COALESCE(json_extract(payload_json,'$.sourceDate'),'') NOT GLOB '????-??-??'))
  OR (content_type = 'exam_notice' AND (COALESCE(json_extract(payload_json,'$.sourceUrl'),'') NOT LIKE 'https://%'
    OR COALESCE(json_extract(payload_json,'$.publishDate'),'') NOT GLOB '????-??-??'))
  OR (content_type = 'exam_event' AND (COALESCE(json_extract(payload_json,'$.sourceUrl'),'') NOT LIKE 'https://%'
    OR COALESCE(json_extract(payload_json,'$.eventDate'),'') NOT GLOB '????-??-??'))
  OR (content_type = 'job_position' AND (COALESCE(json_extract(payload_json,'$.sourceUrl'),'') NOT LIKE 'https://%'
    OR COALESCE(json_extract(payload_json,'$.updatedAt'),'') NOT GLOB '????-??-??'
    OR COALESCE(json_extract(payload_json,'$.dataVersion'),0) < 1))
);--> statement-breakpoint
UPDATE content_items SET access_level = 'free'
WHERE content_type IN ('exam_notice','exam_event','drill_preset','strategy_config')
   OR id IN (
     SELECT MIN(id) FROM content_items
     WHERE content_type IN ('practice_day','morning_read','current_affairs','essay_micro','audio_track')
     GROUP BY content_type
   );--> statement-breakpoint
UPDATE content_item_versions
SET access_level = COALESCE((
  SELECT ci.access_level FROM content_items ci WHERE ci.id = content_item_versions.content_id
), 'member');--> statement-breakpoint
UPDATE media_assets SET access_level = 'free'
WHERE EXISTS (
  SELECT 1 FROM content_items ci
  WHERE ci.access_level = 'free'
    AND instr(ci.payload_json, '/api/app?media=' || media_assets.id) > 0
);
--> statement-breakpoint
UPDATE media_assets SET status = 'disabled', updated_at = CURRENT_TIMESTAMP
WHERE status = 'active' AND lower(content_type) NOT IN (
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'audio/wav', 'audio/mpeg', 'audio/aac', 'audio/mp4', 'audio/ogg',
  'application/pdf'
);--> statement-breakpoint
DELETE FROM daily_checkins
WHERE session_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM practice_sessions ps WHERE ps.id = daily_checkins.session_id
    AND ps.user_id = daily_checkins.user_id AND ps.date_key = daily_checkins.date_key
    AND ps.kind = 'daily' AND ps.mode = 'mixed' AND ps.status = 'completed'
    AND ps.target_count >= 5 AND ps.answered_count >= ps.target_count
);--> statement-breakpoint
INSERT OR IGNORE INTO daily_checkins
  (user_id, date_key, session_id, source, completed_at)
SELECT user_id, date_key, id, 'daily_practice', COALESCE(completed_at, updated_at, created_at, CURRENT_TIMESTAMP)
FROM practice_sessions
WHERE status = 'completed' AND kind = 'daily' AND mode = 'mixed'
  AND target_count >= 5 AND answered_count >= target_count;--> statement-breakpoint
DELETE FROM user_sessions
WHERE revoked_at IS NOT NULL OR datetime(expires_at) <= CURRENT_TIMESTAMP;
