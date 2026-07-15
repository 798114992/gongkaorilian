"use client";

import { useMemo, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Col,
  Form,
  Input,
  InputNumber,
  Modal,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tabs,
  Tag,
  Typography,
  Upload,
} from "antd";
import type { UploadProps } from "antd";
import { PlusOutlined, UploadOutlined } from "@ant-design/icons";
import * as XLSX from "xlsx";
import { useAdminSession } from "../../AdminShell";
import AdminPageFrame from "../_components/AdminPageFrame";
import { adminApi } from "../_components/adminApi";
import { useAdminDomain } from "../_components/useAdminDomain";

type QuizTest = {
  id: string;
  slug: string;
  title: string;
  description: string;
  question_count: number;
  status: string;
  share_title: string;
  disclaimer: string;
};

type QuizQuestion = {
  id: number;
  question_code: string;
  stem: string;
  options: string[];
  correct_index: number;
  explanation: string;
  category: string;
  difficulty: string;
  status: string;
  review_status: string;
  sort_order: number;
};

type QuizLevel = {
  id: string;
  level_key: string;
  title: string;
  min_score: number;
  max_score: number;
  theme: string;
  description: string;
  share_text: string;
  badge_label: string;
  sort_order: number;
  status: string;
};

type QuizDomain = {
  tests: QuizTest[];
  questions: QuizQuestion[];
  levels: QuizLevel[];
  summary: {
    totalQuestions: number;
    publishedQuestions: number;
    attempts: number;
    completed: number;
    avgScore: string;
    directorCount: number;
    shares: number;
  };
};

const initialData: QuizDomain = {
  tests: [],
  questions: [],
  levels: [],
  summary: { totalQuestions: 0, publishedQuestions: 0, attempts: 0, completed: 0, avgScore: "0", directorCount: 0, shares: 0 },
};

const quizId = "quiz-juzhang-thinking";

function difficultyTag(value: string) {
  if (value === "hard") return <Tag color="red">困难</Tag>;
  if (value === "easy") return <Tag color="green">简单</Tag>;
  return <Tag color="blue">中等</Tag>;
}

function publishTag(row: Pick<QuizQuestion, "status" | "review_status">) {
  if (row.status === "published" && row.review_status === "approved") return <Tag color="success">已发布</Tag>;
  if (row.review_status === "pending_review") return <Tag color="warning">待审核</Tag>;
  if (row.status === "archived") return <Tag>已归档</Tag>;
  return <Tag color="default">草稿</Tag>;
}

function sheetRowsFromFile(file: File): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const workbook = XLSX.read(reader.result, { type: "array" });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        resolve(XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" }));
      } catch (error) {
        reject(error);
      }
    };
    reader.onerror = () => reject(new Error("文件读取失败"));
    reader.readAsArrayBuffer(file);
  });
}

