/**
 * Recomputes frequency and derived importance for every eligible question in
 * the scopes selected by one bank or by all banks containing one reviewed
 * question. It deliberately has a fixed seven-bind shape: no question IDs or
 * knowledge-point values are expanded into placeholders.
 *
 * Bind order:
 *   bank mode   -> [bankId, "bank", "bank", 0, 0, firstYear, recentYear]
 *   review mode -> [0, "review", "review", questionId, version, firstYear, recentYear]
 */
export const QUESTION_VALUE_METRICS_SQL = `
WITH
selected_banks(bank_id) AS MATERIALIZED (
  SELECT CAST(? AS INTEGER) WHERE ? = 'bank'
  UNION
  SELECT DISTINCT reviewed_item.bank_id
  FROM question_bank_items reviewed_item
  JOIN questions reviewed_question ON reviewed_question.id = reviewed_item.question_id
  WHERE ? = 'review'
    AND reviewed_question.id = ?
    AND reviewed_question.version = ?
    AND reviewed_question.truth_verified = 1
    AND reviewed_question.review_status = 'approved'
),
target_scopes(source_exam_type, source_region, subject) AS MATERIALIZED (
  SELECT DISTINCT q.source_exam_type, q.source_region, q.subject
  FROM selected_banks selected
  JOIN question_bank_items qbi ON qbi.bank_id = selected.bank_id
  JOIN questions q ON q.id = qbi.question_id
  WHERE q.truth_verified = 1
    AND q.review_status = 'approved'
),
eligible AS MATERIALIZED (
  SELECT q.id, q.source_exam_type, q.source_region, q.subject, q.module,
    COALESCE(q.sub_type, '') AS sub_type, q.source_batch, q.source_year
  FROM questions q
  JOIN target_scopes scope
    ON scope.source_exam_type = q.source_exam_type
   AND scope.source_region = q.source_region
   AND scope.subject = q.subject
  WHERE q.truth_verified = 1
    AND q.review_status = 'approved'
    AND q.status = 'active'
    AND q.source_year >= ?
    AND q.source_batch <> ''
),
scope_stats AS MATERIALIZED (
  SELECT source_exam_type, source_region, subject,
    COUNT(DISTINCT source_batch) AS paper_count
  FROM eligible
  GROUP BY source_exam_type, source_region, subject
),
group_occurrences AS MATERIALIZED (
  SELECT source_exam_type, source_region, subject, module, sub_type,
    COUNT(DISTINCT source_batch) AS occurrence_count
  FROM eligible
  GROUP BY source_exam_type, source_region, subject, module, sub_type
),
group_years AS MATERIALIZED (
  SELECT DISTINCT source_exam_type, source_region, subject, module, sub_type, source_year
  FROM eligible
),
ranked_years AS MATERIALIZED (
  SELECT source_exam_type, source_region, subject, module, sub_type, source_year,
    ROW_NUMBER() OVER (
      PARTITION BY source_exam_type, source_region, subject, module, sub_type
      ORDER BY source_year DESC
    ) AS year_rank
  FROM group_years
),
year_stats AS MATERIALIZED (
  SELECT source_exam_type, source_region, subject, module, sub_type,
    COUNT(*) AS year_count,
    SUM(CASE WHEN source_year >= ? THEN 1 ELSE 0 END) AS recent_year_count,
    json_group_array(source_year) FILTER (WHERE year_rank <= 5) AS years_json
  FROM ranked_years
  GROUP BY source_exam_type, source_region, subject, module, sub_type
),
question_metrics AS MATERIALIZED (
  SELECT e.id AS question_id,
    occurrences.occurrence_count,
    scope.paper_count,
    years.year_count,
    years.recent_year_count,
    years.years_json,
    CASE
      WHEN occurrences.occurrence_count * 100 >= scope.paper_count * 55 THEN '高频'
      WHEN occurrences.occurrence_count * 100 >= scope.paper_count * 25 THEN '中频'
      ELSE '低频'
    END AS frequency_label,
    MIN(5, 1
      + CASE
          WHEN occurrences.occurrence_count * 100 >= scope.paper_count * 55 THEN 2
          WHEN occurrences.occurrence_count * 100 >= scope.paper_count * 25 THEN 1
          ELSE 0
        END
      + CASE WHEN years.year_count >= 3 THEN 1 ELSE 0 END
      + CASE WHEN years.recent_year_count >= 2 THEN 1 ELSE 0 END
    ) AS calculated_stars,
    printf('近5年同范围%d/%d套试卷出现，覆盖%d个年份，近3年持续%d年',
      occurrences.occurrence_count, scope.paper_count,
      years.year_count, years.recent_year_count) AS importance_reason
  FROM eligible e
  JOIN scope_stats scope
    ON scope.source_exam_type = e.source_exam_type
   AND scope.source_region = e.source_region
   AND scope.subject = e.subject
  JOIN group_occurrences occurrences
    ON occurrences.source_exam_type = e.source_exam_type
   AND occurrences.source_region = e.source_region
   AND occurrences.subject = e.subject
   AND occurrences.module = e.module
   AND occurrences.sub_type = e.sub_type
  JOIN year_stats years
    ON years.source_exam_type = e.source_exam_type
   AND years.source_region = e.source_region
   AND years.subject = e.subject
   AND years.module = e.module
   AND years.sub_type = e.sub_type
)
UPDATE questions SET
  frequency = (SELECT frequency_label FROM question_metrics WHERE question_id = questions.id),
  frequency_occurrences = (SELECT occurrence_count FROM question_metrics WHERE question_id = questions.id),
  frequency_papers = (SELECT paper_count FROM question_metrics WHERE question_id = questions.id),
  frequency_years_json = (SELECT years_json FROM question_metrics WHERE question_id = questions.id),
  frequency_updated_at = CURRENT_TIMESTAMP,
  importance_stars = CASE WHEN importance_override_reason <> '' THEN importance_stars
    ELSE (SELECT calculated_stars FROM question_metrics WHERE question_id = questions.id) END,
  importance_rule_version = CASE WHEN importance_override_reason <> '' THEN importance_rule_version
    ELSE 'importance-v1' END,
  importance_reason = CASE WHEN importance_override_reason <> '' THEN importance_reason
    ELSE (SELECT importance_reason FROM question_metrics WHERE question_id = questions.id) END,
  updated_at = CURRENT_TIMESTAMP
WHERE id IN (SELECT question_id FROM question_metrics)
`;

export function questionValueMetricBindsForBank(bankId, firstYear, recentYear) {
  return [bankId, "bank", "bank", 0, 0, firstYear, recentYear];
}

export function questionValueMetricBindsForReview(questionId, version, firstYear, recentYear) {
  return [0, "review", "review", questionId, version, firstYear, recentYear];
}
