ALTER TABLE `invite_relations` ADD `verified_at` text;--> statement-breakpoint
ALTER TABLE `invite_relations` ADD `first_valid_practice_at` text;--> statement-breakpoint
ALTER TABLE `invite_relations` ADD `risk_status` text DEFAULT 'clear' NOT NULL;--> statement-breakpoint
ALTER TABLE `invite_relations` ADD `inviter_grant_id` text;--> statement-breakpoint
ALTER TABLE `invite_relations` ADD `invitee_grant_id` text;--> statement-breakpoint
ALTER TABLE `redemption_codes` ADD `grant_type` text DEFAULT 'duration' NOT NULL;--> statement-breakpoint
ALTER TABLE `redemption_codes` ADD `channel` text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE `user_states` ADD `version` integer DEFAULT 0 NOT NULL;