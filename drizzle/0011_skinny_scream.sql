CREATE TABLE `daily_checkins` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`date_key` text NOT NULL,
	`session_id` text,
	`source` text DEFAULT 'daily_practice' NOT NULL,
	`completed_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `daily_checkins_user_date_uq` ON `daily_checkins` (`user_id`,`date_key`);--> statement-breakpoint
CREATE INDEX `daily_checkins_user_completed_idx` ON `daily_checkins` (`user_id`,`completed_at`);--> statement-breakpoint
CREATE TABLE `entitlement_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`product_id` text,
	`order_id` text,
	`grant_type` text NOT NULL,
	`duration_days` integer DEFAULT 0 NOT NULL,
	`source_type` text NOT NULL,
	`source_id` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`granted_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`revoked_at` text,
	`revoke_reason` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `entitlement_grants_source_uq` ON `entitlement_grants` (`user_id`,`source_type`,`source_id`);--> statement-breakpoint
CREATE INDEX `entitlement_grants_user_status_idx` ON `entitlement_grants` (`user_id`,`status`);--> statement-breakpoint
CREATE TABLE `orders` (
	`id` text PRIMARY KEY NOT NULL,
	`order_no` text NOT NULL,
	`user_id` text NOT NULL,
	`product_id` text NOT NULL,
	`product_name` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`currency` text DEFAULT 'CNY' NOT NULL,
	`status` text DEFAULT 'created' NOT NULL,
	`channel` text DEFAULT 'test' NOT NULL,
	`idempotency_key` text NOT NULL,
	`return_context_json` text DEFAULT '{}' NOT NULL,
	`entitlement_grant_id` text,
	`paid_at` text,
	`closed_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `orders_order_no_uq` ON `orders` (`order_no`);--> statement-breakpoint
