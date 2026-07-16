"use client";

import { useEffect, useMemo, useState } from "react";
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
  status: "draft" | "pending_review" | "rejected" | "scheduled" | "published" | "archived";
  publish_at: string | null;
  payload?: Record<string, unknown>;
  payload_json?: string;
  version: number;
  access_level: "free" | "member";
  version_count?: number | string;
  review_note?: string | null;
  reviewed_by?: string | null;
  reviewed_at?: string | null;
  updated_at: string;
};

export type ContentImportItem = {
  id: number;
  content_type: AdminContentType;
  file_name: string;
  file_size: number;
  file_hash: string;
  source_name: string;
  source_url: string;
  source_published_at: string | null;
  data_version: string;
  duplicate_strategy: "reject" | "skip" | "update_draft";
  total_rows: number;
  uploaded_rows: number;
  processed_rows: number;
  imported_rows: number;
  failed_rows: number;
  duplicate_rows: number;
  total_chunks: number;
  uploaded_chunks: number;
  processed_chunks: number;
  status: "uploading" | "queued" | "processing" | "failed" | "cancelling" | "cancelled" | "completed" | "completed_with_errors";
  error_summary: string;
  dispatch_attempts: number;
  next_retry_at: string | null;
  review_status: "draft" | "pending_review" | "published" | "rejected" | "rolled_back";
  review_note: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

type Props = {
  items: AdminContentItem[];
  contentImports?: ContentImportItem[];
  mediaAssets?: Array<{ id: string; file_name: string; content_type: string; byte_size: number; access_level: "free" | "member"; url: string }>;
  onReload: () => Promise<void>;
  onMessage: (message: string) => void;
  scope?: "content" | "radar";
  canEdit?: boolean;
  canReview?: boolean;
  canPublish?: boolean;
  canUpload?: boolean;
};

type PublishMode = "draft" | "review" | "now" | "scheduled";
type ContentDraft = {
  contentType: Exclude<AdminContentType, "practice_day">;
  contentKey: string;
  title: string;
  publishMode: PublishMode;
  publishAt: string;
  accessLevel: "free" | "member";
  payload: Record<string, unknown>;
};

type VersionItem = {
  id: number;
  version: number;
  title: string;
  status: "draft" | "pending_review" | "rejected" | "scheduled" | "published" | "archived";
  publish_at: string | null;
  payload?: Record<string, unknown>;
  access_level?: "free" | "member";
  created_at: string;
};

type PositionPreview = {
  row: number;
  contentKey: string;
  title: string;
  payload: Record<string, unknown>;
  accessLevel: "free" | "member";
  issues: string[];
};

type ContentImportChunk = {
  rowOffset: number;
  rows: Array<{ rowIndex: number; contentKey: string; title: string; accessLevel: "free" | "member"; payload: Record<string, unknown> }>;
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
  if (type === "morning_read") return { date: chinaDateInput(), category: "人民日报评论", kicker: "今日晨读", source: "", sourceUrl: "", sourceDate: chinaDateInput(), body: "", keywords: "", audioUrl: "", targetCodes: "" };
  if (type === "current_affairs") return { date: chinaDateInput(), category: "月度热点", source: "", sourceUrl: "", sourceDate: chinaDateInput(), summary: "", body: "", importanceStars: 4, targetCodes: "" };
  if (type === "essay_micro") return { date: chinaDateInput(), theme: "基层治理", source: "", sourceUrl: "", sourceDate: chinaDateInput(), material: "", prompt: "", referenceAnswer: "", wordLimit: 150, scoringPoints: "", targetCodes: "" };
  if (type === "audio_track") return { id: "", category: "current", seriesId: "current", seriesTitle: "时政电台", seriesLabel: "时政", seriesColor: "#245c92", seriesIcon: "政", sortOrder: 10, kicker: "月度热点", source: "", sourceUrl: "", sourceDate: chinaDateInput(), duration: "5分钟", description: "", text: "", audioUrl: "" };
  if (type === "exam_notice") return { targetCode: "national", targetLabel: "国考", noticeType: "招录公告", publishDate: "", summary: "", sourceUrl: "", status: "待报名" };
  if (type === "exam_event") return { targetCode: "national", targetLabel: "国考", eventType: "报名开始", eventDate: "", reminderDays: 3, sourceUrl: "" };
  if (type === "job_position") return { targetCode: "national", targetLabel: "国考", examName: "", department: "", unit: "", code: "", region: "", recruitCount: 1, education: "本科及以上", degree: "不限", majors: "", freshLimit: "不限", politicalStatus: "不限", household: "不限", grassrootsYears: "不限", gender: "不限", certificates: "不限", remarks: "", phone: "", sourceUrl: "", dataVersion: 1, updatedAt: chinaDateInput() };
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
  accessLevel: "member",
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

async function sha256Hex(value: ArrayBuffer | string) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function stableContentToken(value: string) {
  const normalized = value.normalize("NFKC").trim().toLowerCase();
  const ascii = normalized.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 22);
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < normalized.length; index += 1) {
    const code = normalized.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ code, 0x85ebca6b) >>> 0;
  }
  const fingerprint = `${first.toString(16).padStart(8, "0")}${second.toString(16).padStart(8, "0")}`;
  return ascii ? `${ascii}-${fingerprint.slice(0, 8)}` : fingerprint;
}

function buildContentImportChunks(rows: PositionPreview[], dataVersion: string) {
  const chunks: ContentImportChunk[] = [];
  let current: ContentImportChunk = { rowOffset: 0, rows: [] };
  let currentUploadBytes = 2;
  let currentProcessingBytes = 2;
  rows.forEach((row, index) => {
    const entry = { rowIndex: row.row, contentKey: row.contentKey, title: row.title,
      accessLevel: row.accessLevel, payload: row.payload };
    const uploadBytes = new TextEncoder().encode(JSON.stringify(entry)).byteLength + (current.rows.length ? 1 : 0);
    const processingEstimate = { importId: 9_999_999, rowIndex: row.row, contentKey: row.contentKey, title: row.title,
      accessLevel: row.accessLevel, payloadJson: JSON.stringify({ ...row.payload, importSource: { importId: 9_999_999, dataVersion } }),
      mode: "update", expectedVersion: 9_999, nextVersion: 10_000 };
    const processingBytes = new TextEncoder().encode(JSON.stringify(processingEstimate)).byteLength + (current.rows.length ? 1 : 0);
    if (uploadBytes > 680 * 1024 || processingBytes > 730 * 1024) {
      throw new Error(`第${row.row}行内容超过单分块上限，请缩短备注或其他长文本`);
    }
    if (current.rows.length && (current.rows.length >= 1_000
      || currentUploadBytes + uploadBytes > 680 * 1024 || currentProcessingBytes + processingBytes > 730 * 1024)) {
      chunks.push(current);
      current = { rowOffset: index, rows: [] };
      currentUploadBytes = 2;
      currentProcessingBytes = 2;
    }
    current.rows.push(entry);
    currentUploadBytes += uploadBytes;
    currentProcessingBytes += processingBytes;
  });
  if (current.rows.length) chunks.push(current);
  if (chunks.length > 75) throw new Error("文件内容较长，持久化分块超过75个；请按地区或部门拆成多个文件导入");
  return chunks;
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
  数据版本: 1,
  数据更新时间: chinaDateInput(),
}];

