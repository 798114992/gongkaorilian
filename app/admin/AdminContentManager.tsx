"use client";

import { useMemo, useState } from "react";
import styles from "./AdminContentManager.module.css";

export type AdminContentType =
  | "morning_read"
  | "current_affairs"
  | "essay_micro"
  | "audio_track"
  | "exam_event"
  | "exam_notice"
  | "job_position"
  | "drill_preset"
  | "strategy_config"
  | "practice_day";

export type AdminContentItem = {
  id: number;
  content_type: AdminContentType;
  content_key: string;
  title: string;
  status: "draft" | "scheduled" | "published" | "archived";
  publish_at: string | null;
  payload?: Record<string, unknown>;
  payload_json?: string;
  version_count?: number | string;
  updated_at: string;
};

type Props = {
  adminToken: string;
  items: AdminContentItem[];
  onReload: () => Promise<void>;
  onMessage: (message: string) => void;
};

type PublishMode = "draft" | "now" | "scheduled";
type ContentDraft = {
  contentType: Exclude<AdminContentType, "practice_day">;
  contentKey: string;
  title: string;
  publishMode: PublishMode;
  publishAt: string;
  payload: Record<string, unknown>;
};

type VersionItem = {
  id: number;
  version: number;
  title: string;
  status: "draft" | "scheduled" | "published" | "archived";
  publish_at: string | null;
  payload?: Record<string, unknown>;
  created_at: string;
};

type PositionPreview = {
  row: number;
  contentKey: string;
  title: string;
  payload: Record<string, unknown>;
  issues: string[];
};

const CONTENT_TYPES: Array<{ type: Exclude<AdminContentType, "practice_day">; label: string; short: string; tone: string }> = [
  { type: "morning_read", label: "申论晨读", short: "文章、规范表达、金句", tone: "blue" },
  { type: "current_affairs", label: "时政内容", short: "热点、会议、新法解读", tone: "orange" },
  { type: "essay_micro", label: "申论微练", short: "材料、任务、参考答案", tone: "green" },
  { type: "audio_track", label: "日练电台", short: "音频、逐字稿、栏目", tone: "purple" },
  { type: "exam_notice", label: "招考公告", short: "公告摘要与官方来源", tone: "orange" },
  { type: "exam_event", label: "考试节点", short: "报名、缴费、准考证、考试", tone: "blue" },
  { type: "job_position", label: "职位数据", short: "单条维护或Excel批量导入", tone: "green" },
  { type: "drill_preset", label: "专项微练", short: "动态配置专项、题量与筛选规则", tone: "purple" },
  { type: "strategy_config", label: "训练策略", short: "时长、题量与选题权重", tone: "blue" },
];

const TYPE_LABEL = Object.fromEntries(CONTENT_TYPES.map((item) => [item.type, item.label])) as Record<AdminContentType, string>;
TYPE_LABEL.practice_day = "旧版日练包";

function chinaDateInput() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

const defaultPayload = (type: ContentDraft["contentType"]): Record<string, unknown> => {
  if (type === "morning_read") return { date: chinaDateInput(), category: "人民日报评论", kicker: "今日晨读", source: "", body: "", keywords: "", audioUrl: "", targetCodes: "" };
  if (type === "current_affairs") return { date: chinaDateInput(), category: "月度热点", source: "", summary: "", body: "", importanceStars: 4, targetCodes: "" };
  if (type === "essay_micro") return { date: chinaDateInput(), theme: "基层治理", material: "", prompt: "", referenceAnswer: "", wordLimit: 150, scoringPoints: "", targetCodes: "" };
  if (type === "audio_track") return { id: "", category: "current", seriesId: "current", seriesTitle: "时政电台", seriesLabel: "时政", seriesColor: "#245c92", seriesIcon: "政", sortOrder: 10, kicker: "月度热点", source: "", duration: "5分钟", description: "", text: "", audioUrl: "" };
  if (type === "exam_notice") return { targetCode: "national", targetLabel: "国考", noticeType: "招录公告", publishDate: "", summary: "", sourceUrl: "", status: "待报名" };
  if (type === "exam_event") return { targetCode: "national", targetLabel: "国考", eventType: "报名开始", eventDate: "", reminderDays: 3, sourceUrl: "" };
  if (type === "job_position") return { targetCode: "national", targetLabel: "国考", examName: "", department: "", unit: "", code: "", region: "", recruitCount: 1, education: "本科及以上", degree: "不限", majors: "", freshLimit: "不限", politicalStatus: "不限", household: "不限", grassrootsYears: "不限", gender: "不限", certificates: "不限", remarks: "", phone: "", sourceUrl: "" };
  if (type === "drill_preset") return { icon: "练", color: "blue", subject: "行测", module: "资料分析", subType: "", bankCodes: "", questionCount: 5, minutes: 8, targetCodes: "", frequency: "高频", importanceStars: 4, scoreRateMin: 40, scoreRateMax: 80, sort: 10, enabled: true };
  return {
    morning10: 0, practice10: 10, essay10: 0, questions10: 5,
    morning30: 5, practice30: 20, essay30: 5, questions30: 10,
    morning45: 5, practice45: 30, essay45: 10, questions45: 15,
    morning60: 10, practice60: 35, essay60: 15, questions60: 20,
    reviewRatio: 60, regionWeight: 30, frequencyWeight: 25, importanceWeight: 25,
    scoreRateWeight: 20, scoreRateMin: 40, scoreRateMax: 80, urgentExamDays: 30, enabled: true,
  };
};

