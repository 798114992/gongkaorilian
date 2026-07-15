CREATE TABLE `content_reports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`content_type` text DEFAULT 'question' NOT NULL,
	`content_key` text NOT NULL,
	`reason_code` text NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	`context_json` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`resolved_by` integer,
	`resolution_note` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`resolved_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `content_reports_open_uq` ON `content_reports` (`user_id`,`content_type`,`content_key`,`reason_code`) WHERE "content_reports"."status" = 'pending';--> statement-breakpoint
CREATE INDEX `content_reports_status_time_idx` ON `content_reports` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `content_reports_user_time_idx` ON `content_reports` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `content_reports_content_idx` ON `content_reports` (`content_type`,`content_key`);--> statement-breakpoint
DELETE FROM daily_checkins
WHERE session_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM practice_sessions ps WHERE ps.id = daily_checkins.session_id
    AND ps.user_id = daily_checkins.user_id AND ps.date_key = daily_checkins.date_key
    AND ps.kind = 'daily' AND ps.mode = 'mixed' AND ps.status = 'completed'
    AND ps.target_count > 0 AND ps.answered_count >= ps.target_count
);--> statement-breakpoint
INSERT OR IGNORE INTO daily_checkins
  (user_id, date_key, session_id, source, completed_at)
SELECT user_id, date_key, id, 'daily_practice', COALESCE(completed_at, updated_at, created_at, CURRENT_TIMESTAMP)
FROM practice_sessions
WHERE status = 'completed' AND kind = 'daily' AND mode = 'mixed'
  AND target_count > 0 AND answered_count >= target_count;
