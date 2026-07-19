"use client";

import { useMemo, useState } from "react";
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Divider,
  Progress,
  Row,
  Space,
  Table,
  Tag,
  Typography,
  Upload,
} from "antd";
import { DownloadOutlined, InboxOutlined, SafetyCertificateOutlined } from "@ant-design/icons";
import { adminApi } from "../_components/adminApi";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_IMPORT_ROWS = 500;
const CONTENT_SHEETS = ["试卷", "材料", "题目", "答案来源", "参考答案"] as const;
const CODE_PATTERN = /^[a-z0-9][a-z0-9_-]{1,79}$/;

type SheetName = typeof CONTENT_SHEETS[number];
type RawRow = Record<string, unknown>;
type IssueLevel = "error" | "warning";
type ImportIssue = { level: IssueLevel; sheet: SheetName; row: number; field: string; message: string };
type ImportRow<T> = { sheet: SheetName; row: number; value: T };

type PaperRow = {
  code: string;
  title: string;
  examType: string;
  region: string;
  examYear: number;
  paperType: string;
  sourceUrl: string;
  resourceUrl: string;
  accessLevel: "free" | "member";
};

type MaterialRow = {
  paperCode: string;
  label: string;
  title: string;
  content: string;
  sortOrder: number;
};

type QuestionRow = {
  paperCode: string;
  code: string;
  number: string;
  prompt: string;
  questionType: string;
  score: number | null;
  wordLimit: number | null;
  materialLabels: string[];
  sortOrder: number;
};

type SourceRow = {
  sourceKey: string;
  name: string;
  homepageUrl: string;
  sortOrder: number;
  status: "active" | "disabled";
};

type AnswerRow = {
  paperCode: string;
  questionCode: string;
  sourceKey: string;
  sourceTitle: string;
  displayMode: "full" | "excerpt" | "link_only";
  content: string;
  excerpt: string;
  sourceUrl: string;
  copyrightStatus: "original" | "authorized" | "fair_quote" | "link_only" | "pending_verification";
  originalPublishedAt: string;
  sortOrder: number;
};

type ParsedImport = {
  papers: ImportRow<PaperRow>[];
  materials: ImportRow<MaterialRow>[];
  questions: ImportRow<QuestionRow>[];
  sources: ImportRow<SourceRow>[];
  answers: ImportRow<AnswerRow>[];
};

export type EssayLibraryImportData = {
  papers: Array<{ id: number; bank_code: string; library_status: string }>;
  materials: Array<{ id: number; bank_id: number; label: string; status: string }>;
  questions: Array<{ id: number; bank_id: number; question_code: string }>;
  sources: Array<{ id: number; source_key: string; status: string }>;
  answers: Array<{ id: number; question_id: number; source_id: number; publication_status: string }>;
};

type Props = {
  canWrite: boolean;
  data: EssayLibraryImportData;
  onImported: () => Promise<unknown> | unknown;
};

const SHEET_HEADERS: Record<SheetName, string[]> = {
  试卷: ["试卷编码", "试卷名称", "考试类型", "地区", "年份", "卷种", "查看权益", "试卷来源链接", "PDF或资料链接"],
  材料: ["试卷编码", "材料编号", "材料标题", "材料正文", "排序"],
  题目: ["试卷编码", "题目编码", "题号", "题干", "题型", "分值", "字数限制", "关联材料编号", "排序"],
  答案来源: ["来源标识", "显示名称", "官方主页", "排序", "状态"],
  参考答案: ["试卷编码", "题目编码", "来源标识", "来源文章标题", "展示方式", "全文", "节选", "原文链接", "版权状态", "原文发布日期", "排序"],
};

function text(value: unknown, maxLength = Number.POSITIVE_INFINITY) {
  return String(value ?? "").normalize("NFKC").trim().slice(0, maxLength);
}

function integer(value: unknown, fallback = 0) {
  const parsed = Number(String(value ?? "").trim());
  return Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
}

function nullableInteger(value: unknown) {
  const raw = text(value);
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.floor(parsed) : null;
}

