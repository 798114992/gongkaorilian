CREATE TABLE `quiz_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`quiz_id` text NOT NULL,
	`challenge_id` text DEFAULT '' NOT NULL,
	`source_attempt_id` text DEFAULT '' NOT NULL,
	`question_ids_json` text DEFAULT '[]' NOT NULL,
	`option_orders_json` text DEFAULT '[]' NOT NULL,
	`answers_json` text DEFAULT '{}' NOT NULL,
	`correct_count` integer,
	`result_key` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`started_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`completed_at` text,
	`share_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `quiz_attempts_user_time_idx` ON `quiz_attempts` (`user_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `quiz_attempts_quiz_status_idx` ON `quiz_attempts` (`quiz_id`,`status`,`completed_at`);--> statement-breakpoint
CREATE INDEX `quiz_attempts_source_idx` ON `quiz_attempts` (`source_attempt_id`);--> statement-breakpoint
CREATE TABLE `quiz_questions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`quiz_id` text NOT NULL,
	`question_code` text NOT NULL,
	`stem` text NOT NULL,
	`options_json` text DEFAULT '[]' NOT NULL,
	`correct_index` integer DEFAULT 0 NOT NULL,
	`explanation` text DEFAULT '' NOT NULL,
	`category` text DEFAULT '办公室语言' NOT NULL,
	`difficulty` text DEFAULT 'medium' NOT NULL,
	`weight` integer DEFAULT 10 NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`review_status` text DEFAULT 'pending_review' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `quiz_questions_code_uq` ON `quiz_questions` (`question_code`);--> statement-breakpoint
CREATE INDEX `quiz_questions_quiz_status_idx` ON `quiz_questions` (`quiz_id`,`status`,`review_status`);--> statement-breakpoint
CREATE INDEX `quiz_questions_category_idx` ON `quiz_questions` (`quiz_id`,`category`);--> statement-breakpoint
CREATE TABLE `quiz_result_levels` (
	`id` text PRIMARY KEY NOT NULL,
	`quiz_id` text NOT NULL,
	`level_key` text NOT NULL,
	`title` text NOT NULL,
	`min_score` integer NOT NULL,
	`max_score` integer NOT NULL,
	`theme` text DEFAULT 'blue' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`share_text` text DEFAULT '' NOT NULL,
	`badge_label` text DEFAULT '' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `quiz_result_levels_quiz_key_uq` ON `quiz_result_levels` (`quiz_id`,`level_key`);--> statement-breakpoint
CREATE INDEX `quiz_result_levels_quiz_score_idx` ON `quiz_result_levels` (`quiz_id`,`min_score`,`max_score`);--> statement-breakpoint
CREATE TABLE `quiz_share_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`quiz_id` text NOT NULL,
	`attempt_id` text DEFAULT '' NOT NULL,
	`challenge_id` text DEFAULT '' NOT NULL,
	`event_name` text NOT NULL,
	`event_data` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `quiz_share_events_quiz_time_idx` ON `quiz_share_events` (`quiz_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `quiz_share_events_attempt_idx` ON `quiz_share_events` (`attempt_id`,`event_name`);--> statement-breakpoint
CREATE TABLE `quiz_tests` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`question_count` integer DEFAULT 10 NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`share_title` text DEFAULT '' NOT NULL,
	`disclaimer` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `quiz_tests_slug_uq` ON `quiz_tests` (`slug`);--> statement-breakpoint
CREATE INDEX `quiz_tests_status_idx` ON `quiz_tests` (`status`,`updated_at`);
--> statement-breakpoint
INSERT INTO `quiz_tests`
  (`id`, `slug`, `title`, `description`, `question_count`, `status`, `share_title`, `disclaimer`)
VALUES
  ('quiz-juzhang-thinking', 'juzhang-thinking', '测测你有没有“局长”思维？', '随机10道办公室语境判断题，测一测你的体制内语感。', 10, 'published', '我测了测自己的局长思维，你也来试试？', '纯属趣味测试，不构成公务员录用、任职或晋升预测。')
ON CONFLICT(`id`) DO UPDATE SET
  `slug` = excluded.`slug`,
  `title` = excluded.`title`,
  `description` = excluded.`description`,
  `question_count` = excluded.`question_count`,
  `status` = excluded.`status`,
  `share_title` = excluded.`share_title`,
  `disclaimer` = excluded.`disclaimer`,
  `updated_at` = CURRENT_TIMESTAMP;
--> statement-breakpoint
INSERT INTO `quiz_result_levels`
  (`id`, `quiz_id`, `level_key`, `title`, `min_score`, `max_score`, `theme`, `description`, `share_text`, `badge_label`, `sort_order`, `status`)
VALUES
  ('quiz-juzhang-thinking-free_soul', 'quiz-juzhang-thinking', 'free_soul', '体制外自由灵魂', 0, 0, 'neon', '恭喜你，精准避开了全部正确答案。你不是听不懂，只是每次都坚定地选择了更快乐的答案。办公室暂时装不下你。', '我精准避开了10道正确答案，这种成绩你很难复制。', '隐藏结果', 0, 'active'),
  ('quiz-juzhang-thinking-staff', 'quiz-juzhang-thinking', 'staff', '科员你肯定稳了', 1, 4, 'blue', '已经能听懂一部分要求，剩下的主要依靠会议纪要和热心同事。', '我先把科员稳住了，你能混到哪一级？', '稳住基本盘', 10, 'active'),
  ('quiz-juzhang-thinking-section_chief', 'quiz-juzhang-thinking', 'section_chief', '科长你肯定稳了', 5, 7, 'orange', '能听懂话，也知道什么时候应该假装没听懂。距离局长思维，只差两道题和一个保温杯。', '我差一点就局长了，你来试试？', '会听话也会办事', 20, 'active'),
  ('quiz-juzhang-thinking-director', 'quiz-juzhang-thinking', 'director', '局长你肯定稳了', 8, 10, 'gold', '领导刚说完上半句，你已经开始统筹下半年的工作了。建议低调，不要过早暴露统筹能力。', '我测出了局长思维，你敢用同一套题挑战吗？', '统筹能力暴露', 30, 'active')
ON CONFLICT(`quiz_id`, `level_key`) DO UPDATE SET
  `title` = excluded.`title`,
  `min_score` = excluded.`min_score`,
  `max_score` = excluded.`max_score`,
  `theme` = excluded.`theme`,
  `description` = excluded.`description`,
  `share_text` = excluded.`share_text`,
  `badge_label` = excluded.`badge_label`,
  `sort_order` = excluded.`sort_order`,
  `status` = excluded.`status`,
  `updated_at` = CURRENT_TIMESTAMP;
--> statement-breakpoint
INSERT INTO `quiz_questions`
  (`quiz_id`, `question_code`, `stem`, `options_json`, `correct_index`, `explanation`, `category`, `difficulty`, `weight`, `status`, `review_status`, `sort_order`)
VALUES
  ('quiz-juzhang-thinking', 'jz-001', '领导说“这个事原则上是不可以的”，你最应该理解为？', '["可以，但需要补齐条件和流程","绝对不可以，马上撤退","可以，且最好现在就发朋友圈庆祝"]', 0, '“原则上”通常意味着存在边界和例外，关键是把依据、流程、风险说清楚。', '体制内语言', 'easy', 10, 'published', 'approved', 0),
  ('quiz-juzhang-thinking', 'jz-002', '领导说“我不想再说第二遍”，此时最稳的动作是？', '["记录要点并复述确认","点头如捣蒜但什么都不记","认真回答：那我申请听第三遍"]', 0, '高压表达背后是对执行确定性的要求，记录和复述能降低误解。', '执行沟通', 'easy', 10, 'published', 'approved', 10),
  ('quiz-juzhang-thinking', 'jz-003', '会上有人说“这个问题历史原因比较复杂”，你应该优先想到？', '["先梳理现状、历史沿革和责任边界","复杂就别碰，自动进入玄学领域","建议把历史原因交给历史老师"]', 0, '复杂问题不能先站队，先把事实链、时间线和责任边界拆开。', '问题拆解', 'medium', 10, 'published', 'approved', 20),
  ('quiz-juzhang-thinking', 'jz-004', '领导说“你先拿个初稿出来”，初稿最好是什么状态？', '["结构完整、关键数据留痕、可继续修改","随便写三行，突出一个初","用空白文档表达无限可能"]', 0, '初稿不是草率稿，而是让讨论有抓手的版本。', '材料写作', 'easy', 10, 'published', 'approved', 30),
  ('quiz-juzhang-thinking', 'jz-005', '同事说“这个事以前一直这么干”，你最该补一句？', '["现在的依据、风险和口径是否仍然一致","以前这么干，那以后也永远这么干","那就把以前请回来继续干"]', 0, '惯例不能代替依据，尤其政策、权限、流程变化后要重新核对。', '风险意识', 'medium', 10, 'published', 'approved', 40),
  ('quiz-juzhang-thinking', 'jz-006', '领导让你“再完善一下”，最应该先完善哪类内容？', '["目标、依据、措施、责任人和时间节点","字体颜色，先把文档打扮得很努力","增加十页空话，让厚度战胜质疑"]', 0, '完善通常不是加字数，而是让方案更能落地、更可追踪。', '方案意识', 'medium', 10, 'published', 'approved', 50),
  ('quiz-juzhang-thinking', 'jz-007', '有人在群里问一个敏感事项，你还不确定口径，最稳的是？', '["先不公开表态，核对依据后统一回复","凭感觉秒回，主打一个热情","发一个表情包让问题自然消失"]', 0, '不确定口径时，快不如准；统一回复能避免信息不一致。', '口径管理', 'medium', 10, 'published', 'approved', 60),
  ('quiz-juzhang-thinking', 'jz-008', '领导说“你们研究一下”，真实含义更接近？', '["形成可选方案、利弊和建议结论","大家围坐一起认真沉默","研究一下今天吃什么"]', 0, '“研究”不是泛泛讨论，而是给决策者可判断的方案。', '决策支持', 'easy', 10, 'published', 'approved', 70),
  ('quiz-juzhang-thinking', 'jz-009', '材料里出现“持续推进、稳步提升、闭环管理”，你应避免什么？', '["只堆词不落到具体动作和指标","把这些词都背下来，考试和人生都稳了","每个词后面加感叹号增强气势"]', 0, '规范表达要服务于动作和指标，不然就是空转。', '规范表达', 'hard', 10, 'published', 'approved', 80),
  ('quiz-juzhang-thinking', 'jz-010', '一项工作跨多个部门，最容易出问题的是？', '["牵头单位、配合单位、完成时限和反馈机制不清","部门太多，会议室椅子不够","大家都很忙，所以自动变成没人忙"]', 0, '跨部门事项必须先明确牵头、配合、时限和反馈。', '统筹协调', 'hard', 10, 'published', 'approved', 90),
  ('quiz-juzhang-thinking', 'jz-011', '群众反映问题情绪很急，你第一步更应该做什么？', '["先接住诉求，核实事实，再按权限流转","立刻开始讲大道理","告诉对方你也很急，双方达成情绪共鸣"]', 0, '先稳定沟通、核实事实，再依法依规处理。', '群众工作', 'medium', 10, 'published', 'approved', 100),
  ('quiz-juzhang-thinking', 'jz-012', '上级临时要数据，手头数据还没完全校验，你应该？', '["注明口径、时间点和待核部分，先报可确认数据","为了显得完整，先补几个看起来圆润的数","把表格做成彩色，转移注意力"]', 0, '数据可以分阶段报，但口径、时间点和不确定部分必须说清楚。', '数据意识', 'hard', 10, 'published', 'approved', 110)
ON CONFLICT(`question_code`) DO UPDATE SET
  `quiz_id` = excluded.`quiz_id`,
  `stem` = excluded.`stem`,
  `options_json` = excluded.`options_json`,
  `correct_index` = excluded.`correct_index`,
  `explanation` = excluded.`explanation`,
  `category` = excluded.`category`,
  `difficulty` = excluded.`difficulty`,
  `weight` = excluded.`weight`,
  `status` = excluded.`status`,
  `review_status` = excluded.`review_status`,
  `sort_order` = excluded.`sort_order`,
  `updated_at` = CURRENT_TIMESTAMP;
--> statement-breakpoint
INSERT INTO `configs` (`key`, `value`, `updated_at`)
VALUES
  ('runtime_schema_version', '19', CURRENT_TIMESTAMP),
  ('default_system_seed_version', '2026-07-15-v2', CURRENT_TIMESTAMP),
  ('default_quiz_seed_version', '1', CURRENT_TIMESTAMP)
ON CONFLICT(`key`) DO UPDATE SET `value` = excluded.`value`, `updated_at` = CURRENT_TIMESTAMP;
