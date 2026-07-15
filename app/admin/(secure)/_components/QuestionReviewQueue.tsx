"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Divider,
  Drawer,
  Input,
  List,
  Modal,
  Segmented,
  Space,
  Table,
  Tag,
  Typography,
} from "antd";
import { CheckOutlined, CloseOutlined, EyeOutlined, ReloadOutlined } from "@ant-design/icons";
import { adminApi } from "./adminApi";

type ReviewStatus = "pending_review" | "rejected" | "approved";
type ReviewQuestion = {
  id: number;
  question_code: string;
  subject: string;
  module: string;
  sub_type: string;
  stem: string;
  options_json: string | null;
  answer: string | null;
  explanation: string;
  technique: string;
  material: string;
  prompt: string;
  word_limit: number | null;
  scoring_points_json: string | null;
  source: string;
  source_exam_type: string;
  source_region: string;
  source_year: number | null;
  source_batch: string;
  truth_verified: number;
  review_status: ReviewStatus;
  review_note: string;
  reviewed_by: number | null;
  reviewed_at: string | null;
  frequency: string;
  frequency_occurrences: number;
  frequency_papers: number;
  frequency_years_json: string | null;
  frequency_updated_at: string | null;
  importance_stars: number;
  importance_rule_version: string;
  importance_reason: string;
  importance_override_reason: string;
  score_rate: number;
  score_rate_correct: number;
  score_rate_attempts: number;
  score_rate_scope: string;
  score_rate_source: string;
  score_rate_updated_at: string | null;
  suggested_seconds: number;
  image_url: string;
  resource_url: string;
  bank_names: string | null;
  bank_id: number | null;
  updated_at: string;
};

type Response = { questions?: ReviewQuestion[]; pagination?: { total?: number } };
type Props = {
  canReview: boolean;
  onMessage: (message: string) => void;
  onChanged: () => Promise<void>;
};

const STATUS_LABEL: Record<ReviewStatus, string> = {
  pending_review: "待审核",
  rejected: "已驳回",
  approved: "已通过",
};

const EMPTY_TEXT = "未填写";

