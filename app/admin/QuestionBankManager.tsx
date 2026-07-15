"use client";

import { useMemo, useState } from "react";

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
  updated_at: string;
};

export type QuestionImportItem = {
  id: number;
  bank_id: number;
  bank_name: string;
  file_name: string;
  total_rows: number;
  imported_rows: number;
  failed_rows: number;
  status: "processing" | "completed" | "completed_with_errors" | "failed";
  error_summary: string;
  created_at: string;
  completed_at: string | null;
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
  frequency: "高频" | "中频" | "低频" | "";
  importanceStars: number | null;
  scoreRate: number | null;
  suggestedSeconds: number | null;
  imageUrl: string;
  resourceUrl: string;
};

type ManagedQuestion = CanonicalQuestion & { id: number; status?: "active" | "disabled"; bankNames?: string };

type RowIssue = { row: number; message: string };

type Props = {
  adminToken: string;
  banks: QuestionBankItem[];
  imports: QuestionImportItem[];
  onReload: () => Promise<void>;
  onMessage: (message: string) => void;
};

// 后端单题CRUD接口接通后改为 true；默认隐藏，避免运营人员触发未实现动作。
const ENABLE_SINGLE_QUESTION_ADMIN = false;

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
    考频: "高频",
    重要星级: 5,
    拿分率: 72,
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
    来源: "广东-2024",
    图片地址: "",
    资源地址: "",
  },
  {
    题目编号: "GD-SL-2024-0001",
    科目: "申论",
    地区: "广东",
    真题年份: 2024,
    考频: "高频",
    重要星级: 5,
    拿分率: 65,
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
    来源: "广东-2024",
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
  const importanceStars = Number(cell(row, ["重要星级", "星级", "importanceStars"]));
  const scoreRate = Number(cell(row, ["拿分率", "基础拿分率", "scoreRate"]).replace("%", ""));
  const suggestedSeconds = Number(cell(row, ["建议用时(秒)", "建议用时", "suggestedSeconds"]));
  const frequencyRaw = cell(row, ["考频", "frequency"]);
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
    frequency: (["高频", "中频", "低频"].includes(frequencyRaw) ? frequencyRaw : "") as CanonicalQuestion["frequency"],
    importanceStars: Number.isInteger(importanceStars) && importanceStars >= 1 && importanceStars <= 5 ? importanceStars : null,
    scoreRate: Number.isFinite(scoreRate) && scoreRate >= 0 && scoreRate <= 100 ? scoreRate : null,
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
  if (!row.source) issues.push({ row: line, message: "来源不能为空，请填写地区-年份，如广东-2024" });
  if (!row.region) issues.push({ row: line, message: "地区不能为空，国考题填写国考" });
  if (!row.examYear) issues.push({ row: line, message: "真题年份必须填写四位年份" });
  if (!row.frequency) issues.push({ row: line, message: "考频只能填写高频、中频或低频" });
  if (!row.importanceStars) issues.push({ row: line, message: "重要星级必须是1—5" });
  if (row.scoreRate === null) issues.push({ row: line, message: "拿分率必须是0—100的数字" });
  if (!row.suggestedSeconds) issues.push({ row: line, message: "建议用时必须填写正整数秒数" });
  if (!row.explanation) issues.push({ row: line, message: "解析/参考答案不能为空" });
  if (row.subject === "行测" && (row.options.length < 2 || !row.answer || !/^[A-H]$/.test(row.answer))) issues.push({ row: line, message: "行测题缺少选项或正确答案" });
  if (row.subject === "申论" && !row.prompt) issues.push({ row: line, message: "申论题缺少申论任务" });
  return issues;
}

