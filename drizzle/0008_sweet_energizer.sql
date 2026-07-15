CREATE TABLE `essay_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`question_code` text NOT NULL,
	`date_key` text NOT NULL,
	`stage` text DEFAULT 'draft' NOT NULL,
	`first_draft` text DEFAULT '' NOT NULL,
	`self_checks_json` text DEFAULT '[]' NOT NULL,
	`self_score` integer,
	`loss_reasons_json` text DEFAULT '[]' NOT NULL,
	`revised_draft` text DEFAULT '' NOT NULL,
	`elapsed_seconds` integer DEFAULT 0 NOT NULL,
	`rewrite_due_at` text,
	`submitted_at` text,
	`completed_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `essay_attempts_user_question_date_uq` ON `essay_attempts` (`user_id`,`question_code`,`date_key`);--> statement-breakpoint
CREATE INDEX `essay_attempts_rewrite_due_idx` ON `essay_attempts` (`user_id`,`rewrite_due_at`);--> statement-breakpoint
CREATE TABLE `practice_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`date_key` text NOT NULL,
	`kind` text NOT NULL,
	`mode` text DEFAULT 'mixed' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`plan_minutes` integer DEFAULT 30 NOT NULL,
	`target_count` integer DEFAULT 0 NOT NULL,
	`bank_codes_json` text DEFAULT '[]' NOT NULL,
	`question_codes_json` text DEFAULT '[]' NOT NULL,
	`answered_count` integer DEFAULT 0 NOT NULL,
	`correct_count` integer DEFAULT 0 NOT NULL,
	`review_added` integer DEFAULT 0 NOT NULL,
	`elapsed_seconds` integer DEFAULT 0 NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
CREATE INDEX `practice_sessions_user_date_idx` ON `practice_sessions` (`user_id`,`date_key`);--> statement-breakpoint
CREATE INDEX `practice_sessions_status_idx` ON `practice_sessions` (`user_id`,`status`);--> statement-breakpoint
CREATE TABLE `user_daily_usage` (
	`user_id` text NOT NULL,
	`date_key` text NOT NULL,
	`practice_count` integer DEFAULT 0 NOT NULL,
	`audio_count` integer DEFAULT 0 NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_daily_usage_user_date_uq` ON `user_daily_usage` (`user_id`,`date_key`);--> statement-breakpoint
CREATE TABLE `user_sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` text NOT NULL,
	`revoked_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`last_seen_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `user_sessions_user_expiry_idx` ON `user_sessions` (`user_id`,`expires_at`);--> statement-breakpoint
ALTER TABLE `practice_attempts` ADD `attempt_key` text;--> statement-breakpoint
ALTER TABLE `practice_attempts` ADD `practice_session_id` text;--> statement-breakpoint
ALTER TABLE `practice_attempts` ADD `selected_answer` integer;--> statement-breakpoint
ALTER TABLE `practice_attempts` ADD `was_due` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `practice_attempts_user_key_uq` ON `practice_attempts` (`user_id`,`attempt_key`);--> statement-breakpoint
ALTER TABLE `questions` ADD `source_exam_type` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `questions` ADD `source_batch` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `questions` ADD `truth_verified` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `questions` ADD `truth_verified_at` text;--> statement-breakpoint
ALTER TABLE `questions` ADD `review_status` text DEFAULT 'pending_review' NOT NULL;--> statement-breakpoint
ALTER TABLE `questions` ADD `frequency_occurrences` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `questions` ADD `frequency_papers` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `questions` ADD `frequency_years_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `questions` ADD `frequency_updated_at` text;--> statement-breakpoint
ALTER TABLE `questions` ADD `importance_rule_version` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `questions` ADD `importance_reason` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `questions` ADD `importance_override_reason` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `questions` ADD `score_rate_correct` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `questions` ADD `score_rate_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `questions` ADD `score_rate_scope` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `questions` ADD `score_rate_source` text DEFAULT 'platform' NOT NULL;--> statement-breakpoint
ALTER TABLE `questions` ADD `score_rate_updated_at` text;--> statement-breakpoint
ALTER TABLE `users` ADD `membership_type` text DEFAULT 'duration' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `verified_at` text;
