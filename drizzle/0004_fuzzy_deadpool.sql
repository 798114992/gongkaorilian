CREATE TABLE `user_exam_targets` (
	`user_id` text NOT NULL,
	`target_code` text NOT NULL,
	`exam_type` text NOT NULL,
	`province` text DEFAULT '' NOT NULL,
	`exam_year` integer NOT NULL,
	`exam_date` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_exam_targets_user_target_uq` ON `user_exam_targets` (`user_id`,`target_code`);--> statement-breakpoint
CREATE INDEX `user_exam_targets_user_idx` ON `user_exam_targets` (`user_id`,`created_at`);