export default function QuestionBankManager({ adminToken, banks, imports, onReload, onMessage }: Props) {
  const [bankForm, setBankForm] = useState({ ...emptyBank });
  const [editingBankId, setEditingBankId] = useState<number | null>(null);
  const [selectedBankId, setSelectedBankId] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [rows, setRows] = useState<CanonicalQuestion[]>([]);
  const [issues, setIssues] = useState<RowIssue[]>([]);
  const [readingFile, setReadingFile] = useState(false);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [questionSearch, setQuestionSearch] = useState("");
  const [questionResults, setQuestionResults] = useState<ManagedQuestion[]>([]);
  const [searchingQuestions, setSearchingQuestions] = useState(false);
  const [editingQuestion, setEditingQuestion] = useState<ManagedQuestion | null>(null);

  const api = async (payload: Record<string, unknown>) => {
    const response = await fetch("/api/app", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, adminToken }),
    });
    const data = await response.json() as Record<string, unknown> & { error?: string };
    if (!response.ok) throw new Error(data.error || "操作失败");
    return data;
  };

  const selectedBank = useMemo(() => banks.find((bank) => String(bank.id) === selectedBankId), [banks, selectedBankId]);

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
    try {
      await api({ action: "adminUpsertQuestion", id: editingQuestion.id, question: editingQuestion });
      onMessage("单题修改已保存");
      setEditingQuestion(null);
      await searchQuestions();
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "单题保存失败");
    }
  };

  const toggleQuestionStatus = async (question: ManagedQuestion) => {
    try {
      const status = question.status === "disabled" ? "active" : "disabled";
      await api({ action: "adminSetQuestionStatus", id: question.id, status });
      onMessage(status === "disabled" ? "题目已停用，不再进入训练" : "题目已恢复使用");
      await searchQuestions();
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "题目状态更新失败");
    }
  };

  const saveBank = async () => {
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
    sheet["!cols"] = Object.keys(templateRows[0]).map((name) => ({ wch: ["题干/材料", "解析", "申论任务"].includes(name) ? 42 : ["图片地址", "资源地址"].includes(name) ? 28 : 14 }));
    XLSX.utils.book_append_sheet(workbook, sheet, "题库导入模板");
    XLSX.writeFile(workbook, "公考日练题库导入模板.xlsx");
    onMessage("题库模板已生成");
  };

  const readFile = async (file: File) => {
    setReadingFile(true);
    try {
      if (!/\.(xlsx|xls|csv)$/i.test(file.name)) throw new Error("请选择 XLSX、XLS 或 CSV 文件");
      if (file.size > 20 * 1024 * 1024) throw new Error("单个文件不能超过20MB");
      const XLSX = await import("xlsx");
      const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
      const sheetName = workbook.SheetNames[0];
      if (!sheetName) throw new Error("文件中没有可读取的工作表");
      const sourceRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[sheetName], { defval: "", raw: false });
      if (!sourceRows.length) throw new Error("文件中没有题目数据");
      if (sourceRows.length > 50_000) throw new Error("单个文件最多导入50000道题");
      const normalized = sourceRows.map(normalizeRow);
      const nextIssues = normalized.flatMap(validateRow);
      setSelectedFile(file);
      setRows(normalized);
      setIssues(nextIssues);
      setProgress(0);
      onMessage(`已读取 ${normalized.length} 行，发现 ${nextIssues.length} 个待处理问题`);
    } catch (error) {
      setSelectedFile(null);
      setRows([]);
      setIssues([]);
      onMessage(error instanceof Error ? error.message : "文件读取失败");
    } finally {
      setReadingFile(false);
    }
  };

  const importQuestions = async () => {
    if (!selectedBank || !selectedFile || !rows.length) return onMessage("请先选择题库并上传文件");
    setImporting(true);
    setProgress(0);
    const allErrors: RowIssue[] = [];
    let importId = 0;
    try {
      const start = await api({
        action: "adminStartQuestionImport",
        bankId: selectedBank.id,
        fileName: selectedFile.name,
        fileSize: selectedFile.size,
        totalRows: rows.length,
      });
      importId = Number(start.importId);
      for (let offset = 0; offset < rows.length; offset += 40) {
        const batch = rows.slice(offset, offset + 40);
        const result = await api({ action: "adminImportQuestionBatch", importId, bankId: selectedBank.id, offset, rows: batch });
        allErrors.push(...((result.errors ?? []) as RowIssue[]));
        setProgress(Math.min(100, Math.round(((offset + batch.length) / rows.length) * 100)));
      }
      const summary = allErrors.slice(0, 100).map((item) => `第${item.row}行：${item.message}`).join("\n");
      await api({ action: "adminFinishQuestionImport", importId, errorSummary: summary });
      onMessage(allErrors.length ? `导入完成，${allErrors.length} 行未通过校验` : `导入完成，共处理 ${rows.length} 道题`);
      await onReload();
    } catch (error) {
      const reason = error instanceof Error ? error.message : "题库导入中断";
      if (importId) {
        try { await api({ action: "adminFinishQuestionImport", importId, aborted: true, errorSummary: reason }); } catch { /* keep original error */ }
      }
      onMessage(reason);
    } finally {
      setImporting(false);
    }
  };

  return (
    <>
      <section className="admin-panel bank-config-panel">
        <div className="admin-panel-title"><div><span>题库配置</span><h2>{editingBankId ? "编辑题库配置" : "创建国考或省考题库"}</h2><small>省考按省份独立建库；国省共通题可复用同一题目编号，系统会跨库去重。</small></div><button onClick={() => { setEditingBankId(null); setBankForm({ ...emptyBank }); }}>新建空白题库</button></div>
        <div className="form-grid bank-form-grid">
          <label>题库编码<input value={bankForm.bankCode} onChange={(event) => setBankForm({ ...bankForm, bankCode: event.target.value.toUpperCase() })} placeholder="如 GD-XC-2027" /></label>
          <label>题库名称<input value={bankForm.name} onChange={(event) => setBankForm({ ...bankForm, name: event.target.value })} placeholder="如 2027广东省考·行测综合" /></label>
          <label>考试类型<select value={bankForm.examType} onChange={(event) => setBankForm({ ...bankForm, examType: event.target.value, province: event.target.value === "provincial" ? bankForm.province : "" })}><option value="national">国考</option><option value="provincial">省考</option><option value="special">专项题库</option></select></label>
          <label>省份<input value={bankForm.province} disabled={bankForm.examType !== "provincial"} onChange={(event) => setBankForm({ ...bankForm, province: event.target.value })} placeholder={bankForm.examType === "provincial" ? "省考必填，如广东" : "仅省考题库需要填写"} /></label>
          <label>适用年份<input type="number" min="2020" max="2100" value={bankForm.examYear} onChange={(event) => setBankForm({ ...bankForm, examYear: Number(event.target.value) })} /></label>
          <label>科目<select value={bankForm.subject} onChange={(event) => setBankForm({ ...bankForm, subject: event.target.value })}><option>行测</option><option>申论</option><option>综合</option></select></label>
          <label>封面颜色<select value={bankForm.coverColor} onChange={(event) => setBankForm({ ...bankForm, coverColor: event.target.value })}><option value="blue">公考蓝</option><option value="orange">活力橙</option><option value="green">成长绿</option><option value="purple">进阶紫</option></select></label>
          <label>初始状态<select value={bankForm.status} onChange={(event) => setBankForm({ ...bankForm, status: event.target.value })}><option value="draft">草稿</option><option value="published">发布</option></select></label>
          <label className="wide">题库简介<textarea value={bankForm.description} onChange={(event) => setBankForm({ ...bankForm, description: event.target.value })} placeholder="适用人群、题目范围和更新说明" /></label>
        </div>
        <button className="admin-primary" onClick={saveBank}>{editingBankId ? "保存题库修改" : "保存题库配置"}</button>
      </section>

      <section className="admin-panel question-upload-panel">
        <div className="admin-panel-title"><div><span>文件导入</span><h2>上传Excel或CSV题库</h2></div><button onClick={() => void downloadTemplate()}>下载Excel模板</button></div>
        <div className="upload-toolbar">
          <label>导入到题库<select value={selectedBankId} onChange={(event) => setSelectedBankId(event.target.value)}><option value="">请选择目标题库</option>{banks.map((bank) => <option key={bank.id} value={bank.id}>{bank.name}（{bank.question_count}题）</option>)}</select></label>
          <label className="upload-dropzone"><input type="file" accept=".xlsx,.xls,.csv" onChange={(event) => { const file = event.target.files?.[0]; if (file) void readFile(file); }} /><span>{readingFile ? "正在读取文件…" : selectedFile ? selectedFile.name : "点击选择 XLSX / XLS / CSV 文件"}</span><small>最大20MB，首行必须是模板字段名</small></label>
        </div>

        {rows.length > 0 && (
          <div className="import-preview">
            <div className="import-summary"><span><b>{rows.length}</b>总行数</span><span><b>{rows.length - new Set(issues.map((item) => item.row)).size}</b>预计通过</span><span className={issues.length ? "has-errors" : ""}><b>{issues.length}</b>校验问题</span></div>
            <div className="admin-table-wrap"><table><thead><tr><th>题目编号</th><th>真题标签</th><th>价值标签</th><th>模块</th><th>题干/材料</th><th>答案/任务</th></tr></thead><tbody>{rows.slice(0, 6).map((row, index) => <tr key={`${row.questionCode}-${index}`}><td>{row.questionCode || "未填写"}</td><td><b>{row.region && row.examYear ? `${row.region}-${row.examYear}` : "未填写"}</b></td><td>{row.frequency || "—"} · {row.importanceStars ? `${row.importanceStars}星` : "—"} · {row.scoreRate ?? "—"}%</td><td>{row.module || "未填写"}</td><td className="preview-text">{row.stem || "未填写"}</td><td className="preview-text">{row.subject === "申论" ? row.prompt : row.answer}</td></tr>)}</tbody></table></div>
            {issues.length > 0 && <details className="issue-list"><summary>查看前20个校验问题</summary>{issues.slice(0, 20).map((issue, index) => <p key={`${issue.row}-${index}`}>第 {issue.row} 行：{issue.message}</p>)}</details>}
            {importing && <div className="import-progress"><div><i style={{ width: `${progress}%` }} /></div><span>{progress}%</span></div>}
            <button className="admin-primary import-button" onClick={importQuestions} disabled={importing || !selectedBankId}>{importing ? "正在分批导入…" : `导入到${selectedBank?.name ?? "目标题库"}`}</button>
          </div>
        )}
      </section>

      <section className="admin-panel table-panel">
        <div className="admin-panel-title"><div><span>题库书架</span><h2>题库整理与发布</h2></div><button onClick={() => void onReload()}>刷新</button></div>
        <div className="admin-table-wrap"><table><thead><tr><th>题库</th><th>分类</th><th>年份</th><th>题量</th><th>状态</th><th>操作</th></tr></thead><tbody>{banks.length ? banks.map((bank) => <tr key={bank.id}><td><b>{bank.name}</b><small>{bank.bank_code}</small></td><td>{bank.exam_type === "national" ? "国考" : bank.exam_type === "provincial" ? `${bank.province}省考` : "专项"} · {bank.subject}</td><td>{bank.exam_year ?? "长期"}</td><td>{bank.question_count}</td><td><span className={`status ${bank.status}`}>{bank.status === "published" ? "已发布" : "草稿"}</span></td><td><button onClick={() => editBank(bank)}>编辑</button><button onClick={() => void toggleBankStatus(bank)}>{bank.status === "published" ? "下线" : "发布"}</button></td></tr>) : <tr><td colSpan={6}>还没有题库，请先在上方创建。</td></tr>}</tbody></table></div>
      </section>

      {ENABLE_SINGLE_QUESTION_ADMIN && <section className="admin-panel table-panel">
        <div className="admin-panel-title"><div><span>单题管理</span><h2>搜索、编辑与停用真题</h2><small>可按题号、题干或来源搜索；标签统一显示为“地区-年份”，如广东-2024。</small></div></div>
        <div className="upload-toolbar">
          <label>目标题库<select value={selectedBankId} onChange={(event) => setSelectedBankId(event.target.value)}><option value="">全部题库</option>{banks.map((bank) => <option key={bank.id} value={bank.id}>{bank.name}</option>)}</select></label>
          <label>搜索关键词<div style={{ display: "flex", gap: 8 }}><input value={questionSearch} onChange={(event) => setQuestionSearch(event.target.value)} placeholder="题目编号、题干或来源" onKeyDown={(event) => { if (event.key === "Enter") void searchQuestions(); }} /><button type="button" onClick={() => void searchQuestions()}>{searchingQuestions ? "搜索中…" : "搜索"}</button></div></label>
        </div>
        {editingQuestion && <div className="import-preview">
          <div className="admin-panel-title"><div><span>编辑单题</span><h2>{editingQuestion.questionCode}</h2></div><button onClick={() => setEditingQuestion(null)}>取消</button></div>
          <div className="form-grid bank-form-grid">
            <label>地区<input value={editingQuestion.region} onChange={(event) => setEditingQuestion({ ...editingQuestion, region: event.target.value })} /></label>
            <label>真题年份<input type="number" value={editingQuestion.examYear ?? ""} onChange={(event) => setEditingQuestion({ ...editingQuestion, examYear: Number(event.target.value) || null })} /></label>
            <label>考频<select value={editingQuestion.frequency} onChange={(event) => setEditingQuestion({ ...editingQuestion, frequency: event.target.value as CanonicalQuestion["frequency"] })}><option>高频</option><option>中频</option><option>低频</option></select></label>
            <label>重要星级<input type="number" min="1" max="5" value={editingQuestion.importanceStars ?? ""} onChange={(event) => setEditingQuestion({ ...editingQuestion, importanceStars: Number(event.target.value) || null })} /></label>
            <label>拿分率<input type="number" min="0" max="100" value={editingQuestion.scoreRate ?? ""} onChange={(event) => setEditingQuestion({ ...editingQuestion, scoreRate: Number(event.target.value) })} /></label>
            <label>建议用时（秒）<input type="number" min="1" value={editingQuestion.suggestedSeconds ?? ""} onChange={(event) => setEditingQuestion({ ...editingQuestion, suggestedSeconds: Number(event.target.value) || null })} /></label>
            <label className="wide">图片地址<input value={editingQuestion.imageUrl} onChange={(event) => setEditingQuestion({ ...editingQuestion, imageUrl: event.target.value })} /></label>
            <label className="wide">资源地址<input value={editingQuestion.resourceUrl} onChange={(event) => setEditingQuestion({ ...editingQuestion, resourceUrl: event.target.value })} /></label>
          </div>
          <button className="admin-primary" onClick={() => void saveQuestion()}>保存单题修改</button>
        </div>}
        {questionResults.length > 0 && <div className="admin-table-wrap"><table><thead><tr><th>题目</th><th>真题标签</th><th>价值标签</th><th>题库</th><th>状态</th><th>操作</th></tr></thead><tbody>{questionResults.map((question) => <tr key={question.id}><td><b>{question.questionCode}</b><small>{question.module} · {question.subType}</small></td><td>{question.region}-{question.examYear}</td><td>{question.frequency} · {question.importanceStars}星 · {question.scoreRate}%</td><td>{question.bankNames ?? "—"}</td><td><span className={`status ${question.status === "disabled" ? "disabled" : "published"}`}>{question.status === "disabled" ? "已停用" : "使用中"}</span></td><td><button onClick={() => setEditingQuestion(question)}>编辑标签</button><button onClick={() => void toggleQuestionStatus(question)}>{question.status === "disabled" ? "恢复" : "停用"}</button></td></tr>)}</tbody></table></div>}
      </section>}

      <section className="admin-panel table-panel">
        <div className="admin-panel-title"><div><span>导入记录</span><h2>最近题库文件</h2></div></div>
        <div className="admin-table-wrap"><table><thead><tr><th>时间</th><th>题库</th><th>文件</th><th>结果</th><th>状态</th></tr></thead><tbody>{imports.length ? imports.map((item) => <tr key={item.id}><td>{new Date(item.created_at).toLocaleString("zh-CN")}</td><td>{item.bank_name}</td><td>{item.file_name}</td><td>{item.imported_rows} 成功 / {item.failed_rows} 失败</td><td><span className={`status ${item.status}`}>{item.status === "processing" ? "导入中" : item.status === "completed" ? "已完成" : item.status === "failed" ? "已中断" : "部分失败"}</span></td></tr>) : <tr><td colSpan={5}>暂无导入记录。</td></tr>}</tbody></table></div>
      </section>
    </>
  );
}
