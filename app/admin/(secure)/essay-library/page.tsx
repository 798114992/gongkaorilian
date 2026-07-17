"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Divider,
  Form,
  Input,
  InputNumber,
  Popconfirm,
  Row,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
} from "antd";
import { EditOutlined, PlusOutlined, SaveOutlined } from "@ant-design/icons";
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
  const [selectedPaperId, setSelectedPaperId] = useState<number | null>(null);
  const [saving, setSaving] = useState("");
  const [paperForm] = Form.useForm();
  const [materialForm] = Form.useForm();
  const [questionForm] = Form.useForm();
  const [sourceForm] = Form.useForm();
  const [answerForm] = Form.useForm();
  const [settingsForm] = Form.useForm();

  useEffect(() => {
    settingsForm.setFieldsValue({ contactEmail: data.contactEmail });
  }, [data.contactEmail, settingsForm]);

  const selectedPaper = data.papers.find((item) => item.id === selectedPaperId) ?? null;
  const paperMaterials = data.materials.filter((item) => item.bank_id === selectedPaperId && item.status !== "disabled");
  const paperQuestions = data.questions.filter((item) => item.bank_id === selectedPaperId);
  const paperQuestionIds = useMemo(() => new Set(paperQuestions.map((item) => item.id)), [paperQuestions]);
  const paperAnswers = data.answers.filter((item) => paperQuestionIds.has(item.question_id));

  async function run(action: string, values: Record<string, unknown>, success: string) {
    setSaving(action);
    try {
      await adminApi({ action, ...values });
      message.success(success);
      await reload();
      return true;
    } catch (reason) {
      message.error(reason instanceof Error ? reason.message : "操作失败");
      return false;
    } finally {
      setSaving("");
    }
  }

  function editPaper(row: Paper) {
    setSelectedPaperId(row.id);
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
    });
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

  function editAnswer(row: ReferenceAnswer) {
    answerForm.setFieldsValue({
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
    });
  }

  return (
    <AdminPageFrame
      eyebrow="内容运营"
      title="申论真题资料库"
      description="按试卷、材料、题目和来源维护多版本参考答案。只有通过版权发布门禁的内容才会进入用户端免费资料库。"
      loading={loading}
      error={error}
      onReload={() => void reload()}
    >
      {!canWrite && <Alert showIcon type="info" message="当前为只读模式" description="你可以查看资料库配置，但不能修改或发布内容。" style={{ marginBottom: 16 }} />}
      <Tabs
        items={[
          {
            key: "papers",
            label: "试卷与内容",
            children: (
              <Space direction="vertical" size={18} style={{ width: "100%" }}>
                <Card title="试卷配置" extra={<Button disabled={!canWrite} icon={<PlusOutlined />} onClick={() => paperForm.resetFields()}>新建试卷</Button>}>
                  <Form
                    form={paperForm}
                    layout="vertical"
                    disabled={!canWrite}
                    onFinish={async (values) => {
                      const ok = await run("adminUpsertEssayPaper", values, "试卷已保存");
                      if (ok) paperForm.resetFields();
                    }}
                  >
                    <Form.Item name="id" hidden><Input /></Form.Item>
                    <Row gutter={12}>
                      <Col xs={24} md={8}><Form.Item name="code" label="试卷编码" rules={[{ required: true }]}><Input placeholder="例如 guokao-2026-fusheng" /></Form.Item></Col>
                      <Col xs={24} md={8}><Form.Item name="title" label="试卷名称" rules={[{ required: true }]}><Input placeholder="2026国考申论（副省级卷）" /></Form.Item></Col>
                      <Col xs={12} md={4}><Form.Item name="examType" label="考试类型" rules={[{ required: true }]}><Input placeholder="国考" /></Form.Item></Col>
                      <Col xs={12} md={4}><Form.Item name="examYear" label="年份" rules={[{ required: true }]}><InputNumber min={2000} max={2200} style={{ width: "100%" }} /></Form.Item></Col>
                      <Col xs={12} md={6}><Form.Item name="region" label="地区"><Input placeholder="全国/广东" /></Form.Item></Col>
                      <Col xs={12} md={6}><Form.Item name="paperType" label="卷种"><Input placeholder="副省级卷" /></Form.Item></Col>
                      <Col xs={24} md={6}><Form.Item name="sourceUrl" label="试卷来源链接"><Input placeholder="https://" /></Form.Item></Col>
                      <Col xs={24} md={6}><Form.Item name="resourceUrl" label="PDF或资料链接"><Input placeholder="公开可访问的 https:// 链接" /></Form.Item></Col>
                    </Row>
                    <Button type="primary" htmlType="submit" icon={<SaveOutlined />} loading={saving === "adminUpsertEssayPaper"}>保存试卷</Button>
                  </Form>
                  <Divider />
                  <Table
                    rowKey="id"
                    size="small"
                    pagination={{ pageSize: 8 }}
                    dataSource={data.papers}
                    columns={[
                      { title: "试卷", render: (_, row: Paper) => <><strong>{row.name}</strong><br /><Typography.Text type="secondary">{row.bank_code}</Typography.Text></> },
                      { title: "范围", render: (_, row: Paper) => `${row.exam_type} · ${row.province || "全国"} · ${row.exam_year}` },
                      { title: "状态", dataIndex: "library_status", render: statusTag },
                      {
                        title: "操作",
                        render: (_, row: Paper) => <Space wrap>
                          <Button size="small" icon={<EditOutlined />} onClick={() => editPaper(row)}>编辑内容</Button>
                          {canPublish && row.library_status !== "published" && <Button size="small" type="primary" onClick={() => void run("adminSetEssayPaperStatus", { id: row.id, status: "published" }, "试卷已发布")}>发布</Button>}
                          {canPublish && row.library_status === "published" && <Button size="small" onClick={() => void run("adminSetEssayPaperStatus", { id: row.id, status: "draft" }, "试卷已转为草稿")}>撤回</Button>}
                        </Space>,
                      },
                    ]}
                  />
                </Card>

                {!selectedPaper ? <Alert showIcon type="info" message="请在上方选择一套试卷，再维护材料和题目" /> : <>
                  <Alert showIcon type="success" message={`当前维护：${selectedPaper.name}`} description="材料与题目沿用现有题库数据结构，资料库只保存必要的关联和展示信息。" />
                  <Row gutter={[16, 16]}>
                    <Col xs={24} xl={12}>
                      <Card title="材料" extra={<Button disabled={!canWrite} size="small" onClick={() => materialForm.resetFields()}>新增材料</Button>}>
                        <Form
                          form={materialForm}
                          layout="vertical"
                          disabled={!canWrite}
                          onFinish={async (values) => {
                            const ok = await run("adminUpsertEssayMaterial", { ...values, paperId: selectedPaper.id }, "材料已保存");
                            if (ok) materialForm.resetFields();
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
                          columns={[
                            { title: "编号", dataIndex: "label", width: 90 },
                            { title: "标题", dataIndex: "title", ellipsis: true },
                            { title: "排序", dataIndex: "sort_order", width: 70 },
                            { title: "操作", width: 150, render: (_, row: Material) => <Space><Button size="small" onClick={() => editMaterial(row)}>编辑</Button><Popconfirm title="确认停用这则材料？" onConfirm={() => void run("adminDeleteEssayMaterial", { id: row.id }, "材料已停用")}><Button danger size="small" disabled={!canWrite}>停用</Button></Popconfirm></Space> },
                          ]}
                        />
                      </Card>
                    </Col>
                    <Col xs={24} xl={12}>
                      <Card title="题目" extra={<Button disabled={!canWrite} size="small" onClick={() => questionForm.resetFields()}>新增题目</Button>}>
                        <Form
                          form={questionForm}
                          layout="vertical"
                          disabled={!canWrite}
                          onFinish={async (values) => {
                            const ok = await run("adminUpsertEssayLibraryQuestion", { ...values, paperId: selectedPaper.id }, "题目已保存");
                            if (ok) questionForm.resetFields();
                          }}
                        >
                          <Form.Item name="id" hidden><Input /></Form.Item>
                          <Row gutter={10}>
                            <Col span={8}><Form.Item name="number" label="题号" rules={[{ required: true }]}><Input placeholder="问题1" /></Form.Item></Col>
                            <Col span={8}><Form.Item name="score" label="分值"><InputNumber min={0} max={200} style={{ width: "100%" }} /></Form.Item></Col>
                            <Col span={8}><Form.Item name="wordLimit" label="字数限制"><InputNumber min={1} style={{ width: "100%" }} /></Form.Item></Col>
                            <Col span={12}><Form.Item name="code" label="题目编码"><Input placeholder="留空可自动生成" /></Form.Item></Col>
                            <Col span={8}><Form.Item name="questionType" label="题型"><Input placeholder="归纳概括" /></Form.Item></Col>
                            <Col span={4}><Form.Item name="sortOrder" label="排序" initialValue={0}><InputNumber style={{ width: "100%" }} /></Form.Item></Col>
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
                          columns={[
                            { title: "题号", dataIndex: "question_number", width: 90 },
                            { title: "题干", dataIndex: "prompt", ellipsis: true },
                            { title: "答案数", width: 75, render: (_, row: LibraryQuestion) => data.answers.filter((item) => item.question_id === row.id).length },
                            { title: "审核", width: 95, render: (_, row: LibraryQuestion) => row.review_status === "approved" && Number(row.truth_verified) === 1
                              ? <Tag color="green">真题已核验</Tag>
                              : row.review_status === "rejected" ? <Tag color="red">已驳回</Tag> : <Tag color="gold">待核验</Tag> },
                            {
                              title: "操作",
                              width: 220,
                              render: (_, row: LibraryQuestion) => <Space wrap>
                                <Button size="small" onClick={() => editQuestion(row)}>编辑</Button>
                                {canReview && row.review_status === "pending_review" && <>
                                  <Button size="small" type="primary" onClick={() => void run("adminReviewEssayLibraryQuestion", {
                                    id: row.id, expectedVersion: row.version, decision: "approve",
                                  }, "真题审核已通过")}>审核通过</Button>
                                  <Popconfirm title="确认驳回这道题？" description="驳回后需编辑并重新提交审核。" onConfirm={() => void run("adminReviewEssayLibraryQuestion", {
                                    id: row.id, expectedVersion: row.version, decision: "reject",
                                    reviewNote: "题目真题信息未通过核验，请修正后重新提交",
                                  }, "题目已驳回")}><Button size="small" danger>驳回</Button></Popconfirm>
                                </>}
                              </Space>,
                            },
                          ]}
                        />
                      </Card>
                    </Col>
                  </Row>
                </>}
              </Space>
            ),
          },
          {
            key: "answers",
            label: "来源与参考答案",
            children: (
              <Space direction="vertical" size={18} style={{ width: "100%" }}>
                <Card title="答案来源" extra={<Button disabled={!canWrite} icon={<PlusOutlined />} onClick={() => sourceForm.resetFields()}>新增来源</Button>}>
                  <Form
                    form={sourceForm}
                    layout="vertical"
                    disabled={!canWrite}
                    onFinish={async (values) => {
                      const ok = await run("adminUpsertEssayAnswerSource", values, "来源已保存");
                      if (ok) sourceForm.resetFields();
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
                    columns={[
                      { title: "来源", render: (_, row: Source) => <><strong>{row.name}</strong><br /><Typography.Text type="secondary">{row.source_key}</Typography.Text></> },
                      { title: "主页", dataIndex: "homepage_url", ellipsis: true },
                      { title: "状态", dataIndex: "status", render: statusTag },
                      { title: "排序", dataIndex: "sort_order" },
                      { title: "操作", render: (_, row: Source) => <Space><Button size="small" onClick={() => editSource(row)}>编辑</Button><Button size="small" disabled={!canWrite} onClick={() => void run("adminSetEssayAnswerSourceStatus", { id: row.id, status: row.status === "active" ? "disabled" : "active" }, row.status === "active" ? "来源已停用" : "来源已启用")}>{row.status === "active" ? "停用" : "启用"}</Button></Space> },
                    ]}
                  />
                </Card>

                <Card title="参考答案">
                  <Form.Item label="当前试卷" style={{ maxWidth: 520 }}>
                    <Select
                      value={selectedPaperId}
                      onChange={setSelectedPaperId}
                      placeholder="请选择试卷"
                      options={data.papers.map((item) => ({ value: item.id, label: item.name }))}
                    />
                  </Form.Item>
                  {!selectedPaper ? <Alert showIcon type="info" message="请先选择试卷" /> : <>
                    <Form
                      form={answerForm}
                      layout="vertical"
                      disabled={!canWrite}
                      onFinish={async (values) => {
                        const ok = await run("adminUpsertEssayReferenceAnswer", values, "参考答案已保存");
                        if (ok) answerForm.resetFields();
                      }}
                    >
                      <Form.Item name="id" hidden><Input /></Form.Item>
                      <Row gutter={10}>
                        <Col xs={24} md={6}><Form.Item name="questionId" label="题目" rules={[{ required: true }]}><Select options={paperQuestions.map((item) => ({ value: item.id, label: `${item.question_number} ${item.prompt.slice(0, 24)}` }))} /></Form.Item></Col>
                        <Col xs={24} md={5}><Form.Item name="sourceId" label="来源" rules={[{ required: true }]}><Select options={data.sources.map((item) => ({ value: item.id, label: `${item.name}${item.status === "disabled" ? "（已停用）" : ""}` }))} /></Form.Item></Col>
                        <Col xs={24} md={5}><Form.Item name="displayMode" label="展示方式" initialValue="link_only" rules={[{ required: true }]}><Select options={[{ value: "full", label: "全文" }, { value: "excerpt", label: "节选" }, { value: "link_only", label: "仅链接" }]} /></Form.Item></Col>
                        <Col xs={24} md={5}><Form.Item name="copyrightStatus" label="版权状态" initialValue="pending_verification" rules={[{ required: true }]}><Select options={Object.entries(copyrightLabel).map(([value, label]) => ({ value, label }))} /></Form.Item></Col>
                        <Col xs={12} md={3}><Form.Item name="sortOrder" label="排序" initialValue={0}><InputNumber style={{ width: "100%" }} /></Form.Item></Col>
                      </Row>
                      <Form.Item name="sourceTitle" label="来源文章标题"><Input /></Form.Item>
                      <Form.Item name="sourceUrl" label="原文链接"><Input placeholder="https://" /></Form.Item>
                      <Form.Item name="content" label="全文（仅平台原创或已授权可公开）"><Input.TextArea rows={7} /></Form.Item>
                      <Form.Item name="excerpt" label="节选（适当引用须提供原文链接）"><Input.TextArea rows={4} /></Form.Item>
                      <Row gutter={10}>
                        <Col xs={24} md={8}><Form.Item name="publicationStatus" label="发布状态" initialValue="draft"><Select options={[
                          { value: "draft", label: "草稿" },
                          ...(canPublish ? [{ value: "published", label: "发布" }] : []),
                          { value: "archived", label: "归档" },
                        ]} /></Form.Item></Col>
                        <Col xs={24} md={8}><Form.Item name="originalPublishedAt" label="原文发布日期"><Input placeholder="YYYY-MM-DD" /></Form.Item></Col>
                      </Row>
                      <Alert showIcon type="warning" message="发布门禁" description="全文仅允许平台原创或已获授权；适当引用必须填写不超过1200字的节选和 HTTPS 原文链接；仅链接模式不会向用户返回正文。" style={{ marginBottom: 14 }} />
                      <Button type="primary" htmlType="submit" loading={saving === "adminUpsertEssayReferenceAnswer"}>保存答案</Button>
                    </Form>
                    <Divider />
                    <Table
                      rowKey="id"
                      size="small"
                      pagination={{ pageSize: 10 }}
                      dataSource={paperAnswers}
                      columns={[
                        { title: "题目", render: (_, row: ReferenceAnswer) => paperQuestions.find((item) => item.id === row.question_id)?.question_number ?? row.question_id },
                        { title: "来源", render: (_, row: ReferenceAnswer) => data.sources.find((item) => item.id === row.source_id)?.name ?? row.source_id },
                        { title: "展示", dataIndex: "display_mode", render: (value) => value === "full" ? "全文" : value === "excerpt" ? "节选" : "仅链接" },
                        { title: "版权", dataIndex: "copyright_status", render: (value) => <Tag color={value === "pending_verification" ? "gold" : "blue"}>{copyrightLabel[value] ?? value}</Tag> },
                        { title: "状态", dataIndex: "publication_status", render: statusTag },
                        { title: "操作", render: (_, row: ReferenceAnswer) => <Space><Button size="small" onClick={() => editAnswer(row)}>编辑</Button>{canPublish && row.publication_status !== "published" && <Button size="small" type="primary" onClick={() => void run("adminSetEssayReferenceAnswerStatus", { id: row.id, status: "published" }, "答案已发布")}>发布</Button>}{canPublish && row.publication_status === "published" && <Button size="small" onClick={() => void run("adminSetEssayReferenceAnswerStatus", { id: row.id, status: "draft" }, "答案已撤回")}>撤回</Button>}</Space> },
                      ]}
                    />
                  </>}
                </Card>
              </Space>
            ),
          },
          {
            key: "bulk-import",
            label: "批量导入",
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
    </AdminPageFrame>
  );
}
