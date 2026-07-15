ALTER TABLE `questions` ADD `reviewed_by` integer;--> statement-breakpoint
ALTER TABLE `questions` ADD `reviewed_at` text;--> statement-breakpoint
ALTER TABLE `questions` ADD `review_note` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `essay_attempts` ADD `rewrite_draft` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `practice_attempts` ADD `apply_status` text DEFAULT 'applied' NOT NULL;--> statement-breakpoint
ALTER TABLE `redemptions` ADD `status` text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE `redemptions` ADD `completed_at` text;--> statement-breakpoint
UPDATE `redemptions` SET `status` = 'completed', `completed_at` = COALESCE(`completed_at`, `redeemed_at`);--> statement-breakpoint
UPDATE `redemption_codes` SET `used_count` = (
  SELECT COUNT(*) FROM `redemptions` WHERE `redemptions`.`code_id` = `redemption_codes`.`id`
);--> statement-breakpoint
UPDATE `questions` SET `review_status` = 'pending_review', `truth_verified_at` = NULL
  WHERE `truth_verified` = 0;--> statement-breakpoint
UPDATE `practice_sessions` SET `status` = 'abandoned', `updated_at` = CURRENT_TIMESTAMP
  WHERE `status` = 'active' AND EXISTS (
    SELECT 1 FROM `practice_sessions` newer
    WHERE newer.`user_id` = `practice_sessions`.`user_id`
      AND newer.`date_key` = `practice_sessions`.`date_key`
      AND newer.`kind` = `practice_sessions`.`kind`
      AND newer.`mode` = `practice_sessions`.`mode`
      AND newer.`status` = 'active'
      AND (newer.`created_at` > `practice_sessions`.`created_at`
        OR (newer.`created_at` = `practice_sessions`.`created_at` AND newer.`id` > `practice_sessions`.`id`))
  );--> statement-breakpoint
UPDATE `practice_attempts` SET `practice_session_id` = NULL
  WHERE `practice_session_id` IS NOT NULL AND EXISTS (
    SELECT 1 FROM `practice_attempts` newer
    WHERE newer.`user_id` = `practice_attempts`.`user_id`
      AND newer.`practice_session_id` = `practice_attempts`.`practice_session_id`
      AND newer.`question_code` = `practice_attempts`.`question_code`
      AND newer.`id` > `practice_attempts`.`id`
  );--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `content_items_job_target_idx`
  ON `content_items` (`content_type`,`status`,json_extract(`payload_json`, '$.targetCode'));--> statement-breakpoint
UPDATE `admin_audit_logs`
  SET `details_json` = '{"redacted":true,"reason":"legacy sensitive audit payload removed"}'
  WHERE lower(`details_json`) LIKE '%"password"%'
    OR lower(`details_json`) LIKE '%"admintoken"%'
    OR lower(`details_json`) LIKE '%"authorization"%'
    OR lower(`details_json`) LIKE '%"codes"%';
