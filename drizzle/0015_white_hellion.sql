ALTER TABLE `content_imports` ADD `duplicate_strategy` text DEFAULT 'reject' NOT NULL;--> statement-breakpoint
ALTER TABLE `content_imports` ADD `dispatch_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `content_imports` ADD `next_retry_at` text;--> statement-breakpoint
ALTER TABLE `content_imports` ADD `review_status` text DEFAULT 'draft' NOT NULL;--> statement-breakpoint
ALTER TABLE `content_imports` ADD `submitted_by` integer;--> statement-breakpoint
ALTER TABLE `content_imports` ADD `submitted_at` text;--> statement-breakpoint
ALTER TABLE `content_imports` ADD `reviewed_by` integer;--> statement-breakpoint
ALTER TABLE `content_imports` ADD `reviewed_at` text;--> statement-breakpoint
ALTER TABLE `content_imports` ADD `review_note` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `content_imports` ADD `published_at` text;--> statement-breakpoint
ALTER TABLE `content_imports` ADD `rolled_back_at` text;--> statement-breakpoint
ALTER TABLE `question_imports` ADD `duplicate_strategy` text DEFAULT 'reject' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `analytics_eligible` integer DEFAULT 1 NOT NULL;--> statement-breakpoint

INSERT OR IGNORE INTO `products`
  (`id`, `name`, `description`, `price_cents`, `currency`, `grant_type`, `duration_days`, `public_promise`, `status`, `sort_order`)
VALUES
  ('gkrl-lifetime-2980', '公考日练终身会员', '解锁完整真题日练、多题库组合、智能复习、申论微练与日练电台。', 2980, 'CNY', 'lifetime', NULL, '29.8元一次购买，终身使用', 'active', 10);--> statement-breakpoint

INSERT OR IGNORE INTO `configs` (`key`, `value`) VALUES ('invite_reward_days', '7');--> statement-breakpoint
INSERT OR IGNORE INTO `configs` (`key`, `value`) VALUES ('invitee_reward_days', '3');--> statement-breakpoint
INSERT OR IGNORE INTO `configs` (`key`, `value`) VALUES ('invite_monthly_cap', '30');--> statement-breakpoint
INSERT OR IGNORE INTO `configs` (`key`, `value`) VALUES ('invite_policy_v2', 'applied');--> statement-breakpoint
UPDATE `redemption_codes` SET `status` = 'disabled' WHERE `batch_name` = '内测演示码';--> statement-breakpoint

INSERT OR IGNORE INTO `question_banks`
  (`bank_code`, `name`, `exam_type`, `province`, `exam_year`, `subject`, `description`, `cover_color`, `status`)
VALUES
  ('gk-2027', '2027国考行测', 'national', NULL, 2027, '行测', '按国考命题结构整理，支持后台持续导入真题与专项题。', 'navy', 'draft'),
  ('joint-provincial-2027', '2027省考联考通用', 'special', '多省', 2027, '行测', '用于省考共通模块训练，各省差异题仍放在对应省份独立题库。', 'green', 'draft'),
  ('gd-2027', '2027广东省考行测', 'provincial', '广东', 2027, '行测', '广东省考独立题库，题型、题量与考情单独维护。', 'orange', 'draft'),
  ('zj-2027', '2027浙江省考行测', 'provincial', '浙江', 2027, '行测', '浙江省考独立题库，题型、题量与考情单独维护。', 'blue', 'draft'),
  ('sd-2027', '2027山东省考行测', 'provincial', '山东', 2027, '行测', '山东省考独立题库，题型、题量与考情单独维护。', 'green', 'draft'),
  ('police-post', '公安岗专项', 'special', '全国', NULL, '综合', '面向公安岗考生的专业科目与岗位专项练习。', 'navy', 'draft'),
  ('law-enforcement', '行政执法专项', 'special', '全国', NULL, '综合', '聚焦行政执法类岗位高频法律与实务考点。', 'orange', 'draft'),
  ('public-institution', '事业单位职测', 'special', '全国', NULL, '综合', '事业单位职测与综合应用能力日练入口。', 'blue', 'draft');--> statement-breakpoint

UPDATE `question_banks` AS `qb` SET `status` = 'draft', `updated_at` = CURRENT_TIMESTAMP
WHERE `qb`.`status` = 'published' AND (
  NOT EXISTS (
    SELECT 1 FROM `question_bank_items` `qbi`
    JOIN `questions` `q` ON `q`.`id` = `qbi`.`question_id`
    WHERE `qbi`.`bank_id` = `qb`.`id` AND `q`.`status` = 'active'
  )
  OR EXISTS (
    SELECT 1 FROM `question_bank_items` `qbi`
    JOIN `questions` `q` ON `q`.`id` = `qbi`.`question_id`
    WHERE `qbi`.`bank_id` = `qb`.`id` AND `q`.`status` = 'active' AND NOT (
      `q`.`truth_verified` = 1 AND `q`.`review_status` = 'approved'
      AND `q`.`source` <> '' AND `q`.`source_region` <> '' AND `q`.`source_year` IS NOT NULL
      AND `q`.`source_batch` <> '' AND `q`.`explanation` <> ''
      AND (`q`.`subject` <> '行测' OR (
        (CASE WHEN json_valid(`q`.`options_json`) THEN json_array_length(`q`.`options_json`) ELSE 0 END) >= 2
        AND instr('ABCDEFGH', `q`.`answer`) >= 1
        AND instr('ABCDEFGH', `q`.`answer`) <=
          (CASE WHEN json_valid(`q`.`options_json`) THEN json_array_length(`q`.`options_json`) ELSE 0 END)
      ))
      AND (
        (`qb`.`exam_type` IN ('national','provincial') AND `q`.`source_exam_type` = `qb`.`exam_type`)
        OR (`qb`.`exam_type` = 'special' AND (
          (replace(replace(replace(replace(replace(replace(replace(trim(COALESCE(`qb`.`province`, '')), '特别行政区', ''), '壮族自治区', ''), '回族自治区', ''), '维吾尔自治区', ''), '自治区', ''), '省', ''), '市', '') = '多省'
            AND `q`.`source_exam_type` = 'provincial')
          OR (replace(replace(replace(replace(replace(replace(replace(trim(COALESCE(`qb`.`province`, '')), '特别行政区', ''), '壮族自治区', ''), '回族自治区', ''), '维吾尔自治区', ''), '自治区', ''), '省', ''), '市', '') <> '多省'
            AND `q`.`source_exam_type` IN ('national','provincial','special'))
        ))
      )
      AND (`qb`.`subject` = '综合' OR `q`.`subject` = `qb`.`subject`)
      AND (`qb`.`exam_type` = 'national' OR COALESCE(`qb`.`province`, '') = ''
        OR replace(replace(replace(replace(replace(replace(replace(trim(COALESCE(`qb`.`province`, '')), '特别行政区', ''), '壮族自治区', ''), '回族自治区', ''), '维吾尔自治区', ''), '自治区', ''), '省', ''), '市', '') IN ('全国','多省')
        OR replace(replace(replace(replace(replace(replace(replace(trim(COALESCE(`qb`.`province`, '')), '特别行政区', ''), '壮族自治区', ''), '回族自治区', ''), '维吾尔自治区', ''), '自治区', ''), '省', ''), '市', '') =
          replace(replace(replace(replace(replace(replace(replace(trim(COALESCE(`q`.`source_region`, '')), '特别行政区', ''), '壮族自治区', ''), '回族自治区', ''), '维吾尔自治区', ''), '自治区', ''), '省', ''), '市', ''))
    )
  )
);--> statement-breakpoint

UPDATE `content_items` SET `status` = 'draft', `publish_at` = NULL, `updated_at` = CURRENT_TIMESTAMP
WHERE `content_type` = 'morning_read' AND `status` IN ('pending_review','published','scheduled') AND (
  json_valid(`payload_json`) = 0
  OR TRIM(COALESCE(json_extract(`payload_json`, '$.title'), '')) = ''
  OR TRIM(COALESCE(json_extract(`payload_json`, '$.body'), '')) = ''
  OR COALESCE(json_extract(`payload_json`, '$.date'), '') NOT GLOB '????-??-??'
  OR TRIM(COALESCE(json_extract(`payload_json`, '$.source'), '')) = ''
  OR COALESCE(json_extract(`payload_json`, '$.sourceUrl'), '') NOT LIKE 'https://%'
  OR COALESCE(json_extract(`payload_json`, '$.sourceDate'), '') NOT GLOB '????-??-??'
);--> statement-breakpoint

UPDATE `content_items` SET `status` = 'draft', `publish_at` = NULL, `updated_at` = CURRENT_TIMESTAMP
WHERE `content_type` = 'current_affairs' AND `status` IN ('pending_review','published','scheduled') AND (
  json_valid(`payload_json`) = 0
  OR TRIM(COALESCE(json_extract(`payload_json`, '$.title'), '')) = ''
  OR TRIM(COALESCE(json_extract(`payload_json`, '$.summary'), '')) = ''
  OR TRIM(COALESCE(json_extract(`payload_json`, '$.body'), '')) = ''
  OR COALESCE(json_extract(`payload_json`, '$.date'), '') NOT GLOB '????-??-??'
  OR CAST(COALESCE(json_extract(`payload_json`, '$.importanceStars'), 0) AS INTEGER) NOT BETWEEN 1 AND 5
  OR TRIM(COALESCE(json_extract(`payload_json`, '$.source'), '')) = ''
  OR COALESCE(json_extract(`payload_json`, '$.sourceUrl'), '') NOT LIKE 'https://%'
  OR COALESCE(json_extract(`payload_json`, '$.sourceDate'), '') NOT GLOB '????-??-??'
);--> statement-breakpoint

UPDATE `content_items` SET `status` = 'draft', `publish_at` = NULL, `updated_at` = CURRENT_TIMESTAMP
WHERE `content_type` = 'essay_micro' AND `status` IN ('pending_review','published','scheduled') AND (
  json_valid(`payload_json`) = 0
  OR TRIM(COALESCE(json_extract(`payload_json`, '$.title'), '')) = ''
  OR TRIM(COALESCE(json_extract(`payload_json`, '$.theme'), '')) = ''
  OR TRIM(COALESCE(json_extract(`payload_json`, '$.material'), '')) = ''
  OR TRIM(COALESCE(json_extract(`payload_json`, '$.prompt'), '')) = ''
  OR TRIM(COALESCE(json_extract(`payload_json`, '$.referenceAnswer'), '')) = ''
  OR CAST(COALESCE(json_extract(`payload_json`, '$.wordLimit'), 0) AS INTEGER) NOT BETWEEN 50 AND 2000
  OR (CASE WHEN json_type(`payload_json`, '$.scoringPoints') = 'array'
      THEN json_array_length(json_extract(`payload_json`, '$.scoringPoints'))
      ELSE LENGTH(TRIM(COALESCE(json_extract(`payload_json`, '$.scoringPoints'), ''))) END) < 1
  OR TRIM(COALESCE(json_extract(`payload_json`, '$.source'), '')) = ''
  OR COALESCE(json_extract(`payload_json`, '$.sourceUrl'), '') NOT LIKE 'https://%'
  OR COALESCE(json_extract(`payload_json`, '$.sourceDate'), '') NOT GLOB '????-??-??'
);--> statement-breakpoint

UPDATE `content_items` SET `status` = 'draft', `publish_at` = NULL, `updated_at` = CURRENT_TIMESTAMP
WHERE `content_type` = 'audio_track' AND `status` IN ('pending_review','published','scheduled') AND (
  json_valid(`payload_json`) = 0
  OR TRIM(COALESCE(json_extract(`payload_json`, '$.title'), '')) = ''
  OR TRIM(COALESCE(json_extract(`payload_json`, '$.seriesId'), '')) = ''
  OR TRIM(COALESCE(json_extract(`payload_json`, '$.seriesTitle'), '')) = ''
  OR TRIM(COALESCE(json_extract(`payload_json`, '$.description'), '')) = ''
  OR TRIM(COALESCE(json_extract(`payload_json`, '$.text'), '')) = ''
  OR TRIM(COALESCE(json_extract(`payload_json`, '$.source'), '')) = ''
  OR COALESCE(json_extract(`payload_json`, '$.sourceUrl'), '') NOT LIKE 'https://%'
  OR COALESCE(json_extract(`payload_json`, '$.sourceDate'), '') NOT GLOB '????-??-??'
);--> statement-breakpoint

UPDATE `content_items` SET `status` = 'draft', `publish_at` = NULL, `updated_at` = CURRENT_TIMESTAMP
WHERE `content_type` = 'exam_notice' AND `status` IN ('pending_review','published','scheduled') AND (
  json_valid(`payload_json`) = 0
  OR TRIM(COALESCE(json_extract(`payload_json`, '$.targetCode'), '')) = ''
  OR TRIM(COALESCE(json_extract(`payload_json`, '$.title'), '')) = ''
  OR TRIM(COALESCE(json_extract(`payload_json`, '$.noticeType'), '')) = ''
  OR TRIM(COALESCE(json_extract(`payload_json`, '$.summary'), '')) = ''
  OR COALESCE(json_extract(`payload_json`, '$.sourceUrl'), '') NOT LIKE 'https://%'
  OR COALESCE(json_extract(`payload_json`, '$.publishDate'), '') NOT GLOB '????-??-??'
);--> statement-breakpoint

UPDATE `content_items` SET `status` = 'draft', `publish_at` = NULL, `updated_at` = CURRENT_TIMESTAMP
WHERE `content_type` = 'exam_event' AND `status` IN ('pending_review','published','scheduled') AND (
  json_valid(`payload_json`) = 0
  OR TRIM(COALESCE(json_extract(`payload_json`, '$.targetCode'), '')) = ''
  OR TRIM(COALESCE(json_extract(`payload_json`, '$.title'), '')) = ''
  OR TRIM(COALESCE(json_extract(`payload_json`, '$.eventType'), '')) = ''
  OR COALESCE(json_extract(`payload_json`, '$.sourceUrl'), '') NOT LIKE 'https://%'
  OR COALESCE(json_extract(`payload_json`, '$.eventDate'), '') NOT GLOB '????-??-??'
  OR CAST(COALESCE(json_extract(`payload_json`, '$.reminderDays'), -1) AS INTEGER) NOT BETWEEN 0 AND 30
);--> statement-breakpoint

UPDATE `content_items` SET `status` = 'draft', `publish_at` = NULL, `updated_at` = CURRENT_TIMESTAMP
WHERE `content_type` = 'job_position' AND `status` IN ('pending_review','published','scheduled') AND (
  json_valid(`payload_json`) = 0
  OR TRIM(COALESCE(json_extract(`payload_json`, '$.targetCode'), '')) = ''
  OR TRIM(COALESCE(json_extract(`payload_json`, '$.examName'), '')) = ''
  OR TRIM(COALESCE(json_extract(`payload_json`, '$.department'), '')) = ''
  OR TRIM(COALESCE(json_extract(`payload_json`, '$.title'), '')) = ''
  OR TRIM(COALESCE(json_extract(`payload_json`, '$.code'), '')) = ''
  OR TRIM(COALESCE(json_extract(`payload_json`, '$.region'), '')) = ''
  OR CAST(COALESCE(json_extract(`payload_json`, '$.recruitCount'), 0) AS INTEGER) NOT BETWEEN 1 AND 9999
  OR COALESCE(json_extract(`payload_json`, '$.sourceUrl'), '') NOT LIKE 'https://%'
  OR COALESCE(json_extract(`payload_json`, '$.updatedAt'), '') NOT GLOB '????-??-??'
  OR CAST(COALESCE(json_extract(`payload_json`, '$.dataVersion'), 0) AS INTEGER) < 1
);--> statement-breakpoint

INSERT OR IGNORE INTO `content_items`
  (`content_type`, `content_key`, `title`, `payload_json`, `access_level`, `status`, `version`)
VALUES
  ('drill_preset', 'drill-data-analysis', '资料分析速算', '{"id":"data-analysis","title":"资料分析速算","subtitle":"5—10分钟一组","icon":"📊","color":"blue","subject":"行测","module":"资料分析","subTypes":[],"questionCount":5,"minutes":8,"sortOrder":10,"enabled":true}', 'free', 'published', 1),
  ('drill_preset', 'drill-graphic-reasoning', '图形判断', '{"id":"graphic-reasoning","title":"图形判断","subtitle":"高频规律微练","icon":"🧩","color":"purple","subject":"行测","module":"判断推理","subTypes":["图形推理"],"questionCount":5,"minutes":8,"sortOrder":20,"enabled":true}', 'free', 'published', 1),
  ('drill_preset', 'drill-idiom', '言语易错成语', '{"id":"idiom","title":"言语易错成语","subtitle":"易混词精练","icon":"📖","color":"orange","subject":"行测","module":"言语理解","subTypes":["选词填空"],"questionCount":5,"minutes":6,"sortOrder":30,"enabled":true}', 'free', 'published', 1),
  ('drill_preset', 'drill-current-affairs', '常识时政', '{"id":"current-affairs","title":"常识时政","subtitle":"高频真题快练","icon":"📰","color":"red","subject":"行测","module":"常识判断","subTypes":["时政"],"questionCount":5,"minutes":5,"sortOrder":40,"enabled":true}', 'free', 'published', 1),
  ('drill_preset', 'drill-essay-expression', '申论规范表达', '{"id":"essay-expression","title":"申论规范表达","subtitle":"从材料到得分词","icon":"✍️","color":"green","subject":"申论","module":"规范表达","subTypes":[],"questionCount":1,"minutes":10,"sortOrder":50,"enabled":true}', 'free', 'published', 1),
  ('strategy_config', 'strategy-default', '默认日练策略', '{"timePlans":{"10":{"morning":0,"practice":10,"essay":0,"questionCount":5},"30":{"morning":5,"practice":20,"essay":5,"questionCount":10},"45":{"morning":5,"practice":30,"essay":10,"questionCount":15},"60":{"morning":10,"practice":35,"essay":15,"questionCount":20}},"reviewIntervals":[1,3,7,14,30],"scoreRateSweetSpot":[40,80],"dueShare":0.6,"urgentDays":30}', 'free', 'published', 1);--> statement-breakpoint

INSERT OR IGNORE INTO `content_item_versions`
  (`content_id`, `version`, `content_type`, `content_key`, `title`, `payload_json`, `access_level`, `status`, `publish_at`, `change_type`)
SELECT `id`, `version`, `content_type`, `content_key`, `title`, `payload_json`, `access_level`, `status`, `publish_at`, 'system_seed'
FROM `content_items`
WHERE `content_key` IN ('drill-data-analysis', 'drill-graphic-reasoning', 'drill-idiom', 'drill-current-affairs', 'drill-essay-expression', 'strategy-default');--> statement-breakpoint

INSERT INTO `configs` (`key`, `value`, `updated_at`)
VALUES ('default_content_seed_version', '1', CURRENT_TIMESTAMP)
ON CONFLICT(`key`) DO UPDATE SET `value` = excluded.`value`, `updated_at` = CURRENT_TIMESTAMP;--> statement-breakpoint
INSERT INTO `configs` (`key`, `value`, `updated_at`)
VALUES ('default_system_seed_version', '2026-07-15-v1', CURRENT_TIMESTAMP)
ON CONFLICT(`key`) DO UPDATE SET `value` = excluded.`value`, `updated_at` = CURRENT_TIMESTAMP;--> statement-breakpoint
INSERT INTO `configs` (`key`, `value`, `updated_at`)
VALUES ('runtime_schema_version', '15', CURRENT_TIMESTAMP)
ON CONFLICT(`key`) DO UPDATE SET `value` = excluded.`value`, `updated_at` = CURRENT_TIMESTAMP;
