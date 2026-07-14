CREATE TABLE `practice_attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`question_code` text NOT NULL,
	`bank_code` text NOT NULL,
	`module` text NOT NULL,
	`is_correct` integer NOT NULL,
	`uncertain` integer DEFAULT 0 NOT NULL,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`answered_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `practice_attempts_user_time_idx` ON `practice_attempts` (`user_id`,`answered_at`);--> statement-breakpoint
CREATE INDEX `practice_attempts_user_module_idx` ON `practice_attempts` (`user_id`,`module`);--> statement-breakpoint
CREATE TABLE `user_exam_profiles` (
	`user_id` text PRIMARY KEY NOT NULL,
	`exam_type` text DEFAULT '国考' NOT NULL,
	`province` text DEFAULT '' NOT NULL,
	`exam_year` integer DEFAULT 2027 NOT NULL,
	`exam_date` text,
	`daily_minutes` integer DEFAULT 20 NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `user_question_banks` (
	`user_id` text NOT NULL,
	`bank_code` text NOT NULL,
	`added_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_question_banks_user_bank_uq` ON `user_question_banks` (`user_id`,`bank_code`);--> statement-breakpoint
CREATE INDEX `user_question_banks_user_idx` ON `user_question_banks` (`user_id`,`added_at`);--> statement-breakpoint
CREATE TABLE `user_question_progress` (
	`user_id` text NOT NULL,
	`question_code` text NOT NULL,
	`state` text DEFAULT 'learning' NOT NULL,
	`correct_count` integer DEFAULT 0 NOT NULL,
	`wrong_count` integer DEFAULT 0 NOT NULL,
	`uncertain_count` integer DEFAULT 0 NOT NULL,
	`last_answer` integer,
	`last_correct` integer DEFAULT 0 NOT NULL,
	`last_duration_ms` integer DEFAULT 0 NOT NULL,
	`last_answered_at` text,
	`next_review_at` text,
	`favorite` integer DEFAULT 0 NOT NULL,
	`wrong_reason` text DEFAULT '' NOT NULL,
	`review_count` integer DEFAULT 0 NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_question_progress_user_question_uq` ON `user_question_progress` (`user_id`,`question_code`);--> statement-breakpoint
CREATE INDEX `user_question_progress_due_idx` ON `user_question_progress` (`user_id`,`next_review_at`);--> statement-breakpoint
CREATE INDEX `user_question_progress_state_idx` ON `user_question_progress` (`user_id`,`state`);