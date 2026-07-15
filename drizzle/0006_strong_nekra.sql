CREATE TABLE `content_item_versions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`content_id` integer NOT NULL,
	`version` integer NOT NULL,
	`content_type` text NOT NULL,
	`content_key` text NOT NULL,
	`title` text NOT NULL,
	`payload_json` text NOT NULL,
	`status` text NOT NULL,
	`publish_at` text,
	`change_type` text DEFAULT 'update' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `content_item_versions_content_version_uq` ON `content_item_versions` (`content_id`,`version`);--> statement-breakpoint
CREATE INDEX `content_item_versions_content_idx` ON `content_item_versions` (`content_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `media_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`object_key` text NOT NULL,
	`file_name` text NOT NULL,
	`content_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`checksum` text NOT NULL,
	`storage` text DEFAULT 'r2' NOT NULL,
	`fallback_data` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_assets_object_key_unique` ON `media_assets` (`object_key`);--> statement-breakpoint
CREATE INDEX `media_assets_status_idx` ON `media_assets` (`status`,`created_at`);--> statement-breakpoint
ALTER TABLE `content_items` ADD `version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `questions` ADD `source_region` text DEFAULT '全国' NOT NULL;--> statement-breakpoint
ALTER TABLE `questions` ADD `source_year` integer;--> statement-breakpoint
ALTER TABLE `questions` ADD `frequency` text DEFAULT '中频' NOT NULL;--> statement-breakpoint
ALTER TABLE `questions` ADD `importance_stars` integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE `questions` ADD `score_rate` integer DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE `questions` ADD `suggested_seconds` integer DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE `questions` ADD `image_url` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `questions` ADD `resource_url` text DEFAULT '' NOT NULL;