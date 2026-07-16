UPDATE `quiz_result_levels`
SET
  `title` = '体制外自由灵魂',
  `min_score` = 0,
  `max_score` = 0,
  `theme` = 'neon',
  `description` = '恭喜你，精准避开了全部正确答案。你不是听不懂，只是每次都坚定地选择了更快乐的答案。',
  `share_text` = '我精准避开了全部正确答案，测出了体制外自由灵魂。',
  `badge_label` = '隐藏结果',
  `sort_order` = 0,
  `status` = 'active',
  `updated_at` = CURRENT_TIMESTAMP
WHERE `quiz_id` = 'quiz-juzhang-thinking' AND `level_key` = 'free_soul';
--> statement-breakpoint
UPDATE `quiz_result_levels`
SET
  `title` = '科员段位·稳了',
  `min_score` = 1,
  `max_score` = 4,
  `theme` = 'blue',
  `description` = '你已经能听懂大部分要求，剩下的主要靠会议纪要保命。',
  `share_text` = '我测出了科员段位·稳了，你能到哪一级？',
  `badge_label` = '1—4题',
  `sort_order` = 10,
  `status` = 'active',
  `updated_at` = CURRENT_TIMESTAMP
WHERE `quiz_id` = 'quiz-juzhang-thinking' AND `level_key` = 'staff';
--> statement-breakpoint
UPDATE `quiz_result_levels`
SET
  `title` = '科长段位·有点稳',
  `min_score` = 5,
  `max_score` = 7,
  `theme` = 'orange',
  `description` = '能接任务、会抓重点，还知道什么时候必须汇报。',
  `share_text` = '我测出了科长段位·有点稳，你来试试？',
  `badge_label` = '5—7题',
  `sort_order` = 20,
  `status` = 'active',
  `updated_at` = CURRENT_TIMESTAMP
WHERE `quiz_id` = 'quiz-juzhang-thinking' AND `level_key` = 'section_chief';
--> statement-breakpoint
UPDATE `quiz_result_levels`
SET
  `title` = '局长段位·建议低调',
  `min_score` = 8,
  `max_score` = 10,
  `theme` = 'gold',
  `description` = '领导刚说上半句，你已经开始安排下半年的工作了。',
  `share_text` = '我测出了局长段位·建议低调，你敢用同一套题挑战吗？',
  `badge_label` = '8—10题',
  `sort_order` = 30,
  `status` = 'active',
  `updated_at` = CURRENT_TIMESTAMP
WHERE `quiz_id` = 'quiz-juzhang-thinking' AND `level_key` = 'director';
--> statement-breakpoint
INSERT INTO `configs` (`key`, `value`, `updated_at`)
VALUES
  ('default_system_seed_version', '2026-07-15-v3', CURRENT_TIMESTAMP),
  ('default_quiz_seed_version', '2', CURRENT_TIMESTAMP)
ON CONFLICT(`key`) DO UPDATE SET `value` = excluded.`value`, `updated_at` = CURRENT_TIMESTAMP;
