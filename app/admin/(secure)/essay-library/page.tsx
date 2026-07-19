"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Divider,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  Popconfirm,
  Progress,
  Row,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import {
  CheckCircleOutlined,
  EditOutlined,
  FileAddOutlined,
  PlusOutlined,
  SaveOutlined,
  UploadOutlined,
} from "@ant-design/icons";
import { useAdminSession } from "../../AdminShell";
import AdminPageFrame from "../_components/AdminPageFrame";
import { adminApi } from "../_components/adminApi";
import { useAdminDomain } from "../_components/useAdminDomain";
import EssayLibraryBulkImport from "./EssayLibraryBulkImport";

type Paper = {
  id: number;
  bank_code: string;
  name: string;
  exam_type: string;
  province: string;
  exam_year: number;
  paper_type: string;
  source_url: string;
  resource_url: string;
  library_access_level: "free" | "member";
  library_status: string;
};

type Material = {
  id: number;
  bank_id: number;
  label: string;
  title: string;
  content: string;
  sort_order: number;
  status: string;
};

type LibraryQuestion = {
  id: number;
  bank_id: number;
  question_code: string;
  question_number: string;
  prompt: string;
  score: number | null;
  word_limit: number | null;
  sub_type: string;
  sort_order: number;
  truth_verified: number;
  review_status: string;
  version: number;
};

type Source = {
  id: number;
  source_key: string;
  name: string;
  homepage_url: string;
  status: string;
  sort_order: number;
};

type ReferenceAnswer = {
  id: number;
  question_id: number;
  source_id: number;
  source_title: string;
  display_mode: string;
  content: string;
  excerpt: string;
  source_url: string;
  copyright_status: string;
  publication_status: string;
  sort_order: number;
  original_published_at?: string;
};

type QuestionMaterial = { question_id: number; material_id: number; sort_order: number };

type EssayLibraryAdminData = {
  contactEmail: string;
  papers: Paper[];
  materials: Material[];
  questions: LibraryQuestion[];
  questionMaterials: QuestionMaterial[];
  sources: Source[];
  answers: ReferenceAnswer[];
};

type PaperReadiness = {
  materialCount: number;
  questionCount: number;
  answerCount: number;
  verifiedQuestionCount: number;
  readyAnswerQuestionCount: number;
  percent: number;
  blockers: string[];
};

const initialData: EssayLibraryAdminData = {
  contactEmail: "",
  papers: [],
  materials: [],
  questions: [],
  questionMaterials: [],
  sources: [],
  answers: [],
};

const paperStatusLabel: Record<string, string> = { draft: "草稿", published: "已发布", archived: "已归档" };
const copyrightLabel: Record<string, string> = {
  original: "平台原创",
  authorized: "已获授权",
  fair_quote: "适当引用",
  link_only: "仅链接",
  pending_verification: "待核验",
};

function statusTag(status: string) {
  const color = status === "published" || status === "active" ? "green" : status === "archived" || status === "disabled" ? "default" : "gold";
  return <Tag color={color}>{paperStatusLabel[status] ?? (status === "active" ? "启用" : status === "disabled" ? "停用" : status)}</Tag>;
}

