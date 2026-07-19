ALTER TABLE `redemption_codes` ADD `created_by` text DEFAULT 'system' NOT NULL;--> statement-breakpoint
ALTER TABLE `redemptions` ADD `membership_before_type` text;--> statement-breakpoint
ALTER TABLE `redemptions` ADD `membership_before_end` text;--> statement-breakpoint
ALTER TABLE `redemptions` ADD `membership_after_type` text;--> statement-breakpoint
ALTER TABLE `redemptions` ADD `membership_after_end` text;