export default function QuizAdminPage() {
  const { can } = useAdminSession();
  const { data, loading, error, reload } = useAdminDomain<QuizDomain>("adminListQuizzes", initialData);
  const [notice, setNotice] = useState("");
  const [questionOpen, setQuestionOpen] = useState(false);
  const [levelOpen, setLevelOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [questionForm] = Form.useForm();
  const [levelForm] = Form.useForm();
  const [settingsForm] = Form.useForm();
  const canWrite = can("content.write");
  const currentQuiz = data.tests.find((item) => item.id === quizId) ?? data.tests[0];

  const resultDistribution = useMemo(() => {
    const completed = Number(data.summary.completed || 0);
    const director = Number(data.summary.directorCount || 0);
    return completed ? Math.round((director / completed) * 100) : 0;
  }, [data.summary.completed, data.summary.directorCount]);

  const openQuestion = (row?: QuizQuestion) => {
    questionForm.resetFields();
    questionForm.setFieldsValue(row ? {
      questionCode: row.question_code,
      stem: row.stem,
      optionA: row.options[0] ?? "",
      optionB: row.options[1] ?? "",
      optionC: row.options[2] ?? "",
      optionD: row.options[3] ?? "",
      correctAnswer: String.fromCharCode(65 + Number(row.correct_index || 0)),
      explanation: row.explanation,
      category: row.category,
      difficulty: row.difficulty,
      status: row.status,
      reviewStatus: row.review_status,
      sortOrder: row.sort_order,
    } : { difficulty: "medium", status: "draft", reviewStatus: "pending_review", correctAnswer: "A" });
    setQuestionOpen(true);
  };

  const openLevel = (row?: QuizLevel) => {
    levelForm.resetFields();
    levelForm.setFieldsValue(row ? {
      levelKey: row.level_key,
      title: row.title,
      minScore: row.min_score,
      maxScore: row.max_score,
      theme: row.theme,
      badgeLabel: row.badge_label,
      description: row.description,
      shareText: row.share_text,
      sortOrder: row.sort_order,
      status: row.status,
    } : { theme: "blue", status: "active", minScore: 0, maxScore: 0 });
    setLevelOpen(true);
  };

  const saveQuestion = async () => {
    const values = await questionForm.validateFields();
    setSaving(true);
    try {
      await adminApi({ action: "adminUpsertQuizQuestion", quizId, ...values });
      setNotice("题目已保存。发布前请确认选项、正确答案和解析。");
      setQuestionOpen(false);
      await reload();
    } finally {
      setSaving(false);
    }
  };

  const saveLevel = async () => {
    const values = await levelForm.validateFields();
    setSaving(true);
    try {
      await adminApi({ action: "adminUpsertQuizResult", quizId, ...values });
      setNotice("结果段位已保存。");
      setLevelOpen(false);
      await reload();
    } finally {
      setSaving(false);
    }
  };

  const saveSettings = async () => {
    const values = await settingsForm.validateFields();
    setSaving(true);
    try {
      await adminApi({ action: "adminUpdateQuiz", quizId, ...values });
      setNotice("测试设置已保存。");
      await reload();
    } finally {
      setSaving(false);
    }
  };

  const uploadProps: UploadProps = {
    accept: ".xlsx,.xls,.csv",
    showUploadList: false,
    beforeUpload: async (file) => {
      setSaving(true);
      try {
        const rows = await sheetRowsFromFile(file);
        const result = await adminApi<{ importedRows: number; failedRows: number; errors?: Array<{ row: number; message: string }> }>({
          action: "adminBulkUpsertQuizQuestions",
          quizId,
          rows,
        });
        setNotice(`已导入 ${result.importedRows} 行，失败 ${result.failedRows} 行${result.errors?.length ? `；首个问题：第${result.errors[0].row}行 ${result.errors[0].message}` : ""}`);
        await reload();
      } catch (uploadError) {
        setNotice(uploadError instanceof Error ? uploadError.message : "导入失败，请检查表头和内容");
      } finally {
        setSaving(false);
      }
      return false;
    },
  };

  return (
    <AdminPageFrame
      eyebrow="内容运营"
      title="趣味测试"
      description="维护“测测你有没有局长思维”的题库、结果段位、分享文案和数据表现。它是免费裂变入口，不参与日练付费门槛。"
      loading={loading}
      error={error}
      onReload={() => void reload()}
      extra={canWrite ? <Button type="primary" icon={<PlusOutlined />} onClick={() => openQuestion()}>新增题目</Button> : undefined}
    >
      {notice && <Alert closable showIcon type="info" message={notice} onClose={() => setNotice("")} style={{ marginBottom: 18 }} />}
      {!canWrite && <Alert showIcon type="warning" message="只读模式" description="当前角色只能查看趣味测试配置和数据，不能新增或修改。" style={{ marginBottom: 18 }} />}

      <Row gutter={[16, 16]} style={{ marginBottom: 20 }}>
        <Col xs={12} lg={6}><Card><Statistic title="可用题目" value={data.summary.publishedQuestions} suffix={`/ ${data.summary.totalQuestions}`} /></Card></Col>
        <Col xs={12} lg={6}><Card><Statistic title="完成测试" value={data.summary.completed} suffix={`/ ${data.summary.attempts}`} /></Card></Col>
        <Col xs={12} lg={6}><Card><Statistic title="平均答对" value={data.summary.avgScore} suffix="题" /></Card></Col>
        <Col xs={12} lg={6}><Card><Statistic title="局长结果占比" value={resultDistribution} suffix="%" /></Card></Col>
      </Row>

      <Tabs
        items={[
          {
            key: "questions",
            label: "题目题库",
            children: <>
              <Space wrap style={{ marginBottom: 16 }}>
                {canWrite && <Upload {...uploadProps}><Button icon={<UploadOutlined />} loading={saving}>Excel/CSV导入题目</Button></Upload>}
                <Typography.Text type="secondary">表头支持：题目编码、题干、A、B、C、正确答案、解析、分类、难度、状态。</Typography.Text>
              </Space>
              <Table
                rowKey="question_code"
                dataSource={data.questions}
                pagination={{ pageSize: 10 }}
                columns={[
                  { title: "题目", dataIndex: "stem", ellipsis: true, render: (value, row) => <><Typography.Text strong>{row.question_code}</Typography.Text><br /><Typography.Text title={String(value)}>{String(value)}</Typography.Text></> },
                  { title: "分类", dataIndex: "category", width: 120 },
                  { title: "难度", dataIndex: "difficulty", width: 90, render: difficultyTag },
                  { title: "状态", key: "status", width: 110, render: (_, row) => publishTag(row) },
                  { title: "正确答案", key: "answer", width: 100, render: (_, row) => String.fromCharCode(65 + Number(row.correct_index || 0)) },
                  {
                    title: "操作",
                    key: "actions",
                    width: 230,
                    render: (_, row) => <Space>
                      <Button size="small" onClick={() => openQuestion(row)}>编辑</Button>
                      {canWrite && <Button size="small" type={row.status === "published" && row.review_status === "approved" ? "default" : "primary"} onClick={async () => {
                        await adminApi({ action: "adminSetQuizQuestionStatus", questionCode: row.question_code, status: "published", reviewStatus: "approved" });
                        await reload();
                      }}>发布</Button>}
                      {canWrite && <Button size="small" danger onClick={async () => {
                        await adminApi({ action: "adminSetQuizQuestionStatus", questionCode: row.question_code, status: "archived", reviewStatus: row.review_status });
                        await reload();
                      }}>归档</Button>}
                    </Space>,
                  },
                ]}
              />
            </>,
          },
          {
            key: "levels",
            label: "结果段位",
            children: <>
              {canWrite && <Button icon={<PlusOutlined />} onClick={() => openLevel()} style={{ marginBottom: 16 }}>新增结果段位</Button>}
              <Table
                rowKey="level_key"
                dataSource={data.levels}
                pagination={false}
                columns={[
                  { title: "分数", key: "score", width: 90, render: (_, row) => `${row.min_score}-${row.max_score}` },
                  { title: "结果", dataIndex: "title", width: 180 },
                  { title: "分享钩子", dataIndex: "share_text", ellipsis: true },
                  { title: "主题", dataIndex: "theme", width: 90, render: (value) => <Tag>{String(value)}</Tag> },
                  { title: "状态", dataIndex: "status", width: 90, render: (value) => value === "active" ? <Tag color="success">启用</Tag> : <Tag>停用</Tag> },
                  { title: "操作", key: "actions", width: 90, render: (_, row) => <Button size="small" onClick={() => openLevel(row)}>编辑</Button> },
                ]}
              />
            </>,
          },
          {
            key: "settings",
            label: "测试设置",
            children: currentQuiz ? <Card>
              <Form form={settingsForm} layout="vertical" initialValues={{
                title: currentQuiz.title,
                description: currentQuiz.description,
                questionCount: currentQuiz.question_count,
                status: currentQuiz.status,
                shareTitle: currentQuiz.share_title,
                disclaimer: currentQuiz.disclaimer,
              }}>
                <Row gutter={16}>
                  <Col xs={24} md={12}><Form.Item name="title" label="测试标题" rules={[{ required: true }]}><Input maxLength={80} /></Form.Item></Col>
                  <Col xs={24} md={6}><Form.Item name="questionCount" label="每次抽题数"><InputNumber min={5} max={20} style={{ width: "100%" }} /></Form.Item></Col>
                  <Col xs={24} md={6}><Form.Item name="status" label="状态"><Select options={[{ value: "published", label: "发布" }, { value: "draft", label: "草稿" }]} /></Form.Item></Col>
                  <Col xs={24}><Form.Item name="description" label="测试简介"><Input.TextArea rows={2} maxLength={240} /></Form.Item></Col>
                  <Col xs={24}><Form.Item name="shareTitle" label="默认分享标题"><Input maxLength={120} /></Form.Item></Col>
                  <Col xs={24}><Form.Item name="disclaimer" label="合规提示"><Input maxLength={160} /></Form.Item></Col>
                </Row>
                {canWrite && <Button type="primary" loading={saving} onClick={() => void saveSettings()}>保存测试设置</Button>}
              </Form>
            </Card> : <Alert showIcon type="warning" message="测试主题尚未初始化" />,
          },
          {
            key: "analytics",
            label: "数据概览",
            children: <Row gutter={[16, 16]}>
              <Col xs={12} md={6}><Card><Statistic title="分享次数" value={data.summary.shares} /></Card></Col>
              <Col xs={12} md={6}><Card><Statistic title="局长结果" value={data.summary.directorCount} /></Card></Col>
              <Col xs={12} md={6}><Card><Statistic title="完成率" value={data.summary.attempts ? Math.round((data.summary.completed / data.summary.attempts) * 100) : 0} suffix="%" /></Card></Col>
              <Col xs={12} md={6}><Card><Statistic title="题目池安全线" value={data.summary.publishedQuestions >= 10 ? "达标" : "不足"} /></Card></Col>
            </Row>,
          },
        ]}
      />

      <Modal title="维护测试题目" open={questionOpen} onCancel={() => setQuestionOpen(false)} onOk={() => void saveQuestion()} confirmLoading={saving} width={760}>
        <Form form={questionForm} layout="vertical">
          <Row gutter={12}>
            <Col xs={24} md={8}><Form.Item name="questionCode" label="题目编码"><Input placeholder="留空自动生成" /></Form.Item></Col>
            <Col xs={12} md={8}><Form.Item name="category" label="分类"><Input placeholder="体制内语言" /></Form.Item></Col>
            <Col xs={12} md={8}><Form.Item name="difficulty" label="难度"><Select options={[{ value: "easy", label: "简单" }, { value: "medium", label: "中等" }, { value: "hard", label: "困难" }]} /></Form.Item></Col>
            <Col xs={24}><Form.Item name="stem" label="题干" rules={[{ required: true }]}><Input.TextArea rows={3} /></Form.Item></Col>
            <Col xs={24} md={12}><Form.Item name="optionA" label="A" rules={[{ required: true }]}><Input /></Form.Item></Col>
            <Col xs={24} md={12}><Form.Item name="optionB" label="B" rules={[{ required: true }]}><Input /></Form.Item></Col>
            <Col xs={24} md={12}><Form.Item name="optionC" label="C"><Input /></Form.Item></Col>
            <Col xs={24} md={12}><Form.Item name="optionD" label="D"><Input /></Form.Item></Col>
            <Col xs={12} md={8}><Form.Item name="correctAnswer" label="正确答案"><Select options={["A", "B", "C", "D"].map((value) => ({ value, label: value }))} /></Form.Item></Col>
            <Col xs={12} md={8}><Form.Item name="status" label="发布状态"><Select options={[{ value: "draft", label: "草稿" }, { value: "published", label: "发布" }]} /></Form.Item></Col>
            <Col xs={12} md={8}><Form.Item name="reviewStatus" label="审核状态"><Select options={[{ value: "pending_review", label: "待审核" }, { value: "approved", label: "通过" }]} /></Form.Item></Col>
            <Col xs={12} md={8}><Form.Item name="sortOrder" label="排序"><InputNumber min={0} style={{ width: "100%" }} /></Form.Item></Col>
            <Col xs={24}><Form.Item name="explanation" label="解析"><Input.TextArea rows={3} /></Form.Item></Col>
          </Row>
        </Form>
      </Modal>

      <Modal title="维护结果段位" open={levelOpen} onCancel={() => setLevelOpen(false)} onOk={() => void saveLevel()} confirmLoading={saving} width={720}>
        <Form form={levelForm} layout="vertical">
          <Row gutter={12}>
            <Col xs={12} md={8}><Form.Item name="levelKey" label="结果标识" rules={[{ required: true }]}><Input placeholder="director" /></Form.Item></Col>
            <Col xs={12} md={8}><Form.Item name="minScore" label="最低分"><InputNumber min={0} max={20} style={{ width: "100%" }} /></Form.Item></Col>
            <Col xs={12} md={8}><Form.Item name="maxScore" label="最高分"><InputNumber min={0} max={20} style={{ width: "100%" }} /></Form.Item></Col>
            <Col xs={24} md={12}><Form.Item name="title" label="结果标题" rules={[{ required: true }]}><Input /></Form.Item></Col>
            <Col xs={12} md={6}><Form.Item name="theme" label="主题"><Select options={["neon", "blue", "orange", "gold"].map((value) => ({ value, label: value }))} /></Form.Item></Col>
            <Col xs={12} md={6}><Form.Item name="status" label="状态"><Select options={[{ value: "active", label: "启用" }, { value: "disabled", label: "停用" }]} /></Form.Item></Col>
            <Col xs={24}><Form.Item name="badgeLabel" label="角标文案"><Input /></Form.Item></Col>
            <Col xs={24}><Form.Item name="description" label="结果说明"><Input.TextArea rows={3} /></Form.Item></Col>
            <Col xs={24}><Form.Item name="shareText" label="分享钩子"><Input /></Form.Item></Col>
            <Col xs={12}><Form.Item name="sortOrder" label="排序"><InputNumber min={0} style={{ width: "100%" }} /></Form.Item></Col>
          </Row>
        </Form>
      </Modal>
    </AdminPageFrame>
  );
}
