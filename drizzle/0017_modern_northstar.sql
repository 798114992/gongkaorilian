CREATE TABLE `device_account_links` (
	`device_hash` text NOT NULL,
	`user_id` text NOT NULL,
	`first_seen_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`last_seen_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_account_links_device_user_uq` ON `device_account_links` (`device_hash`,`user_id`);--> statement-breakpoint
CREATE INDEX `device_account_links_user_device_idx` ON `device_account_links` (`user_id`,`device_hash`);--> statement-breakpoint
ALTER TABLE `question_import_codes` ADD `base_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
INSERT INTO `configs` (`key`, `value`, `updated_at`)
VALUES ('runtime_schema_version', '17', CURRENT_TIMESTAMP)
ON CONFLICT(`key`) DO UPDATE SET `value` = excluded.`value`, `updated_at` = CURRENT_TIMESTAMP;
