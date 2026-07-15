"use client";

import { useState } from "react";
import { Alert, Card, Col, Row, Statistic } from "antd";
import QuestionBankManager, { type QuestionBankItem, type QuestionImportItem } from "../../QuestionBankManager";
import { useAdminSession } from "../../AdminShell";
import AdminPageFrame from "../_components/AdminPageFrame";
import { useAdminDomain } from "../_components/useAdminDomain";

type ImportDomain = {
  questionBanks: QuestionBankItem[];
  questionImports: QuestionImportItem[];
  summary?: { processingImports?: number; failedImports?: number; importedRows?: number };
};

const initialData: ImportDomain = { questionBanks: [], questionImports: [] };

export default function ImportsPage() {
  const { can } = useAdminSession();
  const { data, loading, error, reload } = useAdminDomain<ImportDomain>("adminListQuestions", initialData);
  const [notice, setNotice] = useState("");
  const canRead = can("question.read");
  const canImport = can("question.import");
  const summary = data.summary ?? {};
  const completedRows = data.questionImports.reduce((sum, item) => sum + Number(item.imported_rows || 0), 0);

  return (
    <AdminPageFrame
      eyebrow="题库与训练"
      title="导入任务"
      description="按“选择文件—校验预览—确认导入—结果追踪”处理题库文件。校验失败的行不会写入题库。"
      loading={loading}
      error={error}
      onReload={() => void reload()}
    >
      {!canRead ? <Alert showIcon type="warning" message="当前角色没有题库查看权限" /> : <>
        {notice && <Alert closable showIcon type="info" message={notice} onClose={() => setNotice("")} style={{ marginBottom: 18 }} />}
        {!canImport && <Alert showIcon type="warning" message="只读模式" description="你可以查看导入记录，但不能发起新的导入任务。" style={{ marginBottom: 18 }} />}
        <Row gutter={[16, 16]} style={{ marginBottom: 20 }}>
          <Col xs={12} lg={6}><Card><Statistic title="可选题库" value={data.questionBanks.length} /></Card></Col>
          <Col xs={12} lg={6}><Card><Statistic title="累计成功行" value={summary.importedRows ?? completedRows} /></Card></Col>
          <Col xs={12} lg={6}><Card><Statistic title="进行中" value={summary.processingImports ?? data.questionImports.filter((item) => item.status === "processing").length} /></Card></Col>
          <Col xs={12} lg={6}><Card><Statistic title="异常任务" value={summary.failedImports ?? data.questionImports.filter((item) => item.status === "failed" || item.status === "completed_with_errors").length} /></Card></Col>
        </Row>
        <QuestionBankManager
          view="imports"
          banks={data.questionBanks}
          imports={data.questionImports}
          canEdit={canImport}
          canPublish={false}
          onReload={reload}
          onMessage={setNotice}
        />
      </>}
    </AdminPageFrame>
  );
}

