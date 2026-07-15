CREATE TABLE `content_import_chunks` (
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
	`lease_token` text,
	`lease_until` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `content_import_chunks_import_index_uq` ON `content_import_chunks` (`import_id`,`chunk_index`);--> statement-breakpoint
CREATE INDEX `content_import_chunks_status_idx` ON `content_import_chunks` (`import_id`,`status`,`chunk_index`);--> statement-breakpoint
CREATE TABLE `content_import_errors` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`import_id` integer NOT NULL,
	`chunk_index` integer NOT NULL,
	`row_index` integer NOT NULL,
	`content_key` text DEFAULT '' NOT NULL,
	`kind` text NOT NULL,
	`message` text NOT NULL,
	`raw_json` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `content_import_errors_import_row_kind_uq` ON `content_import_errors` (`import_id`,`row_index`,`kind`);--> statement-breakpoint
CREATE INDEX `content_import_errors_import_idx` ON `content_import_errors` (`import_id`,`row_index`);--> statement-breakpoint
CREATE TABLE `content_import_keys` (
	`import_id` integer NOT NULL,
	`row_index` integer NOT NULL,
	`content_key` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `content_import_keys_import_row_uq` ON `content_import_keys` (`import_id`,`row_index`);--> statement-breakpoint
CREATE UNIQUE INDEX `content_import_keys_import_key_uq` ON `content_import_keys` (`import_id`,`content_key`);--> statement-breakpoint
CREATE TABLE `content_import_row_results` (
	`import_id` integer NOT NULL,
	`row_index` integer NOT NULL,
	`chunk_index` integer NOT NULL,
	`status` text NOT NULL,
	`content_key` text DEFAULT '' NOT NULL,
	`content_version` integer,
	`message` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `content_import_row_results_import_row_uq` ON `content_import_row_results` (`import_id`,`row_index`);--> statement-breakpoint
CREATE INDEX `content_import_row_results_status_idx` ON `content_import_row_results` (`import_id`,`status`);--> statement-breakpoint
CREATE TABLE `content_imports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`content_type` text NOT NULL,
	`file_name` text NOT NULL,
	`file_size` integer DEFAULT 0 NOT NULL,
	`file_hash` text NOT NULL,
	`source_name` text DEFAULT '' NOT NULL,
	`source_url` text DEFAULT '' NOT NULL,
	`source_published_at` text,
	`data_version` text DEFAULT '' NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL,
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
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
CREATE INDEX `content_imports_status_idx` ON `content_imports` (`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `content_imports_hash_idx` ON `content_imports` (`file_hash`,`created_at`);--> statement-breakpoint
INSERT INTO configs (key, value, updated_at)
VALUES ('runtime_schema_version', '14', CURRENT_TIMESTAMP)
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP;
