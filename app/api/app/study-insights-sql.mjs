// Keep the SQL reliability gate aligned with metricFields().  This fragment is
// exported so the migrated-database test executes the same predicate used by
// the production insights queries instead of maintaining a second copy.
export const RELIABLE_FREQUENCY_SQL = `q.truth_verified = 1
  AND q.frequency_occurrences > 0
  AND q.frequency_papers >= 3
  AND q.frequency_updated_at IS NOT NULL
  AND TRIM(q.frequency_updated_at) <> ''
  AND (
    SELECT COUNT(DISTINCT CAST(frequency_year.value AS INTEGER))
    FROM json_each(
      CASE WHEN json_valid(q.frequency_years_json) THEN q.frequency_years_json ELSE '[]' END
    ) AS frequency_year
    WHERE typeof(frequency_year.value) = 'integer'
      AND CAST(frequency_year.value AS INTEGER) BETWEEN 1990 AND CAST(strftime('%Y', 'now') AS INTEGER)
  ) >= 3`;