CREATE UNIQUE INDEX `orders_user_idempotency_uq` ON `orders` (`user_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `orders_user_created_idx` ON `orders` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `payment_transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`provider` text DEFAULT 'test' NOT NULL,
	`provider_transaction_id` text NOT NULL,
	`callback_id` text NOT NULL,
	`event_type` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`currency` text DEFAULT 'CNY' NOT NULL,
	`status` text DEFAULT 'received' NOT NULL,
	`raw_payload_json` text DEFAULT '{}' NOT NULL,
	`processed_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_transactions_provider_tx_uq` ON `payment_transactions` (`provider`,`provider_transaction_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `payment_transactions_callback_uq` ON `payment_transactions` (`provider`,`callback_id`);--> statement-breakpoint
CREATE INDEX `payment_transactions_order_idx` ON `payment_transactions` (`order_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `products` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`price_cents` integer NOT NULL,
	`currency` text DEFAULT 'CNY' NOT NULL,
	`grant_type` text NOT NULL,
	`duration_days` integer,
	`public_promise` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `products_status_sort_idx` ON `products` (`status`,`sort_order`);--> statement-breakpoint
CREATE TABLE `question_import_chunks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`import_id` integer NOT NULL,
	`chunk_index` integer NOT NULL,
	`row_offset` integer NOT NULL,
	`row_count` integer NOT NULL,
	`payload_hash` text NOT NULL,
	`rows_json` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`imported_rows` integer DEFAULT 0 NOT NULL,
	`failed_rows` integer DEFAULT 0 NOT NULL,
	`duplicate_rows` integer DEFAULT 0 NOT NULL,
	`error_summary` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `question_import_chunks_import_index_uq` ON `question_import_chunks` (`import_id`,`chunk_index`);--> statement-breakpoint
CREATE INDEX `question_import_chunks_status_idx` ON `question_import_chunks` (`import_id`,`status`,`chunk_index`);--> statement-breakpoint
CREATE TABLE `question_import_codes` (
	`import_id` integer NOT NULL,
	`chunk_index` integer NOT NULL,
	`row_number` integer NOT NULL,
	`question_code` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `question_import_codes_import_row_uq` ON `question_import_codes` (`import_id`,`row_number`);--> statement-breakpoint
CREATE INDEX `question_import_codes_code_idx` ON `question_import_codes` (`import_id`,`question_code`);--> statement-breakpoint
CREATE TABLE `question_import_errors` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`import_id` integer NOT NULL,
	`chunk_index` integer NOT NULL,
	`row_number` integer NOT NULL,
	`question_code` text DEFAULT '' NOT NULL,
	`kind` text DEFAULT 'validation' NOT NULL,
	`message` text NOT NULL,
	`raw_json` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `question_import_errors_import_row_uq` ON `question_import_errors` (`import_id`,`row_number`);--> statement-breakpoint
CREATE INDEX `question_import_errors_import_idx` ON `question_import_errors` (`import_id`,`row_number`);--> statement-breakpoint
CREATE TABLE `question_import_row_results` (
	`import_id` integer NOT NULL,
	`row_number` integer NOT NULL,
	`chunk_index` integer NOT NULL,
	`status` text NOT NULL,
	`question_code` text DEFAULT '' NOT NULL,
	`question_version` integer,
	`message` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `question_import_row_results_import_row_uq` ON `question_import_row_results` (`import_id`,`row_number`);--> statement-breakpoint
CREATE INDEX `question_import_row_results_status_idx` ON `question_import_row_results` (`import_id`,`status`);--> statement-breakpoint
CREATE TABLE `question_versions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`question_id` integer NOT NULL,
	`version` integer NOT NULL,
	`question_code` text NOT NULL,
	`snapshot_json` text NOT NULL,
	`change_type` text DEFAULT 'import' NOT NULL,
	`import_id` integer,
	`source_row` integer,
	`from_version` integer,
	`admin_user_id` integer,
	`review_status` text DEFAULT 'pending_review' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `question_versions_question_version_uq` ON `question_versions` (`question_id`,`version`);--> statement-breakpoint
CREATE UNIQUE INDEX `question_versions_import_row_uq` ON `question_versions` (`import_id`,`source_row`);--> statement-breakpoint
CREATE INDEX `question_versions_question_idx` ON `question_versions` (`question_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `refunds` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`transaction_id` text,
	`provider` text DEFAULT 'test' NOT NULL,
	`provider_refund_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`currency` text DEFAULT 'CNY' NOT NULL,
	`status` text DEFAULT 'created' NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`processed_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `refunds_provider_refund_uq` ON `refunds` (`provider`,`provider_refund_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `refunds_idempotency_uq` ON `refunds` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `refunds_order_idx` ON `refunds` (`order_id`,`created_at`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_question_imports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`bank_id` integer NOT NULL,
	`file_name` text NOT NULL,
	`file_size` integer DEFAULT 0 NOT NULL,
	`file_hash` text DEFAULT '' NOT NULL,
	`total_rows` integer DEFAULT 0 NOT NULL,
	`uploaded_rows` integer DEFAULT 0 NOT NULL,
	`processed_rows` integer DEFAULT 0 NOT NULL,
	`imported_rows` integer DEFAULT 0 NOT NULL,
	`failed_rows` integer DEFAULT 0 NOT NULL,
	`duplicate_rows` integer DEFAULT 0 NOT NULL,
	`total_chunks` integer DEFAULT 0 NOT NULL,
	`uploaded_chunks` integer DEFAULT 0 NOT NULL,
	`processed_chunks` integer DEFAULT 0 NOT NULL,
	`cancel_requested` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'uploading' NOT NULL,
	`error_summary` text DEFAULT '' NOT NULL,
	`created_by` integer,
	`sealed_at` text,
	`started_at` text,
	`last_heartbeat_at` text,
	`lease_token` text,
	`lease_until` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
INSERT INTO `__new_question_imports`(
	"id", "bank_id", "file_name", "file_size", "file_hash", "total_rows", "uploaded_rows", "processed_rows",
	"imported_rows", "failed_rows", "duplicate_rows", "total_chunks", "uploaded_chunks", "processed_chunks",
	"cancel_requested", "status", "error_summary", "created_by", "sealed_at", "started_at", "last_heartbeat_at",
	"lease_token", "lease_until", "created_at", "updated_at", "completed_at"
) SELECT
	"id", "bank_id", "file_name", "file_size", '', "total_rows",
	CASE WHEN "completed_at" IS NOT NULL THEN "total_rows" ELSE "imported_rows" + "failed_rows" END,
	"imported_rows" + "failed_rows", "imported_rows", "failed_rows", 0, 0, 0, 0, 0,
	CASE WHEN "status" = 'processing' AND "completed_at" IS NULL THEN 'failed'
		WHEN "status" = 'completed' AND "failed_rows" > 0 THEN 'completed_with_errors'
		ELSE "status" END,
	CASE WHEN "status" = 'processing' AND "completed_at" IS NULL
		THEN '历史导入任务没有持久化分块，不能安全续传；请重新导入原文件'
		ELSE "error_summary" END,
	NULL, NULL, NULL, NULL, NULL, NULL, "created_at", COALESCE("completed_at", "created_at"), "completed_at"
FROM `question_imports`;--> statement-breakpoint
DROP TABLE `question_imports`;--> statement-breakpoint
ALTER TABLE `__new_question_imports` RENAME TO `question_imports`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
ALTER TABLE `questions` ADD `version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `practice_attempts_session_question_uq` ON `practice_attempts` (`user_id`,`practice_session_id`,`question_code`) WHERE "practice_attempts"."practice_session_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `practice_sessions_active_uq` ON `practice_sessions` (`user_id`,`date_key`,`kind`,`mode`) WHERE "practice_sessions"."status" = 'active';
