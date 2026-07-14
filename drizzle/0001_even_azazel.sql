CREATE TABLE `analytics_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`event_name` text NOT NULL,
	`event_data` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `analytics_events_name_time_idx` ON `analytics_events` (`event_name`,`created_at`);--> statement-breakpoint
CREATE INDEX `analytics_events_user_time_idx` ON `analytics_events` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `content_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`content_type` text NOT NULL,
	`content_key` text NOT NULL,
	`title` text NOT NULL,
	`payload_json` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`publish_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `content_items_content_key_unique` ON `content_items` (`content_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `content_items_key_uq` ON `content_items` (`content_key`);