"use client";

import { useState } from "react";
import { Alert, Card, Col, Progress, Row, Statistic, Table, Tag, Typography } from "antd";
import QuestionBankManager, { type QuestionBankItem, type QuestionImportItem } from "../../QuestionBankManager";
import { useAdminSession } from "../../AdminShell";
import AdminPageFrame from "../_components/AdminPageFrame";
import QuestionReviewQueue from "../_components/QuestionReviewQueue";
import { useAdminDomain } from "../_components/useAdminDomain";

type QuestionDomain = {
  questionBanks: QuestionBankItem[];
  questionImports: QuestionImportItem[];
  questions?: unknown[];
  bankHealth?: Array<{
    id: number;
    bank_code: string;
    name: string;
    status: string;
    total_questions: number;
    usable_questions: number;
    module_count: number;
    module_coverage: number;
    year_count: number;
    missing_explanation: number;
    missing_answer: number;
    missing_tags: number;
    duplicate_risk: number;
    published_unavailable: number;
    exhaustion_level: "blocked" | "critical" | "warning" | "healthy";
  }>;
  summary?: {
    question_count?: number | string;
    active_count?: number | string;
    incomplete_count?: number | string;
    totalBanks?: number;
    publishedBanks?: number;
    pendingReviewQuestions?: number | string;
    unhealthyBanks?: number;
    publishedUnavailableBanks?: number;
  };
};

const initialData: QuestionDomain = { questionBanks: [], questionImports: [] };

export default function QuestionBanksPage() {
  const { can } = useAdminSession();
  const { data, loading, error, reload } = useAdminDomain<QuestionDomain>("adminListQuestions", initialData);
  const [notice, setNotice] = useState("");
  const canRead = can("question.read");
  const canWrite = can("question.write");
  const canReview = can("question.review");
  const summary = data.summary ?? {};

  return (
    <AdminPageFrame
      eyebrow="题库与训练"
      title="题库与题目"
      description="按国考、省份、年份和科目维护独立题库。发布前确认题量与真题标签，避免空题库进入考生的备考组合。"
      loading={loading}
      error={error}
      onReload={() => void reload()}
    >
      {!canRead ? <Alert showIcon type="warning" message="当前角色没有题库查看权限" /> : <>
        {notice && <Alert closable showIcon type="info" message={notice} onClose={() => setNotice("")} style={{ marginBottom: 18 }} />}
        {!canWrite && !canReview && <Alert showIcon type="warning" message="只读模式" description="你可以查看题库与审核状态，但不能修改。" style={{ marginBottom: 18 }} />}
        {canReview && !canWrite && <Alert showIcon type="success" message="审核模式" description="你可以核验待审真题，但不能修改题库或导入题目。" style={{ marginBottom: 18 }} />}
        <Row gutter={[16, 16]} style={{ marginBottom: 20 }}>
          <Col xs={12} lg={6}><Card><Statistic title="题库总数" value={summary.totalBanks ?? data.questionBanks.length} /></Card></Col>
          <Col xs={12} lg={6}><Card><Statistic title="待审核真题" value={Number(summary.pendingReviewQuestions ?? 0)} valueStyle={{ color: Number(summary.pendingReviewQuestions ?? 0) > 0 ? "#d97706" : undefined }} /></Card></Col>
          <Col xs={12} lg={6}><Card><Statistic title="真题总量" value={Number(summary.question_count ?? data.questionBanks.reduce((sum, item) => sum + Number(item.question_count || 0), 0))} /></Card></Col>
          <Col xs={12} lg={6}><Card><Statistic title="标签待完善" value={Number(summary.incomplete_count ?? 0)} valueStyle={{ color: Number(summary.incomplete_count ?? 0) > 0 ? "#cf5f45" : undefined }} /></Card></Col>
        </Row>
        <Card title="题库健康度" extra={<Typography.Text type="secondary">先处理红色阻断项，再扩充即将耗尽题库</Typography.Text>} style={{ marginBottom: 20 }}>
          <Table
            size="small"
            rowKey="id"
            pagination={false}
            scroll={{ x: 1080 }}
            dataSource={data.bankHealth ?? []}
            columns={[
              { title: "题库", key: "bank", fixed: "left", width: 210, render: (_, row) => <div><strong>{row.name}</strong><br /><Typography.Text type="secondary">{row.bank_code}</Typography.Text></div> },
              { title: "可进入日练", dataIndex: "usable_questions", width: 110, render: (value, row) => <span><b>{value}</b> / {row.total_questions}</span> },
              { title: "模块覆盖", dataIndex: "module_coverage", width: 145, render: (value, row) => <div><Progress percent={value} size="small" status={value < 60 ? "exception" : "normal"} /><Typography.Text type="secondary">{row.module_count} 个模块</Typography.Text></div> },
              { title: "年份", dataIndex: "year_count", width: 70 },
              { title: "缺答案", dataIndex: "missing_answer", width: 80 },
              { title: "缺解析", dataIndex: "missing_explanation", width: 80 },
              { title: "缺标签", dataIndex: "missing_tags", width: 80 },
              { title: "重复风险", dataIndex: "duplicate_risk", width: 90 },
              { title: "训练供给", dataIndex: "exhaustion_level", width: 105, render: (value) => {
                const map = { blocked: ["error", "无法训练"], critical: ["error", "即将耗尽"], warning: ["warning", "库存偏低"], healthy: ["success", "充足"] } as const;
                const [color, label] = map[value];
                return <Tag color={color}>{label}</Tag>;
              } },
              { title: "发布可用", dataIndex: "published_unavailable", width: 100, render: (value, row) => value ? <Tag color="error">已发布但不可练</Tag> : <Tag color={row.status === "published" ? "success" : "default"}>{row.status === "published" ? "正常" : "草稿"}</Tag> },
            ]}
          />
        </Card>
        <QuestionReviewQueue canReview={canReview} onMessage={setNotice} onChanged={reload} />
        <QuestionBankManager
          view="banks"
          banks={data.questionBanks}
          imports={data.questionImports}
          canEdit={canWrite}
          canPublish={canWrite}
          onReload={reload}
          onMessage={setNotice}
        />
      </>}
    </AdminPageFrame>
  );
}