function isHttpsUrl(value: string) {
  if (!value.trim()) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function answerIsPubliclyReady(answer: ReferenceAnswer, source: Source | undefined) {
  if (answer.publication_status !== "published" || source?.status !== "active") return false;
  if (answer.copyright_status === "pending_verification") return false;
  if (answer.source_url && !isHttpsUrl(answer.source_url)) return false;
  if (answer.display_mode === "full") {
    return ["original", "authorized"].includes(answer.copyright_status) && Boolean(answer.content.trim());
  }
  if (answer.display_mode === "excerpt") {
    if (!["original", "authorized", "fair_quote"].includes(answer.copyright_status) || !answer.excerpt.trim()) return false;
    if (answer.copyright_status === "fair_quote") return answer.excerpt.trim().length <= 1200 && isHttpsUrl(answer.source_url);
    return true;
  }
  if (answer.display_mode === "link_only") {
    return ["link_only", "original", "authorized"].includes(answer.copyright_status) && isHttpsUrl(answer.source_url);
  }
  return false;
}

function paperReadiness(paper: Paper, data: EssayLibraryAdminData): PaperReadiness {
  const materials = data.materials.filter((item) => item.bank_id === paper.id && item.status !== "disabled");
  const questions = data.questions.filter((item) => item.bank_id === paper.id);
  const questionIds = new Set(questions.map((item) => item.id));
  const answers = data.answers.filter((item) => questionIds.has(item.question_id));
  const sourceById = new Map(data.sources.map((item) => [item.id, item]));
  const readyAnswerQuestionIds = new Set(answers
    .filter((item) => answerIsPubliclyReady(item, sourceById.get(item.source_id)))
    .map((item) => item.question_id));
  const verifiedQuestionCount = questions.filter((item) => item.review_status === "approved" && Number(item.truth_verified) === 1).length;
  const blockers: string[] = [];
  if (!materials.length) blockers.push("至少添加一则材料");
  if (!questions.length) blockers.push("至少添加一道题目");
  if (questions.length && verifiedQuestionCount !== questions.length) blockers.push(`${questions.length - verifiedQuestionCount}道题尚未完成真题审核`);
  if (questions.length && readyAnswerQuestionIds.size !== questions.length) blockers.push(`${questions.length - readyAnswerQuestionIds.size}道题缺少已发布且可公开的参考答案`);
  if (!isHttpsUrl(paper.source_url || "")) blockers.push("补充可追溯的HTTPS试卷来源链接");
  if (!data.contactEmail.trim()) blockers.push("配置版权联系邮箱");
  const checks = [
    true,
    materials.length > 0,
    questions.length > 0,
    questions.length > 0 && verifiedQuestionCount === questions.length,
    questions.length > 0 && readyAnswerQuestionIds.size === questions.length,
    isHttpsUrl(paper.source_url || ""),
    Boolean(data.contactEmail.trim()),
  ];
  return {
    materialCount: materials.length,
    questionCount: questions.length,
    answerCount: answers.length,
    verifiedQuestionCount,
    readyAnswerQuestionCount: readyAnswerQuestionIds.size,
    percent: Math.round((checks.filter(Boolean).length / checks.length) * 100),
    blockers,
  };
}

function paperScope(paper: Paper) {
  return `${paper.exam_type} · ${paper.province || "全国"} · ${paper.exam_year}${paper.paper_type ? ` · ${paper.paper_type}` : ""}`;
}

export default function EssayLibraryAdminPage() {
  const { message } = App.useApp();
  const { can } = useAdminSession();
  const canWrite = can("content.write");
  const canPublish = can("content.publish");
  const canReview = can("question.review");
  const { data, loading, error, reload } = useAdminDomain<EssayLibraryAdminData>(
    "adminGetEssayReferenceLibrary",
    initialData,
  );
  const [activeTab, setActiveTab] = useState("papers");
  const [selectedPaperId, setSelectedPaperId] = useState<number | null>(null);
  const [answerQuestionId, setAnswerQuestionId] = useState<number | null>(null);
  const [paperDrawerOpen, setPaperDrawerOpen] = useState(false);
  const [answerDrawerOpen, setAnswerDrawerOpen] = useState(false);
  const [saving, setSaving] = useState("");
  const workspaceRef = useRef<HTMLDivElement>(null);
  const [paperForm] = Form.useForm();
  const [materialForm] = Form.useForm();
  const [questionForm] = Form.useForm();
  const [sourceForm] = Form.useForm();
  const [answerForm] = Form.useForm();
  const [settingsForm] = Form.useForm();

  useEffect(() => {
    settingsForm.setFieldsValue({ contactEmail: data.contactEmail });
  }, [data.contactEmail, settingsForm]);

  useEffect(() => {
    if (selectedPaperId && data.papers.length && !data.papers.some((item) => item.id === selectedPaperId)) {
      setSelectedPaperId(null);
    }
  }, [data.papers, selectedPaperId]);

  const selectedPaper = data.papers.find((item) => item.id === selectedPaperId) ?? null;
  const paperMaterials = data.materials.filter((item) => item.bank_id === selectedPaperId && item.status !== "disabled");
  const paperQuestions = data.questions.filter((item) => item.bank_id === selectedPaperId);
  const paperQuestionIds = useMemo(() => new Set(paperQuestions.map((item) => item.id)), [paperQuestions]);
  const paperAnswers = data.answers.filter((item) => paperQuestionIds.has(item.question_id));
  const answerQuestion = data.questions.find((item) => item.id === answerQuestionId) ?? null;
  const sourceById = useMemo(() => new Map(data.sources.map((item) => [item.id, item])), [data.sources]);
  const readinessByPaper = useMemo(() => new Map(data.papers.map((paper) => [paper.id, paperReadiness(paper, data)])), [data]);
  const selectedReadiness = selectedPaper ? readinessByPaper.get(selectedPaper.id) ?? null : null;

  async function run<T extends Record<string, unknown> = Record<string, unknown>>(
    action: string,
    values: Record<string, unknown>,
    success: string,
  ): Promise<T | null> {
    setSaving(action);
    try {
      const response = await adminApi<T>({ action, ...values });
      message.success(success);
      await reload();
      return response;
    } catch (reason) {
      message.error(reason instanceof Error ? reason.message : "操作失败");
      return null;
    } finally {
      setSaving("");
    }
  }

  function focusPaper(paperId: number) {
    setSelectedPaperId(paperId);
    setActiveTab("papers");
    window.setTimeout(() => workspaceRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
  }

  function openNewPaper() {
    paperForm.resetFields();
    paperForm.setFieldsValue({ accessLevel: "free" });
    setPaperDrawerOpen(true);
  }

  function openPaperEditor(row: Paper) {
    paperForm.setFieldsValue({
      id: row.id,
      code: row.bank_code,
      title: row.name,
      examType: row.exam_type,
      region: row.province,
      examYear: row.exam_year,
      paperType: row.paper_type,
      sourceUrl: row.source_url,
      resourceUrl: row.resource_url,
      accessLevel: row.library_access_level === "member" ? "member" : "free",
    });
    setPaperDrawerOpen(true);
  }

  function editMaterial(row: Material) {
    materialForm.setFieldsValue({
      id: row.id,
      label: row.label,
      title: row.title,
      content: row.content,
      sortOrder: row.sort_order,
    });
  }

  function editQuestion(row: LibraryQuestion) {
    questionForm.setFieldsValue({
      id: row.id,
      code: row.question_code,
      number: row.question_number,
      prompt: row.prompt,
      score: row.score,
      wordLimit: row.word_limit,
      questionType: row.sub_type,
      sortOrder: row.sort_order,
      materialIds: data.questionMaterials.filter((item) => item.question_id === row.id).map((item) => item.material_id),
    });
  }

  function editSource(row: Source) {
    sourceForm.setFieldsValue({
      id: row.id,
      sourceKey: row.source_key,
      name: row.name,
      homepageUrl: row.homepage_url,
      sortOrder: row.sort_order,
      status: row.status,
    });
  }

  function openAnswerEditor(questionId: number, row?: ReferenceAnswer) {
    const question = data.questions.find((item) => item.id === questionId);
    if (question) setSelectedPaperId(question.bank_id);
    setAnswerQuestionId(questionId);
    answerForm.resetFields();
    answerForm.setFieldsValue(row ? {
      id: row.id,
      questionId: row.question_id,
      sourceId: row.source_id,
      sourceTitle: row.source_title,
      displayMode: row.display_mode,
      content: row.content,
      excerpt: row.excerpt,
      sourceUrl: row.source_url,
      copyrightStatus: row.copyright_status,
      publicationStatus: canPublish ? row.publication_status : "draft",
      sortOrder: row.sort_order,
      originalPublishedAt: row.original_published_at,
    } : {
      questionId,
      sourceId: data.sources.filter((item) => item.status === "active").length === 1
        ? data.sources.find((item) => item.status === "active")?.id
        : undefined,
      displayMode: "link_only",
      copyrightStatus: "pending_verification",
      publicationStatus: "draft",
      sortOrder: data.answers.filter((item) => item.question_id === questionId).length,
    });
    setAnswerDrawerOpen(true);
  }

  function goToSources() {
    setAnswerDrawerOpen(false);
    setActiveTab("sources");
  }

  function goToBulkImport() {
    setActiveTab("bulk-import");
  }

  async function publishPaper(paper: Paper) {
    const readiness = readinessByPaper.get(paper.id);
    if (!readiness || readiness.blockers.length) {
      message.error(`暂不能发布：${readiness?.blockers[0] ?? "试卷数据未完成检查"}`);
      focusPaper(paper.id);
      return;
    }
    await run("adminSetEssayPaperStatus", { id: paper.id, status: "published" }, "试卷已发布");
  }

  function renderQuestionAnswers(question: LibraryQuestion) {
    const answers = data.answers.filter((item) => item.question_id === question.id);
    return (
      <Card
        size="small"
        title={`${question.question_number}的参考答案`}
        extra={<Button disabled={!canWrite} size="small" type="primary" icon={<PlusOutlined />} onClick={() => openAnswerEditor(question.id)}>添加参考答案</Button>}
        style={{ background: "#fafcff" }}
      >
        {!answers.length ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未添加参考答案；可为同一道题添加多个来源" />
        ) : (
          <Space direction="vertical" size={8} style={{ width: "100%" }}>
            {answers.map((answer) => {
              const source = sourceById.get(answer.source_id);
              const ready = answerIsPubliclyReady(answer, source);
              return (
                <Card key={answer.id} size="small">
                  <Row gutter={[12, 8]} align="middle">
                    <Col flex="auto">
                      <Space wrap>
                        <Typography.Text strong>{source?.name ?? `来源#${answer.source_id}`}</Typography.Text>
                        {statusTag(answer.publication_status)}
                        <Tag color={answer.copyright_status === "pending_verification" ? "gold" : "blue"}>{copyrightLabel[answer.copyright_status] ?? answer.copyright_status}</Tag>
                        {ready ? <Tag color="green" icon={<CheckCircleOutlined />}>可用于发布</Tag> : <Tag color="orange">尚未满足发布条件</Tag>}
                      </Space>
                      <Typography.Paragraph type="secondary" ellipsis={{ rows: 2 }} style={{ margin: "8px 0 0" }}>
                        {answer.source_title || answer.excerpt || answer.content || answer.source_url || "尚未填写展示内容"}
                      </Typography.Paragraph>
                    </Col>
                    <Col>
                      <Space wrap>
                        <Button size="small" onClick={() => openAnswerEditor(question.id, answer)}>编辑</Button>
                        {canPublish && answer.publication_status !== "published" && (
                          <Button size="small" type="primary" onClick={() => void run("adminSetEssayReferenceAnswerStatus", { id: answer.id, status: "published" }, "答案已发布")}>发布</Button>
                        )}
                        {canPublish && answer.publication_status === "published" && (
                          <Button size="small" onClick={() => void run("adminSetEssayReferenceAnswerStatus", { id: answer.id, status: "draft" }, "答案已撤回")}>撤回</Button>
                        )}
                      </Space>
                    </Col>
                  </Row>
                </Card>
              );
            })}
          </Space>
        )}
      </Card>
    );
  }

  const paperWorkspace = selectedPaper && selectedReadiness ? (
    <div ref={workspaceRef}>
      <Card
        title={<Space wrap><span>当前试卷：{selectedPaper.name}</span>{statusTag(selectedPaper.library_status)}</Space>}
        extra={<Space wrap><Button onClick={() => openPaperEditor(selectedPaper)}>修改基本信息</Button><Button icon={<UploadOutlined />} onClick={goToBulkImport}>批量导入内容</Button></Space>}
      >
        <Typography.Text type="secondary">{paperScope(selectedPaper)} · 编码 {selectedPaper.bank_code}</Typography.Text>
        <Row gutter={[20, 14]} align="middle" style={{ marginTop: 18 }}>
          <Col xs={24} md={8}>
            <Typography.Text strong>发布完整度 {selectedReadiness.percent}%</Typography.Text>
            <Progress percent={selectedReadiness.percent} size="small" status={selectedReadiness.blockers.length ? "active" : "success"} />
          </Col>
          <Col xs={24} md={16}>
            <Space wrap>
              <Tag>材料 {selectedReadiness.materialCount}</Tag>
              <Tag>题目 {selectedReadiness.questionCount}</Tag>
              <Tag>参考答案 {selectedReadiness.answerCount}</Tag>
              <Tag color={selectedReadiness.verifiedQuestionCount === selectedReadiness.questionCount && selectedReadiness.questionCount ? "green" : "gold"}>已核验题目 {selectedReadiness.verifiedQuestionCount}/{selectedReadiness.questionCount}</Tag>
              <Tag color={selectedReadiness.readyAnswerQuestionCount === selectedReadiness.questionCount && selectedReadiness.questionCount ? "green" : "gold"}>答案覆盖 {selectedReadiness.readyAnswerQuestionCount}/{selectedReadiness.questionCount}</Tag>
            </Space>
          </Col>
        </Row>
      </Card>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} xl={10}>
          <Card title="1. 材料" extra={<Button disabled={!canWrite} size="small" onClick={() => materialForm.resetFields()}>新增材料</Button>}>
            <Form
              form={materialForm}
              layout="vertical"
              disabled={!canWrite}
              onFinish={async (values) => {
                const response = await run("adminUpsertEssayMaterial", { ...values, paperId: selectedPaper.id }, "材料已保存");
                if (response) materialForm.resetFields();
              }}
            >
              <Form.Item name="id" hidden><Input /></Form.Item>
              <Row gutter={10}>
                <Col span={8}><Form.Item name="label" label="材料编号" rules={[{ required: true }]}><Input placeholder="材料1" /></Form.Item></Col>
                <Col span={12}><Form.Item name="title" label="标题"><Input /></Form.Item></Col>
                <Col span={4}><Form.Item name="sortOrder" label="排序" initialValue={0}><InputNumber style={{ width: "100%" }} /></Form.Item></Col>
              </Row>
              <Form.Item name="content" label="材料正文" rules={[{ required: true }]}><Input.TextArea rows={8} /></Form.Item>
              <Button type="primary" htmlType="submit" loading={saving === "adminUpsertEssayMaterial"}>保存材料</Button>
            </Form>
            <Divider />
            <Table
              rowKey="id"
              size="small"
              pagination={false}
              dataSource={paperMaterials}
              locale={{ emptyText: "尚未添加材料" }}
              columns={[
                { title: "编号", dataIndex: "label", width: 90 },
                { title: "标题", dataIndex: "title", ellipsis: true },
                { title: "操作", width: 130, render: (_, row: Material) => <Space><Button size="small" onClick={() => editMaterial(row)}>编辑</Button><Popconfirm title="确认停用这则材料？" onConfirm={() => void run("adminDeleteEssayMaterial", { id: row.id }, "材料已停用")}><Button danger size="small" disabled={!canWrite}>停用</Button></Popconfirm></Space> },
              ]}
            />
          </Card>
        </Col>
        <Col xs={24} xl={14}>
          <Card title="2. 题目与参考答案" extra={<Button disabled={!canWrite} size="small" onClick={() => questionForm.resetFields()}>新增题目</Button>}>
            <Alert showIcon type="info" message="保存题目后，可在题目下直接维护多个来源的参考答案" style={{ marginBottom: 14 }} />
            <Form
              form={questionForm}
              layout="vertical"
              disabled={!canWrite}
              onFinish={async (values) => {
                const response = await run("adminUpsertEssayLibraryQuestion", { ...values, paperId: selectedPaper.id }, "题目已保存");
                if (response) questionForm.resetFields();
              }}
            >
              <Form.Item name="id" hidden><Input /></Form.Item>
              <Row gutter={10}>
                <Col xs={12} md={6}><Form.Item name="number" label="题号" rules={[{ required: true }]}><Input placeholder="问题1" /></Form.Item></Col>
                <Col xs={12} md={5}><Form.Item name="score" label="分值"><InputNumber min={0} max={200} style={{ width: "100%" }} /></Form.Item></Col>
                <Col xs={12} md={5}><Form.Item name="wordLimit" label="字数限制"><InputNumber min={1} style={{ width: "100%" }} /></Form.Item></Col>
                <Col xs={12} md={8}><Form.Item name="questionType" label="题型"><Input placeholder="归纳概括" /></Form.Item></Col>
                <Col xs={18} md={18}><Form.Item name="code" label="题目编码"><Input placeholder="留空可自动生成" /></Form.Item></Col>
                <Col xs={6} md={6}><Form.Item name="sortOrder" label="排序" initialValue={0}><InputNumber style={{ width: "100%" }} /></Form.Item></Col>
              </Row>
              <Form.Item name="materialIds" label="关联材料"><Select mode="multiple" options={paperMaterials.map((item) => ({ value: item.id, label: `${item.label} ${item.title}` }))} /></Form.Item>
              <Form.Item name="prompt" label="题干" rules={[{ required: true }]}><Input.TextArea rows={5} /></Form.Item>
              <Button type="primary" htmlType="submit" loading={saving === "adminUpsertEssayLibraryQuestion"}>保存题目</Button>
            </Form>
            <Divider />
            <Table
              rowKey="id"
              size="small"
              pagination={false}
              dataSource={paperQuestions}
              locale={{ emptyText: "尚未添加题目" }}
              expandable={{
                expandedRowRender: renderQuestionAnswers,
                rowExpandable: () => true,
              }}
              columns={[
                { title: "题号", dataIndex: "question_number", width: 80 },
                { title: "题干", dataIndex: "prompt", ellipsis: true },
                { title: "答案", width: 70, render: (_, row: LibraryQuestion) => data.answers.filter((item) => item.question_id === row.id).length },
                { title: "审核", width: 100, render: (_, row: LibraryQuestion) => row.review_status === "approved" && Number(row.truth_verified) === 1
                  ? <Tag color="green">已核验</Tag>
                  : row.review_status === "rejected" ? <Tag color="red">已驳回</Tag> : <Tag color="gold">待核验</Tag> },
                {
                  title: "操作",
                  width: 230,
                  render: (_, row: LibraryQuestion) => <Space wrap>
                    <Button size="small" onClick={() => editQuestion(row)}>编辑</Button>
                    <Button size="small" type="primary" disabled={!canWrite} onClick={() => openAnswerEditor(row.id)}>添加答案</Button>
                    {canReview && row.review_status === "pending_review" && (
                      <>
                        <Button size="small" onClick={() => void run("adminReviewEssayLibraryQuestion", {
                          id: row.id,
                          expectedVersion: row.version,
                          decision: "approve",
                        }, "真题审核已通过")}>审核通过</Button>
                        <Popconfirm
                          title="确认驳回这道题？"
                          description="驳回后需修正题干或来源信息，再重新提交审核。"
                          onConfirm={() => void run("adminReviewEssayLibraryQuestion", {
                            id: row.id,
                            expectedVersion: row.version,
                            decision: "reject",
                            reviewNote: "题目真题信息未通过核验，请修正后重新提交",
                          }, "题目已驳回")}
                        >
                          <Button size="small" danger>驳回</Button>
                        </Popconfirm>
                      </>
                    )}
                  </Space>,
                },
              ]}
            />
          </Card>
        </Col>
      </Row>

      <Card title="3. 发布检查" style={{ marginTop: 16 }}>
        {selectedReadiness.blockers.length ? (
          <Alert
            showIcon
            type="warning"
            message={`还有${selectedReadiness.blockers.length}项未完成`}
            description={<Space direction="vertical" size={4}>{selectedReadiness.blockers.map((item) => <Typography.Text key={item}>· {item}</Typography.Text>)}</Space>}
          />
        ) : (
          <Alert showIcon type="success" message="发布检查已通过" description="材料、题目、真题审核、参考答案和版权设置均已完成。" />
        )}
        <Space style={{ marginTop: 16 }}>
          {canPublish && selectedPaper.library_status !== "published" && (
            <Button type="primary" disabled={selectedReadiness.blockers.length > 0} onClick={() => void publishPaper(selectedPaper)}>发布整套试卷</Button>
          )}
          {canPublish && selectedPaper.library_status === "published" && (
            <Button onClick={() => void run("adminSetEssayPaperStatus", { id: selectedPaper.id, status: "draft" }, "试卷已转为草稿")}>撤回为草稿</Button>
          )}
        </Space>
      </Card>
    </div>
  ) : (
    <Card ref={workspaceRef}>
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={data.papers.length ? "选择一套试卷后，在这里连续录入材料、题目和参考答案" : "资料库中还没有试卷"}
      >
        <Space wrap>
          <Button type="primary" disabled={!canWrite} icon={<FileAddOutlined />} onClick={openNewPaper}>新建第一套试卷</Button>
          <Button icon={<UploadOutlined />} onClick={goToBulkImport}>批量导入整套试卷</Button>
        </Space>
      </Empty>
    </Card>
  );

  return (
    <AdminPageFrame
      eyebrow="内容运营"
      title="申论真题资料库"
      description="以整套试卷为单位，连续完成材料、题目、多来源参考答案、审核与发布。"
      loading={loading}
      error={error}
      onReload={() => void reload()}
    >
      {!canWrite && <Alert showIcon type="info" message="当前为只读模式" description="你可以查看资料库配置，但不能修改或发布内容。" style={{ marginBottom: 16 }} />}
      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        items={[
          {
            key: "papers",
            label: "试卷工作台",
            children: (
              <Space direction="vertical" size={18} style={{ width: "100%" }}>
                <Alert
                  showIcon
                  type="info"
                  message="先选择试卷，再连续录入材料、题目和参考答案"
                  description="资料较多时，可直接使用Excel模板一次导入整套试卷。PDF或资料链接只用于保存来源，不会自动拆分题干和答案。"
                  action={<Button icon={<UploadOutlined />} onClick={goToBulkImport}>批量导入整套试卷</Button>}
                />
                <Card
                  title="试卷列表"
                  extra={<Space><Button icon={<UploadOutlined />} onClick={goToBulkImport}>批量导入</Button><Button type="primary" disabled={!canWrite} icon={<PlusOutlined />} onClick={openNewPaper}>新建试卷</Button></Space>}
                >
                  <Table
                    rowKey="id"
                    size="small"
                    pagination={{ pageSize: 8 }}
                    dataSource={data.papers}
                    locale={{ emptyText: "暂无试卷，可新建或批量导入" }}
                    columns={[
                      { title: "试卷", render: (_, row: Paper) => <><Typography.Text strong>{row.name}</Typography.Text><br /><Typography.Text type="secondary">{paperScope(row)}</Typography.Text></> },
                      { title: "内容", width: 190, render: (_, row: Paper) => {
                        const readiness = readinessByPaper.get(row.id);
                        return <Space wrap size={[4, 4]}><Tag>材料 {readiness?.materialCount ?? 0}</Tag><Tag>题目 {readiness?.questionCount ?? 0}</Tag><Tag>答案 {readiness?.answerCount ?? 0}</Tag></Space>;
                      } },
                      { title: "完整度", width: 160, render: (_, row: Paper) => {
                        const readiness = readinessByPaper.get(row.id);
                        return <Progress percent={readiness?.percent ?? 0} size="small" status={readiness?.blockers.length ? "active" : "success"} />;
                      } },
                      { title: "权益", width: 90, dataIndex: "library_access_level", render: (value: string) => value === "member" ? <Tag color="gold">会员</Tag> : <Tag color="green">免费</Tag> },
                      { title: "状态", width: 90, dataIndex: "library_status", render: statusTag },
                      {
                        title: "操作",
                        width: 280,
                        render: (_, row: Paper) => {
                          const readiness = readinessByPaper.get(row.id);
                          return <Space wrap>
                            <Button type="primary" size="small" icon={<EditOutlined />} onClick={() => focusPaper(row.id)}>继续录入</Button>
                            <Button size="small" onClick={() => openPaperEditor(row)}>基本信息</Button>
                            {canPublish && row.library_status !== "published" && (
                              <Tooltip title={readiness?.blockers.length ? readiness.blockers[0] : "发布整套试卷"}>
                                <Button size="small" disabled={Boolean(readiness?.blockers.length)} onClick={() => void publishPaper(row)}>发布</Button>
                              </Tooltip>
                            )}
                            {canPublish && row.library_status === "published" && <Button size="small" onClick={() => void run("adminSetEssayPaperStatus", { id: row.id, status: "draft" }, "试卷已转为草稿")}>撤回</Button>}
                          </Space>;
                        },
                      },
                    ]}
                  />
                </Card>
                {paperWorkspace}
              </Space>
            ),
          },
          {
            key: "sources",
            label: "答案来源管理",
            children: (
              <Space direction="vertical" size={18} style={{ width: "100%" }}>
                <Alert showIcon type="info" message="答案正文已移到试卷工作台" description="在试卷工作台展开题目，即可直接添加或编辑该题的多来源参考答案；这里仅维护全局来源并集中查看答案。" />
                <Card title="全局答案来源" extra={<Button disabled={!canWrite} icon={<PlusOutlined />} onClick={() => sourceForm.resetFields()}>新增来源</Button>}>
                  <Form
                    form={sourceForm}
                    layout="vertical"
                    disabled={!canWrite}
                    onFinish={async (values) => {
                      const response = await run("adminUpsertEssayAnswerSource", values, "来源已保存");
                      if (response) sourceForm.resetFields();
                    }}
                  >
                    <Form.Item name="id" hidden><Input /></Form.Item>
                    <Row gutter={10}>
                      <Col xs={24} md={5}><Form.Item name="sourceKey" label="来源标识" rules={[{ required: true }]}><Input placeholder="fenbi" /></Form.Item></Col>
                      <Col xs={24} md={5}><Form.Item name="name" label="显示名称" rules={[{ required: true }]}><Input placeholder="粉笔" /></Form.Item></Col>
                      <Col xs={24} md={8}><Form.Item name="homepageUrl" label="官方主页"><Input placeholder="https://" /></Form.Item></Col>
                      <Col xs={12} md={3}><Form.Item name="sortOrder" label="排序" initialValue={0}><InputNumber style={{ width: "100%" }} /></Form.Item></Col>
                      <Col xs={12} md={3}><Form.Item name="status" label="状态" initialValue="active"><Select options={[{ value: "active", label: "启用" }, { value: "disabled", label: "停用" }]} /></Form.Item></Col>
                    </Row>
                    <Button type="primary" htmlType="submit" loading={saving === "adminUpsertEssayAnswerSource"}>保存来源</Button>
                  </Form>
                  <Divider />
                  <Table
                    rowKey="id"
                    size="small"
                    pagination={false}
                    dataSource={data.sources}
                    locale={{ emptyText: "尚未配置答案来源" }}
                    columns={[
                      { title: "来源", render: (_, row: Source) => <><strong>{row.name}</strong><br /><Typography.Text type="secondary">{row.source_key}</Typography.Text></> },
                      { title: "主页", dataIndex: "homepage_url", ellipsis: true },
                      { title: "状态", dataIndex: "status", render: statusTag },
                      { title: "排序", dataIndex: "sort_order" },
                      { title: "操作", render: (_, row: Source) => <Space><Button size="small" onClick={() => editSource(row)}>编辑</Button><Button size="small" disabled={!canWrite} onClick={() => void run("adminSetEssayAnswerSourceStatus", { id: row.id, status: row.status === "active" ? "disabled" : "active" }, row.status === "active" ? "来源已停用" : "来源已启用")}>{row.status === "active" ? "停用" : "启用"}</Button></Space> },
                    ]}
                  />
                </Card>

                <Card title="按试卷查看参考答案">
                  <Form.Item label="当前试卷" style={{ maxWidth: 520 }}>
                    <Select
                      value={selectedPaperId}
                      onChange={setSelectedPaperId}
                      placeholder="请选择试卷"
                      options={data.papers.map((item) => ({ value: item.id, label: item.name }))}
                    />
                  </Form.Item>
                  {!selectedPaper ? <Alert showIcon type="info" message="请先选择试卷" /> : (
                    <Table
                      rowKey="id"
                      size="small"
                      pagination={{ pageSize: 10 }}
                      dataSource={paperAnswers}
                      locale={{ emptyText: "该试卷尚无参考答案" }}
                      columns={[
                        { title: "题目", render: (_, row: ReferenceAnswer) => paperQuestions.find((item) => item.id === row.question_id)?.question_number ?? row.question_id },
                        { title: "来源", render: (_, row: ReferenceAnswer) => data.sources.find((item) => item.id === row.source_id)?.name ?? row.source_id },
                        { title: "展示", dataIndex: "display_mode", render: (value) => value === "full" ? "全文" : value === "excerpt" ? "节选" : "仅链接" },
                        { title: "版权", dataIndex: "copyright_status", render: (value) => <Tag color={value === "pending_verification" ? "gold" : "blue"}>{copyrightLabel[value] ?? value}</Tag> },
                        { title: "状态", dataIndex: "publication_status", render: statusTag },
                        { title: "操作", render: (_, row: ReferenceAnswer) => <Space><Button size="small" onClick={() => openAnswerEditor(row.question_id, row)}>编辑</Button>{canPublish && row.publication_status !== "published" && <Button size="small" type="primary" onClick={() => void run("adminSetEssayReferenceAnswerStatus", { id: row.id, status: "published" }, "答案已发布")}>发布</Button>}{canPublish && row.publication_status === "published" && <Button size="small" onClick={() => void run("adminSetEssayReferenceAnswerStatus", { id: row.id, status: "draft" }, "答案已撤回")}>撤回</Button>}</Space> },
                      ]}
                    />
                  )}
                </Card>
              </Space>
            ),
          },
          {
            key: "bulk-import",
            label: "批量导入整套试卷",
            children: <EssayLibraryBulkImport canWrite={canWrite} data={data} onImported={reload} />,
          },
          {
            key: "settings",
            label: "版权设置",
            children: (
              <Card title="版权与内容来源说明">
                <Typography.Paragraph type="secondary">用户端入口固定为“我的 → 关于公考日练 → 版权与内容来源说明”。此处只配置真实、长期可用的版权联系邮箱；未配置时用户端显示“暂未配置”。</Typography.Paragraph>
                <Form
                  form={settingsForm}
                  layout="vertical"
                  disabled={!canPublish}
                  onFinish={(values) => void run("adminUpdateEssayLibrarySettings", values, "版权联系邮箱已更新")}
                  style={{ maxWidth: 520 }}
                >
                  <Form.Item name="contactEmail" label="版权联系邮箱" rules={[{ type: "email", message: "请输入有效邮箱" }]}><Input placeholder="未配置时留空" /></Form.Item>
                  <Button type="primary" htmlType="submit" icon={<SaveOutlined />} loading={saving === "adminUpdateEssayLibrarySettings"}>保存设置</Button>
                </Form>
              </Card>
            ),
          },
        ]}
      />

      <Drawer
        title={paperForm.getFieldValue("id") ? "编辑试卷基本信息" : "新建试卷"}
        width={720}
        open={paperDrawerOpen}
        onClose={() => setPaperDrawerOpen(false)}
        destroyOnHidden
      >
        <Alert showIcon type="info" message="保存后将自动进入内容录入" description="每套资料可独立设置免费或会员；目录对所有用户可见，会员资料正文仅向有效会员开放。" style={{ marginBottom: 18 }} />
        <Form
          form={paperForm}
          layout="vertical"
          disabled={!canWrite}
          onFinish={async (values) => {
            const response = await run<{ id: number }>("adminUpsertEssayPaper", values, "试卷已保存，开始录入内容");
            const savedPaperId = Number(response?.id);
            if (savedPaperId > 0) {
              paperForm.resetFields();
              setPaperDrawerOpen(false);
              focusPaper(savedPaperId);
            }
          }}
        >
          <Form.Item name="id" hidden><Input /></Form.Item>
          <Row gutter={12}>
            <Col xs={24} md={12}><Form.Item name="title" label="试卷名称" rules={[{ required: true }]}><Input placeholder="2026国考申论（副省级卷）" /></Form.Item></Col>
            <Col xs={24} md={12}><Form.Item name="code" label="试卷编码（唯一）" rules={[{ required: true }]}><Input placeholder="例如 guokao-2026-fusheng" /></Form.Item></Col>
            <Col xs={12} md={6}><Form.Item name="examType" label="考试类型" rules={[{ required: true }]}><Input placeholder="国考" /></Form.Item></Col>
            <Col xs={12} md={6}><Form.Item name="examYear" label="年份" rules={[{ required: true }]}><InputNumber min={2000} max={2200} style={{ width: "100%" }} /></Form.Item></Col>
            <Col xs={12} md={6}><Form.Item name="region" label="地区"><Input placeholder="全国/广东" /></Form.Item></Col>
            <Col xs={12} md={6}><Form.Item name="paperType" label="卷种"><Input placeholder="副省级卷" /></Form.Item></Col>
            <Col xs={24} md={12}><Form.Item name="accessLevel" label="查看权益" initialValue="free" rules={[{ required: true }]}><Select options={[{ value: "free", label: "免费开放" }, { value: "member", label: "会员专享" }]} /></Form.Item></Col>
            <Col xs={24}><Form.Item name="sourceUrl" label="试卷来源链接" extra="真题审核和发布需要可追溯的HTTPS来源"><Input placeholder="https://" /></Form.Item></Col>
            <Col xs={24}><Form.Item name="resourceUrl" label="PDF或资料链接" extra="这里只保存来源文件链接，不会自动识别题干和答案"><Input placeholder="公开可访问的 https:// 链接" /></Form.Item></Col>
          </Row>
          <Button type="primary" htmlType="submit" icon={<SaveOutlined />} loading={saving === "adminUpsertEssayPaper"}>保存并继续录入</Button>
        </Form>
      </Drawer>

      <Drawer
        title={answerForm.getFieldValue("id") ? "编辑参考答案" : "添加参考答案"}
        width={760}
        open={answerDrawerOpen}
        onClose={() => setAnswerDrawerOpen(false)}
        destroyOnHidden
      >
        {answerQuestion && (
          <Alert
            showIcon
            type="info"
            message={`${answerQuestion.question_number} · ${answerQuestion.prompt.slice(0, 80)}`}
            description="同一道题可以分别添加粉笔、华图等多个来源的参考答案。"
            style={{ marginBottom: 18 }}
          />
        )}
        {!data.sources.some((item) => item.status === "active") && (
          <Alert
            showIcon
            type="warning"
            message="请先配置一个启用的答案来源"
            action={<Button onClick={goToSources}>去配置来源</Button>}
            style={{ marginBottom: 18 }}
          />
        )}
        <Form
          form={answerForm}
          layout="vertical"
          disabled={!canWrite || !data.sources.some((item) => item.status === "active")}
          onFinish={async (values) => {
            const response = await run("adminUpsertEssayReferenceAnswer", values, "参考答案已保存");
            if (response) {
              answerForm.resetFields();
              setAnswerDrawerOpen(false);
            }
          }}
        >
          <Form.Item name="id" hidden><Input /></Form.Item>
          <Form.Item name="questionId" hidden><Input /></Form.Item>
          <Row gutter={10}>
            <Col xs={24} md={8}><Form.Item name="sourceId" label="答案来源" rules={[{ required: true }]}><Select options={data.sources.map((item) => ({ value: item.id, label: `${item.name}${item.status === "disabled" ? "（已停用）" : ""}`, disabled: item.status === "disabled" }))} /></Form.Item></Col>
            <Col xs={24} md={8}><Form.Item name="displayMode" label="展示方式" rules={[{ required: true }]}><Select options={[{ value: "full", label: "全文" }, { value: "excerpt", label: "节选" }, { value: "link_only", label: "仅链接" }]} /></Form.Item></Col>
            <Col xs={24} md={8}><Form.Item name="copyrightStatus" label="版权状态" rules={[{ required: true }]}><Select options={Object.entries(copyrightLabel).map(([value, label]) => ({ value, label }))} /></Form.Item></Col>
          </Row>
          <Form.Item name="sourceTitle" label="来源文章标题"><Input /></Form.Item>
          <Form.Item name="sourceUrl" label="原文链接"><Input placeholder="https://" /></Form.Item>
          <Form.Item name="content" label="全文（仅平台原创或已授权可公开）"><Input.TextArea rows={7} /></Form.Item>
          <Form.Item name="excerpt" label="节选（适当引用须提供原文链接）"><Input.TextArea rows={4} /></Form.Item>
          <Row gutter={10}>
            <Col xs={24} md={8}><Form.Item name="publicationStatus" label="发布状态"><Select options={[
              { value: "draft", label: "草稿" },
              ...(canPublish ? [{ value: "published", label: "发布" }] : []),
              { value: "archived", label: "归档" },
            ]} /></Form.Item></Col>
            <Col xs={24} md={8}><Form.Item name="originalPublishedAt" label="原文发布日期"><Input placeholder="YYYY-MM-DD" /></Form.Item></Col>
            <Col xs={24} md={8}><Form.Item name="sortOrder" label="排序"><InputNumber min={0} style={{ width: "100%" }} /></Form.Item></Col>
          </Row>
          <Alert showIcon type="warning" message="发布门禁" description="全文仅允许平台原创或已获授权；适当引用必须填写不超过1200字的节选和HTTPS原文链接；仅链接模式不会向用户返回正文。" style={{ marginBottom: 14 }} />
          <Space>
            <Button type="primary" htmlType="submit" loading={saving === "adminUpsertEssayReferenceAnswer"}>保存答案</Button>
            <Button onClick={goToSources}>管理答案来源</Button>
          </Space>
        </Form>
      </Drawer>
    </AdminPageFrame>
  );
}
