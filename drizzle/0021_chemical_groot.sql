CREATE TABLE `essay_answer_sources` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_key` text NOT NULL,
	`name` text NOT NULL,
	`homepage_url` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `essay_answer_sources_key_uq` ON `essay_answer_sources` (`source_key`);--> statement-breakpoint
CREATE INDEX `essay_answer_sources_status_sort_idx` ON `essay_answer_sources` (`status`,`sort_order`);--> statement-breakpoint
CREATE TABLE `essay_library_materials` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`bank_id` integer NOT NULL,
	`label` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`content` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `essay_library_materials_bank_label_uq` ON `essay_library_materials` (`bank_id`,`label`);--> statement-breakpoint
CREATE INDEX `essay_library_materials_bank_sort_idx` ON `essay_library_materials` (`bank_id`,`status`,`sort_order`);--> statement-breakpoint
CREATE TABLE `essay_library_question_materials` (
	`question_id` integer NOT NULL,
	`material_id` integer NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `essay_library_question_materials_uq` ON `essay_library_question_materials` (`question_id`,`material_id`);--> statement-breakpoint
CREATE INDEX `essay_library_question_materials_question_idx` ON `essay_library_question_materials` (`question_id`,`sort_order`);--> statement-breakpoint
CREATE TABLE `essay_reference_answers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`question_id` integer NOT NULL,
	`source_id` integer NOT NULL,
	`source_title` text DEFAULT '' NOT NULL,
	`display_mode` text DEFAULT 'link_only' NOT NULL,
	`content` text DEFAULT '' NOT NULL,
	`excerpt` text DEFAULT '' NOT NULL,
	`source_url` text DEFAULT '' NOT NULL,
	`copyright_status` text DEFAULT 'pending_verification' NOT NULL,
	`publication_status` text DEFAULT 'draft' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`original_published_at` text,
	`collected_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`created_by` integer,
	`updated_by` integer,
	`published_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `essay_reference_answers_question_source_uq` ON `essay_reference_answers` (`question_id`,`source_id`);--> statement-breakpoint
CREATE INDEX `essay_reference_answers_question_status_idx` ON `essay_reference_answers` (`question_id`,`publication_status`,`sort_order`);--> statement-breakpoint
CREATE INDEX `essay_reference_answers_source_idx` ON `essay_reference_answers` (`source_id`,`publication_status`);--> statement-breakpoint
ALTER TABLE `question_bank_items` ADD `question_number` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `question_bank_items` ADD `score` integer;--> statement-breakpoint
ALTER TABLE `question_banks` ADD `paper_type` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `question_banks` ADD `source_url` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `question_banks` ADD `resource_url` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `question_banks` ADD `library_enabled` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `question_banks` ADD `library_status` text DEFAULT 'draft' NOT NULL;--> statement-breakpoint
INSERT INTO `configs` (`key`, `value`, `updated_at`)
VALUES ('runtime_schema_version', '20', CURRENT_TIMESTAMP)
ON CONFLICT(`key`) DO UPDATE SET `value` = excluded.`value`, `updated_at` = CURRENT_TIMESTAMP;