function isHttps(value: string) {
  if (!value) return true;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function splitLabels(value: unknown) {
  return [...new Set(text(value).split(/[|｜,，、;；]/).map((item) => item.trim()).filter(Boolean))].slice(0, 100);
}

function issue(level: IssueLevel, sheet: SheetName, row: number, field: string, message: string): ImportIssue {
  return { level, sheet, row, field, message };
}

function inferSingleSheet(headers: string[]): SheetName | null {
  const values = new Set(headers);
  if (values.has("试卷名称") && values.has("考试类型") && values.has("年份")) return "试卷";
  if (values.has("材料编号") && values.has("材料正文")) return "材料";
  if (values.has("题目编码") && values.has("题干") && values.has("题号")) return "题目";
  if (values.has("来源标识") && values.has("显示名称")) return "答案来源";
  if (values.has("题目编码") && values.has("来源标识") && values.has("展示方式")) return "参考答案";
  return null;
}

function parseRows(rowsBySheet: Partial<Record<SheetName, RawRow[]>>) {
  const parsed: ParsedImport = { papers: [], materials: [], questions: [], sources: [], answers: [] };
  const issues: ImportIssue[] = [];

  for (const [index, row] of (rowsBySheet.试卷 ?? []).entries()) {
    const rowNumber = index + 2;
    const accessLabel = text(row.查看权益, 20).toLowerCase();
    const value: PaperRow = {
      code: text(row.试卷编码, 80).toLowerCase(),
      title: text(row.试卷名称, 160),
      examType: text(row.考试类型, 40),
      region: text(row.地区, 40),
      examYear: integer(row.年份, 0),
      paperType: text(row.卷种, 60),
      sourceUrl: text(row.试卷来源链接, 1000),
      resourceUrl: text(row.PDF或资料链接, 1000),
      accessLevel: ["会员", "会员专享", "member"].includes(accessLabel) ? "member" : "free",
    };
    if (!value.code) issues.push(issue("error", "试卷", rowNumber, "试卷编码", "不能为空"));
    else if (!CODE_PATTERN.test(value.code)) issues.push(issue("error", "试卷", rowNumber, "试卷编码", "仅允许2—80位小写字母、数字、下划线和连字符"));
    if (!value.title) issues.push(issue("error", "试卷", rowNumber, "试卷名称", "不能为空"));
    if (!value.examType) issues.push(issue("error", "试卷", rowNumber, "考试类型", "不能为空"));
    if (value.examYear < 2000 || value.examYear > 2200) issues.push(issue("error", "试卷", rowNumber, "年份", "须为2000—2200之间的年份"));
    if (!isHttps(value.sourceUrl)) issues.push(issue("error", "试卷", rowNumber, "试卷来源链接", "必须是HTTPS链接"));
    if (!isHttps(value.resourceUrl)) issues.push(issue("error", "试卷", rowNumber, "PDF或资料链接", "必须是HTTPS链接"));
    if (accessLabel && !["免费", "免费开放", "free", "会员", "会员专享", "member"].includes(accessLabel)) {
      issues.push(issue("error", "试卷", rowNumber, "查看权益", "仅支持免费或会员"));
    }
    parsed.papers.push({ sheet: "试卷", row: rowNumber, value });
  }

  for (const [index, row] of (rowsBySheet.材料 ?? []).entries()) {
    const rowNumber = index + 2;
    const value: MaterialRow = {
      paperCode: text(row.试卷编码, 80).toLowerCase(),
      label: text(row.材料编号, 40),
      title: text(row.材料标题, 160),
      content: text(row.材料正文, 100_000),
      sortOrder: Math.max(0, Math.min(100_000, integer(row.排序, 0))),
    };
    if (!value.paperCode) issues.push(issue("error", "材料", rowNumber, "试卷编码", "不能为空"));
    if (!value.label) issues.push(issue("error", "材料", rowNumber, "材料编号", "不能为空"));
    if (!value.content) issues.push(issue("error", "材料", rowNumber, "材料正文", "不能为空"));
    parsed.materials.push({ sheet: "材料", row: rowNumber, value });
  }

  for (const [index, row] of (rowsBySheet.题目 ?? []).entries()) {
    const rowNumber = index + 2;
    const value: QuestionRow = {
      paperCode: text(row.试卷编码, 80).toLowerCase(),
      code: text(row.题目编码, 80).toLowerCase(),
      number: text(row.题号, 24),
      prompt: text(row.题干, 30_000),
      questionType: text(row.题型, 80),
      score: nullableInteger(row.分值),
      wordLimit: nullableInteger(row.字数限制),
      materialLabels: splitLabels(row.关联材料编号),
      sortOrder: Math.max(0, Math.min(100_000, integer(row.排序, 0))),
    };
    if (!value.paperCode) issues.push(issue("error", "题目", rowNumber, "试卷编码", "不能为空"));
    if (!value.code) issues.push(issue("error", "题目", rowNumber, "题目编码", "不能为空，且每道题须使用独立编码"));
    else if (!CODE_PATTERN.test(value.code)) issues.push(issue("error", "题目", rowNumber, "题目编码", "仅允许2—80位小写字母、数字、下划线和连字符"));
    if (!value.number) issues.push(issue("error", "题目", rowNumber, "题号", "不能为空"));
    if (!value.prompt) issues.push(issue("error", "题目", rowNumber, "题干", "不能为空"));
    if (value.score !== null && (value.score < 0 || value.score > 200)) issues.push(issue("error", "题目", rowNumber, "分值", "须为0—200之间的整数"));
    if (value.wordLimit !== null && (value.wordLimit < 1 || value.wordLimit > 20_000)) issues.push(issue("error", "题目", rowNumber, "字数限制", "须为1—20000之间的整数"));
    parsed.questions.push({ sheet: "题目", row: rowNumber, value });
  }

  for (const [index, row] of (rowsBySheet.答案来源 ?? []).entries()) {
    const rowNumber = index + 2;
    const rawStatus = text(row.状态).toLowerCase();
    const value: SourceRow = {
      sourceKey: text(row.来源标识, 80).toLowerCase(),
      name: text(row.显示名称, 100),
      homepageUrl: text(row.官方主页, 1000),
      sortOrder: Math.max(0, Math.min(100_000, integer(row.排序, 0))),
      status: rawStatus === "disabled" || rawStatus === "停用" ? "disabled" : "active",
    };
    if (!value.sourceKey) issues.push(issue("error", "答案来源", rowNumber, "来源标识", "不能为空"));
    else if (!CODE_PATTERN.test(value.sourceKey)) issues.push(issue("error", "答案来源", rowNumber, "来源标识", "仅允许2—80位小写字母、数字、下划线和连字符"));
    if (!value.name) issues.push(issue("error", "答案来源", rowNumber, "显示名称", "不能为空"));
    if (!isHttps(value.homepageUrl)) issues.push(issue("error", "答案来源", rowNumber, "官方主页", "必须是HTTPS链接"));
    parsed.sources.push({ sheet: "答案来源", row: rowNumber, value });
  }

  const displayModes = new Set(["full", "excerpt", "link_only"]);
  const copyrightStatuses = new Set(["original", "authorized", "fair_quote", "link_only", "pending_verification"]);
  for (const [index, row] of (rowsBySheet.参考答案 ?? []).entries()) {
    const rowNumber = index + 2;
    const displayMode = text(row.展示方式).toLowerCase() || "link_only";
    const copyrightStatus = text(row.版权状态).toLowerCase() || "pending_verification";
    const value: AnswerRow = {
      paperCode: text(row.试卷编码, 80).toLowerCase(),
      questionCode: text(row.题目编码, 80).toLowerCase(),
      sourceKey: text(row.来源标识, 80).toLowerCase(),
      sourceTitle: text(row.来源文章标题, 300),
      displayMode: (displayModes.has(displayMode) ? displayMode : "link_only") as AnswerRow["displayMode"],
      content: text(row.全文, 100_000),
      excerpt: text(row.节选, 8_000),
      sourceUrl: text(row.原文链接, 1000),
      copyrightStatus: (copyrightStatuses.has(copyrightStatus) ? copyrightStatus : "pending_verification") as AnswerRow["copyrightStatus"],
      originalPublishedAt: text(row.原文发布日期, 40),
      sortOrder: Math.max(0, Math.min(100_000, integer(row.排序, 0))),
    };
    if (!value.paperCode) issues.push(issue("error", "参考答案", rowNumber, "试卷编码", "不能为空"));
    if (!value.questionCode) issues.push(issue("error", "参考答案", rowNumber, "题目编码", "不能为空"));
    if (!value.sourceKey) issues.push(issue("error", "参考答案", rowNumber, "来源标识", "不能为空"));
    if (!displayModes.has(displayMode)) issues.push(issue("error", "参考答案", rowNumber, "展示方式", "仅支持full、excerpt、link_only"));
    if (!copyrightStatuses.has(copyrightStatus)) issues.push(issue("error", "参考答案", rowNumber, "版权状态", "版权状态值无效"));
    if (!isHttps(value.sourceUrl)) issues.push(issue("error", "参考答案", rowNumber, "原文链接", "必须是HTTPS链接"));
    if (value.displayMode === "full" && !value.content) issues.push(issue("warning", "参考答案", rowNumber, "全文", "全文模式缺少正文，导入后无法通过发布门禁"));
    if (value.displayMode === "excerpt" && !value.excerpt) issues.push(issue("warning", "参考答案", rowNumber, "节选", "节选模式缺少节选，导入后无法通过发布门禁"));
    if (value.displayMode === "link_only" && !value.sourceUrl) issues.push(issue("warning", "参考答案", rowNumber, "原文链接", "仅链接模式缺少原文链接，导入后无法通过发布门禁"));
    parsed.answers.push({ sheet: "参考答案", row: rowNumber, value });
  }

  return { parsed, issues };
}

function validateRelations(parsed: ParsedImport, data: EssayLibraryImportData) {
  const issues: ImportIssue[] = [];
  const paperCodes = new Set(data.papers.map((item) => item.bank_code));
  const paperIdByCode = new Map(data.papers.map((item) => [item.bank_code, item.id]));
  for (const row of parsed.papers) paperCodes.add(row.value.code);

  const sourceKeys = new Set(data.sources.map((item) => item.source_key));
  for (const row of parsed.sources) sourceKeys.add(row.value.sourceKey);

  const existingPaperCodeById = new Map(data.papers.map((item) => [item.id, item.bank_code]));
  const materialKeys = new Set(data.materials.filter((item) => item.status !== "disabled").flatMap((item) => {
    const paperCode = existingPaperCodeById.get(item.bank_id);
    return paperCode ? [`${paperCode}\u0000${item.label}`] : [];
  }));
  for (const row of parsed.materials) materialKeys.add(`${row.value.paperCode}\u0000${row.value.label}`);

  const questionKeys = new Set(data.questions.flatMap((item) => {
    const paperCode = existingPaperCodeById.get(item.bank_id);
    return paperCode ? [`${paperCode}\u0000${item.question_code}`] : [];
  }));
  for (const row of parsed.questions) questionKeys.add(`${row.value.paperCode}\u0000${row.value.code}`);

  const duplicateChecks: Array<[SheetName, Array<ImportRow<unknown>>, (row: ImportRow<unknown>) => string]> = [
    ["试卷", parsed.papers, (row) => (row.value as PaperRow).code],
    ["材料", parsed.materials, (row) => `${(row.value as MaterialRow).paperCode}\u0000${(row.value as MaterialRow).label}`],
    ["题目", parsed.questions, (row) => (row.value as QuestionRow).code],
    ["答案来源", parsed.sources, (row) => (row.value as SourceRow).sourceKey],
    ["参考答案", parsed.answers, (row) => `${(row.value as AnswerRow).questionCode}\u0000${(row.value as AnswerRow).sourceKey}`],
  ];
  for (const [sheet, rows, keyOf] of duplicateChecks) {
    const firstRow = new Map<string, number>();
    for (const row of rows) {
      const key = keyOf(row);
      if (!key) continue;
      const first = firstRow.get(key);
      if (first) issues.push(issue("error", sheet, row.row, "唯一标识", `与第${first}行重复`));
      else firstRow.set(key, row.row);
    }
  }

  for (const row of parsed.materials) {
    if (!paperCodes.has(row.value.paperCode)) issues.push(issue("error", "材料", row.row, "试卷编码", "文件和资料库中均不存在该试卷"));
  }
  for (const row of parsed.questions) {
    if (!paperCodes.has(row.value.paperCode)) issues.push(issue("error", "题目", row.row, "试卷编码", "文件和资料库中均不存在该试卷"));
    for (const label of row.value.materialLabels) {
      if (!materialKeys.has(`${row.value.paperCode}\u0000${label}`)) issues.push(issue("error", "题目", row.row, "关联材料编号", `找不到材料“${label}”`));
    }
  }
  for (const row of parsed.answers) {
    if (!paperCodes.has(row.value.paperCode)) issues.push(issue("error", "参考答案", row.row, "试卷编码", "文件和资料库中均不存在该试卷"));
    if (!questionKeys.has(`${row.value.paperCode}\u0000${row.value.questionCode}`)) issues.push(issue("error", "参考答案", row.row, "题目编码", "该试卷下不存在此题目"));
    if (!sourceKeys.has(row.value.sourceKey)) issues.push(issue("error", "参考答案", row.row, "来源标识", "文件和资料库中均不存在该来源"));
  }

  const updateCount = parsed.papers.filter((row) => paperIdByCode.has(row.value.code)).length;
  if (updateCount) issues.push(issue("warning", "试卷", 0, "更新策略", `${updateCount}套同编码试卷将更新并自动转为草稿`));
  const publishedAnswerByKey = new Set(data.answers.filter((item) => item.publication_status === "published").map((item) => `${item.question_id}\u0000${item.source_id}`));
  if (publishedAnswerByKey.size && parsed.answers.length) {
    issues.push(issue("warning", "参考答案", 0, "导入状态", "若覆盖已发布答案，答案与所属试卷会自动撤回为草稿"));
  }
  return issues;
}

function rowCount(parsed: ParsedImport) {
  return parsed.papers.length + parsed.materials.length + parsed.questions.length + parsed.sources.length + parsed.answers.length;
}

export default function EssayLibraryBulkImport({ canWrite, data, onImported }: Props) {
  const { message, modal } = App.useApp();
  const [fileName, setFileName] = useState("");
  const [parsed, setParsed] = useState<ParsedImport | null>(null);
  const [issues, setIssues] = useState<ImportIssue[]>([]);
  const [reading, setReading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState("");

  const errorCount = issues.filter((item) => item.level === "error").length;
  const warningCount = issues.length - errorCount;
  const counts = useMemo(() => parsed ? [
    ["试卷", parsed.papers.length],
    ["材料", parsed.materials.length],
    ["题目", parsed.questions.length],
    ["来源", parsed.sources.length],
    ["答案", parsed.answers.length],
  ] as const : [], [parsed]);

  async function downloadTemplate() {
    const XLSX = await import("xlsx");
    const workbook = XLSX.utils.book_new();
    for (const sheetName of CONTENT_SHEETS) {
      const sheet = XLSX.utils.aoa_to_sheet([SHEET_HEADERS[sheetName]]);
      sheet["!cols"] = SHEET_HEADERS[sheetName].map((header) => ({ wch: ["材料正文", "题干", "全文", "节选"].includes(header) ? 48 : 18 }));
      XLSX.utils.book_append_sheet(workbook, sheet, sheetName);
    }
    const guide = XLSX.utils.aoa_to_sheet([
      ["导入规则", "说明"],
      ["导入顺序", "系统按试卷 → 答案来源 → 材料 → 题目 → 参考答案顺序写入；同编码记录更新，文件内重复会阻断导入。"],
      ["状态规则", "所有试卷、题目和参考答案仅保存为草稿/待审核，批量导入不会自动发布，也不会自动通过真题核验。"],
      ["编码规则", "试卷编码、题目编码、来源标识使用2—80位小写字母、数字、下划线或连字符。"],
      ["关联材料", "题目表中的多个材料编号使用 | 分隔，且必须属于同一试卷。"],
      ["展示方式", "full（全文）、excerpt（节选）、link_only（仅链接）。"],
      ["版权状态", "original、authorized、fair_quote、link_only、pending_verification；不确定时填pending_verification。"],
      ["文件限制", `XLSX/XLS/CSV不超过10MB，每次最多${MAX_IMPORT_ROWS}条；CSV一次仅导入一种记录，系统按表头自动识别。`],
    ]);
    guide["!cols"] = [{ wch: 18 }, { wch: 110 }];
    XLSX.utils.book_append_sheet(workbook, guide, "填写说明");
    XLSX.writeFile(workbook, "公考日练-申论真题资料库导入模板.xlsx");
    message.success("导入模板已下载");
  }

  async function readFile(file: File) {
    setReading(true);
    setResult("");
    try {
      if (!/\.(xlsx|xls|csv)$/i.test(file.name)) throw new Error("请选择XLSX、XLS或CSV文件");
      if (file.size > MAX_FILE_BYTES) throw new Error("文件不能超过10MB");
      const XLSX = await import("xlsx");
      const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
      const rowsBySheet: Partial<Record<SheetName, RawRow[]>> = {};
      for (const sheetName of CONTENT_SHEETS) {
        const sheet = workbook.Sheets[sheetName];
        if (sheet) rowsBySheet[sheetName] = XLSX.utils.sheet_to_json<RawRow>(sheet, { defval: "", raw: false });
      }
      if (!Object.keys(rowsBySheet).length && workbook.SheetNames.length === 1) {
        const onlySheet = workbook.Sheets[workbook.SheetNames[0]];
        const matrix = XLSX.utils.sheet_to_json<unknown[]>(onlySheet, { header: 1, defval: "", raw: false });
        const headers = (matrix[0] ?? []).map((item) => text(item));
        const inferred = inferSingleSheet(headers);
        if (!inferred) throw new Error("无法识别CSV/单工作表类型，请使用下载的模板表头");
        rowsBySheet[inferred] = XLSX.utils.sheet_to_json<RawRow>(onlySheet, { defval: "", raw: false });
      }
      const next = parseRows(rowsBySheet);
      const total = rowCount(next.parsed);
      if (!total) throw new Error("文件中没有可导入的数据行");
      if (total > MAX_IMPORT_ROWS) throw new Error(`每次最多导入${MAX_IMPORT_ROWS}条记录，请拆分文件`);
      const nextIssues = [...next.issues, ...validateRelations(next.parsed, data)];
      setFileName(file.name);
      setParsed(next.parsed);
      setIssues(nextIssues);
      setProgress(0);
      message[ nextIssues.some((item) => item.level === "error") ? "warning" : "success" ](`已预检${total}条记录`);
    } catch (reason) {
      setFileName("");
      setParsed(null);
      setIssues([]);
      setProgress(0);
      message.error(reason instanceof Error ? reason.message : "文件读取失败");
    } finally {
      setReading(false);
    }
  }

  async function confirmImport() {
    if (!canWrite) return message.error("当前角色没有内容编辑权限");
    if (!parsed || !fileName || errorCount) return message.error("请先上传文件并处理全部阻断问题");
    const total = rowCount(parsed);
    modal.confirm({
      title: `确认导入${total}条记录？`,
      content: "导入会新建或更新同编码记录，全部保存为草稿/待审核；不会自动发布。中途中断时可修正后重新导入，同编码记录会继续更新。",
      okText: "确认导入草稿",
      cancelText: "取消",
      onOk: async () => {
        setImporting(true);
        setResult("");
        setProgress(0);
        const batchId = globalThis.crypto?.randomUUID?.() ?? `essay-import-${Date.now()}`;
        const paperIdByCode = new Map(data.papers.map((item) => [item.bank_code, item.id]));
        const paperCodeById = new Map(data.papers.map((item) => [item.id, item.bank_code]));
        const materialIdByKey = new Map<string, number>(data.materials.flatMap((item) => {
          const paperCode = paperCodeById.get(item.bank_id);
          return paperCode ? [[`${paperCode}\u0000${item.label}`, item.id] as const] : [];
        }));
        const questionIdByKey = new Map<string, number>(data.questions.flatMap((item) => {
          const paperCode = paperCodeById.get(item.bank_id);
          return paperCode ? [[`${paperCode}\u0000${item.question_code}`, item.id] as const] : [];
        }));
        const sourceIdByKey = new Map(data.sources.map((item) => [item.source_key, item.id]));
        const answerIdByKey = new Map<string, number>(data.answers.map((item) => [`${item.question_id}\u0000${item.source_id}`, item.id]));
        let completed = 0;
        let currentLabel = "";
        const audit = (row: ImportRow<unknown>) => ({ importBatchId: batchId, importFileName: fileName, importSheet: row.sheet, importRow: row.row });
        try {
          for (const row of parsed.papers) {
            currentLabel = `${row.sheet}第${row.row}行`;
            const response = await adminApi<{ id: number }>({ action: "adminUpsertEssayPaper", id: paperIdByCode.get(row.value.code), ...row.value, ...audit(row) });
            paperIdByCode.set(row.value.code, Number(response.id));
            paperCodeById.set(Number(response.id), row.value.code);
            completed += 1; setProgress(Math.round((completed / total) * 100));
          }
          for (const row of parsed.sources) {
            currentLabel = `${row.sheet}第${row.row}行`;
            const response = await adminApi<{ id: number }>({ action: "adminUpsertEssayAnswerSource", id: sourceIdByKey.get(row.value.sourceKey), ...row.value, ...audit(row) });
            sourceIdByKey.set(row.value.sourceKey, Number(response.id));
            completed += 1; setProgress(Math.round((completed / total) * 100));
          }
          for (const row of parsed.materials) {
            currentLabel = `${row.sheet}第${row.row}行`;
            const paperId = paperIdByCode.get(row.value.paperCode);
            if (!paperId) throw new Error("关联试卷不存在");
            const key = `${row.value.paperCode}\u0000${row.value.label}`;
            const response = await adminApi<{ id: number }>({ action: "adminUpsertEssayMaterial", id: materialIdByKey.get(key), paperId, label: row.value.label, title: row.value.title, content: row.value.content, sortOrder: row.value.sortOrder, ...audit(row) });
            materialIdByKey.set(key, Number(response.id));
            completed += 1; setProgress(Math.round((completed / total) * 100));
          }
          for (const row of parsed.questions) {
            currentLabel = `${row.sheet}第${row.row}行`;
            const paperId = paperIdByCode.get(row.value.paperCode);
            if (!paperId) throw new Error("关联试卷不存在");
            const key = `${row.value.paperCode}\u0000${row.value.code}`;
            const materialIds = row.value.materialLabels.map((label) => materialIdByKey.get(`${row.value.paperCode}\u0000${label}`)).filter((id): id is number => Boolean(id));
            const response = await adminApi<{ id: number }>({ action: "adminUpsertEssayLibraryQuestion", id: questionIdByKey.get(key), paperId, code: row.value.code, number: row.value.number, prompt: row.value.prompt, questionType: row.value.questionType, score: row.value.score, wordLimit: row.value.wordLimit, materialIds, sortOrder: row.value.sortOrder, ...audit(row) });
            questionIdByKey.set(key, Number(response.id));
            completed += 1; setProgress(Math.round((completed / total) * 100));
          }
          for (const row of parsed.answers) {
            currentLabel = `${row.sheet}第${row.row}行`;
            const questionId = questionIdByKey.get(`${row.value.paperCode}\u0000${row.value.questionCode}`);
            const sourceId = sourceIdByKey.get(row.value.sourceKey);
            if (!questionId || !sourceId) throw new Error("关联题目或答案来源不存在");
            const key = `${questionId}\u0000${sourceId}`;
            const response = await adminApi<{ id: number }>({
              action: "adminUpsertEssayReferenceAnswer",
              id: answerIdByKey.get(key),
              questionId,
              sourceId,
              sourceTitle: row.value.sourceTitle,
              displayMode: row.value.displayMode,
              content: row.value.content,
              excerpt: row.value.excerpt,
              sourceUrl: row.value.sourceUrl,
              copyrightStatus: row.value.copyrightStatus,
              publicationStatus: "draft",
              originalPublishedAt: row.value.originalPublishedAt,
              sortOrder: row.value.sortOrder,
              ...audit(row),
            });
            answerIdByKey.set(key, Number(response.id));
            completed += 1; setProgress(Math.round((completed / total) * 100));
          }
          setProgress(100);
          setResult(`导入完成：${completed}条记录已保存为草稿/待审核。请完成真题核验与版权审核后再单独发布。`);
          message.success("申论资料已导入草稿库");
          await onImported();
        } catch (reason) {
          const detail = reason instanceof Error ? reason.message : "导入失败";
          setResult(`导入在${currentLabel || "开始阶段"}停止：已保存${completed}条，未保存${total - completed}条。原因：${detail}`);
          message.error(`${currentLabel || "导入"}：${detail}`);
          await onImported();
        } finally {
          setImporting(false);
        }
      },
    });
  }

  return (
    <Space direction="vertical" size={18} style={{ width: "100%" }}>
      <Alert
        showIcon
        type="info"
        icon={<SafetyCertificateOutlined />}
        message="批量导入只进入草稿库"
        description="导入动作需要内容编辑权限，并逐条记录操作日志；题目保持待核验、答案保持草稿、试卷保持草稿，不能通过导入绕过审核与发布门禁。"
      />
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={10}>
          <Card title="1. 下载并填写模板">
            <Typography.Paragraph type="secondary">Excel模板按“试卷、材料、题目、答案来源、参考答案”拆分工作表。CSV也可上传，但一次只能包含一种记录，系统会按表头识别。</Typography.Paragraph>
            <Button icon={<DownloadOutlined />} onClick={() => void downloadTemplate()}>下载Excel模板</Button>
            <Divider />
            <Typography.Text type="secondary">限制：XLSX/XLS/CSV，最大10MB，每次最多{MAX_IMPORT_ROWS}条记录。</Typography.Text>
          </Card>
        </Col>
        <Col xs={24} lg={14}>
          <Card title="2. 上传并预检">
            <Upload.Dragger
              accept=".xlsx,.xls,.csv"
              disabled={!canWrite || reading || importing}
              multiple={false}
              maxCount={1}
              showUploadList={false}
              beforeUpload={(file) => {
                void readFile(file);
                return Upload.LIST_IGNORE;
              }}
            >
              <p className="ant-upload-drag-icon"><InboxOutlined /></p>
              <p className="ant-upload-text">{reading ? "正在读取并预检…" : fileName || "点击或拖入导入文件"}</p>
              <p className="ant-upload-hint">文件只在浏览器中解析；确认后才会逐条写入草稿库。</p>
            </Upload.Dragger>
          </Card>
        </Col>
      </Row>

      {parsed && <Card title="3. 预检结果" extra={<Space>{errorCount > 0 && <Tag color="red">{errorCount}个阻断问题</Tag>}{warningCount > 0 && <Tag color="gold">{warningCount}条提示</Tag>}{errorCount === 0 && <Tag color="green">可以导入</Tag>}</Space>}>
        <Space wrap size={[8, 8]}>{counts.map(([label, count]) => <Tag key={label}>{label} {count}</Tag>)}</Space>
        {issues.length > 0 && <Table
          rowKey={(row) => `${row.level}-${row.sheet}-${row.row}-${row.field}-${row.message}`}
          size="small"
          style={{ marginTop: 14 }}
          pagination={{ pageSize: 8 }}
          dataSource={issues}
          columns={[
            { title: "级别", dataIndex: "level", width: 80, render: (value: IssueLevel) => <Tag color={value === "error" ? "red" : "gold"}>{value === "error" ? "阻断" : "提示"}</Tag> },
            { title: "位置", width: 150, render: (_, row: ImportIssue) => `${row.sheet}${row.row > 0 ? ` 第${row.row}行` : ""}` },
            { title: "字段", dataIndex: "field", width: 130 },
            { title: "说明", dataIndex: "message" },
          ]}
        />}
        <Divider />
        {importing && <Progress percent={progress} status="active" style={{ marginBottom: 14 }} />}
        {result && <Alert showIcon type={progress === 100 ? "success" : "warning"} message={result} style={{ marginBottom: 14 }} />}
        <Button type="primary" disabled={!canWrite || errorCount > 0 || importing} loading={importing} onClick={() => void confirmImport()}>确认导入草稿</Button>
      </Card>}
    </Space>
  );
}