const emptyDraft = (type: ContentDraft["contentType"] = "morning_read"): ContentDraft => ({
  contentType: type,
  contentKey: `${type}-${Date.now().toString(36)}`,
  title: "",
  publishMode: "draft",
  publishAt: "",
  payload: defaultPayload(type),
});

function readPayload(item: AdminContentItem): Record<string, unknown> {
  if (item.payload && typeof item.payload === "object") return item.payload;
  if (item.payload_json) {
    try {
      const parsed = JSON.parse(item.payload_json) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch { /* 编辑时仍可加载公共字段 */ }
  }
  return {};
}

function asText(value: unknown) {
  if (Array.isArray(value)) return value.join("、");
  if (typeof value === "boolean") return value ? "是" : "否";
  return value === null || value === undefined ? "" : String(value);
}

function dateTimeLocal(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 16);
  const adjusted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return adjusted.toISOString().slice(0, 16);
}

function spreadsheetCell(row: Record<string, unknown>, names: string[]) {
  for (const name of names) {
    const value = row[name];
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return "";
}

const positionTemplate = [{
  考试目标: "广东省考",
  目标编码: "province:广东",
  考试名称: "2027广东省考",
  部门: "广州市某区人民政府",
  用人单位: "基层治理办公室",
  职位名称: "基层治理岗",
  职位代码: "101001",
  地区: "广州",
  招录人数: 1,
  学历: "本科及以上",
  学位: "学士及以上",
  专业: "汉语言文学、法学、公共管理类",
  应届限制: "不限",
  政治面貌: "不限",
  户籍限制: "不限",
  基层年限: "不限",
  性别: "不限",
  证书要求: "不限",
  备注: "请以官方职位表为准",
  咨询电话: "020-00000000",
  来源链接: "https://example.com/position-table",
}];

export default function AdminContentManager({ adminToken, items, onReload, onMessage }: Props) {
  const [draft, setDraft] = useState<ContentDraft>(() => emptyDraft());
  const [editingId, setEditingId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [filterType, setFilterType] = useState<"all" | AdminContentType>("all");
  const [search, setSearch] = useState("");
  const [preview, setPreview] = useState<AdminContentItem | ContentDraft | null>(null);
  const [versionItem, setVersionItem] = useState<AdminContentItem | null>(null);
  const [versions, setVersions] = useState<VersionItem[]>([]);
  const [loadingVersions, setLoadingVersions] = useState(false);
  const [uploadingAudio, setUploadingAudio] = useState(false);
  const [uploadingAsset, setUploadingAsset] = useState(false);
  const [lastAsset, setLastAsset] = useState<{ name: string; url: string } | null>(null);
  const [positionFile, setPositionFile] = useState<File | null>(null);
  const [positionRows, setPositionRows] = useState<PositionPreview[]>([]);
  const [readingPositions, setReadingPositions] = useState(false);
  const [importingPositions, setImportingPositions] = useState(false);

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

  const filteredItems = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return items.filter((item) => {
      if (filterType !== "all" && item.content_type !== filterType) return false;
      if (!keyword) return true;
      return `${TYPE_LABEL[item.content_type] ?? item.content_type} ${item.content_key} ${item.title}`.toLowerCase().includes(keyword);
    });
  }, [filterType, items, search]);

  const setField = (name: string, value: unknown) => setDraft((current) => ({
    ...current,
    payload: { ...current.payload, [name]: value },
  }));

  const switchType = (type: ContentDraft["contentType"]) => {
    setEditingId(null);
    setDraft(emptyDraft(type));
    document.querySelector("[data-content-form]")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const fullItem = async (item: AdminContentItem) => {
    if (Object.keys(readPayload(item)).length) return item;
    try {
      const data = await api({ action: "adminGetContent", id: item.id });
      return (data.content ?? item) as AdminContentItem;
    } catch {
      return item;
    }
  };

  const beginEdit = async (item: AdminContentItem) => {
    const source = await fullItem(item);
    const payload = readPayload(source);
    const type = source.content_type === "practice_day" ? "morning_read" : source.content_type;
    setEditingId(source.id);
    setDraft({
      contentType: type,
      contentKey: source.content_key,
      title: source.title,
      publishMode: source.status === "draft" || source.status === "archived" ? "draft" : source.status === "scheduled" ? "scheduled" : "now",
      publishAt: dateTimeLocal(source.publish_at),
      payload: { ...defaultPayload(type), ...payload },
    });
    document.querySelector("[data-content-form]")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const duplicate = async (item: AdminContentItem) => {
    const source = await fullItem(item);
    const type = source.content_type === "practice_day" ? "morning_read" : source.content_type;
    setEditingId(null);
    setDraft({
      contentType: type,
      contentKey: `${source.content_key}-copy-${Date.now().toString(36)}`,
      title: `${source.title}（副本）`,
      publishMode: "draft",
      publishAt: "",
      payload: { ...defaultPayload(type), ...readPayload(source) },
    });
    onMessage("已复制为新草稿，请确认后保存");
    document.querySelector("[data-content-form]")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const validateDraft = () => {
    if (!draft.title.trim()) throw new Error("请填写内容标题");
    if (!draft.contentKey.trim()) throw new Error("请填写内容标识");
    if (["morning_read", "current_affairs", "essay_micro"].includes(draft.contentType) && !/^\d{4}-\d{2}-\d{2}$/.test(asText(draft.payload.date))) throw new Error("请选择内容展示日期");
    if (draft.publishMode === "scheduled" && !draft.publishAt) throw new Error("请选择定时发布时间");
    if (draft.publishMode === "scheduled" && new Date(draft.publishAt).getTime() <= Date.now()) throw new Error("定时发布时间必须晚于当前时间");
    if (draft.contentType === "audio_track" && !asText(draft.payload.audioUrl)) throw new Error("请上传音频或填写音频地址");
    if (draft.contentType === "exam_event" && !asText(draft.payload.eventDate)) throw new Error("请填写节点日期");
    if (draft.contentType === "exam_notice" && !asText(draft.payload.sourceUrl)) throw new Error("公告必须填写官方来源链接");
    if (draft.contentType === "job_position" && !asText(draft.payload.code)) throw new Error("请填写职位代码");
  };

  const save = async () => {
    setSaving(true);
    try {
      validateDraft();
      const status = draft.publishMode === "draft" ? "draft" : "published";
      const publishAt = draft.publishMode === "scheduled" ? new Date(draft.publishAt).toISOString() : null;
      await api({
        action: "adminUpsertContentBatch",
        items: [{
          contentType: draft.contentType,
          contentKey: draft.contentKey.trim(),
          title: draft.title.trim(),
          status,
          publishAt,
          payload: { ...draft.payload, title: draft.title.trim(), ...(draft.contentType === "audio_track" ? { id: draft.contentKey.trim() } : {}) },
        }],
      });
      onMessage(draft.publishMode === "draft" ? "内容已保存为草稿" : draft.publishMode === "scheduled" ? "内容已进入定时发布队列" : "内容已立即发布");
      setEditingId(null);
      setDraft(emptyDraft(draft.contentType));
      await onReload();
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "内容保存失败");
    } finally {
      setSaving(false);
    }
  };

  const disable = async (item: AdminContentItem) => {
    try {
      await api({ action: "adminDisableContent", id: item.id });
      onMessage("内容已下架并保留在草稿库，可随时重新发布");
      await onReload();
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "内容下架失败");
    }
  };

  const republish = async (item: AdminContentItem) => {
    const source = await fullItem(item);
    const payload = readPayload(source);
    if (!Object.keys(payload).length) return onMessage("该旧内容缺少回填数据，请先点编辑补齐后发布");
    try {
      await api({ action: "adminUpsertContentBatch", items: [{ contentType: source.content_type, contentKey: source.content_key, title: source.title, status: "published", publishAt: null, payload }] });
      onMessage("内容已重新发布");
      await onReload();
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "重新发布失败");
    }
  };

  const openVersions = async (item: AdminContentItem) => {
    setVersionItem(item);
    setVersions([]);
    setLoadingVersions(true);
    try {
      const data = await api({ action: "adminListContentVersions", id: item.id, contentType: item.content_type, contentKey: item.content_key });
      setVersions((data.versions ?? []) as VersionItem[]);
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "版本记录加载失败");
    } finally {
      setLoadingVersions(false);
    }
  };

  const rollback = async (version: VersionItem) => {
    if (!versionItem) return;
    try {
      await api({ action: "adminRollbackContent", id: versionItem.id, version: version.version });
      onMessage(`已回滚到第 ${version.version} 版，并生成一条新的版本记录`);
      setVersionItem(null);
      await onReload();
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "版本回滚失败");
    }
  };

  const uploadMediaFile = async (file: File) => {
    if (file.size > 25 * 1024 * 1024) throw new Error("单个文件不能超过25MB");
    const form = new FormData();
    form.append("action", "adminUploadMedia");
    form.append("adminToken", adminToken);
    form.append("file", file);
    const response = await fetch("/api/app", { method: "POST", body: form });
    const data = await response.json() as { error?: string; url?: string; asset?: { url?: string } };
    if (!response.ok) throw new Error(data.error || "媒体上传失败");
    const url = data.url ?? data.asset?.url;
    if (!url) throw new Error("上传成功但没有返回媒体地址");
    return url;
  };

  const uploadAudio = async (file: File) => {
    if (!file.type.startsWith("audio/") && !/\.(mp3|m4a|wav|aac|ogg)$/i.test(file.name)) return onMessage("请选择 MP3、M4A、WAV、AAC 或 OGG 音频");
    setUploadingAudio(true);
    try {
      const url = await uploadMediaFile(file);
      setField("audioUrl", url);
      onMessage("音频已上传并自动回填地址");
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "音频上传失败");
    } finally {
      setUploadingAudio(false);
    }
  };

  const uploadAsset = async (file: File) => {
    if (!file.type.startsWith("audio/") && !file.type.startsWith("image/") && file.type !== "application/pdf") return onMessage("请选择音频、图片或PDF文件");
    setUploadingAsset(true);
    try {
      const url = await uploadMediaFile(file);
      setLastAsset({ name: file.name, url });
      onMessage("媒体已上传，可复制地址填入题库模板或内容表单");
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "媒体上传失败");
    } finally {
      setUploadingAsset(false);
    }
  };

  const downloadPositionTemplate = async () => {
    const XLSX = await import("xlsx");
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.json_to_sheet(positionTemplate);
    sheet["!cols"] = Object.keys(positionTemplate[0]).map((name) => ({ wch: Math.max(12, Math.min(30, name.length * 2 + 8)) }));
    XLSX.utils.book_append_sheet(workbook, sheet, "职位导入模板");
    XLSX.writeFile(workbook, "公考日练职位导入模板.xlsx");
    onMessage("职位表模板已生成");
  };

  const readPositionFile = async (file: File) => {
    setReadingPositions(true);
    try {
      if (!/\.(xlsx|xls|csv)$/i.test(file.name)) throw new Error("请选择 XLSX、XLS 或 CSV 文件");
      if (file.size > 30 * 1024 * 1024) throw new Error("单个职位表不能超过30MB");
      const XLSX = await import("xlsx");
      const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
      const sheetName = workbook.SheetNames[0];
      if (!sheetName) throw new Error("文件中没有可读取的工作表");
      const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[sheetName], { defval: "", raw: false });
      if (!rawRows.length) throw new Error("职位表中没有数据");
      if (rawRows.length > 50_000) throw new Error("单个文件最多导入50000条职位");
      const normalized = rawRows.map((row, index): PositionPreview => {
        const code = spreadsheetCell(row, ["职位代码", "岗位代码", "code"]);
        const title = spreadsheetCell(row, ["职位名称", "岗位名称", "title"]);
        const department = spreadsheetCell(row, ["部门", "招录机关", "department"]);
        const examName = spreadsheetCell(row, ["考试名称", "examName"]);
        const region = spreadsheetCell(row, ["地区", "工作地点", "region"]);
        const targetLabel = spreadsheetCell(row, ["考试目标", "targetLabel"]) || examName;
        const targetCode = spreadsheetCell(row, ["目标编码", "targetCode"]) || (targetLabel.includes("国考") ? "national" : `province:${targetLabel.replace(/省考|省/g, "")}`);
        const issues: string[] = [];
        if (!examName) issues.push("考试名称为空");
        if (!department) issues.push("部门为空");
        if (!title) issues.push("职位名称为空");
        if (!code) issues.push("职位代码为空");
        if (!region) issues.push("地区为空");
        const count = Number(spreadsheetCell(row, ["招录人数", "人数", "recruitCount"]) || 1);
        if (!Number.isInteger(count) || count < 1) issues.push("招录人数必须是正整数");
        return {
          row: index + 2,
          contentKey: `position-${code || index + 1}`.replace(/\s+/g, "-").toLowerCase(),
          title,
          issues,
          payload: {
            targetCode,
            targetLabel,
            examName,
            department,
            unit: spreadsheetCell(row, ["用人单位", "单位", "unit"]),
            title,
            code,
            region,
            recruitCount: Number.isInteger(count) && count > 0 ? count : 1,
            education: spreadsheetCell(row, ["学历", "education"]) || "不限",
            degree: spreadsheetCell(row, ["学位", "degree"]) || "不限",
            majors: spreadsheetCell(row, ["专业", "专业要求", "majors"]),
            freshLimit: spreadsheetCell(row, ["应届限制", "应届生", "freshLimit"]) || "不限",
            politicalStatus: spreadsheetCell(row, ["政治面貌", "politicalStatus"]) || "不限",
            household: spreadsheetCell(row, ["户籍限制", "户籍", "household"]) || "不限",
            grassrootsYears: spreadsheetCell(row, ["基层年限", "基层工作年限", "grassrootsYears"]) || "不限",
            gender: spreadsheetCell(row, ["性别", "gender"]) || "不限",
            certificates: spreadsheetCell(row, ["证书要求", "证书", "certificates"]) || "不限",
            remarks: spreadsheetCell(row, ["备注", "remarks"]),
            phone: spreadsheetCell(row, ["咨询电话", "电话", "phone"]),
            sourceUrl: spreadsheetCell(row, ["来源链接", "官方链接", "sourceUrl"]),
          },
        };
      });
      setPositionFile(file);
      setPositionRows(normalized);
      const issueCount = normalized.filter((row) => row.issues.length).length;
      onMessage(`已读取 ${normalized.length} 条职位，${issueCount} 条需要修正`);
    } catch (error) {
      setPositionFile(null);
      setPositionRows([]);
      onMessage(error instanceof Error ? error.message : "职位表读取失败");
    } finally {
      setReadingPositions(false);
    }
  };

  const importPositions = async () => {
    const valid = positionRows.filter((row) => !row.issues.length);
    if (!positionFile || !valid.length) return onMessage("没有可导入的有效职位");
    setImportingPositions(true);
    try {
      const batchSize = 100;
      for (let offset = 0; offset < valid.length; offset += batchSize) {
        const batch = valid.slice(offset, offset + batchSize).map((row) => ({
          contentType: "job_position",
          contentKey: row.contentKey,
          title: row.title,
          status: "draft",
          publishAt: null,
          payload: row.payload,
        }));
        await api({ action: "adminUpsertContentBatch", items: batch });
      }
      onMessage(`已导入 ${valid.length} 条职位草稿；请抽查后再发布`);
      setPositionFile(null);
      setPositionRows([]);
      await onReload();
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "职位导入失败");
    } finally {
      setImportingPositions(false);
    }
  };

  const p = draft.payload;
  const textInput = (name: string, label: string, placeholder = "", type = "text") => (
    <label>{label}<input type={type} value={asText(p[name])} placeholder={placeholder} onChange={(event) => setField(name, event.target.value)} /></label>
  );
  const numberInput = (name: string, label: string, min = 0, max = 9999) => (
    <label>{label}<input type="number" min={min} max={max} value={asText(p[name])} onChange={(event) => setField(name, Number(event.target.value))} /></label>
  );
  const textArea = (name: string, label: string, placeholder = "", wide = true) => (
    <label className={wide ? "wide" : undefined}>{label}<textarea value={asText(p[name])} placeholder={placeholder} onChange={(event) => setField(name, event.target.value)} /></label>
  );
  const selectInput = (name: string, label: string, options: Array<[string, string]>) => (
    <label>{label}<select value={asText(p[name])} onChange={(event) => setField(name, event.target.value)}>{options.map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label>
  );

  const renderTypeFields = () => {
    if (draft.contentType === "morning_read") return <>
      {textInput("date", "展示日期", "", "date")}{selectInput("category", "内容分类", [["人民日报评论", "人民日报评论"], ["规范表达", "规范表达"], ["分主题金句", "分主题金句"], ["政策原文", "政策原文"]])}
      {textInput("kicker", "栏目角标", "今日晨读")}{textInput("source", "内容来源", "人民日报等")}{textInput("targetCodes", "适用考试", "national,province:广东")}
      {textArea("body", "晨读正文", "填写正文；每个自然段换行，前端会自动分段")}{textInput("keywords", "记忆关键词", "多个关键词用逗号或顿号分隔")}{textInput("audioUrl", "配套音频地址", "可选，或到电台板块单独上传")}
    </>;
    if (draft.contentType === "current_affairs") return <>
      {textInput("date", "内容日期", "", "date")}{selectInput("category", "内容分类", [["月度热点", "月度热点"], ["重要会议", "重要会议"], ["新法解读", "新法解读"], ["科技民生", "科技民生"]])}
      {textInput("source", "权威来源", "新华社、政府网站等")}{numberInput("importanceStars", "重要星级", 1, 5)}{textInput("targetCodes", "适用考试", "national,province:广东")}
      {textArea("summary", "一句话摘要", "帮助考生快速判断是否需要阅读")}{textArea("body", "完整内容", "填写热点背景、核心考点和可能考法")}
    </>;
    if (draft.contentType === "essay_micro") return <>
      {textInput("date", "展示日期", "", "date")}{textInput("theme", "申论主题", "基层治理")}{numberInput("wordLimit", "字数限制", 50, 2000)}{textInput("targetCodes", "适用考试", "national,province:广东")}
      {textArea("material", "给定材料", "填写精简材料")}{textArea("prompt", "作答任务", "填写题目要求")}{textArea("referenceAnswer", "参考答案", "填写规范参考答案")}{textArea("scoringPoints", "采分点", "多个采分点用｜分隔")}
    </>;
    if (draft.contentType === "audio_track") return <>
      {selectInput("category", "电台栏目", [["current", "时政电台"], ["morning", "申论晨读"], ["wrong", "错题朗读"], ["meeting", "重要会议"], ["law", "新法解读"]])}
      {textInput("seriesId", "系列编码", "current")}{textInput("seriesTitle", "系列名称", "时政电台")}{textInput("seriesLabel", "系列短标签", "时政")}{textInput("seriesColor", "系列颜色", "#245c92")}{textInput("seriesIcon", "系列图标文字", "政")}{numberInput("sortOrder", "展示顺序", 0, 9999)}
      {textInput("kicker", "栏目角标", "月度热点")}{textInput("duration", "音频时长", "5分钟")}{textInput("source", "内容来源", "公考日练整理")}
      {textArea("description", "本期简介", "一句话说明收听价值")}{textArea("text", "音频逐字稿", "用于字幕、搜索与无障碍阅读")}
      <label className="wide">音频文件<div className={styles.mediaRow}><input value={asText(p.audioUrl)} placeholder="上传后自动回填，也可填写已有HTTPS地址" onChange={(event) => setField("audioUrl", event.target.value)} /><label className={styles.uploadButton}><input type="file" accept="audio/*,.mp3,.m4a,.wav,.aac,.ogg" onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadAudio(file); }} />{uploadingAudio ? "上传中…" : "选择音频"}</label></div><small>支持MP3/M4A/WAV/AAC/OGG，单文件最大25MB。</small></label>
    </>;
    if (draft.contentType === "exam_notice") return <>
      {textInput("targetLabel", "考试目标", "广东省考")}{textInput("targetCode", "目标编码", "province:广东")}{selectInput("noticeType", "公告类型", [["招录公告", "招录公告"], ["职位表", "职位表"], ["补充公告", "补充公告"], ["资格审查", "资格审查"], ["成绩公告", "成绩公告"]])}
      {textInput("publishDate", "公告日期", "", "date")}{selectInput("status", "当前阶段", [["待报名", "待报名"], ["报名中", "报名中"], ["已截止", "已截止"], ["待考试", "待考试"]])}{textInput("sourceUrl", "官方来源链接", "https://")}
      {textArea("summary", "公告摘要", "只提炼会影响报考决策的变化、时间和条件")}
    </>;
    if (draft.contentType === "exam_event") return <>
      {textInput("targetLabel", "考试目标", "广东省考")}{textInput("targetCode", "目标编码", "province:广东")}{selectInput("eventType", "节点类型", [["公告发布", "公告发布"], ["报名开始", "报名开始"], ["报名截止", "报名截止"], ["缴费截止", "缴费截止"], ["准考证打印", "准考证打印"], ["笔试", "笔试"], ["成绩公布", "成绩公布"]])}
      {textInput("eventDate", "节点日期", "", "date")}{numberInput("reminderDays", "提前提醒天数", 0, 30)}{textInput("sourceUrl", "官方来源链接", "https://")}
    </>;
    if (draft.contentType === "job_position") return <>
      {textInput("targetLabel", "考试目标", "广东省考")}{textInput("targetCode", "目标编码", "province:广东")}{textInput("examName", "考试名称", "2027广东省考")}
      {textInput("department", "招录机关/部门")}{textInput("unit", "用人单位")}{textInput("code", "职位代码")}{textInput("region", "工作地区")}{numberInput("recruitCount", "招录人数", 1, 999)}
      {textInput("education", "学历要求")}{textInput("degree", "学位要求")}{textInput("majors", "专业要求")}{textInput("freshLimit", "应届限制")}{textInput("politicalStatus", "政治面貌")}{textInput("household", "户籍限制")}
      {textInput("grassrootsYears", "基层工作年限")}{textInput("gender", "性别要求")}{textInput("certificates", "证书要求")}{textInput("phone", "咨询电话")}{textInput("sourceUrl", "职位表来源链接", "https://")}{textArea("remarks", "职位备注")}
    </>;
    if (draft.contentType === "drill_preset") return <>
      {textInput("icon", "图标文字", "练")}{selectInput("color", "主题颜色", [["blue", "公考蓝"], ["orange", "活力橙"], ["green", "成长绿"], ["purple", "进阶紫"]])}{selectInput("subject", "科目", [["行测", "行测"], ["申论", "申论"]])}{textInput("module", "题目模块", "资料分析")}{textInput("subType", "细分题型", "增长率，可留空")}
      {numberInput("questionCount", "每组题量", 1, 30)}{numberInput("minutes", "预计分钟", 3, 30)}{textInput("targetCodes", "适用考试", "留空表示全部")}{textInput("bankCodes", "限定题库编码", "多个编码用逗号分隔，可留空")}{selectInput("frequency", "最低考频", [["高频", "高频"], ["中频", "中频"], ["低频", "低频"]])}
      {numberInput("importanceStars", "最低重要星级", 1, 5)}{numberInput("scoreRateMin", "最低拿分率%", 0, 100)}{numberInput("scoreRateMax", "最高拿分率%", 0, 100)}{numberInput("sort", "展示顺序", 0, 999)}
    </>;
    return <>
      {numberInput("questions10", "10分钟题量", 1, 20)}{numberInput("questions30", "30分钟题量", 1, 30)}{numberInput("questions45", "45分钟题量", 1, 40)}{numberInput("questions60", "60分钟题量", 1, 50)}
      {numberInput("morning30", "30分钟·晨读", 0, 30)}{numberInput("practice30", "30分钟·刷题", 0, 30)}{numberInput("essay30", "30分钟·申论", 0, 30)}
      {numberInput("morning45", "45分钟·晨读", 0, 45)}{numberInput("practice45", "45分钟·刷题", 0, 45)}{numberInput("essay45", "45分钟·申论", 0, 45)}
      {numberInput("morning60", "60分钟·晨读", 0, 60)}{numberInput("practice60", "60分钟·刷题", 0, 60)}{numberInput("essay60", "60分钟·申论", 0, 60)}
      {numberInput("reviewRatio", "到期回炉题占比%", 0, 100)}{numberInput("urgentExamDays", "临考加权天数", 1, 180)}
      {numberInput("regionWeight", "地区匹配权重%", 0, 100)}{numberInput("frequencyWeight", "考频权重%", 0, 100)}{numberInput("importanceWeight", "重要星级权重%", 0, 100)}{numberInput("scoreRateWeight", "拿分率权重%", 0, 100)}
      {numberInput("scoreRateMin", "优先拿分率下限%", 0, 100)}{numberInput("scoreRateMax", "优先拿分率上限%", 0, 100)}
      <p className={`${styles.formHint} wide`}>权重用于“今天最值得练什么”的选题排序。建议地区、考频、重要星级、拿分率四项合计为100%。发布新策略前请先预览。</p>
    </>;
  };

  const previewPayload: Record<string, unknown> = preview && "payload" in preview ? (preview.payload ?? {}) : preview ? readPayload(preview) : {};
  const previewTitle = preview ? ("title" in preview ? preview.title : "") : "";

  return <>
    <section className="admin-panel">
      <div className="admin-panel-title"><div><span>媒体资源库</span><h2>上传音频、题目图片与附件</h2><small>上传后复制地址，可用于题库Excel的图片地址/资源地址，或粘贴到任意内容表单。</small></div></div>
      <div className={styles.mediaRow}>
        <label className={styles.uploadButton}><input type="file" accept="audio/*,image/*,.pdf,application/pdf" onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadAsset(file); }} />{uploadingAsset ? "上传中…" : "选择媒体文件"}</label>
        {lastAsset && <><input readOnly value={lastAsset.url} aria-label={`${lastAsset.name}资源地址`} /><button type="button" onClick={() => { void navigator.clipboard.writeText(lastAsset.url); onMessage("媒体地址已复制"); }}>复制地址</button></>}
      </div>
    </section>
    <section className="admin-panel" data-content-form>
      <div className="admin-panel-title"><div><span>内容配置中心</span><h2>{editingId ? "编辑运营内容" : "创建运营内容"}</h2><small>框架固定，内容均可新增、编辑、排期、下架和重新发布。</small></div><button onClick={() => { setEditingId(null); setDraft(emptyDraft(draft.contentType)); }}>新建空白内容</button></div>

      <div className={styles.typeGrid} aria-label="内容类型">
        {CONTENT_TYPES.map((item) => <button key={item.type} type="button" className={`${styles.typeCard} ${styles[item.tone]} ${draft.contentType === item.type ? styles.active : ""}`} onClick={() => switchType(item.type)}><b>{item.label}</b><small>{item.short}</small></button>)}
      </div>

      <div className={styles.editorHeader}>
        <div><span>{TYPE_LABEL[draft.contentType]}</span><h3>{editingId ? `正在编辑 #${editingId}` : "新建内容"}</h3></div>
        <button type="button" onClick={() => setPreview(draft)}>预览当前内容</button>
      </div>

      <div className="form-grid">
        <label>内容标题<input value={draft.title} onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} placeholder="用户端看到的标题" /></label>
        <label>唯一标识<input value={draft.contentKey} onChange={(event) => setDraft((current) => ({ ...current, contentKey: event.target.value }))} placeholder="保存后不建议修改" /></label>
        <label>发布方式<select value={draft.publishMode} onChange={(event) => setDraft((current) => ({ ...current, publishMode: event.target.value as PublishMode }))}><option value="draft">仅保存草稿</option><option value="now">立即发布</option><option value="scheduled">定时发布</option></select></label>
        {draft.publishMode === "scheduled" && <label>发布时间<input type="datetime-local" value={draft.publishAt} onChange={(event) => setDraft((current) => ({ ...current, publishAt: event.target.value }))} /></label>}
        {renderTypeFields()}
      </div>
      <div className={styles.editorActions}><button type="button" onClick={() => setPreview(draft)}>预览</button><button className="admin-primary" type="button" disabled={saving} onClick={() => void save()}>{saving ? "保存中…" : draft.publishMode === "draft" ? "保存草稿" : draft.publishMode === "scheduled" ? "保存并定时发布" : "立即发布"}</button></div>
    </section>

    <section className="admin-panel">
      <div className="admin-panel-title"><div><span>职位表批量导入</span><h2>上传Excel或CSV职位数据</h2><small>文件先在本地校验和预览，通过的数据只导入为草稿。</small></div><button onClick={() => void downloadPositionTemplate()}>下载职位模板</button></div>
      <div className={styles.positionUpload}>
        <label><input type="file" accept=".xlsx,.xls,.csv" onChange={(event) => { const file = event.target.files?.[0]; if (file) void readPositionFile(file); }} /><span>{readingPositions ? "正在读取…" : positionFile?.name ?? "选择 XLSX / XLS / CSV 职位表"}</span><small>最大30MB，最多50000条职位</small></label>
        {positionRows.length > 0 && <div className={styles.positionSummary}><span><b>{positionRows.length}</b>总行数</span><span><b>{positionRows.filter((row) => !row.issues.length).length}</b>可导入</span><span className={positionRows.some((row) => row.issues.length) ? styles.danger : ""}><b>{positionRows.filter((row) => row.issues.length).length}</b>需修正</span></div>}
      </div>
      {positionRows.length > 0 && <>
        <div className="admin-table-wrap"><table><thead><tr><th>行号</th><th>考试</th><th>职位代码</th><th>职位名称</th><th>地区</th><th>校验</th></tr></thead><tbody>{positionRows.slice(0, 8).map((row) => <tr key={row.row}><td>{row.row}</td><td>{asText(row.payload.examName)}</td><td>{asText(row.payload.code)}</td><td>{row.title || "未填写"}</td><td>{asText(row.payload.region)}</td><td>{row.issues.length ? <span className={styles.errorText}>{row.issues.join("、")}</span> : <span className={styles.okText}>通过</span>}</td></tr>)}</tbody></table></div>
        <div className={styles.editorActions}><p>问题行不会导入，请回到原文件修正后重新上传。</p><button className="admin-primary" disabled={importingPositions || !positionRows.some((row) => !row.issues.length)} onClick={() => void importPositions()}>{importingPositions ? "分批导入中…" : "导入有效职位为草稿"}</button></div>
      </>}
    </section>

    <section className="admin-panel table-panel">
      <div className="admin-panel-title"><div><span>内容库</span><h2>全部运营内容</h2><small>支持回填编辑、复制、预览、下架、重发与历史版本回滚。</small></div><button onClick={() => void onReload()}>刷新</button></div>
      <div className={styles.libraryFilters}><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索标题或内容标识" /><select value={filterType} onChange={(event) => setFilterType(event.target.value as "all" | AdminContentType)}><option value="all">全部类型</option>{CONTENT_TYPES.map((item) => <option key={item.type} value={item.type}>{item.label}</option>)}<option value="practice_day">旧版日练包</option></select></div>
      <div className="admin-table-wrap"><table><thead><tr><th>类型</th><th>内容</th><th>状态</th><th>发布时间</th><th>版本</th><th>操作</th></tr></thead><tbody>{filteredItems.length ? filteredItems.map((item) => {
        const scheduled = item.status === "scheduled";
        return <tr key={item.id}><td>{TYPE_LABEL[item.content_type] ?? item.content_type}</td><td><b>{item.title}</b><small>{item.content_key}</small></td><td><span className={`status ${item.status}`}>{scheduled ? "待发布" : item.status === "published" ? "已发布" : item.status === "archived" ? "已下架" : "草稿"}</span></td><td>{item.publish_at ? new Date(item.publish_at).toLocaleString("zh-CN") : item.status === "published" ? "立即" : "—"}</td><td>{Number(item.version_count ?? 1)}版</td><td><div className={styles.rowActions}><button onClick={() => void beginEdit(item)}>编辑</button><button onClick={() => void duplicate(item)}>复制</button><button onClick={() => setPreview(item)}>预览</button><button onClick={() => void openVersions(item)}>版本</button>{item.status === "published" || item.status === "scheduled" ? <button className={styles.dangerButton} onClick={() => void disable(item)}>下架</button> : <button onClick={() => void republish(item)}>发布</button>}</div></td></tr>;
      }) : <tr><td colSpan={6}>没有符合条件的内容，请从上方创建。</td></tr>}</tbody></table></div>
    </section>

    {preview && <div className={styles.overlay} role="dialog" aria-modal="true" aria-label="内容预览" onMouseDown={(event) => { if (event.currentTarget === event.target) setPreview(null); }}><article className={styles.modal}><header><div><span>用户端内容预览</span><h2>{previewTitle || "未命名内容"}</h2><p>{"contentType" in preview ? TYPE_LABEL[preview.contentType] : TYPE_LABEL[preview.content_type]}</p></div><button aria-label="关闭预览" onClick={() => setPreview(null)}>×</button></header><div className={styles.previewBody}>{Object.entries(previewPayload).filter(([, value]) => asText(value)).map(([key, value]) => <section key={key}><small>{key}</small><p>{asText(value)}</p></section>)}</div><footer><button onClick={() => setPreview(null)}>关闭</button></footer></article></div>}

    {versionItem && <div className={styles.overlay} role="dialog" aria-modal="true" aria-label="版本记录" onMouseDown={(event) => { if (event.currentTarget === event.target) setVersionItem(null); }}><article className={styles.modal}><header><div><span>版本记录</span><h2>{versionItem.title}</h2><p>回滚不会删除后续历史，而是生成一个新版本。</p></div><button aria-label="关闭版本记录" onClick={() => setVersionItem(null)}>×</button></header><div className={styles.versionList}>{loadingVersions ? <p>正在加载版本…</p> : versions.length ? versions.map((version) => <section key={version.id}><div><b>第 {version.version} 版</b><span className={`status ${version.status}`}>{version.status === "published" ? "发布" : version.status === "scheduled" ? "定时" : version.status === "archived" ? "下架" : "草稿"}</span><small>{new Date(version.created_at).toLocaleString("zh-CN")}</small></div><button onClick={() => void rollback(version)}>回滚到此版</button></section>) : <p>暂无历史版本；下一次编辑保存后会自动留档。</p>}</div><footer><button onClick={() => setVersionItem(null)}>关闭</button></footer></article></div>}
  </>;
}
