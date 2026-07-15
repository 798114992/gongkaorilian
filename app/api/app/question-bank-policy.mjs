const nonNegativeCount = (value) => Math.max(0, Number(value) || 0);

const canonicalProvince = (value) => {
  const normalized = String(value ?? "").normalize("NFKC").trim();
  if (normalized === "全国" || normalized === "多省") return normalized;
  return normalized
    .replace(/特别行政区$/, "")
    .replace(/壮族自治区$|回族自治区$|维吾尔自治区$|自治区$/, "")
    .replace(/省$|市$/, "");
};

/**
 * The import/review path uses the same scope contract as the publish gate.
 * `question_banks.exam_year` is the learner's target sitting, while
 * `questions.source_year` is the historical paper year shown on the truth
 * label. They must not be forced equal: a 2027 preparation bank legitimately
 * contains Guangdong-2024 questions. A comprehensive bank may contain both
 * 行测 and 申论; provincial/special banks with a province remain isolated.
 */
export function questionMatchesQuestionBankScope(bank, question) {
  const bankExamType = String(bank.examType ?? bank.exam_type ?? "");
  const questionExamType = String(question.sourceExamType ?? question.source_exam_type ?? "");
  const bankSubject = String(bank.subject ?? "");
  const questionSubject = String(question.subject ?? "");
  const bankProvince = canonicalProvince(bank.province);
  const questionProvince = canonicalProvince(question.region ?? question.sourceRegion ?? question.source_region);
  const examTypeMatches = bankExamType === "special"
    ? (bankProvince === "多省" ? questionExamType === "provincial"
      : new Set(["national", "provincial", "special"]).has(questionExamType))
    : bankExamType === questionExamType;
  const provinceMatches = bankExamType === "national"
    || !bankProvince || bankProvince === "全国" || bankProvince === "多省"
    || bankProvince === questionProvince;
  return examTypeMatches
    && (bankSubject === "综合" || bankSubject === questionSubject)
    && provinceMatches;
}

const canonicalProvinceSql = (column) => `(CASE
  WHEN trim(COALESCE(${column}, '')) IN ('全国','多省') THEN trim(COALESCE(${column}, ''))
  ELSE replace(replace(replace(replace(replace(replace(replace(trim(COALESCE(${column}, '')), '特别行政区', ''), '壮族自治区', ''), '回族自治区', ''), '维吾尔自治区', ''), '自治区', ''), '省', ''), '市', '')
END)`;

// SQL fragments intentionally use aliases `qb` and `q`; keeping this contract
// centralized prevents import, publish and learner queries from drifting apart.
export const QUESTION_BANK_SCOPE_MATCH_SQL = `((
    (qb.exam_type IN ('national','provincial') AND q.source_exam_type = qb.exam_type)
    OR (qb.exam_type = 'special' AND (
      (${canonicalProvinceSql("qb.province")} = '多省' AND q.source_exam_type = 'provincial')
      OR (${canonicalProvinceSql("qb.province")} <> '多省'
        AND q.source_exam_type IN ('national','provincial','special'))
    )))
  AND (qb.subject = '综合' OR q.subject = qb.subject)
  AND (qb.exam_type = 'national' OR COALESCE(qb.province, '') = ''
    OR ${canonicalProvinceSql("qb.province")} IN ('全国','多省')
    OR ${canonicalProvinceSql("qb.province")} = ${canonicalProvinceSql("q.source_region")}))`;

export const QUESTION_BANK_PUBLISHABLE_ITEM_SQL = `(q.status = 'active'
  AND q.truth_verified = 1 AND q.review_status = 'approved'
  AND q.source <> '' AND q.source_region <> '' AND q.source_year IS NOT NULL
  AND q.source_batch <> '' AND q.explanation <> ''
  AND (q.subject <> '行测' OR ((CASE WHEN json_valid(q.options_json)
      THEN json_array_length(q.options_json) ELSE 0 END) >= 2
    AND instr('ABCDEFGH', q.answer) >= 1
    AND instr('ABCDEFGH', q.answer) <= (CASE WHEN json_valid(q.options_json)
      THEN json_array_length(q.options_json) ELSE 0 END)))
  AND ${QUESTION_BANK_SCOPE_MATCH_SQL})`;

export const QUESTION_BANK_CAN_PUBLISH_SQL = `(EXISTS (
    SELECT 1 FROM question_bank_items publishable_item
    JOIN questions q ON q.id = publishable_item.question_id
    WHERE publishable_item.bank_id = qb.id AND q.status = 'active'
  )
  AND NOT EXISTS (
    SELECT 1 FROM question_bank_items invalid_item
    JOIN questions q ON q.id = invalid_item.question_id
    WHERE invalid_item.bank_id = qb.id AND q.status = 'active'
      AND NOT ${QUESTION_BANK_PUBLISHABLE_ITEM_SQL}
  )
  AND NOT EXISTS (
    SELECT 1 FROM question_imports active_import
    WHERE active_import.bank_id = qb.id
      AND active_import.status IN ('uploading','queued','processing','cancelling')
  ))`;

/**
 * Keep the identity behind user shelves, imports and practice sessions stable.
 * `bankCode` is immutable from creation; the remaining scope may only change
 * while the bank is a never-published, dependency-free draft.
 */
export function inspectQuestionBankIdentityChange(current, next) {
  const codeChanged = String(current.bankCode ?? "") !== String(next.bankCode ?? "");
  const scopeFields = [
    String(current.examType ?? "") !== String(next.examType ?? "") ? "考试类型" : "",
    String(current.province ?? "") !== String(next.province ?? "") ? "省份" : "",
    String(current.subject ?? "") !== String(next.subject ?? "") ? "科目" : "",
    Number(current.examYear ?? 0) !== Number(next.examYear ?? 0) ? "适用年份" : "",
  ].filter(Boolean);
  const lockReasons = [
    current.status === "published" ? "已发布题库" : "",
    nonNegativeCount(current.questionCount) > 0 ? "已关联题目" : "",
    nonNegativeCount(current.importCount) > 0 ? "已有导入记录" : "",
    nonNegativeCount(current.selectionCount) > 0 ? "已被用户加入书架" : "",
    nonNegativeCount(current.activeSessionCount) > 0 ? "存在进行中的练习" : "",
  ].filter(Boolean);
  return {
    locked: codeChanged || (scopeFields.length > 0 && lockReasons.length > 0),
    codeChanged,
    lockedFields: [...(codeChanged ? ["题库编码"] : []), ...(lockReasons.length ? scopeFields : [])],
    changedScopeFields: scopeFields,
    lockReasons: codeChanged && !lockReasons.length ? ["题库编码创建后永久不可修改"] : lockReasons,
  };
}
