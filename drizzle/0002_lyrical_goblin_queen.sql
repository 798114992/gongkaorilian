CREATE TABLE `question_bank_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`bank_id` integer NOT NULL,
	`question_id` integer NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `question_bank_items_bank_question_uq` ON `question_bank_items` (`bank_id`,`question_id`);--> statement-breakpoint
CREATE INDEX `question_bank_items_bank_idx` ON `question_bank_items` (`bank_id`,`sort_order`);--> statement-breakpoint
CREATE TABLE `question_banks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`bank_code` text NOT NULL,
	`name` text NOT NULL,
	`exam_type` text NOT NULL,
	`province` text,
	`exam_year` integer,
	`subject` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`cover_color` text DEFAULT 'blue' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `question_banks_bank_code_unique` ON `question_banks` (`bank_code`);--> statement-breakpoint
CREATE TABLE `question_imports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`bank_id` integer NOT NULL,
	`file_name` text NOT NULL,
	`file_size` integer DEFAULT 0 NOT NULL,
	`total_rows` integer DEFAULT 0 NOT NULL,
	`imported_rows` integer DEFAULT 0 NOT NULL,
	`failed_rows` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'processing' NOT NULL,
	`error_summary` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
CREATE TABLE `questions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`question_code` text NOT NULL,
	`subject` text NOT NULL,
	`module` text NOT NULL,
	`sub_type` text DEFAULT '' NOT NULL,
	`stem` text NOT NULL,
	`options_json` text DEFAULT '[]' NOT NULL,
	`answer` text,
	`explanation` text DEFAULT '' NOT NULL,
	`technique` text DEFAULT '' NOT NULL,
	`material` text DEFAULT '' NOT NULL,
	`prompt` text DEFAULT '' NOT NULL,
	`word_limit` integer,
	`scoring_points_json` text DEFAULT '[]' NOT NULL,
	`difficulty` text DEFAULT '中等' NOT NULL,
	`source` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `questions_question_code_unique` ON `questions` (`question_code`);--> statement-breakpoint
CREATE INDEX `questions_subject_module_idx` ON `questions` (`subject`,`module`);