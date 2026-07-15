CREATE TABLE `daily_step_completions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`date_key` text NOT NULL,
	`step` text NOT NULL,
	`source_ref` text DEFAULT '' NOT NULL,
	`completed_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `daily_step_completions_user_date_step_uq` ON `daily_step_completions` (`user_id`,`date_key`,`step`);--> statement-breakpoint
CREATE INDEX `daily_step_completions_user_completed_idx` ON `daily_step_completions` (`user_id`,`completed_at`);