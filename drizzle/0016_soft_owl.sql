CREATE TABLE `user_daily_audio_access` (
	`user_id` text NOT NULL,
	`date_key` text NOT NULL,
	`asset_id` text NOT NULL,
	`granted_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_daily_audio_access_user_date_uq` ON `user_daily_audio_access` (`user_id`,`date_key`);--> statement-breakpoint
CREATE INDEX `user_daily_audio_access_asset_idx` ON `user_daily_audio_access` (`asset_id`,`date_key`);--> statement-breakpoint
INSERT INTO configs (key, value, updated_at)
VALUES ('runtime_schema_version', '16', CURRENT_TIMESTAMP)
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP;
