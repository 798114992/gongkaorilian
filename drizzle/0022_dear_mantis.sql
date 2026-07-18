CREATE TABLE `user_daily_queue_items` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`date_key` text NOT NULL,
	`item_type` text NOT NULL,
	`source_id` text NOT NULL,
	`source_parent_id` text DEFAULT '' NOT NULL,
	`title` text NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	`estimated_minutes` integer DEFAULT 5 NOT NULL,
	`status` text DEFAULT 'scheduled' NOT NULL,
	`origin` text DEFAULT 'manual' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_daily_queue_items_user_date_source_uq` ON `user_daily_queue_items` (`user_id`,`date_key`,`item_type`,`source_id`);--> statement-breakpoint
CREATE INDEX `user_daily_queue_items_user_date_status_idx` ON `user_daily_queue_items` (`user_id`,`date_key`,`status`,`sort_order`);--> statement-breakpoint
CREATE INDEX `user_daily_queue_items_user_source_idx` ON `user_daily_queue_items` (`user_id`,`item_type`,`source_id`,`status`);