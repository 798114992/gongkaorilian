ALTER TABLE `practice_attempts` ADD `confidence` text DEFAULT 'confident' NOT NULL;--> statement-breakpoint
ALTER TABLE `practice_attempts` ADD `wrong_reason` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `practice_attempts` ADD `overtime` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `user_question_progress` ADD `review_stage` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `practice_attempts` SET `confidence` = CASE WHEN `uncertain` = 1 THEN 'hesitant' ELSE 'confident' END;--> statement-breakpoint
UPDATE `user_question_progress` SET `review_stage` = CASE
  WHEN `state` = 'mastered' THEN 3
  WHEN `state` = 'learning' THEN 1
  ELSE 0
END;