function parseStringList(value: string | null | undefined) {
  try {
    const parsed = JSON.parse(value || "[]") as unknown;
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function safeExternalUrl(value: string | null | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function multiline(value: string | null | undefined) {
  return <Typography.Paragraph style={{ marginBottom: 0, whiteSpace: "pre-wrap" }}>{value || EMPTY_TEXT}</Typography.Paragraph>;
}

function ReviewStatusTag({ status }: { status: ReviewStatus }) {
  return <Tag color={status === "approved" ? "green" : status === "rejected" ? "red" : "orange"}>{STATUS_LABEL[status]}</Tag>;
}

export default function QuestionReviewQueue({ canReview, onMessage, onChanged }: Props) {
  const [status, setStatus] = useState<ReviewStatus>("pending_review");
  const [questions, setQuestions] = useState<ReviewQuestion[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [detailQuestion, setDetailQuestion] = useState<ReviewQuestion | null>(null);
  const [reviewing, setReviewing] = useState<{ question: ReviewQuestion; decision: "approve" | "reject" } | null>(null);
  const [reviewNote, setReviewNote] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await adminApi<Response>({ action: "adminListQuestions", reviewStatus: status, page: 1, pageSize: 100 });
      setQuestions(data.questions ?? []);
      setTotal(Number(data.pagination?.total ?? data.questions?.length ?? 0));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "审核队列加载失败");
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    const task = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(task);
  }, [load]);

  const openReview = (question: ReviewQuestion, decision: "approve" | "reject") => {
    setReviewing({ question, decision });
    setReviewNote("");
  };

  const submitReview = async () => {
    if (!reviewing) return;
    if (reviewing.decision === "reject" && !reviewNote.trim()) {
      onMessage("驳回时必须填写原因");
      return;
    }
    setSubmitting(true);
    try {
      await adminApi({ action: "adminReviewQuestion", id: reviewing.question.id, decision: reviewing.decision, reviewNote: reviewNote.trim() || null });
      onMessage(reviewing.decision === "approve" ? "真题已核验通过并重新计算题库价值指标" : "题目已驳回，上传人员可按原因修正后重新导入");
      setReviewing(null);
      setDetailQuestion(null);
      setReviewNote("");
      await Promise.all([load(), onChanged()]);
    } catch (reason) {
      onMessage(reason instanceof Error ? reason.message : "题目审核失败");
    } finally {
      setSubmitting(false);
    }
  };

  const columns = [
    { title: "真题", key: "question", width: 210, render: (_: unknown, row: ReviewQuestion) => <><Typography.Text strong>{row.question_code}</Typography.Text><br /><Typography.Text type="secondary">{row.source_region}-{row.source_year ?? "年份缺失"} · {row.subject}/{row.module}</Typography.Text></> },
    { title: "来源追溯", key: "source", width: 280, render: (_: unknown, row: ReviewQuestion) => <><Typography.Text>{row.source || "来源缺失"}</Typography.Text><br /><Typography.Text type="secondary">批次：{row.source_batch || "未填写"}</Typography.Text></> },
    { title: "题干摘要", dataIndex: "stem", key: "stem", ellipsis: true, render: (value: string) => <Typography.Text title={value}>{value}</Typography.Text> },
    { title: "所属题库", dataIndex: "bank_names", key: "banks", width: 160, render: (value: string | null) => value || "未归入题库" },
    { title: "状态", key: "status", width: 110, render: (_: unknown, row: ReviewQuestion) => <ReviewStatusTag status={row.review_status} /> },
    { title: "审核备注", dataIndex: "review_note", key: "note", width: 180, render: (value: string) => value || "—" },
    { title: "操作", key: "action", fixed: "right" as const, width: 245, render: (_: unknown, row: ReviewQuestion) => <Space size={2}>
      <Button type="link" icon={<EyeOutlined />} onClick={() => setDetailQuestion(row)}>详情</Button>
      {row.review_status === "pending_review" && <>
        <Button type="link" icon={<CheckOutlined />} disabled={!canReview} onClick={() => openReview(row, "approve")}>通过</Button>
        <Button danger type="link" icon={<CloseOutlined />} disabled={!canReview} onClick={() => openReview(row, "reject")}>驳回</Button>
      </>}
    </Space> },
  ];

  const detailOptions = parseStringList(detailQuestion?.options_json);
  const scoringPoints = parseStringList(detailQuestion?.scoring_points_json);
  const frequencyYears = parseStringList(detailQuestion?.frequency_years_json);
  const scoreAttempts = Number(detailQuestion?.score_rate_attempts ?? 0);
  const scoreCorrect = Number(detailQuestion?.score_rate_correct ?? 0);
  const calculatedScoreRate = scoreAttempts > 0 ? Math.round(scoreCorrect * 100 / scoreAttempts) : 0;
  const resourceUrl = safeExternalUrl(detailQuestion?.resource_url);
  const imageUrl = safeExternalUrl(detailQuestion?.image_url);
  const scoreSourceUrl = detailQuestion?.score_rate_source === "platform" ? null : safeExternalUrl(detailQuestion?.score_rate_source);

  return (
    <Card
      title={<Space><span>真题审核队列</span><Tag color={status === "pending_review" ? "orange" : undefined}>{total}条</Tag></Space>}
      extra={<Space wrap><Segmented<ReviewStatus> value={status} onChange={setStatus} options={[{ label: "待审核", value: "pending_review" }, { label: "已驳回", value: "rejected" }, { label: "已通过", value: "approved" }]} /><Button icon={<ReloadOutlined />} onClick={() => void load()}>刷新</Button></Space>}
      style={{ marginBottom: 20 }}
    >
      {!canReview && <Alert showIcon type="info" message="当前角色可以查看审核状态，但不能自审；需由审核发布角色处理。" style={{ marginBottom: 16 }} />}
      {error && <Alert showIcon type="error" message={error} style={{ marginBottom: 16 }} />}
      <Table<ReviewQuestion> rowKey="id" loading={loading} columns={columns} dataSource={questions} pagination={false} scroll={{ x: 1260 }} locale={{ emptyText: status === "pending_review" ? "暂无待审核真题" : `暂无${STATUS_LABEL[status]}真题` }} />
      {total > questions.length && <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>当前显示前100条，共{total}条；请先处理本页后刷新。</Typography.Paragraph>}

      <Drawer
        title={detailQuestion ? `${detailQuestion.question_code} · 真题审核详情` : "真题审核详情"}
        width={820}
        open={Boolean(detailQuestion)}
        onClose={() => setDetailQuestion(null)}
        extra={detailQuestion?.review_status === "pending_review" && canReview ? <Space>
          <Button danger icon={<CloseOutlined />} onClick={() => openReview(detailQuestion, "reject")}>驳回</Button>
          <Button type="primary" icon={<CheckOutlined />} onClick={() => openReview(detailQuestion, "approve")}>审核通过</Button>
        </Space> : undefined}
      >
        {detailQuestion && <>
          <Alert
            showIcon
            type={detailQuestion.review_status === "approved" ? "success" : detailQuestion.review_status === "rejected" ? "error" : "warning"}
            message={<Space><ReviewStatusTag status={detailQuestion.review_status} /><span>{detailQuestion.source_region}-{detailQuestion.source_year ?? "年份缺失"} · {detailQuestion.subject}/{detailQuestion.module}{detailQuestion.sub_type ? `/${detailQuestion.sub_type}` : ""}</span></Space>}
            description={detailQuestion.review_note ? `审核备注：${detailQuestion.review_note}` : "请核对题干、答案、解析、来源批次和指标证据后再作出审核决定。"}
            style={{ marginBottom: 20 }}
          />

          <Typography.Title level={5}>完整题目</Typography.Title>
          {detailQuestion.material && <><Typography.Text type="secondary">材料</Typography.Text>{multiline(detailQuestion.material)}</>}
          <Divider style={{ margin: "14px 0" }} />
          <Typography.Text type="secondary">题干</Typography.Text>
          {multiline(detailQuestion.stem)}
          {detailOptions.length > 0 && <List
            bordered
            size="small"
            style={{ marginTop: 14 }}
            dataSource={detailOptions}
            renderItem={(option, index) => <List.Item><Typography.Text strong style={{ width: 28 }}>{String.fromCharCode(65 + index)}.</Typography.Text><Typography.Text style={{ flex: 1, whiteSpace: "pre-wrap" }}>{option}</Typography.Text></List.Item>}
          />}
          <Descriptions bordered size="small" column={2} style={{ marginTop: 16 }}>
            <Descriptions.Item label="正确答案">{detailQuestion.answer ? <Tag color="blue">{detailQuestion.answer}</Tag> : EMPTY_TEXT}</Descriptions.Item>
            <Descriptions.Item label={detailQuestion.subject === "申论" ? "字数限制" : "建议用时"}>
              {detailQuestion.subject === "申论"
                ? detailQuestion.word_limit ? `${detailQuestion.word_limit}字` : EMPTY_TEXT
                : detailQuestion.suggested_seconds ? `${detailQuestion.suggested_seconds}秒` : EMPTY_TEXT}
            </Descriptions.Item>
          </Descriptions>

          {detailQuestion.subject === "申论" && <>
            <Typography.Title level={5} style={{ marginTop: 24 }}>申论作答要求与采分点</Typography.Title>
            <Typography.Text type="secondary">作答任务</Typography.Text>
            {multiline(detailQuestion.prompt)}
            <Typography.Text type="secondary">采分点</Typography.Text>
            {scoringPoints.length ? <List size="small" bordered dataSource={scoringPoints} renderItem={(point, index) => <List.Item><Typography.Text>{index + 1}. {point}</Typography.Text></List.Item>} /> : multiline(EMPTY_TEXT)}
          </>}

          <Typography.Title level={5} style={{ marginTop: 24 }}>{detailQuestion.subject === "申论" ? "参考答案与作答提示" : "完整解析"}</Typography.Title>
          {multiline(detailQuestion.explanation)}
          {detailQuestion.technique && <><Typography.Text type="secondary">技巧/补充说明</Typography.Text>{multiline(detailQuestion.technique)}</>}

          <Typography.Title level={5} style={{ marginTop: 24 }}>来源与原始资源</Typography.Title>
          <Descriptions bordered size="small" column={2}>
            <Descriptions.Item label="真题来源">{detailQuestion.source || EMPTY_TEXT}</Descriptions.Item>
            <Descriptions.Item label="地区-年份">{detailQuestion.source_region || EMPTY_TEXT}-{detailQuestion.source_year ?? EMPTY_TEXT}</Descriptions.Item>
            <Descriptions.Item label="考试类型">{detailQuestion.source_exam_type || EMPTY_TEXT}</Descriptions.Item>
            <Descriptions.Item label="来源批次 sourceBatch">{detailQuestion.source_batch || EMPTY_TEXT}</Descriptions.Item>
            <Descriptions.Item label="原始资源" span={2}>{resourceUrl ? <Typography.Link href={resourceUrl} target="_blank" rel="noreferrer">打开原始资源链接</Typography.Link> : detailQuestion.resource_url || EMPTY_TEXT}</Descriptions.Item>
            <Descriptions.Item label="题图资源" span={2}>{imageUrl ? <Typography.Link href={imageUrl} target="_blank" rel="noreferrer">打开题图链接</Typography.Link> : detailQuestion.image_url || EMPTY_TEXT}</Descriptions.Item>
            <Descriptions.Item label="所属题库" span={2}>{detailQuestion.bank_names || "未归入题库"}</Descriptions.Item>
          </Descriptions>

          <Typography.Title level={5} style={{ marginTop: 24 }}>考频与重要度证据</Typography.Title>
          <Descriptions bordered size="small" column={2}>
            <Descriptions.Item label="考频">{detailQuestion.frequency || EMPTY_TEXT}</Descriptions.Item>
            <Descriptions.Item label="覆盖统计">出现{detailQuestion.frequency_occurrences ?? 0}套 / 覆盖{detailQuestion.frequency_papers ?? 0}套</Descriptions.Item>
            <Descriptions.Item label="覆盖年份">{frequencyYears.length ? frequencyYears.join("、") : EMPTY_TEXT}</Descriptions.Item>
            <Descriptions.Item label="统计日期">{detailQuestion.frequency_updated_at || EMPTY_TEXT}</Descriptions.Item>
            <Descriptions.Item label="重要星级">{detailQuestion.importance_stars ? `${detailQuestion.importance_stars}星` : EMPTY_TEXT}</Descriptions.Item>
            <Descriptions.Item label="规则版本">{detailQuestion.importance_rule_version || EMPTY_TEXT}</Descriptions.Item>
            <Descriptions.Item label="重要度理由" span={2}>{detailQuestion.importance_reason || EMPTY_TEXT}</Descriptions.Item>
            <Descriptions.Item label="人工覆盖理由" span={2}>{detailQuestion.importance_override_reason || "未人工覆盖"}</Descriptions.Item>
          </Descriptions>

          <Typography.Title level={5} style={{ marginTop: 24 }}>拿分率证据</Typography.Title>
          <Descriptions bordered size="small" column={2}>
            <Descriptions.Item label="拿分率">{scoreAttempts > 0 ? `${calculatedScoreRate}%` : "暂无有效样本"}</Descriptions.Item>
            <Descriptions.Item label="样本">{scoreCorrect}/{scoreAttempts}</Descriptions.Item>
            <Descriptions.Item label="统计范围">{detailQuestion.score_rate_scope || EMPTY_TEXT}</Descriptions.Item>
            <Descriptions.Item label="统计日期">{detailQuestion.score_rate_updated_at || EMPTY_TEXT}</Descriptions.Item>
            <Descriptions.Item label="数据来源" span={2}>
              {detailQuestion.score_rate_source === "platform" ? <Tag color="blue">平台答题记录（系统统计）</Tag> : scoreSourceUrl ? <Typography.Link href={scoreSourceUrl} target="_blank" rel="noreferrer">打开外部统计来源</Typography.Link> : detailQuestion.score_rate_source || EMPTY_TEXT}
            </Descriptions.Item>
          </Descriptions>
          {scoreAttempts > 0 && Number(detailQuestion.score_rate ?? 0) !== calculatedScoreRate && <Alert showIcon type="warning" message={`存储拿分率${detailQuestion.score_rate}%与样本计算值${calculatedScoreRate}%不一致，请先核验数据。`} style={{ marginTop: 12 }} />}
        </>}
      </Drawer>

      <Modal
        title={reviewing?.decision === "approve" ? "确认真题审核通过" : "驳回真题"}
        open={Boolean(reviewing)}
        onCancel={() => { setReviewing(null); setReviewNote(""); }}
        onOk={() => void submitReview()}
        okText={reviewing?.decision === "approve" ? "确认通过" : "确认驳回"}
        okButtonProps={{ danger: reviewing?.decision === "reject", loading: submitting }}
        cancelButtonProps={{ disabled: submitting }}
      >
        {reviewing && <>
          <Typography.Paragraph><Typography.Text strong>{reviewing.question.question_code}</Typography.Text> · {reviewing.question.source_region}-{reviewing.question.source_year}</Typography.Paragraph>
          <Typography.Paragraph type="secondary">{reviewing.question.source}<br />来源批次：{reviewing.question.source_batch}</Typography.Paragraph>
          <Input.TextArea rows={4} maxLength={1_000} showCount value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} placeholder={reviewing.decision === "reject" ? "必填：说明来源、年份、题干或答案存在的问题" : "可选：记录核验依据或注意事项"} />
        </>}
      </Modal>
    </Card>
  );
}
