"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Steps, Tag, Typography } from "antd";

export type QuestionBankItem = {
  id: number;
  bank_code: string;
  name: string;
  exam_type: "national" | "provincial" | "special";
  province: string | null;
  exam_year: number | null;
  subject: "行测" | "申论" | "综合";
  description: string;
  cover_color: "blue" | "orange" | "green" | "purple";
  status: "draft" | "published";
  question_count: number | string;
  import_count?: number | string;
  selection_count?: number | string;
  active_session_count?: number | string;
  updated_at: string;
};

export type QuestionImportItem = {
  id: number;
  bank_id: number;
  bank_name: string;
  file_name: string;
  file_size: number;
  file_hash: string;
  duplicate_strategy?: "reject" | "preserve_metrics" | "replace_external_metrics";
  total_rows: number;
  uploaded_rows: number;
  processed_rows: number;
  imported_rows: number;
  failed_rows: number;
  duplicate_rows: number;
  total_chunks: number;
  uploaded_chunks: number;
  processed_chunks: number;
  cancel_requested: number;
  status: "uploading" | "queued" | "processing" | "cancelling" | "cancelled" | "completed" | "completed_with_errors" | "failed";
  error_summary: string;
  sealed_at: string | null;
  started_at: string | null;
  last_heartbeat_at: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

type QuestionVersionItem = {
  id: number;
  version: number;
  change_type: "baseline" | "import" | "rollback" | string;
  from_version: number | null;
  review_status: string;
  admin_name: string | null;
  created_at: string;
  snapshot: Record<string, unknown> | null;
};

type CanonicalQuestion = {
  questionCode: string;
  subject: string;
  module: string;
  subType: string;
  stem: string;
  options: string[];
  answer: string | null;
  explanation: string;
  technique: string;
  material: string;
  prompt: string;
  wordLimit: number | null;
  scoringPoints: string[];
  difficulty: string;
  source: string;
  region: string;
  examYear: number | null;
  truthVerified: boolean;
  sourceExamType: string;
  sourceBatch: string;
  frequency: "高频" | "中频" | "低频" | "";
  frequencyOccurrences: number | null;
  frequencyPapers: number | null;
  frequencyYears: number[];
  importanceStars: number | null;
  importanceRuleVersion: string;
  importanceReason: string;
  importanceOverrideReason: string;
  scoreRate: number | null;
  scoreRateCorrect: number | null;
  scoreRateAttempts: number | null;
  scoreRateScope: string;
  scoreRateSource: string;
  scoreRateUpdatedAt: string;
  suggestedSeconds: number | null;
  imageUrl: string;
  resourceUrl: string;
};

type ManagedQuestion = CanonicalQuestion & {
  id: number;
  version: number;
  status?: "active" | "disabled";
  reviewStatus?: "pending_review" | "approved" | "rejected";
  bankNames?: string;
};

type RowIssue = { row: number; message: string };
type RowAdvisory = { row: number; message: string };

type Props = {
  banks: QuestionBankItem[];
  imports: QuestionImportItem[];
  onReload: () => Promise<void>;
  onMessage: (message: string) => void;
  view?: "banks" | "imports";
  canEdit?: boolean;
  canPublish?: boolean;
};

const ENABLE_SINGLE_QUESTION_ADMIN = true;

const emptyBank = {
  bankCode: "",
  name: "",
  examType: "national",
  province: "",
  examYear: new Date().getFullYear() + 1,
  subject: "行测",
  description: "",
  coverColor: "blue",
  status: "draft",
};

const templateRows = [
  {
    题目编号: "GD-XC-2024-0001",
    科目: "行测",
    地区: "广东",
    真题年份: 2024,
    来源: "广东省公务员录用考试行政职业能力测验真题",
    真题已核验: "否/待核验",
    来源考试类型: "provincial",
    来源批次: "GD-2024-XC-A",
    拿分率正确首答数: "",
    拿分率有效首答数: "",
    拿分率统计范围: "",
    拿分率参考链接: "",
    拿分率统计日期: "",
    "建议用时(秒)": 60,
    模块: "言语理解",
    子题型: "逻辑填空",
    "题干/材料": "请在这里填写行测题干",
    A选项: "选项A",
    B选项: "选项B",
    C选项: "选项C",
    D选项: "选项D",
    正确答案: "A",
    解析: "填写完整解析",
    解题技巧: "填写方法或秒杀技巧",
    申论任务: "",
    字数限制: "",
    采分点: "",
    难度: "中等",
    图片地址: "",
    资源地址: "",
  },
  {
    题目编号: "GD-SL-2024-0001",
    科目: "申论",
    地区: "广东",
    真题年份: 2024,
    来源: "广东省公务员录用考试申论真题",
    真题已核验: "否/待核验",
    来源考试类型: "provincial",
    来源批次: "GD-2024-SL-A",
    拿分率正确首答数: "",
    拿分率有效首答数: "",
    拿分率统计范围: "",
    拿分率参考链接: "",
    拿分率统计日期: "",
    "建议用时(秒)": 1200,
    模块: "归纳概括",
    子题型: "单一题",
    "题干/材料": "请在这里填写申论材料",
    A选项: "",
    B选项: "",
    C选项: "",
    D选项: "",
    正确答案: "",
    解析: "填写参考答案",
    解题技巧: "填写作答结构",
    申论任务: "请概括材料反映的主要问题。",
    字数限制: 150,
    采分点: "问题一|问题二|问题三",
    难度: "中等",
    图片地址: "",
    资源地址: "",
  },
];

function cell(row: Record<string, unknown>, names: string[]) {
  for (const name of names) {
    const value = row[name];
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return "";
}

function optionalInteger(row: Record<string, unknown>, names: string[]) {
  const raw = cell(row, names);
  if (!raw) return null;
  const value = Number(raw.replaceAll(",", ""));
  return Number.isInteger(value) ? value : Number.NaN;
}

function normalizeRow(row: Record<string, unknown>): CanonicalQuestion {
  const subjectRaw = cell(row, ["科目", "subject"]);
  const subject = subjectRaw.includes("申论") ? "申论" : subjectRaw.includes("行测") ? "行测" : subjectRaw;
  const stem = cell(row, ["题干/材料", "题干", "材料", "stem"]);
  const options = ["A", "B", "C", "D", "E", "F", "G", "H"]
    .map((letter) => cell(row, [`${letter}选项`, letter, `选项${letter}`]))
    .filter(Boolean);
  const answerRaw = cell(row, ["正确答案", "答案", "answer"]).toUpperCase().replace(/^答案[:：]?/, "");
  const scoringRaw = cell(row, ["采分点", "评分点", "scoringPoints"]);
  const wordValue = Number(cell(row, ["字数限制", "wordLimit"]));
  const examYear = Number(cell(row, ["真题年份", "年份", "examYear"]));
  const scoreRateCorrect = optionalInteger(row, ["拿分率正确首答数", "正确首答数", "scoreRateCorrect"]);
  const scoreRateAttempts = optionalInteger(row, ["拿分率有效首答数", "有效首答样本数", "scoreRateAttempts"]);
  const scoreRate = scoreRateAttempts && scoreRateCorrect !== null && Number.isFinite(scoreRateCorrect) && Number.isFinite(scoreRateAttempts)
    ? Math.round(scoreRateCorrect * 100 / scoreRateAttempts)
    : null;
  const suggestedSeconds = Number(cell(row, ["建议用时(秒)", "建议用时", "suggestedSeconds"]));
  return {
    questionCode: cell(row, ["题目编号", "题号", "questionCode", "id"]).toUpperCase(),
    subject,
    module: cell(row, ["模块", "module"]),
    subType: cell(row, ["子题型", "题型", "subType"]),
    stem,
    options,
    answer: answerRaw ? answerRaw.slice(0, 1) : null,
    explanation: cell(row, ["解析", "参考答案", "explanation"]),
    technique: cell(row, ["解题技巧", "作答结构", "technique"]),
    material: subject === "申论" ? stem : cell(row, ["材料", "material"]),
    prompt: cell(row, ["申论任务", "作答任务", "prompt"]),
    wordLimit: Number.isInteger(wordValue) && wordValue > 0 ? wordValue : null,
    scoringPoints: scoringRaw.split(/[|｜；;\n]/).map((item) => item.trim()).filter(Boolean),
    difficulty: cell(row, ["难度", "difficulty"]) || "中等",
    source: cell(row, ["来源", "source"]),
    region: cell(row, ["地区", "region"]),
    examYear: Number.isInteger(examYear) && examYear > 1900 ? examYear : null,
    // 导入人员只能提交待核验真题，不能通过模板字段自行将题目标为已审核。
    truthVerified: false,
    sourceExamType: cell(row, ["来源考试类型", "sourceExamType"]),
    sourceBatch: cell(row, ["来源批次", "sourceBatch"]),
    // 考频与星级由已审核真题样本计算，文件字段不会进入可信指标。
    frequency: "",
    frequencyOccurrences: null,
    frequencyPapers: null,
    frequencyYears: [],
    importanceStars: null,
    importanceRuleVersion: "",
    importanceReason: "",
    importanceOverrideReason: "",
    scoreRate: scoreRate !== null && scoreRate >= 0 && scoreRate <= 100 ? scoreRate : null,
    scoreRateCorrect,
    scoreRateAttempts,
    scoreRateScope: cell(row, ["拿分率统计范围", "scoreRateScope"]),
    scoreRateSource: cell(row, ["拿分率参考链接", "拿分率数据来源", "scoreRateSource"]),
    scoreRateUpdatedAt: cell(row, ["拿分率统计日期", "scoreRateUpdatedAt", "scoreRateObservedAt"]),
    suggestedSeconds: Number.isInteger(suggestedSeconds) && suggestedSeconds > 0 ? suggestedSeconds : null,
    imageUrl: cell(row, ["图片地址", "图片URL", "imageUrl"]),
    resourceUrl: cell(row, ["资源地址", "资源URL", "resourceUrl"]),
  };
}

function validateRow(row: CanonicalQuestion, index: number): RowIssue[] {
  const issues: RowIssue[] = [];
  const line = index + 2;
  if (!/^[A-Z0-9][A-Z0-9_-]{2,79}$/.test(row.questionCode)) issues.push({ row: line, message: "题目编号格式错误" });
  if (!new Set(["行测", "申论"]).has(row.subject)) issues.push({ row: line, message: "科目只能填写行测或申论" });
  if (!row.module) issues.push({ row: line, message: "模块不能为空" });
  if (!row.stem) issues.push({ row: line, message: "题干/材料不能为空" });
  if (!row.source) issues.push({ row: line, message: "来源不能为空，请填写官方试卷或可追溯出处" });
  if (!row.sourceBatch) issues.push({ row: line, message: "来源批次不能为空，同一套试卷请填写同一批次" });
  if (!row.region) issues.push({ row: line, message: "地区不能为空，国考题填写国考" });
  if (!row.examYear) issues.push({ row: line, message: "真题年份必须填写四位年份" });

  const hasScoreMetric = row.scoreRateCorrect !== null || row.scoreRateAttempts !== null || Boolean(row.scoreRateScope || row.scoreRateSource || row.scoreRateUpdatedAt);
  if (hasScoreMetric && (row.scoreRateCorrect === null || row.scoreRateAttempts === null || !row.scoreRateScope || !row.scoreRateSource || !row.scoreRateUpdatedAt)) {
    issues.push({ row: line, message: "外部拿分率需同时填写正确首答数、有效首答数、统计范围、参考链接和统计日期" });
  }
  if (row.scoreRateSource && !/^https:\/\//i.test(row.scoreRateSource)) issues.push({ row: line, message: "外部拿分率必须填写可追溯的 HTTPS 参考链接，不能填写“平台统计”" });
  if (row.scoreRateUpdatedAt && (!/^\d{4}-\d{2}-\d{2}$/.test(row.scoreRateUpdatedAt)
    || Date.parse(`${row.scoreRateUpdatedAt}T23:59:59Z`) > Date.now())) issues.push({ row: line, message: "拿分率统计日期需为不晚于今天的 YYYY-MM-DD" });
  if (row.scoreRateCorrect !== null && (!Number.isInteger(row.scoreRateCorrect) || row.scoreRateCorrect < 0)) issues.push({ row: line, message: "正确首答数必须是非负整数" });
  if (row.scoreRateAttempts !== null && (!Number.isInteger(row.scoreRateAttempts) || row.scoreRateAttempts < 1)) issues.push({ row: line, message: "有效首答数必须是正整数" });
  if (row.scoreRateCorrect !== null && row.scoreRateAttempts !== null && row.scoreRateCorrect > row.scoreRateAttempts) issues.push({ row: line, message: "正确首答数不能大于有效首答数" });
  if (!row.suggestedSeconds) issues.push({ row: line, message: "建议用时必须填写正整数秒数" });
  if (!row.explanation) issues.push({ row: line, message: "解析/参考答案不能为空" });
  if (row.subject === "行测" && (row.options.length < 2 || !row.answer || !/^[A-H]$/.test(row.answer))) issues.push({ row: line, message: "行测题缺少选项或正确答案" });
  if (row.subject === "申论" && !row.prompt) issues.push({ row: line, message: "申论题缺少申论任务" });
  return issues;
}

function adviseRow(row: CanonicalQuestion, index: number): RowAdvisory[] {
  const advisories: RowAdvisory[] = [];
  const line = index + 2;
  advisories.push({ row: line, message: "导入后进入待审核池；只有审核员通过后才会成为可发布真题" });
  if (!row.frequency) advisories.push({ row: line, message: "考频样本积累中：不会自动填成中频" });
  if (!row.importanceStars) advisories.push({ row: line, message: "重要度待评估：不会自动填成3星" });
  if (!row.scoreRateAttempts || row.scoreRateAttempts < 100) advisories.push({ row: line, message: "拿分率样本积累中：不足100个有效首答不展示百分比" });
  return advisories;
}

function frequencyPreview(row: CanonicalQuestion) {
  if (!row.frequency) return <Tag>样本积累中</Tag>;
  return <div><Tag color="orange">{row.frequency}</Tag><small>{row.frequencyOccurrences}/{row.frequencyPapers}份试卷 · {row.frequencyYears.join("、")}</small></div>;
}

function importancePreview(row: CanonicalQuestion) {
  if (!row.importanceStars || !row.importanceRuleVersion || !(row.importanceReason || row.importanceOverrideReason)) return <Tag>待评估</Tag>;
  return <div><Tag color="gold">{row.importanceStars}星</Tag><small>{row.importanceRuleVersion}{row.importanceOverrideReason ? " · 人工覆盖" : ""}</small></div>;
}

function scoreRatePreview(row: CanonicalQuestion) {
  if (!row.scoreRateAttempts || row.scoreRateAttempts < 100 || row.scoreRate === null) {
    return <div><Tag>样本积累中</Tag>{row.scoreRateAttempts ? <small>{row.scoreRateCorrect ?? 0}/{row.scoreRateAttempts}个有效首答</small> : null}</div>;
  }
  return <div><Tag color="blue">{row.scoreRate}%</Tag><small>{row.scoreRateCorrect}/{row.scoreRateAttempts} · {row.scoreRateScope}</small></div>;
}

async function adminApiRequest(payload: Record<string, unknown>) {
  const response = await fetch("/api/app", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json() as Record<string, unknown> & { error?: string };
  if (!response.ok) throw new Error(data.error || "操作失败");
  return data;
}

async function sha256Buffer(buffer: ArrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const ACTIVE_IMPORT_STATUSES = new Set<QuestionImportItem["status"]>(["uploading", "queued", "processing", "cancelling"]);
const AUTO_POLL_IMPORT_STATUSES = new Set<QuestionImportItem["status"]>(["queued", "processing", "cancelling"]);
const TERMINAL_IMPORT_STATUSES = new Set<QuestionImportItem["status"]>(["cancelled", "completed", "completed_with_errors", "failed"]);
const IMPORT_CHUNK_SIZE = 80;
const IMPORT_MAX_FILE_ROWS = 800;
const IMPORT_MAX_CHUNKS_PER_FILE = 10;
const IMPORT_CHUNK_BYTES = 480 * 1024;

function buildPersistentImportChunks(rows: CanonicalQuestion[]) {
  const encoder = new TextEncoder();
  const chunks: Array<{ offset: number; rows: CanonicalQuestion[] }> = [];
  let current: CanonicalQuestion[] = [];
  let currentBytes = 2;
  let currentOffset = 0;
  rows.forEach((row, index) => {
    const rowBytes = encoder.encode(JSON.stringify(row)).byteLength + (current.length ? 1 : 0);
    if (current.length && (current.length >= IMPORT_CHUNK_SIZE || currentBytes + rowBytes > IMPORT_CHUNK_BYTES)) {
      chunks.push({ offset: currentOffset, rows: current });
      current = [];
      currentBytes = 2;
      currentOffset = index;
    }
    current.push(row);
    currentBytes += rowBytes;
  });
  if (current.length) chunks.push({ offset: currentOffset, rows: current });
  return chunks;
}

export default function QuestionBankManager({
  banks,
  imports,
  onReload,
  onMessage,
  view = "banks",
  canEdit = true,
  canPublish = true,
}: Props) {
  const [bankForm, setBankForm] = useState({ ...emptyBank });
  const [editingBankId, setEditingBankId] = useState<number | null>(null);
  const [selectedBankId, setSelectedBankId] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [selectedFileHash, setSelectedFileHash] = useState("");
  const [rows, setRows] = useState<CanonicalQuestion[]>([]);
  const [issues, setIssues] = useState<RowIssue[]>([]);
  const [advisories, setAdvisories] = useState<RowAdvisory[]>([]);
  const [readingFile, setReadingFile] = useState(false);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [importStage, setImportStage] = useState<0 | 1 | 2 | 3>(0);
  const [importResult, setImportResult] = useState("");
  const [activeImportId, setActiveImportId] = useState(0);
  const [duplicateStrategy, setDuplicateStrategy] = useState<"reject" | "preserve_metrics" | "replace_external_metrics">("reject");
  const [versionQuestionCode, setVersionQuestionCode] = useState("");
  const [versionQuestion, setVersionQuestion] = useState<Record<string, unknown> | null>(null);
  const [questionVersions, setQuestionVersions] = useState<QuestionVersionItem[]>([]);
  const [loadingVersions, setLoadingVersions] = useState(false);
  const cancelledImportIds = useRef(new Set<number>());
  const [questionSearch, setQuestionSearch] = useState("");
  const [questionResults, setQuestionResults] = useState<ManagedQuestion[]>([]);
  const [searchingQuestions, setSearchingQuestions] = useState(false);
  const [editingQuestion, setEditingQuestion] = useState<ManagedQuestion | null>(null);

  const api = adminApiRequest;

  const selectedBank = useMemo(() => banks.find((bank) => String(bank.id) === selectedBankId), [banks, selectedBankId]);
  const editingBank = useMemo(() => banks.find((bank) => bank.id === editingBankId) ?? null, [banks, editingBankId]);
  const editingBankIdentityLocked = Boolean(editingBank && (editingBank.status === "published"
    || Number(editingBank.question_count ?? 0) > 0 || Number(editingBank.import_count ?? 0) > 0
    || Number(editingBank.selection_count ?? 0) > 0 || Number(editingBank.active_session_count ?? 0) > 0));
  const activeServerImportKey = useMemo(() => imports.filter((item) => AUTO_POLL_IMPORT_STATUSES.has(item.status))
    .map((item) => item.id).join(","), [imports]);

  useEffect(() => {
    if (!activeServerImportKey) return;
    const activeIds = activeServerImportKey.split(",").map(Number).filter(Boolean);
    let disposed = false;
    const poll = async () => {
      try {
        await Promise.all(activeIds.map((importId) => adminApiRequest({ action: "adminGetQuestionImport", importId })));
        if (!disposed) await onReload();
      } catch { /* 页面级轮询失败不打断运营操作，下轮自动重试。 */ }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 3_000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [activeServerImportKey, onReload]);

  const retryImport = (item: QuestionImportItem) => {
    setSelectedBankId(String(item.bank_id));
    setActiveImportId(item.status === "uploading" ? item.id : 0);
    setSelectedFile(null);
    setSelectedFileHash("");
    setRows([]);
    setIssues([]);
    setAdvisories([]);
    setProgress(0);
    onMessage(item.status === "uploading"
      ? `已恢复任务 #${item.id}，请重新选择同一个“${item.file_name}”；文件指纹一致后才允许续传`
      : `已选中“${item.bank_name}”，请重新选择修正后的文件，新建一次可追溯导入`);
    document.querySelector(".question-upload-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const searchQuestions = async () => {
    setSearchingQuestions(true);
    try {
      const data = await api({ action: "adminSearchQuestions", query: questionSearch.trim(), bankId: selectedBankId || null, limit: 50 });
      setQuestionResults((data.questions ?? []) as ManagedQuestion[]);
      onMessage(`找到 ${Number((data.questions as unknown[] | undefined)?.length ?? 0)} 道题`);
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "题目搜索失败");
    } finally {
      setSearchingQuestions(false);
    }
  };

  const saveQuestion = async () => {
    if (!editingQuestion) return;
    if (!canEdit) return onMessage("当前角色没有编辑题目的权限");
    const original = questionResults.find((item) => item.id === editingQuestion.id);
    if (original && Number(original.importanceStars ?? 0) !== Number(editingQuestion.importanceStars ?? 0)
      && editingQuestion.importanceOverrideReason.trim().length < 5) {
      return onMessage("人工调整重要星级时，请填写至少5个字的覆盖理由");
    }
    try {
      const result = await api({ action: "adminUpsertQuestion", id: editingQuestion.id,
        expectedVersion: editingQuestion.version, question: editingQuestion });
      onMessage(result.unchanged ? "没有检测到需要保存的修改" : "单题修改已保存，并已回到待审核状态");
      setEditingQuestion(null);
      await searchQuestions();
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "单题保存失败");
    }
  };

  const toggleQuestionStatus = async (question: ManagedQuestion) => {
    if (!canEdit) return onMessage("当前角色没有停用或恢复题目的权限");
    try {
      const status = question.status === "disabled" ? "active" : "disabled";
      await api({ action: "adminSetQuestionStatus", id: question.id, expectedVersion: question.version, status });
      onMessage(status === "disabled" ? "题目已停用，不再进入训练" : "题目已恢复使用");
      await searchQuestions();
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "题目状态更新失败");
    }
  };

  const saveBank = async () => {
    if (!canEdit) return onMessage("当前角色没有编辑题库的权限");
    try {
      await api({ action: "adminUpsertQuestionBank", bankId: editingBankId, ...bankForm });
      onMessage("题库配置已保存");
      setBankForm({ ...emptyBank });
      setEditingBankId(null);
      await onReload();
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "题库保存失败");
    }
  };

  const editBank = (bank: QuestionBankItem) => {
    setEditingBankId(bank.id);
    setBankForm({
      bankCode: bank.bank_code,
      name: bank.name,
      examType: bank.exam_type,
      province: bank.province ?? "",
      examYear: bank.exam_year ?? new Date().getFullYear() + 1,
      subject: bank.subject,
      description: bank.description,
      coverColor: bank.cover_color,
      status: bank.status,
    });
    document.querySelector(".bank-config-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const toggleBankStatus = async (bank: QuestionBankItem) => {
    if (!canPublish) return onMessage("当前角色没有发布或下线题库的权限");
    try {
      await api({ action: "adminSetQuestionBankStatus", id: bank.id, status: bank.status === "published" ? "draft" : "published" });
      onMessage(bank.status === "published" ? "题库已转为草稿" : "题库已发布");
      await onReload();
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "题库状态更新失败");
    }
  };

  const downloadTemplate = async () => {
    const XLSX = await import("xlsx");
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.json_to_sheet(templateRows);
    sheet["!cols"] = Object.keys(templateRows[0]).map((name) => ({
      wch: ["题干/材料", "解析", "申论任务", "重要性理由", "重要性覆盖理由", "拿分率统计范围"].includes(name)
        ? 42
        : ["来源", "图片地址", "资源地址"].includes(name) ? 28 : 16,
    }));
    XLSX.utils.book_append_sheet(workbook, sheet, "题库导入模板");
    const guide = XLSX.utils.aoa_to_sheet([
      ["字段组", "字段", "要求", "说明"],
      ["真题可信", "地区、真题年份、来源", "必填", "前台统一显示为地区-年份，如广东-2024；来源填写可追溯的官方试卷或出处"],
      ["真题可信", "真题已核验", "固定为否/待核验", "上传者无权自审；导入后由审核员核对来源、地区、年份和来源批次"],
      ["考频", "系统自动计算", "无需填写", "只按已审核真题的稳定试卷批次计算高/中/低频，文件中的同名字段会被忽略"],
      ["重要度", "系统自动计算", "无需填写", "星级由考频、年份覆盖和近期持续性计算；文件不能注入人工星级，人工覆盖只能在审核后台留痕操作"],
      ["拿分率", "正确首答数、有效首答数、统计范围、参考链接、统计日期", "整组可选", "仅允许导入可追溯的外部参考数据；平台拿分率由真实有效首答自动计算，模板不预填示例数值"],
      ["缺失策略", "考频/重要度/拿分率", "允许暂缺", "缺失不会阻断导入，也绝不默认成中频、3星或60%；分别显示样本积累中、待评估、样本积累中"],
    ]);
    guide["!cols"] = [{ wch: 12 }, { wch: 48 }, { wch: 14 }, { wch: 88 }];
    XLSX.utils.book_append_sheet(workbook, guide, "字段说明");
    XLSX.writeFile(workbook, "公考日练题库导入模板.xlsx");
    onMessage("题库模板已生成");
  };

  const readFile = async (file: File) => {
    setReadingFile(true);
    try {
      if (!/\.(xlsx|xls|csv)$/i.test(file.name)) throw new Error("请选择 XLSX、XLS 或 CSV 文件");
      if (file.size > 20 * 1024 * 1024) throw new Error("单个文件不能超过20MB");
      const XLSX = await import("xlsx");
      const fileBuffer = await file.arrayBuffer();
      const [fileHash] = await Promise.all([sha256Buffer(fileBuffer)]);
      const workbook = XLSX.read(fileBuffer, { type: "array" });
      const sheetName = workbook.SheetNames[0];
      if (!sheetName) throw new Error("文件中没有可读取的工作表");
      const sourceRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[sheetName], { defval: "", raw: false });
      if (!sourceRows.length) throw new Error("文件中没有题目数据");
      if (sourceRows.length > IMPORT_MAX_FILE_ROWS) throw new Error(`单个文件最多导入${IMPORT_MAX_FILE_ROWS}道题，超出请按年份或地区拆分文件`);
      const normalized = sourceRows.map(normalizeRow);
      if (buildPersistentImportChunks(normalized).length > IMPORT_MAX_CHUNKS_PER_FILE) {
        throw new Error(`单个文件最多拆成${IMPORT_MAX_CHUNKS_PER_FILE}个后台分块；当前内容较大，请按年份或地区拆分文件`);
      }
      const nextIssues = normalized.flatMap(validateRow);
      const nextAdvisories = normalized.flatMap(adviseRow);
      setSelectedFile(file);
      setSelectedFileHash(fileHash);
      setRows(normalized);
      setIssues(nextIssues);
      setAdvisories(nextAdvisories);
      setProgress(0);
      setImportStage(1);
      setImportResult("");
      onMessage(`已读取 ${normalized.length} 行：${nextIssues.length} 个阻断问题，${nextAdvisories.length} 条质量提示`);
    } catch (error) {
      setSelectedFile(null);
      setSelectedFileHash("");
      setRows([]);
      setIssues([]);
      setAdvisories([]);
      setImportStage(0);
      setImportResult("");
      onMessage(error instanceof Error ? error.message : "文件读取失败");
    } finally {
      setReadingFile(false);
    }
  };

  const importQuestions = async () => {
    if (!canEdit) return onMessage("当前角色没有导入题目的权限");
    if (!selectedBank || !selectedFile || !selectedFileHash || !rows.length) return onMessage("请先选择题库并上传文件");
    const persistentChunks = buildPersistentImportChunks(rows);
    const invalidRows = new Set(issues.map((item) => item.row)).size;
    if (!activeImportId && !window.confirm(`确认提交 ${rows.length} 行到“${selectedBank.name}”？文件会先完整持久化，再由后台校验和导入；预计 ${invalidRows} 行不会通过。`)) return;
    setImporting(true);
    setProgress(0);
    setImportStage(2);
    setImportResult("");
    let importId = activeImportId;
    try {
      if (!importId) {
        const start = await api({
          action: "adminStartQuestionImport",
          bankId: selectedBank.id,
          fileName: selectedFile.name,
          fileSize: selectedFile.size,
          fileHash: selectedFileHash,
          totalRows: rows.length,
          chunkSize: IMPORT_CHUNK_SIZE,
          totalChunks: persistentChunks.length,
          duplicateStrategy,
        });
        importId = Number(start.importId);
        setActiveImportId(importId);
      }
      cancelledImportIds.current.delete(importId);
      let uploadedRows = 0;
      for (let chunkIndex = 0; chunkIndex < persistentChunks.length; chunkIndex += 1) {
        if (cancelledImportIds.current.has(importId)) throw new Error("任务已取消");
        const { offset, rows: batch } = persistentChunks[chunkIndex];
        let uploaded = false;
        let lastError: unknown;
        for (let attempt = 0; attempt < 3 && !uploaded; attempt += 1) {
          try {
            await api({ action: "adminImportQuestionBatch", importId, bankId: selectedBank.id, fileHash: selectedFileHash, chunkIndex, offset, rows: batch });
            uploaded = true;
          } catch (error) {
            lastError = error;
            if (attempt < 2) await new Promise((resolve) => window.setTimeout(resolve, 500 * (attempt + 1)));
          }
        }
        if (!uploaded) throw lastError instanceof Error ? lastError : new Error("分块上传失败");
        uploadedRows += batch.length;
        setProgress(Math.min(70, Math.round((uploadedRows / rows.length) * 70)));
      }
      const duplicatePreview = await api({ action: "adminPreviewQuestionImportDuplicates", importId });
      const fileDuplicates = Number(duplicatePreview.duplicateRows ?? 0);
      const existingCount = Number(duplicatePreview.existingCount ?? (Array.isArray(duplicatePreview.existing) ? duplicatePreview.existing.length : 0));
      const duplicateSamples = (Array.isArray(duplicatePreview.withinFile) ? duplicatePreview.withinFile : [])
        .slice(0, 5).map((item) => `${String((item as Record<string, unknown>).question_code)}（行${String((item as Record<string, unknown>).rows)}）`).join("、");
      const existingSamples = (Array.isArray(duplicatePreview.existing) ? duplicatePreview.existing : [])
        .slice(0, 5).map((item) => `${String((item as Record<string, unknown>).question_code)}（${String((item as Record<string, unknown>).bank_names ?? "未关联题库")}）`).join("、");
      const duplicateStrategyLabel = duplicateStrategy === "reject" ? "拒绝覆盖已存在题号"
        : duplicateStrategy === "preserve_metrics" ? "更新单库题目但保留现有拿分率样本"
          : "使用文件中的可追溯外部拿分率并重新审核";
      if ((fileDuplicates > 0 || existingCount > 0) && !window.confirm(
        `重复预览：文件内有 ${fileDuplicates} 个重复题号（后续重复行会记为失败），另有 ${existingCount} 个题号已存在。当前策略：${duplicateStrategyLabel}。${duplicateSamples ? `\n文件内示例：${duplicateSamples}` : ""}${existingSamples ? `\n已存在示例：${existingSamples}` : ""}\n确认提交后台处理？`,
      )) {
        await api({ action: "adminCancelQuestionImport", importId });
        setActiveImportId(0);
        setImportResult("已取消，本次持久化分块不会写入题库");
        setImportStage(3);
        await onReload();
        return;
      }
      await api({ action: "adminFinishQuestionImport", importId });
      setProgress(72);
      let finalJob: Record<string, unknown> | null = null;
      for (let attempt = 0; attempt < 120; attempt += 1) {
        if (cancelledImportIds.current.has(importId)) break;
        const statusResult = await api({ action: "adminGetQuestionImport", importId });
        const job = statusResult.job as Record<string, unknown>;
        finalJob = job;
        const processed = Number(job.processed_rows ?? 0);
        setProgress(Math.min(99, 70 + Math.round((processed / Math.max(1, rows.length)) * 30)));
        if (TERMINAL_IMPORT_STATUSES.has(String(job.status) as QuestionImportItem["status"])) break;
        await new Promise((resolve) => window.setTimeout(resolve, 1_000));
      }
      const status = (cancelledImportIds.current.has(importId) ? "cancelled" : String(finalJob?.status ?? "queued")) as QuestionImportItem["status"];
      const imported = Number(finalJob?.imported_rows ?? 0);
      const failed = Number(finalJob?.failed_rows ?? 0);
      const resultMessage = status === "completed"
        ? `后台导入完成，共写入 ${imported} 道题`
        : status === "completed_with_errors"
          ? `后台导入完成：${imported} 道成功，${failed} 行未通过；可下载错误清单`
          : status === "failed"
            ? "后台处理失败，已保留行级结果，可在记录中安全重试失败分块"
            : status === "cancelled"
              ? "导入任务已取消"
              : "任务已完整提交，后台仍在处理；关闭页面不会丢失已提交任务";
      setProgress(TERMINAL_IMPORT_STATUSES.has(status) ? 100 : 99);
      setImportResult(resultMessage);
      setImportStage(3);
      if (TERMINAL_IMPORT_STATUSES.has(status)) setActiveImportId(0);
      onMessage(resultMessage);
      await onReload();
    } catch (error) {
      const reason = error instanceof Error ? error.message : "题库导入中断";
      const cancelled = Boolean(importId && cancelledImportIds.current.has(importId));
      setImportResult(cancelled ? "导入任务已取消" : `上传暂停：${reason}。已上传分块仍在云端，可再次点击继续并安全重试同一分块。`);
      if (cancelled) setActiveImportId(0);
      setImportStage(3);
      onMessage(reason);
    } finally {
      setImporting(false);
    }
  };

  const cancelImport = async (importId: number) => {
    if (!window.confirm("确认取消该导入任务？已经完成的行级写入不会回滚，尚未处理的分块会停止。")) return;
    try {
      await api({ action: "adminCancelQuestionImport", importId });
      cancelledImportIds.current.add(importId);
      if (activeImportId === importId) setActiveImportId(0);
      onMessage("已提交取消请求");
      await onReload();
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "取消失败");
    }
  };

  const retryServerImport = async (importId: number) => {
    try {
      await api({ action: "adminRetryQuestionImport", importId });
      onMessage("失败分块已安全重新排队，已完成的行不会重复写入");
      await onReload();
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "重试失败");
    }
  };

  const downloadImportErrors = async (importId: number) => {
    try {
      const parts: string[] = [];
      let offset: number | null = 0;
      let fileName = `导入错误-${importId}.csv`;
      let contentType = "text/csv;charset=utf-8";
      while (offset !== null) {
        const result = await api({ action: "adminDownloadQuestionImportErrors", importId, offset });
        parts.push(String(result.content ?? ""));
        fileName = String(result.fileName ?? fileName);
        contentType = String(result.contentType ?? contentType);
        offset = result.nextOffset === null || result.nextOffset === undefined ? null : Number(result.nextOffset);
      }
      const blob = new Blob(parts, { type: contentType });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "错误清单下载失败");
    }
  };

  const loadQuestionVersions = async () => {
    if (!versionQuestionCode.trim()) return onMessage("请输入题目编号");
    setLoadingVersions(true);
    try {
      const result = await api({ action: "adminListQuestionVersions", questionCode: versionQuestionCode.trim() });
      setVersionQuestion((result.question ?? null) as Record<string, unknown> | null);
      setQuestionVersions((result.versions ?? []) as QuestionVersionItem[]);
    } catch (error) {
      setVersionQuestion(null);
      setQuestionVersions([]);
      onMessage(error instanceof Error ? error.message : "版本历史读取失败");
    } finally {
      setLoadingVersions(false);
    }
  };

  const rollbackQuestionVersion = async (version: number) => {
    const questionId = Number(versionQuestion?.id ?? 0);
    const expectedVersion = Number(versionQuestion?.version ?? 0);
    const sharedWarning = Number(versionQuestion?.bank_count ?? 0) > 1
      ? `\n注意：该题被 ${String(versionQuestion?.bank_count)} 个题库共用（${String(versionQuestion?.bank_names ?? "")}），新版本审核通过后会共同生效。`
      : "";
    if (!questionId || !expectedVersion || !window.confirm(`确认基于 v${version} 生成一个新的待审核版本？当前版本和历史记录都不会被删除。${sharedWarning}`)) return;
    try {
      const result = await api({ action: "adminRollbackQuestionVersion", questionId, version, expectedVersion });
      onMessage(String(result.message ?? "已生成待审核回滚版本"));
      await loadQuestionVersions();
      await onReload();
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "版本回滚失败");
    }
  };

  return (
    <>
      {view === "banks" && <section className="admin-panel bank-config-panel">
        <div className="admin-panel-title"><div><span>题库配置</span><h2>{editingBankId ? "编辑题库配置" : "创建国考或省考题库"}</h2><small>省考按省份独立建库；国省共通题可复用同一题目编号，系统会跨库去重。</small></div><button onClick={() => { setEditingBankId(null); setBankForm({ ...emptyBank }); }}>新建空白题库</button></div>
        {editingBankId && <Alert showIcon type={editingBankIdentityLocked ? "warning" : "info"}
          message={editingBankIdentityLocked ? "题库身份范围已锁定" : "当前是纯草稿空库，可调整范围"}
          description={editingBankIdentityLocked
            ? "题库编码、考试类型、省份、适用年份和科目已参与题目、导入、用户书架、练习或发布关系，不能原地修改；范围变化请复制为新题库。名称、简介、封面和上下线状态仍可调整。"
            : "题库编码创建后仍不可修改；在尚未发布、没有题目、导入、用户选择和进行中练习前，可调整考试类型、省份、年份和科目。"}
          style={{ marginBottom: 16 }} />}
        <div className="form-grid bank-form-grid">
          <label>题库编码<input value={bankForm.bankCode} disabled={Boolean(editingBankId)} onChange={(event) => setBankForm({ ...bankForm, bankCode: event.target.value.toUpperCase() })} placeholder="如 GD-XC-2027" /><small>{editingBankId ? "编码用于用户书架、练习记录和题目关联，创建后不可修改" : "保存后永久不可修改，请按地区、科目和年份规划编码"}</small></label>
          <label>题库名称<input value={bankForm.name} onChange={(event) => setBankForm({ ...bankForm, name: event.target.value })} placeholder="如 2027广东省考·行测综合" /></label>
          <label>考试类型<select value={bankForm.examType} disabled={editingBankIdentityLocked} onChange={(event) => setBankForm({ ...bankForm, examType: event.target.value, province: event.target.value === "provincial" ? bankForm.province : "" })}><option value="national">国考</option><option value="provincial">省考</option><option value="special">专项题库</option></select></label>
          <label>省份<input value={bankForm.province} disabled={editingBankIdentityLocked || bankForm.examType !== "provincial"} onChange={(event) => setBankForm({ ...bankForm, province: event.target.value })} placeholder={bankForm.examType === "provincial" ? "省考必填，如广东" : "仅省考题库需要填写"} /></label>
          <label>适用年份<input type="number" min="2020" max="2100" value={bankForm.examYear} disabled={editingBankIdentityLocked} onChange={(event) => setBankForm({ ...bankForm, examYear: Number(event.target.value) })} /></label>
          <label>科目<select value={bankForm.subject} disabled={editingBankIdentityLocked} onChange={(event) => setBankForm({ ...bankForm, subject: event.target.value })}><option>行测</option><option>申论</option><option>综合</option></select></label>
          <label>封面颜色<select value={bankForm.coverColor} onChange={(event) => setBankForm({ ...bankForm, coverColor: event.target.value })}><option value="blue">公考蓝</option><option value="orange">活力橙</option><option value="green">成长绿</option><option value="purple">进阶紫</option></select></label>
          <label>初始状态<select value={bankForm.status} onChange={(event) => setBankForm({ ...bankForm, status: event.target.value })}><option value="draft">草稿</option><option value="published">发布</option></select></label>
          <label className="wide">题库简介<textarea value={bankForm.description} onChange={(event) => setBankForm({ ...bankForm, description: event.target.value })} placeholder="适用人群、题目范围和更新说明" /></label>
        </div>
        <button className="admin-primary" disabled={!canEdit} onClick={saveBank}>{editingBankId ? "保存题库修改" : "保存题库配置"}</button>
      </section>}

      {view === "imports" && <section className="admin-panel question-upload-panel">
        <div className="admin-panel-title"><div><span>文件导入</span><h2>上传Excel或CSV题库</h2></div><button onClick={() => void downloadTemplate()}>下载Excel模板</button></div>
        <Steps
          size="small"
          current={importStage}
          items={[{ title: "选择题库与文件" }, { title: "校验预览" }, { title: "确认导入" }, { title: "查看结果" }]}
          style={{ marginBottom: 24 }}
        />
        <Alert
          showIcon
          type="info"
          message="先校验真题可信，再补充可追溯指标"
          description={<Typography.Text type="secondary">地区、年份、来源和来源批次负责真题追溯；所有上传题目统一进入待审核池，上传者不能自行核验。考频、重要度、拿分率可以暂缺，但必须成组填写并保留口径。</Typography.Text>}
          style={{ marginBottom: 18 }}
        />
        <div className="upload-toolbar">
          <label>导入到题库<select value={selectedBankId} onChange={(event) => setSelectedBankId(event.target.value)}><option value="">请选择目标题库</option>{banks.map((bank) => <option key={bank.id} value={bank.id}>{bank.name}（{bank.question_count}题）</option>)}</select></label>
          <label>已存在题号处理<select value={duplicateStrategy} disabled={Boolean(activeImportId)} onChange={(event) => setDuplicateStrategy(event.target.value as typeof duplicateStrategy)}><option value="reject">拒绝覆盖（推荐）</option><option value="preserve_metrics">更新题干解析，保留现有拿分率样本</option><option value="replace_external_metrics">用本文件外部样本替换（需HTTPS来源并重新审核）</option></select><small>平台真实作答样本不会被默认值覆盖；选择外部替换后仍只进入待审核。</small></label>
          <label className="upload-dropzone"><input type="file" accept=".xlsx,.xls,.csv" onChange={(event) => { const file = event.target.files?.[0]; if (file) void readFile(file); }} /><span>{readingFile ? "正在读取文件…" : selectedFile ? selectedFile.name : "点击选择 XLSX / XLS / CSV 文件"}</span><small>最大20MB / 800题；超出请按年份或地区拆分，首行必须是模板字段名</small></label>
        </div>

        {rows.length > 0 && (
          <div className="import-preview">
            <div className="import-summary"><span><b>{rows.length}</b>总行数</span><span><b>{rows.length - new Set(issues.map((item) => item.row)).size}</b>预计通过</span><span className={issues.length ? "has-errors" : ""}><b>{issues.length}</b>阻断问题</span><span><b>{advisories.length}</b>质量提示</span></div>
            <div className="admin-table-wrap"><table><thead><tr><th>题目编号</th><th>真题可信</th><th>考频</th><th>重要度</th><th>拿分率</th><th>模块</th><th>题干/材料</th></tr></thead><tbody>{rows.slice(0, 6).map((row, index) => <tr key={`${row.questionCode}-${index}`}><td>{row.questionCode || "未填写"}</td><td><b>{row.region && row.examYear ? `${row.region}-${row.examYear}` : "未填写"}</b><div><Tag color={row.truthVerified ? "green" : "orange"}>{row.truthVerified ? "已核验" : "待核验"}</Tag></div><small>{row.source || "来源未填写"}</small></td><td>{frequencyPreview(row)}</td><td>{importancePreview(row)}</td><td>{scoreRatePreview(row)}</td><td>{row.module || "未填写"}</td><td className="preview-text">{row.stem || "未填写"}</td></tr>)}</tbody></table></div>
            {issues.length > 0 && <details className="issue-list"><summary>查看前20个校验问题</summary>{issues.slice(0, 20).map((issue, index) => <p key={`${issue.row}-${index}`}>第 {issue.row} 行：{issue.message}</p>)}</details>}
            {advisories.length > 0 && <details className="issue-list"><summary>查看前20条质量提示（不阻断导入）</summary>{advisories.slice(0, 20).map((item, index) => <p key={`${item.row}-${index}`}>第 {item.row} 行：{item.message}</p>)}</details>}
            {importing && <div className="import-progress"><div><i style={{ width: `${progress}%` }} /></div><span>{progress}%</span></div>}
            {importResult && <div className={`import-result ${importResult.startsWith("导入中断") ? "has-errors" : ""}`} role="status">{importResult}。可在下方导入记录查看详细结果；修正原文件后可直接重新选择并导入。</div>}
            <button className="admin-primary import-button" onClick={importQuestions} disabled={!canEdit || importing || !selectedBankId}>{importing ? (progress < 70 ? "正在持久化文件…" : "后台正在处理…") : activeImportId ? "继续上传未完成分块" : `导入到${selectedBank?.name ?? "目标题库"}`}</button>
            {activeImportId ? <button type="button" onClick={() => void cancelImport(activeImportId)}>取消当前导入任务</button> : null}
          </div>
        )}
      </section>}

      {view === "banks" && <section className="admin-panel table-panel">
        <div className="admin-panel-title"><div><span>版本与回滚</span><h2>题目不可变版本历史</h2><small>导入和回滚都会生成新版本；回滚不会覆盖历史，而是进入现有待审核流程。</small></div></div>
        <div className="upload-toolbar">
          <label>题目编号<div style={{ display: "flex", gap: 8 }}><input value={versionQuestionCode} onChange={(event) => setVersionQuestionCode(event.target.value.toUpperCase())} placeholder="如 GD-XC-2024-0001" onKeyDown={(event) => { if (event.key === "Enter") void loadQuestionVersions(); }} /><button type="button" onClick={() => void loadQuestionVersions()}>{loadingVersions ? "查询中…" : "查询版本"}</button></div></label>
        </div>
        {versionQuestion && <Alert showIcon type={Number(versionQuestion.bank_count ?? 0) > 1 ? "warning" : "info"} message={`${String(versionQuestion.question_code)} · 当前 v${String(versionQuestion.version)}`} description={`当前审核状态：${String(versionQuestion.review_status)} · 关联题库：${String(versionQuestion.bank_names ?? "未关联")}`} style={{ marginBottom: 16 }} />}
        {questionVersions.length > 0 && <div className="admin-table-wrap"><table><thead><tr><th>版本</th><th>变更</th><th>审核状态</th><th>操作者</th><th>时间</th><th>操作</th></tr></thead><tbody>{questionVersions.map((item) => <tr key={item.id}><td><b>v{item.version}</b>{item.from_version ? <small>基于 v{item.from_version}</small> : null}</td><td>{item.change_type === "baseline" ? "基线快照" : item.change_type === "rollback" ? "回滚生成" : "题库导入"}</td><td><span className={`status ${item.review_status}`}>{item.review_status === "approved" ? "已通过" : item.review_status === "rejected" ? "已驳回" : "待审核"}</span></td><td>{item.admin_name || "系统"}</td><td>{new Date(item.created_at).toLocaleString("zh-CN")}</td><td>{Number(versionQuestion.version) === item.version ? "当前版本" : <button disabled={!canEdit} onClick={() => void rollbackQuestionVersion(item.version)}>生成回滚版本</button>}</td></tr>)}</tbody></table></div>}
      </section>}

      {view === "banks" && <section className="admin-panel table-panel">
        <div className="admin-panel-title"><div><span>题库书架</span><h2>题库整理与发布</h2></div><button onClick={() => void onReload()}>刷新</button></div>
        <div className="admin-table-wrap"><table><thead><tr><th>题库</th><th>分类</th><th>年份</th><th>题量</th><th>状态</th><th>操作</th></tr></thead><tbody>{banks.length ? banks.map((bank) => <tr key={bank.id}><td><b>{bank.name}</b><small>{bank.bank_code}</small></td><td>{bank.exam_type === "national" ? "国考" : bank.exam_type === "provincial" ? `${bank.province}省考` : "专项"} · {bank.subject}</td><td>{bank.exam_year ?? "长期"}</td><td>{bank.question_count}</td><td><span className={`status ${bank.status}`}>{bank.status === "published" ? "已发布" : "草稿"}</span></td><td><button disabled={!canEdit} onClick={() => editBank(bank)}>编辑</button><button disabled={!canPublish} onClick={() => void toggleBankStatus(bank)}>{bank.status === "published" ? "下线" : "发布"}</button></td></tr>) : <tr><td colSpan={6}>还没有题库，请先在上方创建。</td></tr>}</tbody></table></div>
      </section>}

      {view === "banks" && ENABLE_SINGLE_QUESTION_ADMIN && <section className="admin-panel table-panel">
        <div className="admin-panel-title"><div><span>单题管理</span><h2>搜索、编辑与停用真题</h2><small>可按题号、题干或来源搜索；标签统一显示为“地区-年份”，如广东-2024。</small></div></div>
        <div className="upload-toolbar">
          <label>目标题库<select value={selectedBankId} onChange={(event) => setSelectedBankId(event.target.value)}><option value="">全部题库</option>{banks.map((bank) => <option key={bank.id} value={bank.id}>{bank.name}</option>)}</select></label>
          <label>搜索关键词<div style={{ display: "flex", gap: 8 }}><input value={questionSearch} onChange={(event) => setQuestionSearch(event.target.value)} placeholder="题目编号、题干或来源" onKeyDown={(event) => { if (event.key === "Enter") void searchQuestions(); }} /><button type="button" onClick={() => void searchQuestions()}>{searchingQuestions ? "搜索中…" : "搜索"}</button></div></label>
        </div>
        {editingQuestion && <div className="import-preview">
          <div className="admin-panel-title"><div><span>编辑单题 · 当前 v{editingQuestion.version}</span><h2>{editingQuestion.questionCode}</h2><small>题目编号永久不变；内容或标签有实质修改后会生成新版本，并回到待审核状态。</small></div><button onClick={() => setEditingQuestion(null)}>取消</button></div>
          <Alert showIcon type="warning" message="考频和平台拿分率为系统指标" description="考频根据同范围已审核真题试卷样本计算；平台拿分率根据真实有效首答计算。两项均只读，不能在单题编辑中手工改百分比。" style={{ marginBottom: 16 }} />
          <div className="form-grid bank-form-grid">
            <label>科目<select value={editingQuestion.subject} onChange={(event) => setEditingQuestion({ ...editingQuestion, subject: event.target.value })}><option>行测</option><option>申论</option></select></label>
            <label>模块<input value={editingQuestion.module} onChange={(event) => setEditingQuestion({ ...editingQuestion, module: event.target.value })} /></label>
            <label>子题型<input value={editingQuestion.subType} onChange={(event) => setEditingQuestion({ ...editingQuestion, subType: event.target.value })} /></label>
            <label>地区<input value={editingQuestion.region} onChange={(event) => setEditingQuestion({ ...editingQuestion, region: event.target.value })} /></label>
            <label>真题年份<input type="number" min="1990" max={new Date().getFullYear()} value={editingQuestion.examYear ?? ""} onChange={(event) => setEditingQuestion({ ...editingQuestion, examYear: Number(event.target.value) || null })} /></label>
            <label>来源考试类型<input value={editingQuestion.sourceExamType} onChange={(event) => setEditingQuestion({ ...editingQuestion, sourceExamType: event.target.value })} placeholder="如 provincial / national" /></label>
            <label className="wide">真题来源<input value={editingQuestion.source} onChange={(event) => setEditingQuestion({ ...editingQuestion, source: event.target.value })} /></label>
            <label className="wide">来源批次<input value={editingQuestion.sourceBatch} onChange={(event) => setEditingQuestion({ ...editingQuestion, sourceBatch: event.target.value })} placeholder="同一套试卷保持一致" /></label>
            <label className="wide">题干 / 材料<textarea value={editingQuestion.stem} onChange={(event) => setEditingQuestion({ ...editingQuestion, stem: event.target.value })} /></label>
            {editingQuestion.subject === "行测" ? <>
              {editingQuestion.options.map((option, index) => <label key={`${editingQuestion.id}-option-${index}`} className="wide">{String.fromCharCode(65 + index)}选项<input value={option} onChange={(event) => setEditingQuestion({ ...editingQuestion, options: editingQuestion.options.map((item, itemIndex) => itemIndex === index ? event.target.value : item) })} /></label>)}
              <label>正确答案<select value={editingQuestion.answer ?? ""} onChange={(event) => setEditingQuestion({ ...editingQuestion, answer: event.target.value || null })}><option value="">请选择</option>{editingQuestion.options.map((_, index) => <option key={index} value={String.fromCharCode(65 + index)}>{String.fromCharCode(65 + index)}</option>)}</select></label>
            </> : <label className="wide">申论作答任务<textarea value={editingQuestion.prompt} onChange={(event) => setEditingQuestion({ ...editingQuestion, prompt: event.target.value })} /></label>}
            <label className="wide">解析 / 参考答案<textarea value={editingQuestion.explanation} onChange={(event) => setEditingQuestion({ ...editingQuestion, explanation: event.target.value })} /></label>
            <label className="wide">解题技巧<textarea value={editingQuestion.technique} onChange={(event) => setEditingQuestion({ ...editingQuestion, technique: event.target.value })} /></label>
            <label>考频（系统）<input value={editingQuestion.frequency || "样本积累中"} disabled /><small>{editingQuestion.frequencyPapers ? `${editingQuestion.frequencyOccurrences ?? 0}/${editingQuestion.frequencyPapers}份试卷 · ${editingQuestion.frequencyYears.join("、")}` : "至少3套、3个年份后形成可靠标签"}</small></label>
            <label>重要星级<input type="number" min="1" max="5" value={editingQuestion.importanceStars || ""} onChange={(event) => setEditingQuestion({ ...editingQuestion, importanceStars: Number(event.target.value) || null })} /><small>人工调整必须在下方留下覆盖理由</small></label>
            <label className="wide">重要星级人工覆盖理由<textarea value={editingQuestion.importanceOverrideReason} onChange={(event) => setEditingQuestion({ ...editingQuestion, importanceOverrideReason: event.target.value })} placeholder="说明为什么需要偏离系统计算，至少5个字" /></label>
            <label>拿分率（系统）<input value={editingQuestion.scoreRateAttempts ? `${editingQuestion.scoreRate}%` : "样本积累中"} disabled /><small>{editingQuestion.scoreRateAttempts ? `${editingQuestion.scoreRateCorrect ?? 0}/${editingQuestion.scoreRateAttempts}个有效首答 · ${editingQuestion.scoreRateSource === "platform" ? "平台自动统计" : "外部可追溯样本"}` : "满100个有效首答后前台展示"}</small></label>
            <label>建议用时（秒）<input type="number" min="10" max="3600" value={editingQuestion.suggestedSeconds ?? ""} onChange={(event) => setEditingQuestion({ ...editingQuestion, suggestedSeconds: Number(event.target.value) || null })} /></label>
            <label className="wide">图片地址<input value={editingQuestion.imageUrl} onChange={(event) => setEditingQuestion({ ...editingQuestion, imageUrl: event.target.value })} /></label>
            <label className="wide">资源地址<input value={editingQuestion.resourceUrl} onChange={(event) => setEditingQuestion({ ...editingQuestion, resourceUrl: event.target.value })} /></label>
          </div>
          <button className="admin-primary" disabled={!canEdit} onClick={() => void saveQuestion()}>保存并提交复审</button>
        </div>}
        {questionResults.length > 0 && <div className="admin-table-wrap"><table><thead><tr><th>题目</th><th>真题标签</th><th>价值标签</th><th>题库</th><th>状态</th><th>操作</th></tr></thead><tbody>{questionResults.map((question) => <tr key={question.id}><td><b>{question.questionCode}</b><small>{question.module} · {question.subType} · v{question.version}</small></td><td>{question.region}-{question.examYear}</td><td>{question.frequency || "考频积累中"} · {question.importanceStars ? `${question.importanceStars}星` : "重要度待评估"} · {question.scoreRateAttempts && question.scoreRateAttempts >= 100 ? `${question.scoreRate}%` : "拿分率积累中"}</td><td>{question.bankNames || "—"}</td><td><span className={`status ${question.status === "disabled" ? "disabled" : question.reviewStatus === "approved" ? "published" : "pending_review"}`}>{question.status === "disabled" ? "已停用" : question.reviewStatus === "approved" ? "使用中" : "待审核"}</span></td><td><button disabled={!canEdit} onClick={() => setEditingQuestion(question)}>编辑单题</button><button disabled={!canEdit} onClick={() => void toggleQuestionStatus(question)}>{question.status === "disabled" ? "恢复" : "停用"}</button></td></tr>)}</tbody></table></div>}
      </section>}

      {view === "imports" && <section className="admin-panel table-panel">
        <div className="admin-panel-title"><div><span>导入记录</span><h2>持久化任务与处理进度</h2><small>“完整提交”后可关闭页面；服务端会按 D1 租约从未完成分块自动续跑，平台瞬时中断后重开后台也会恢复。</small></div><button onClick={() => void onReload()}>刷新</button></div>
        <div className="admin-table-wrap"><table><thead><tr><th>时间</th><th>题库 / 文件</th><th>持久化</th><th>处理结果</th><th>状态</th><th>错误摘要</th><th>操作</th></tr></thead><tbody>{imports.length ? imports.map((item) => {
          const uploadPercent = Math.round((Number(item.uploaded_rows || 0) / Math.max(1, Number(item.total_rows || 0))) * 100);
          const processPercent = Math.round((Number(item.processed_rows || 0) / Math.max(1, Number(item.total_rows || 0))) * 100);
          const statusLabel = item.status === "uploading" ? "等待完整上传" : item.status === "queued" ? "后台排队" : item.status === "processing" ? "后台处理中" : item.status === "cancelling" ? "正在取消" : item.status === "cancelled" ? "已取消" : item.status === "completed" ? "已完成" : item.status === "failed" ? "系统处理失败" : "完成但有错行";
          return <tr key={item.id}><td>{new Date(item.created_at).toLocaleString("zh-CN")}</td><td><b>{item.bank_name}</b><small>{item.file_name}</small><small>重复策略：{item.duplicate_strategy === "replace_external_metrics" ? "外部样本替换" : item.duplicate_strategy === "preserve_metrics" ? "保留现有拿分率" : "拒绝覆盖"}</small></td><td>{item.uploaded_rows}/{item.total_rows} 行<small>{uploadPercent}% · {item.uploaded_chunks}/{item.total_chunks} 分块</small></td><td>{item.imported_rows} 成功 / {item.failed_rows} 失败<small>{processPercent}% · 文件内重复 {item.duplicate_rows || 0}</small></td><td><span className={`status ${item.status}`}>{statusLabel}</span></td><td className="preview-text">{item.error_summary ? <details><summary>查看原因</summary><pre style={{ whiteSpace: "pre-wrap", maxWidth: 320 }}>{item.error_summary}</pre></details> : "—"}</td><td><div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {item.status === "uploading" ? <button disabled={!canEdit} onClick={() => retryImport(item)}>选择原文件续传</button> : null}
            {item.status === "failed" ? <button disabled={!canEdit} onClick={() => void retryServerImport(item.id)}>安全重试分块</button> : null}
            {item.status === "completed_with_errors" ? <button disabled={!canEdit} onClick={() => retryImport(item)}>修正文件后新建</button> : null}
            {item.failed_rows > 0 ? <button onClick={() => void downloadImportErrors(item.id)}>下载错误CSV</button> : null}
            {ACTIVE_IMPORT_STATUSES.has(item.status) ? <button disabled={!canEdit} onClick={() => void cancelImport(item.id)}>取消</button> : null}
            {!ACTIVE_IMPORT_STATUSES.has(item.status) && item.status !== "failed" && item.status !== "completed_with_errors" && item.failed_rows < 1 ? "—" : null}
          </div></td></tr>;
        }) : <tr><td colSpan={7}>暂无导入记录。</td></tr>}</tbody></table></div>
      </section>}
    </>
  );
}
