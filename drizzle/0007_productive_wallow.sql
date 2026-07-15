CREATE TABLE `admin_audit_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`admin_user_id` integer,
	`username` text DEFAULT 'system' NOT NULL,
	`role` text DEFAULT 'system' NOT NULL,
	`action` text NOT NULL,
	`resource_type` text DEFAULT 'system' NOT NULL,
	`resource_id` text DEFAULT '' NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`result` text DEFAULT 'success' NOT NULL,
	`details_json` text DEFAULT '{}' NOT NULL,
	`ip_address` text DEFAULT '' NOT NULL,
	`user_agent` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `admin_audit_logs_user_time_idx` ON `admin_audit_logs` (`admin_user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `admin_audit_logs_action_time_idx` ON `admin_audit_logs` (`action`,`created_at`);--> statement-breakpoint
CREATE TABLE `admin_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`admin_user_id` integer NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` text NOT NULL,
	`ip_address` text DEFAULT '' NOT NULL,
	`user_agent` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`last_seen_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`revoked_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `admin_sessions_token_hash_unique` ON `admin_sessions` (`token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `admin_sessions_token_hash_uq` ON `admin_sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `admin_sessions_user_expiry_idx` ON `admin_sessions` (`admin_user_id`,`expires_at`);--> statement-breakpoint
CREATE TABLE `admin_users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`username` text NOT NULL,
	`display_name` text NOT NULL,
	`password_hash` text NOT NULL,
	`password_salt` text NOT NULL,
	`password_iterations` integer DEFAULT 210000 NOT NULL,
	`role` text DEFAULT 'read_only' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`last_login_at` text,
	`created_by` integer,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `admin_users_username_unique` ON `admin_users` (`username`);--> statement-breakpoint
CREATE UNIQUE INDEX `admin_users_username_uq` ON `admin_users` (`username`);--> statement-breakpoint
CREATE INDEX `admin_users_status_role_idx` ON `admin_users` (`status`,`role`);--> statement-breakpoint
ALTER TABLE `content_items` ADD `review_note` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `content_items` ADD `submitted_by` integer;--> statement-breakpoint
ALTER TABLE `content_items` ADD `submitted_at` text;--> statement-breakpoint
ALTER TABLE `content_items` ADD `reviewed_by` integer;--> statement-breakpoint
ALTER TABLE `content_items` ADD `reviewed_at` text;