export default function AdminContentManager({
  items,
  contentImports = [],
  mediaAssets = [],
  onReload,
  onMessage,
  scope = "content",
  canEdit = true,
  canReview = false,
  canPublish = true,
  canUpload = true,
}: Props) {
  const [draft, setDraft] = useState<ContentDraft>(() => emptyDraft(scope === "radar" ? "exam_notice" : "morning_read"));
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingVersion, setEditingVersion] = useState<number | null>(null);
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
  const [positionFileHash, setPositionFileHash] = useState("");
  const [positionRows, setPositionRows] = useState<PositionPreview[]>([]);
  const [readingPositions, setReadingPositions] = useState(false);
  const [importingPositions, setImportingPositions] = useState(false);
  const [activeContentImportId, setActiveContentImportId] = useState<number | null>(null);
  const [positionSourceName, setPositionSourceName] = useState("");
  const [positionSourceUrl, setPositionSourceUrl] = useState("");
  const [positionSourcePublishedAt, setPositionSourcePublishedAt] = useState("");
  const [positionDataVersion, setPositionDataVersion] = useState("");
  const [positionUploadProgress, setPositionUploadProgress] = useState(0);
  const [bulkImportType, setBulkImportType] = useState<ContentDraft["contentType"]>(scope === "radar" ? "job_position" : "morning_read");
  const [contentDuplicateStrategy, setContentDuplicateStrategy] = useState<"reject" | "skip" | "update_draft">("reject");
  const [contentImportUpdates, setContentImportUpdates] = useState<Record<number, ContentImportItem>>({});

  const scopedTypes = useMemo(() => CONTENT_TYPES.filter((item) => scope === "radar"
    ? ["exam_notice", "exam_event", "job_position"].includes(item.type)
    : ["morning_read", "current_affairs", "essay_micro", "audio_track", "drill_preset", "strategy_config"].includes(item.type)), [scope]);
  const scopedTypeNames = useMemo(() => new Set(scopedTypes.map((item) => item.type)), [scopedTypes]);

  const api = async (payload: Record<string, unknown>) => {
    const response = await fetch("/api/app", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json() as Record<string, unknown> & { error?: string };
    if (!response.ok) throw new Error(data.error || "操作失败");
    return data;
  };

  const visibleContentImports = useMemo(() => contentImports.map((item) => contentImportUpdates[item.id] ?? item),
    [contentImportUpdates, contentImports]);

  const runningContentImportIds = useMemo(() => visibleContentImports
    .filter((item) => ["queued", "processing", "cancelling"].includes(item.status))
    .slice(0, 5)
    .map((item) => item.id).join(","), [visibleContentImports]);

  useEffect(() => {
    if (!runningContentImportIds) return;
    let disposed = false;
    const poll = async () => {
      const ids = runningContentImportIds.split(",").map(Number).filter((id) => id > 0);
      const updates = await Promise.all(ids.map(async (importId) => {
        try {
          const response = await fetch("/api/app", {
            method: "POST", credentials: "include", headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "adminGetContentImport", importId }),
          });
          const data = await response.json() as { import?: ContentImportItem };
          return response.ok ? data.import ?? null : null;
        } catch { /* 下一轮会继续查询，持久化任务不会依赖当前页面 */ }
        return null;
      }));
      if (disposed) return;
      const changed = updates.filter((item): item is ContentImportItem => Boolean(item));
      if (changed.length) setContentImportUpdates((current) => ({ ...current,
        ...Object.fromEntries(changed.map((item) => [item.id, item])) }));
      if (changed.some((item) => ["completed", "completed_with_errors", "cancelled", "failed"].includes(item.status))) {
        await onReload();
      }
    };
    const timer = window.setInterval(() => { void poll(); }, 3_000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [onReload, runningContentImportIds]);

  const filteredItems = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return items.filter((item) => {
      if (item.content_type !== "practice_day" && !scopedTypeNames.has(item.content_type)) return false;
      if (item.content_type === "practice_day" && scope === "radar") return false;
      if (filterType !== "all" && item.content_type !== filterType) return false;
      if (!keyword) return true;
      return `${TYPE_LABEL[item.content_type] ?? item.content_type} ${item.content_key} ${item.title}`.toLowerCase().includes(keyword);
    });
  }, [filterType, items, scope, scopedTypeNames, search]);

  const setField = (name: string, value: unknown) => setDraft((current) => ({
    ...current,
    payload: { ...current.payload, [name]: value },
  }));

  const switchType = (type: ContentDraft["contentType"]) => {
    setEditingId(null);
    setEditingVersion(null);
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
    setEditingVersion(Math.max(1, Number(source.version ?? 1)));
    setDraft({
      contentType: type,
      contentKey: source.content_key,
      title: source.title,
      publishMode: source.status === "pending_review" || source.status === "rejected" ? "review" : source.status === "draft" || source.status === "archived" ? "draft" : source.status === "scheduled" ? "scheduled" : "now",
      publishAt: dateTimeLocal(source.publish_at),
      accessLevel: source.access_level === "free" ? "free" : "member",
      payload: { ...defaultPayload(type), ...payload },
    });
    document.querySelector("[data-content-form]")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const duplicate = async (item: AdminContentItem) => {
    const source = await fullItem(item);
    const type = source.content_type === "practice_day" ? "morning_read" : source.content_type;
    setEditingId(null);
    setEditingVersion(null);
    setDraft({
      contentType: type,
      contentKey: `${source.content_key}-copy-${Date.now().toString(36)}`,
      title: `${source.title}（副本）`,
      publishMode: "draft",
      publishAt: "",
      accessLevel: "member",
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
    if (!canEdit) return onMessage("当前角色没有编辑此内容的权限");
    setSaving(true);
    try {
      validateDraft();
      const freeAudioNeedsReview = draft.contentType === "audio_track" && draft.accessLevel === "free";
      const needsReview = freeAudioNeedsReview || draft.publishMode === "review" || ((draft.publishMode === "now" || draft.publishMode === "scheduled") && !canPublish);
      const status = needsReview || draft.publishMode === "draft" ? "draft" : draft.publishMode === "scheduled" ? "scheduled" : "published";
      const publishAt = draft.publishMode === "scheduled" ? new Date(draft.publishAt).toISOString() : null;
      const result = await api({
        action: "adminUpsertContentBatch",
        items: [{
          contentType: draft.contentType,
          contentKey: draft.contentKey.trim(),
          title: draft.title.trim(),
          status,
          publishAt,
          accessLevel: draft.accessLevel,
          ...(editingId ? { expectedVersion: editingVersion } : {}),
          payload: { ...draft.payload, title: draft.title.trim(), ...(needsReview && publishAt ? { requestedPublishAt: publishAt } : {}), ...(draft.contentType === "audio_track" ? { id: draft.contentKey.trim() } : {}) },
        }],
      });
      if (needsReview) {
        const saved = (result.items as Array<{ id?: number; version?: number }> | undefined)?.[0];
        if (!saved?.id) throw new Error("内容已保存，但提交审核时没有取得内容编号");
        await api({ action: "adminSubmitContentReview", id: saved.id, expectedVersion: saved.version });
      }
      onMessage(needsReview ? "内容已提交审核" : draft.publishMode === "draft" ? "内容已保存为草稿" : draft.publishMode === "scheduled" ? "内容已进入定时发布队列" : "内容已立即发布");
      setEditingId(null);
      setEditingVersion(null);
      setDraft(emptyDraft(draft.contentType));
      await onReload();
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "内容保存失败");
    } finally {
      setSaving(false);
    }
  };

  const disable = async (item: AdminContentItem) => {
    if (!canPublish) return onMessage("当前角色没有下架内容的权限");
    try {
      await api({ action: "adminDisableContent", id: item.id, expectedVersion: item.version });
      onMessage("内容已下架并保留在草稿库，可随时重新发布");
      await onReload();
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "内容下架失败");
    }
  };

  const republish = async (item: AdminContentItem) => {
    if (!canPublish) return onMessage("当前角色没有发布内容的权限，请提交审核");
    try {
      await api({ action: "adminSetContentStatus", id: item.id, expectedVersion: item.version, status: "published" });
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
    if (!canPublish) return onMessage("当前角色没有版本回滚权限");
    if (!versionItem) return;
    try {
      await api({ action: "adminRollbackContent", id: versionItem.id, version: version.version, expectedVersion: versionItem.version });
      onMessage(`已回滚到第 ${version.version} 版，并生成一条新的版本记录`);
      setVersionItem(null);
      await onReload();
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "版本回滚失败");
    }
  };

  const review = async (item: AdminContentItem, decision: "approve" | "reject") => {
    if (!canReview) return onMessage("当前角色没有内容审核权限");
    const reviewNote = decision === "reject" ? window.prompt("请输入驳回原因，方便编辑人员修改：", "")?.trim() : "";
    if (decision === "reject" && !reviewNote) return;
    try {
      const source = await fullItem(item);
      const requestedPublishAt = asText(readPayload(source).requestedPublishAt) || null;
      await api({ action: "adminReviewContent", id: item.id, expectedVersion: item.version, decision, reviewNote: reviewNote || null, publishAt: decision === "approve" ? requestedPublishAt : null });
      onMessage(decision === "approve" ? "审核通过，内容已发布" : "内容已驳回并退回编辑");
      await onReload();
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "审核操作失败");
    }
  };

  const uploadMediaFile = async (file: File) => {
    if (!canUpload) throw new Error("当前角色没有上传媒体的权限");
    if (file.size > 25 * 1024 * 1024) throw new Error("单个文件不能超过25MB");
    const form = new FormData();
    form.append("action", "adminUploadMedia");
    form.append("file", file);
    const response = await fetch("/api/app", { method: "POST", credentials: "include", body: form });
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

  const setMediaAccess = async (id: string, accessLevel: "free" | "member") => {
    try {
      await api({ action: "adminSetMediaAccess", id, accessLevel });
      onMessage(accessLevel === "free" ? "媒体已通过免费内容审核开放" : "媒体已设为会员内容");
      await onReload();
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "媒体权益修改失败");
    }
  };

  const downloadPositionTemplate = async () => {
    const XLSX = await import("xlsx");
    const workbook = XLSX.utils.book_new();
    const template = bulkImportType === "job_position" ? positionTemplate : [{
      内容标识: `${bulkImportType}-example-001`,
      标题: `${TYPE_LABEL[bulkImportType]}示例`,
      访问权益: "member",
      内容JSON: JSON.stringify(defaultPayload(bulkImportType)),
    }];
    const sheet = XLSX.utils.json_to_sheet(template);
    sheet["!cols"] = Object.keys(template[0]).map((name) => ({ wch: name === "内容JSON" ? 80 : Math.max(12, Math.min(30, name.length * 2 + 8)) }));
    XLSX.utils.book_append_sheet(workbook, sheet, `${TYPE_LABEL[bulkImportType]}导入模板`);
    XLSX.writeFile(workbook, `公考日练-${TYPE_LABEL[bulkImportType]}-导入模板.xlsx`);
    onMessage(`${TYPE_LABEL[bulkImportType]}模板已生成`);
  };

  const readPositionFile = async (file: File) => {
    setReadingPositions(true);
    try {
      if (!/\.(xlsx|xls|csv)$/i.test(file.name)) throw new Error("请选择 XLSX、XLS 或 CSV 文件");
      if (file.size > 30 * 1024 * 1024) throw new Error("单个内容文件不能超过30MB");
      const fileBuffer = await file.arrayBuffer();
      const fileHash = await sha256Hex(fileBuffer);
      const XLSX = await import("xlsx");
      const workbook = XLSX.read(fileBuffer, { type: "array" });
      const sheetName = workbook.SheetNames[0];
      if (!sheetName) throw new Error("文件中没有可读取的工作表");
      const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[sheetName], { defval: "", raw: false });
      if (!rawRows.length) throw new Error("文件中没有数据");
      if (rawRows.length > 50_000) throw new Error("单个文件最多导入50000条内容");
      const normalized = bulkImportType === "job_position" ? rawRows.map((row, index): PositionPreview => {
        const code = spreadsheetCell(row, ["职位代码", "岗位代码", "code"]);
        const title = spreadsheetCell(row, ["职位名称", "岗位名称", "title"]);
        const department = spreadsheetCell(row, ["部门", "招录机关", "department"]);
        const examName = spreadsheetCell(row, ["考试名称", "examName"]);
        const region = spreadsheetCell(row, ["地区", "工作地点", "region"]);
        const targetLabel = spreadsheetCell(row, ["考试目标", "targetLabel"]) || examName;
        const targetCode = spreadsheetCell(row, ["目标编码", "targetCode"]) || (targetLabel.includes("国考") ? "national" : `province:${targetLabel.replace(/省考|省/g, "")}`);
        const sourceUrl = spreadsheetCell(row, ["来源链接", "官方链接", "sourceUrl"]);
        const updatedAt = spreadsheetCell(row, ["数据更新时间", "更新时间", "updatedAt"]);
        const dataVersion = Number(spreadsheetCell(row, ["数据版本", "版本", "dataVersion"]) || 1);
        const issues: string[] = [];
        if (!examName) issues.push("考试名称为空");
        if (!department) issues.push("部门为空");
        if (!title) issues.push("职位名称为空");
        if (!code) issues.push("职位代码为空");
        if (!region) issues.push("地区为空");
        if (!/^https:\/\//i.test(sourceUrl)) issues.push("来源链接必须是HTTPS官方地址");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(updatedAt)) issues.push("数据更新时间需为YYYY-MM-DD");
        if (!Number.isInteger(dataVersion) || dataVersion < 1) issues.push("数据版本必须是正整数");
        const count = Number(spreadsheetCell(row, ["招录人数", "人数", "recruitCount"]) || 1);
        if (!Number.isInteger(count) || count < 1) issues.push("招录人数必须是正整数");
        return {
          row: index + 2,
          contentKey: `position-${stableContentToken(targetCode || "unknown")}-${stableContentToken(code || `row-${index + 2}`)}`,
          title,
          accessLevel: spreadsheetCell(row, ["访问权益", "accessLevel"]) === "free" ? "free" : "member",
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
            sourceUrl,
            dataVersion: Number.isInteger(dataVersion) && dataVersion > 0 ? dataVersion : 1,
            updatedAt,
          },
        };
      }) : rawRows.map((row, index): PositionPreview => {
        const contentKey = spreadsheetCell(row, ["内容标识", "contentKey"]).toLowerCase();
        const title = spreadsheetCell(row, ["标题", "内容标题", "title"]);
        const accessValue = spreadsheetCell(row, ["访问权益", "accessLevel"]).toLowerCase();
        const rawPayload = spreadsheetCell(row, ["内容JSON", "payloadJson", "payload"]);
        const issues: string[] = [];
        let payload: Record<string, unknown> = {};
        if (!/^[a-z0-9][a-z0-9_-]{2,80}$/i.test(contentKey)) issues.push("内容标识格式无效");
        if (!title) issues.push("标题为空");
        if (accessValue && !new Set(["free", "member", "免费", "会员"]).has(accessValue)) issues.push("访问权益只能是free/member");
        try {
          const parsed = JSON.parse(rawPayload) as unknown;
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) issues.push("内容JSON必须是对象");
          else payload = parsed as Record<string, unknown>;
        } catch { issues.push("内容JSON无法解析"); }
        return { row: index + 2, contentKey, title,
          accessLevel: accessValue === "free" || accessValue === "免费" ? "free" : "member", payload, issues };
      });
      setPositionFile(file);
      setPositionFileHash(fileHash);
      setPositionRows(normalized);
      const firstPayload = normalized[0]?.payload ?? {};
      if (!positionSourceName) setPositionSourceName(bulkImportType === "job_position"
        ? `${asText(firstPayload.examName) || "公考"}官方职位表`
        : asText(firstPayload.source) || `${TYPE_LABEL[bulkImportType]}运营批次`);
      if (!positionSourceUrl) setPositionSourceUrl(asText(firstPayload.sourceUrl));
      if (!positionSourcePublishedAt) setPositionSourcePublishedAt(asText(firstPayload.updatedAt || firstPayload.sourceDate || firstPayload.publishDate || firstPayload.eventDate));
      if (!positionDataVersion) setPositionDataVersion(asText(firstPayload.dataVersion));
      const issueCount = normalized.filter((row) => row.issues.length).length;
      onMessage(`已读取 ${normalized.length} 条${TYPE_LABEL[bulkImportType]}，${issueCount} 条需要修正`);
    } catch (error) {
      setPositionFile(null);
      setPositionFileHash("");
      setPositionRows([]);
      onMessage(error instanceof Error ? error.message : "内容文件读取失败");
    } finally {
      setReadingPositions(false);
    }
  };

  const importPositions = async () => {
    if (!canEdit) return onMessage("当前角色没有批量导入内容的权限");
    if (!positionFile || !positionFileHash || !positionRows.length) return onMessage("请先选择并读取内容文件");
    if (!positionSourceName.trim() || !positionDataVersion.trim() || !/^https:\/\//i.test(positionSourceUrl.trim())) {
      return onMessage("请补全官方来源名称、HTTPS来源链接和数据版本");
    }
    setImportingPositions(true);
    try {
      const chunks = buildContentImportChunks(positionRows, positionDataVersion.trim());
      let importId = activeContentImportId;
      if (importId) {
        const active = visibleContentImports.find((item) => item.id === importId);
        if (active && active.file_hash !== positionFileHash) throw new Error("所选文件与待续传任务不一致，请重新选择原文件");
        if (active && active.status !== "uploading") throw new Error("该任务已封存，不能继续上传文件分块");
      } else {
        const started = await api({
          action: "adminStartContentImport",
          contentType: bulkImportType,
          fileName: positionFile.name,
          fileSize: positionFile.size,
          fileHash: positionFileHash,
          totalRows: positionRows.length,
          totalChunks: chunks.length,
          sourceName: positionSourceName.trim(),
          sourceUrl: positionSourceUrl.trim(),
          sourcePublishedAt: positionSourcePublishedAt || null,
          dataVersion: positionDataVersion.trim(),
          duplicateStrategy: contentDuplicateStrategy,
          metadata: { template: `${bulkImportType}_v1`, scope },
        });
        importId = Number(started.importId);
        if (!Number.isInteger(importId) || importId < 1) throw new Error("服务端没有返回有效的导入任务编号");
        setActiveContentImportId(importId);
      }
      let uploadedRows = 0;
      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
        const chunk = chunks[chunkIndex];
        const rowsJson = JSON.stringify(chunk.rows);
        await api({
          action: "adminUploadContentImportChunk",
          importId,
          chunkIndex,
          rowOffset: chunk.rowOffset,
          fileHash: positionFileHash,
          payloadHash: await sha256Hex(rowsJson),
          rows: chunk.rows,
        });
        uploadedRows += chunk.rows.length;
        setPositionUploadProgress(Math.round(uploadedRows / positionRows.length * 100));
      }
      await api({ action: "adminFinishContentImport", importId });
      onMessage(`文件已完整上传并封存（任务 #${importId}）。任务状态已持久化，后续安全请求会继续派发；离开页面不会丢失进度，但完成时间取决于后续请求触发。`);
      setActiveContentImportId(null);
      setPositionFile(null);
      setPositionFileHash("");
      setPositionRows([]);
      setPositionUploadProgress(0);
      setPositionSourceName("");
      setPositionSourceUrl("");
      setPositionSourcePublishedAt("");
      setPositionDataVersion("");
      await onReload();
    } catch (error) {
      onMessage(`${error instanceof Error ? error.message : "内容导入失败"}。已上传分块仍保留，可使用同一文件继续上传。`);
    } finally {
      setImportingPositions(false);
    }
  };

  const resumeContentImport = (task: ContentImportItem) => {
    setActiveContentImportId(task.id);
    setPositionFile(null);
    setPositionFileHash("");
    setPositionRows([]);
    setPositionSourceName(task.source_name);
    setPositionSourceUrl(task.source_url);
    setPositionSourcePublishedAt(task.source_published_at ?? "");
    setPositionDataVersion(task.data_version);
    setBulkImportType(task.content_type === "practice_day" ? "morning_read" : task.content_type);
    setContentDuplicateStrategy(task.duplicate_strategy ?? "reject");
    setPositionUploadProgress(task.total_rows ? Math.round(task.uploaded_rows / task.total_rows * 100) : 0);
    onMessage(`已选择续传任务 #${task.id}，请重新选择原文件；服务端会校验文件指纹并跳过已上传分块。`);
  };

  const cancelContentImport = async (task: ContentImportItem) => {
    if (!window.confirm(`确认取消任务 #${task.id}？已导入的草稿不会删除。`)) return;
    try {
      await api({ action: "adminCancelContentImport", importId: task.id });
      if (activeContentImportId === task.id) setActiveContentImportId(null);
      setContentImportUpdates((current) => {
        const next = { ...current };
        delete next[task.id];
        return next;
      });
      onMessage(`任务 #${task.id} 已请求取消`);
      await onReload();
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "取消任务失败");
    }
  };

  const retryContentImport = async (task: ContentImportItem) => {
    try {
      await api({ action: "adminRetryContentImport", importId: task.id });
      setContentImportUpdates((current) => {
        const next = { ...current };
        delete next[task.id];
        return next;
      });
      onMessage(`任务 #${task.id} 已安全重试；已成功行不会重复生成版本`);
      await onReload();
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "重试任务失败");
    }
  };

  const downloadContentImportErrors = async (task: ContentImportItem) => {
    try {
      let offset = 0;
      let nextOffset: number | null = 0;
      let fileName = `${task.file_name}-导入错误.csv`;
      const pieces: string[] = [];
      while (nextOffset !== null) {
        const data = await api({ action: "adminDownloadContentImportErrors", importId: task.id, offset });
        pieces.push(String(data.content ?? ""));
        fileName = String(data.fileName ?? fileName);
        nextOffset = data.nextOffset === null || data.nextOffset === undefined ? null : Number(data.nextOffset);
        offset = nextOffset ?? offset;
      }
      const url = URL.createObjectURL(new Blob(pieces, { type: "text/csv;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;
      link.click();
      URL.revokeObjectURL(url);
      onMessage(`任务 #${task.id} 的错误明细已下载`);
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "错误明细下载失败");
    }
  };

  const submitContentImportReview = async (task: ContentImportItem) => {
    if (!window.confirm(`确认将任务 #${task.id}（${task.data_version}）成功导入的全部内容提交审核？`)) return;
    try {
      await api({ action: "adminSubmitContentImportReview", importId: task.id });
      onMessage(`任务 #${task.id} 已整批提交审核`);
      await onReload();
    } catch (error) { onMessage(error instanceof Error ? error.message : "批次提交审核失败"); }
  };

  const reviewContentImport = async (task: ContentImportItem, decision: "approve" | "reject") => {
    const reviewNote = decision === "reject" ? window.prompt("请输入批次驳回原因")?.trim() ?? "" : "";
    if (decision === "reject" && reviewNote.length < 2) return onMessage("驳回批次时必须填写原因");
    if (!window.confirm(decision === "approve"
      ? `确认通过并立即发布任务 #${task.id} 的全部内容？`
      : `确认驳回任务 #${task.id} 的全部内容？`)) return;
    try {
      await api({ action: "adminReviewContentImport", importId: task.id, decision, reviewNote });
      onMessage(decision === "approve" ? `任务 #${task.id} 已整批审核发布` : `任务 #${task.id} 已整批驳回`);
      await onReload();
    } catch (error) { onMessage(error instanceof Error ? error.message : "批次审核失败"); }
  };

  const rollbackContentImport = async (task: ContentImportItem) => {
    if (!window.confirm(`确认按任务 #${task.id} / 数据版本 ${task.data_version} 整批回滚？新建内容会下架，更新内容会恢复到导入前版本。`)) return;
    try {
      await api({ action: "adminRollbackContentImport", importId: task.id, dataVersion: task.data_version });
      onMessage(`任务 #${task.id} 已生成整批回滚版本`);
      await onReload();
    } catch (error) { onMessage(error instanceof Error ? error.message : "批次回滚失败"); }
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
      {textInput("kicker", "栏目角标", "今日晨读")}{textInput("source", "内容来源", "人民日报等")}{textInput("sourceUrl", "来源原文链接", "https://")}{textInput("sourceDate", "来源发布日期", "", "date")}{textInput("targetCodes", "适用考试", "national,province:广东")}
      {textArea("body", "晨读正文", "填写正文；每个自然段换行，前端会自动分段")}{textInput("keywords", "记忆关键词", "多个关键词用逗号或顿号分隔")}{textInput("audioUrl", "配套音频地址", "可选，或到电台板块单独上传")}
    </>;
    if (draft.contentType === "current_affairs") return <>
      {textInput("date", "内容日期", "", "date")}{selectInput("category", "内容分类", [["月度热点", "月度热点"], ["重要会议", "重要会议"], ["新法解读", "新法解读"], ["科技民生", "科技民生"]])}
      {textInput("source", "权威来源", "新华社、政府网站等")}{textInput("sourceUrl", "来源原文链接", "https://")}{textInput("sourceDate", "来源发布日期", "", "date")}{numberInput("importanceStars", "重要星级", 1, 5)}{textInput("targetCodes", "适用考试", "national,province:广东")}
      {textArea("summary", "一句话摘要", "帮助考生快速判断是否需要阅读")}{textArea("body", "完整内容", "填写热点背景、核心考点和可能考法")}
    </>;
    if (draft.contentType === "essay_micro") return <>
      {textInput("date", "展示日期", "", "date")}{textInput("theme", "申论主题", "基层治理")}{textInput("source", "材料来源", "官方媒体或政府网站")}{textInput("sourceUrl", "来源原文链接", "https://")}{textInput("sourceDate", "来源发布日期", "", "date")}{numberInput("wordLimit", "字数限制", 50, 2000)}{textInput("targetCodes", "适用考试", "national,province:广东")}
      {textArea("material", "给定材料", "填写精简材料")}{textArea("prompt", "作答任务", "填写题目要求")}{textArea("referenceAnswer", "参考答案", "填写规范参考答案")}{textArea("scoringPoints", "采分点", "多个采分点用｜分隔")}
    </>;
    if (draft.contentType === "audio_track") return <>
      {selectInput("category", "电台栏目", [["current", "时政电台"], ["morning", "申论晨读"], ["wrong", "错题朗读"], ["meeting", "重要会议"], ["law", "新法解读"]])}
      {textInput("seriesId", "系列编码", "current")}{textInput("seriesTitle", "系列名称", "时政电台")}{textInput("seriesLabel", "系列短标签", "时政")}{textInput("seriesColor", "系列颜色", "#245c92")}{textInput("seriesIcon", "系列图标文字", "政")}{numberInput("sortOrder", "展示顺序", 0, 9999)}
      {textInput("kicker", "栏目角标", "月度热点")}{textInput("duration", "音频时长", "5分钟")}{textInput("source", "内容来源", "政府网站或权威媒体")}{textInput("sourceUrl", "来源原文链接", "https://")}{textInput("sourceDate", "来源发布日期", "", "date")}
      {textArea("description", "本期简介", "一句话说明收听价值")}{textArea("text", "音频逐字稿", "用于字幕、搜索与无障碍阅读")}
      <label className="wide">音频文件<div className={styles.mediaRow}><input value={asText(p.audioUrl)} placeholder="请上传站内音频，系统会自动回填受鉴权地址" onChange={(event) => setField("audioUrl", event.target.value)} /><label className={styles.uploadButton}><input disabled={!canUpload} type="file" accept=".mp3,.m4a,.wav,.aac,.ogg,audio/mpeg,audio/mp4,audio/wav,audio/aac,audio/ogg" onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadAudio(file); }} />{uploadingAudio ? "上传中…" : canUpload ? "选择音频" : "无上传权限"}</label></div><small>上传文件默认是会员私有媒体；选择“免费/试听”内容后，需提交审核，审核通过才会开放试听。禁止填写公开目录或第三方音频直链。</small></label>
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
      {textInput("grassrootsYears", "基层工作年限")}{textInput("gender", "性别要求")}{textInput("certificates", "证书要求")}{textInput("phone", "咨询电话")}{textInput("sourceUrl", "职位表来源链接", "https://")}{numberInput("dataVersion", "职位数据版本", 1, 9999)}{textInput("updatedAt", "数据更新时间", "", "date")}{textArea("remarks", "职位备注")}
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
      {numberInput("reviewRatio", "到期复习题占比%", 0, 100)}{numberInput("urgentExamDays", "临考加权天数", 1, 180)}
      {numberInput("regionWeight", "地区匹配权重%", 0, 100)}{numberInput("frequencyWeight", "考频权重%", 0, 100)}{numberInput("importanceWeight", "重要星级权重%", 0, 100)}{numberInput("scoreRateWeight", "拿分率权重%", 0, 100)}
      {numberInput("scoreRateMin", "优先拿分率下限%", 0, 100)}{numberInput("scoreRateMax", "优先拿分率上限%", 0, 100)}
      <p className={`${styles.formHint} wide`}>权重用于今日训练的选题排序。建议地区、考频、重要星级、拿分率四项合计为100%。发布新策略前请先预览。</p>
    </>;
  };

  const previewPayload: Record<string, unknown> = preview && "payload" in preview ? (preview.payload ?? {}) : preview ? readPayload(preview) : {};
  const previewTitle = preview ? ("title" in preview ? preview.title : "") : "";

  return <>
    {scope === "content" && canUpload && <section className="admin-panel">
      <div className="admin-panel-title"><div><span>媒体资源库</span><h2>上传音频、题目图片与附件</h2><small>上传后复制地址，可用于题库Excel的图片地址/资源地址，或粘贴到任意内容表单。</small></div></div>
      <div className={styles.mediaRow}>
        <span className={styles.formHint}>新上传资源统一为会员私有媒体；免费试听需关联免费内容并通过审核。</span>
        <label className={styles.uploadButton} aria-disabled={!canUpload}><input disabled={!canUpload} type="file" accept=".jpg,.jpeg,.png,.gif,.webp,.mp3,.m4a,.wav,.aac,.ogg,.pdf,image/jpeg,image/png,image/gif,image/webp,audio/mpeg,audio/mp4,audio/wav,audio/aac,audio/ogg,application/pdf" onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadAsset(file); }} />{uploadingAsset ? "上传中…" : canUpload ? "选择媒体文件" : "无上传权限"}</label>
        {lastAsset && <><input readOnly value={lastAsset.url} aria-label={`${lastAsset.name}资源地址`} /><button type="button" onClick={() => { void navigator.clipboard.writeText(lastAsset.url); onMessage("媒体地址已复制"); }}>复制地址</button></>}
      </div>
      {mediaAssets.length > 0 && <div className="admin-table-wrap"><table><thead><tr><th>文件</th><th>类型</th><th>访问权益</th><th>操作</th></tr></thead><tbody>{mediaAssets.slice(0, 30).map((asset) => <tr key={asset.id}><td>{asset.file_name}</td><td>{asset.content_type}</td><td>{asset.access_level === "free" ? "已审核免费/试听" : "会员私有"}</td><td>{asset.access_level === "free" ? <button type="button" onClick={() => void setMediaAccess(asset.id, "member")}>改为会员</button> : <small>随免费内容审核开放</small>} <button type="button" onClick={() => { void navigator.clipboard.writeText(asset.url); onMessage("媒体地址已复制"); }}>复制地址</button></td></tr>)}</tbody></table></div>}
    </section>}
    {canEdit && <section className="admin-panel" data-content-form>
      <div className="admin-panel-title"><div><span>{scope === "radar" ? "招考数据配置" : "内容配置中心"}</span><h2>{editingId ? "编辑运营内容" : "创建运营内容"}</h2><small>编辑人员先保存或提交审核，审核通过后再进入用户端。</small></div><button disabled={!canEdit} onClick={() => { setEditingId(null); setEditingVersion(null); setDraft(emptyDraft(draft.contentType)); }}>新建空白内容</button></div>

      <div className={styles.typeGrid} aria-label="内容类型">
        {scopedTypes.map((item) => <button key={item.type} type="button" className={`${styles.typeCard} ${styles[item.tone]} ${draft.contentType === item.type ? styles.active : ""}`} onClick={() => switchType(item.type)}><b>{item.label}</b><small>{item.short}</small></button>)}
      </div>

      <div className={styles.editorHeader}>
        <div><span>{TYPE_LABEL[draft.contentType]}</span><h3>{editingId ? `正在编辑 #${editingId}` : "新建内容"}</h3></div>
        <button type="button" onClick={() => setPreview(draft)}>预览当前内容</button>
      </div>

      <div className="form-grid">
        <label>内容标题<input value={draft.title} onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} placeholder="用户端看到的标题" /></label>
          <label>唯一标识<input disabled={Boolean(editingId)} value={draft.contentKey} onChange={(event) => setDraft((current) => ({ ...current, contentKey: event.target.value }))} placeholder="创建后不可修改" /><small>{editingId ? "内容标识和业务类型已锁定；需要更换时请复制为新内容。" : "创建后不可修改，用于版本、审核和前端引用。"}</small></label>
        <label>保存方式<select value={draft.publishMode} onChange={(event) => setDraft((current) => ({ ...current, publishMode: event.target.value as PublishMode }))}><option value="draft">仅保存草稿</option><option value="review">提交审核</option>{canPublish && <option value="now">审核通过并立即发布</option>}{canPublish && <option value="scheduled">审核通过并定时发布</option>}</select></label>
        <label>访问权益<select value={draft.accessLevel} onChange={(event) => setDraft((current) => ({ ...current, accessLevel: event.target.value as "free" | "member" }))}><option value="member">会员完整内容</option><option value="free">免费/试听内容</option></select><small>草稿中可调整；正式发布后按审核通过的版本生效，无需重新部署。</small></label>
        {draft.publishMode === "scheduled" && <label>发布时间<input type="datetime-local" value={draft.publishAt} onChange={(event) => setDraft((current) => ({ ...current, publishAt: event.target.value }))} /></label>}
        {renderTypeFields()}
      </div>
      <div className={styles.editorActions}><button type="button" onClick={() => setPreview(draft)}>预览</button><button className="admin-primary" type="button" disabled={!canEdit || saving} onClick={() => void save()}>{saving ? "保存中…" : draft.publishMode === "draft" ? "保存草稿" : draft.publishMode === "review" || !canPublish ? "提交审核" : draft.publishMode === "scheduled" ? "保存并定时发布" : "立即发布"}</button></div>
    </section>}

    <section className="admin-panel">
      <div className="admin-panel-title"><div><span>内容持久化批量导入</span><h2>上传Excel或CSV运营内容</h2><small>支持当前模块全部内容类型；导入只生成草稿，须整批提交、审核后才能发布。任务由后续安全请求持久续跑，不依赖页面轮询。</small></div><button onClick={() => void downloadPositionTemplate()}>下载当前类型模板</button></div>
      <div className="form-grid">
        <label>导入内容类型<select disabled={!canEdit || Boolean(activeContentImportId)} value={bulkImportType} onChange={(event) => { setBulkImportType(event.target.value as ContentDraft["contentType"]); setPositionFile(null); setPositionFileHash(""); setPositionRows([]); setPositionSourceName(""); setPositionSourceUrl(""); setPositionSourcePublishedAt(""); setPositionDataVersion(""); }} >{scopedTypes.map((item) => <option key={item.type} value={item.type}>{item.label}</option>)}</select></label>
        <label>重复处理策略<select disabled={!canEdit || Boolean(activeContentImportId)} value={contentDuplicateStrategy} onChange={(event) => setContentDuplicateStrategy(event.target.value as typeof contentDuplicateStrategy)}><option value="reject">拒绝重复（推荐）</option><option value="skip">跳过重复并保留现有内容</option><option value="update_draft">仅更新现有草稿/已驳回内容</option></select><small>已发布或待审核内容绝不会被导入直接覆盖。</small></label>
        <label>官方来源名称<input disabled={!canEdit} value={positionSourceName} onChange={(event) => setPositionSourceName(event.target.value)} placeholder="如：广东省公务员局职位表" /></label>
        <label>官方来源链接<input disabled={!canEdit} value={positionSourceUrl} onChange={(event) => setPositionSourceUrl(event.target.value)} placeholder="https:// 官方页面" /></label>
        <label>来源发布日期<input disabled={!canEdit} type="date" value={positionSourcePublishedAt} onChange={(event) => setPositionSourcePublishedAt(event.target.value)} /></label>
        <label>数据版本<input disabled={!canEdit} value={positionDataVersion} onChange={(event) => setPositionDataVersion(event.target.value)} placeholder="如：2027-广东-第一版" /></label>
      </div>
      <div className={styles.positionUpload}>
        <label><input disabled={!canEdit} type="file" accept=".xlsx,.xls,.csv" onChange={(event) => { const file = event.target.files?.[0]; if (file) void readPositionFile(file); }} /><span>{readingPositions ? "正在读取…" : positionFile?.name ?? `选择 ${TYPE_LABEL[bulkImportType]} XLSX / XLS / CSV 文件`}</span><small>最大30MB，最多50000条内容</small></label>
        {positionRows.length > 0 && <div className={styles.positionSummary}><span><b>{positionRows.length}</b>总行数</span><span><b>{positionRows.filter((row) => !row.issues.length).length}</b>可导入</span><span className={positionRows.some((row) => row.issues.length) ? styles.danger : ""}><b>{positionRows.filter((row) => row.issues.length).length}</b>需修正</span></div>}
      </div>
      {activeContentImportId && <p className={styles.formHint}>正在续传任务 #{activeContentImportId}。必须选择原文件，服务端会核对 SHA-256 指纹；当前上传进度 {positionUploadProgress}%。</p>}
      {positionRows.length > 0 && <>
        <div className="admin-table-wrap"><table><thead><tr><th>行号</th><th>类型</th><th>内容标识</th><th>标题</th><th>权益</th><th>校验</th></tr></thead><tbody>{positionRows.slice(0, 8).map((row) => <tr key={row.row}><td>{row.row}</td><td>{TYPE_LABEL[bulkImportType]}</td><td>{row.contentKey || "未填写"}</td><td>{row.title || "未填写"}</td><td>{row.accessLevel === "free" ? "免费" : "会员"}</td><td>{row.issues.length ? <span className={styles.errorText}>{row.issues.join("、")}</span> : <span className={styles.okText}>通过</span>}</td></tr>)}</tbody></table></div>
        <div className={styles.editorActions}><p>问题行也会随文件封存，但只记录为错误，不会写入内容库；完成后可下载错误 CSV。</p><button className="admin-primary" disabled={!canEdit || importingPositions || !positionRows.length} onClick={() => void importPositions()}>{importingPositions ? `上传中 ${positionUploadProgress}%` : activeContentImportId ? "继续上传并封存" : "上传并创建后台任务"}</button></div>
      </>}
      {visibleContentImports.filter((task) => scopedTypeNames.has(task.content_type)).length > 0 && <>
        <div className={styles.editorHeader}><div><span>后台任务</span><h3>内容批量导入记录</h3></div><button type="button" onClick={() => { setContentImportUpdates({}); void onReload(); }}>刷新</button></div>
        <div className="admin-table-wrap"><table><thead><tr><th>任务</th><th>来源 / 版本</th><th>进度</th><th>结果</th><th>状态</th><th>操作</th></tr></thead><tbody>
          {visibleContentImports.filter((task) => scopedTypeNames.has(task.content_type)).slice(0, 30).map((task) => {
            const progress = task.total_rows > 0 ? Math.min(100, Math.round(task.processed_rows / task.total_rows * 100)) : 0;
            const statusLabel: Record<ContentImportItem["status"], string> = { uploading: "等待文件上传", queued: "后台排队", processing: "后台处理中", failed: "系统处理失败", cancelling: "正在取消", cancelled: "已取消", completed: "已完成", completed_with_errors: "完成（有错误行）" };
            const reviewLabel = task.review_status === "pending_review" ? "待整批审核" : task.review_status === "published" ? "已整批发布" : task.review_status === "rejected" ? "批次已驳回" : task.review_status === "rolled_back" ? "已整批回滚" : "草稿批次";
            return <tr key={task.id}><td><b>#{task.id} · {TYPE_LABEL[task.content_type]}</b><br /><small>{task.file_name}</small></td><td>{task.source_name}<br /><small>{task.data_version} · {task.duplicate_strategy}</small></td><td>{task.status === "uploading" ? `${task.uploaded_rows}/${task.total_rows} 已上传` : `${task.processed_rows}/${task.total_rows}（${progress}%）`}</td><td>{task.imported_rows} 导入 / {task.failed_rows} 错误{task.duplicate_rows ? ` / ${task.duplicate_rows} 重复` : ""}</td><td>{statusLabel[task.status]}<br /><small>{reviewLabel}</small>{task.error_summary && <><br /><small className={styles.errorText}>{task.error_summary}</small></>}</td><td><div className={styles.rowActions}>
              {canEdit && task.status === "uploading" && <button type="button" onClick={() => resumeContentImport(task)}>选择原文件续传</button>}
              {canEdit && ["uploading", "queued", "processing"].includes(task.status) && <button type="button" className={styles.dangerButton} onClick={() => void cancelContentImport(task)}>取消</button>}
              {canEdit && task.status === "failed" && <button type="button" onClick={() => void retryContentImport(task)}>安全重试</button>}
              {task.failed_rows > 0 && <button type="button" onClick={() => void downloadContentImportErrors(task)}>错误CSV</button>}
              {canEdit && ["completed", "completed_with_errors"].includes(task.status) && new Set(["draft", "rejected"]).has(task.review_status) && task.imported_rows > 0 && <button type="button" onClick={() => void submitContentImportReview(task)}>整批提交审核</button>}
              {canReview && task.review_status === "pending_review" && <><button type="button" onClick={() => void reviewContentImport(task, "approve")}>整批通过并发布</button><button type="button" className={styles.dangerButton} onClick={() => void reviewContentImport(task, "reject")}>整批驳回</button></>}
              {canPublish && ["draft", "pending_review", "published", "rejected"].includes(task.review_status) && task.imported_rows > 0 && <button type="button" className={styles.dangerButton} onClick={() => void rollbackContentImport(task)}>按批次回滚</button>}
            </div></td></tr>;
          })}
        </tbody></table></div>
      </>}
    </section>

    <section className="admin-panel table-panel">
      <div className="admin-panel-title"><div><span>内容库</span><h2>全部运营内容</h2><small>支持回填编辑、复制、预览、下架、重发与历史版本回滚。</small></div><button onClick={() => void onReload()}>刷新</button></div>
      <div className={styles.libraryFilters}><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索标题或内容标识" /><select value={filterType} onChange={(event) => setFilterType(event.target.value as "all" | AdminContentType)}><option value="all">全部类型</option>{scopedTypes.map((item) => <option key={item.type} value={item.type}>{item.label}</option>)}{scope === "content" && <option value="practice_day">旧版日练包</option>}</select></div>
      <div className="admin-table-wrap"><table><thead><tr><th>类型</th><th>内容</th><th>权益</th><th>状态</th><th>发布时间</th><th>版本</th><th>操作</th></tr></thead><tbody>{filteredItems.length ? filteredItems.map((item) => {
        const scheduled = item.status === "scheduled";
        const statusLabel = scheduled ? "待发布" : item.status === "pending_review" ? "待审核" : item.status === "rejected" ? "已驳回" : item.status === "published" ? "已发布" : item.status === "archived" ? "已下架" : "草稿";
        return <tr key={item.id}><td>{TYPE_LABEL[item.content_type] ?? item.content_type}</td><td><b>{item.title}</b><small>{item.content_key}</small>{item.status === "rejected" && item.review_note && <small className={styles.errorText}>驳回原因：{item.review_note}</small>}</td><td>{item.access_level === "free" ? "免费/试听" : "会员"}</td><td><span className={`status ${item.status}`}>{statusLabel}</span></td><td>{item.publish_at ? new Date(item.publish_at).toLocaleString("zh-CN") : item.status === "published" ? "立即" : "—"}</td><td>{Number(item.version_count ?? 1)}版</td><td><div className={styles.rowActions}><button disabled={!canEdit || item.status === "pending_review"} onClick={() => void beginEdit(item)}>编辑</button><button disabled={!canEdit} onClick={() => void duplicate(item)}>复制</button><button onClick={() => setPreview(item)}>预览</button><button onClick={() => void openVersions(item)}>版本</button>{item.status === "pending_review" && canReview ? <><button onClick={() => void review(item, "approve")}>通过并发布</button><button className={styles.dangerButton} onClick={() => void review(item, "reject")}>驳回</button></> : item.status === "published" || item.status === "scheduled" ? <button disabled={!canPublish} className={styles.dangerButton} onClick={() => void disable(item)}>下架</button> : item.status === "archived" && <button disabled={!canPublish} onClick={() => void republish(item)}>重新发布</button>}</div></td></tr>;
      }) : <tr><td colSpan={7}>没有符合条件的内容，请从上方创建。</td></tr>}</tbody></table></div>
    </section>

    {preview && <div className={styles.overlay} role="dialog" aria-modal="true" aria-label="内容预览" onMouseDown={(event) => { if (event.currentTarget === event.target) setPreview(null); }}><article className={styles.modal}><header><div><span>用户端内容预览</span><h2>{previewTitle || "未命名内容"}</h2><p>{"contentType" in preview ? TYPE_LABEL[preview.contentType] : TYPE_LABEL[preview.content_type]}</p></div><button aria-label="关闭预览" onClick={() => setPreview(null)}>×</button></header><div className={styles.previewBody}>{Object.entries(previewPayload).filter(([, value]) => asText(value)).map(([key, value]) => <section key={key}><small>{key}</small><p>{asText(value)}</p></section>)}</div><footer><button onClick={() => setPreview(null)}>关闭</button></footer></article></div>}

    {versionItem && <div className={styles.overlay} role="dialog" aria-modal="true" aria-label="版本记录" onMouseDown={(event) => { if (event.currentTarget === event.target) setVersionItem(null); }}><article className={styles.modal}><header><div><span>版本记录</span><h2>{versionItem.title}</h2><p>回滚不会删除后续历史，而是生成一个新版本。</p></div><button aria-label="关闭版本记录" onClick={() => setVersionItem(null)}>×</button></header><div className={styles.versionList}>{loadingVersions ? <p>正在加载版本…</p> : versions.length ? versions.map((version) => <section key={version.id}><div><b>第 {version.version} 版</b><span className={`status ${version.status}`}>{version.status === "published" ? "发布" : version.status === "pending_review" ? "待审核" : version.status === "rejected" ? "驳回" : version.status === "scheduled" ? "定时" : version.status === "archived" ? "下架" : "草稿"}</span><small>{new Date(version.created_at).toLocaleString("zh-CN")}</small></div><button disabled={!canPublish} onClick={() => void rollback(version)}>回滚到此版</button></section>) : <p>暂无历史版本；下一次编辑保存后会自动留档。</p>}</div><footer><button onClick={() => setVersionItem(null)}>关闭</button></footer></article></div>}
  </>;
}
