"use client";

import { useState } from "react";
import { Alert, Card, Col, Row, Statistic } from "antd";
import QuestionBankManager, { type QuestionBankItem, type QuestionImportItem } from "../../QuestionBankManager";
import { useAdminSession } from "../../AdminShell";
import AdminPageFrame from "../_components/AdminPageFrame";
import { useAdminDomain } from "../_components/useAdminDomain";

type QuestionDomain = {
  questionBanks: QuestionBankItem[];
  questionImports: QuestionImportItem[];
  questions?: unknown[];
  summary?: {
    question_count?: number | string;
    active_count?: number | string;
    incomplete_count?: number | string;
    totalBanks?: number;
    publishedBanks?: number;
  };
};

const initialData: QuestionDomain = { questionBanks: [], questionImports: [] };

export default function QuestionBanksPage() {
  const { can } = useAdminSession();
  const { data, loading, error, reload } = useAdminDomain<QuestionDomain>("adminListQuestions", initialData);
  const [notice, setNotice] = useState("");
  const canRead = can("question.read");
  const canWrite = can("question.write");
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
        {!canWrite && <Alert showIcon type="warning" message="只读模式" description="你可以查看题库状态，但不能新建、编辑、发布或下线。" style={{ marginBottom: 18 }} />}
        <Row gutter={[16, 16]} style={{ marginBottom: 20 }}>
          <Col xs={12} lg={6}><Card><Statistic title="题库总数" value={summary.totalBanks ?? data.questionBanks.length} /></Card></Col>
          <Col xs={12} lg={6}><Card><Statistic title="已发布" value={summary.publishedBanks ?? data.questionBanks.filter((item) => item.status === "published").length} /></Card></Col>
          <Col xs={12} lg={6}><Card><Statistic title="真题总量" value={Number(summary.question_count ?? data.questionBanks.reduce((sum, item) => sum + Number(item.question_count || 0), 0))} /></Card></Col>
          <Col xs={12} lg={6}><Card><Statistic title="标签待完善" value={Number(summary.incomplete_count ?? 0)} valueStyle={{ color: Number(summary.incomplete_count ?? 0) > 0 ? "#cf5f45" : undefined }} /></Card></Col>
        </Row>
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
