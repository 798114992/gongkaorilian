"use client";

import { useEffect, useState } from "react";
import { Alert, Button, Card, Col, Empty, Input, List, Modal, Row, Space, Statistic, Tag, Typography } from "antd";
import AdminContentManager, { type AdminContentItem, type ContentImportItem } from "../../AdminContentManager";
import { useAdminSession } from "../../AdminShell";
import { adminApi } from "../_components/adminApi";
import AdminPageFrame from "../_components/AdminPageFrame";
import { useAdminDomain } from "../_components/useAdminDomain";

type ContentReportItem = {
  id: number;
  content_type: string;
  content_key: string;
  reason_code: string;
  detail: string;
  context_json: string;
  status: "pending" | "resolved" | "rejected";
  resolution_note: string;
  created_at: string;
  resolved_at?: string | null;
  reporter: string;
  stem?: string | null;
  source?: string | null;
  question_version?: number | null;
  resolver_name?: string | null;
};

type ContentDomain = {
  content: AdminContentItem[];
  contentImports?: ContentImportItem[];
  mediaAssets?: Array<{ id: string; file_name: string; content_type: string; byte_size: number; access_level: "free" | "member"; url: string }>;
  pagination?: { page?: number; pageSize?: number; total?: number };
  summary?: { statusCounts?: Array<{ status: string; count: number | string }> };
  reports?: ContentReportItem[];
  reportSummary?: { total?: number; pending?: number; resolved?: number; rejected?: number };
};

const initialData: ContentDomain = { content: [] };
const reportReasonLabels: Record<string, string> = {
  stem_or_option: "题干/选项有误",
  answer: "答案有误",
  explanation: "解析有误",
  asset: "图片/附件有误",
  source_label: "题源/标签有误",
  other: "其他问题",
};

function reportContext(value: string) {
  try { return JSON.parse(value) as { bankName?: string; module?: string; source?: string }; }
  catch { return {}; }
}

export default function ContentPage() {
  const [entryQuery] = useState(() => {
    if (typeof window === "undefined") return { type: "all", status: "all", queue: "" };
    const query = new URLSearchParams(window.location.search);
    const type = query.get("type") ?? "all";
    const status = query.get("status") ?? "all";
    return {
      type: ["morning_read", "current_affairs", "essay_micro", "audio_track", "drill_preset", "strategy_config", "resource_card", "campaign_slot", "paywall_policy"].includes(type) ? type : "all",
      status: ["draft", "pending_review", "rejected", "scheduled", "published", "archived"].includes(status) ? status : "all",
      queue: query.get("queue") ?? "",
    };
  });
  const { can } = useAdminSession();
  const { data, loading, error, reload } = useAdminDomain<ContentDomain>("adminListContent", initialData);
  const [notice, setNotice] = useState("");
  const [handling, setHandling] = useState<{ report: ContentReportItem; decision: "resolved" | "rejected" } | null>(null);
  const [resolutionNote, setResolutionNote] = useState("");
  const [resolving, setResolving] = useState(false);
  const canRead = can("content.read");
  const canWrite = can("content.write");
  const canReview = can("content.review");
  const canPublish = can("content.publish");
  const canResolveReport = canWrite || canReview;
  const summary = data.summary ?? {};
  const statusCount = (status: string) => Number(summary.statusCounts?.find((item) => item.status === status)?.count ?? 0);
  const pendingReports = (data.reports ?? []).filter((item) => item.status === "pending");

  useEffect(() => {
    if (loading || entryQuery.queue !== "reports") return;
    const timer = window.setTimeout(() => document.getElementById("content-report-queue")?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
    return () => window.clearTimeout(timer);
  }, [entryQuery.queue, loading]);

  const resolveReport = async () => {
    if (!handling || resolutionNote.trim().length < 2) return;
    setResolving(true);
    try {
      await adminApi({
        action: "adminResolveContentReport",
        id: handling.report.id,
        decision: handling.decision,
        resolutionNote: resolutionNote.trim(),
      });
      setNotice(handling.decision === "resolved" ? "报错已标记为已修正，并写入操作日志" : "报错已驳回，并写入操作日志");
      setHandling(null);
      setResolutionNote("");
      await reload();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "处理失败，请稍后重试");
    } finally {
      setResolving(false);
    }
  };

  return (
    <AdminPageFrame
      eyebrow="内容运营"
      title="内容库与发布"
      description="统一维护晨读、时政、申论微练、日练电台、专项微练和训练策略；编辑与审核职责分离。"
      loading={loading}
      error={error}
      onReload={() => void reload()}
    >
      {!canRead ? <Alert showIcon type="warning" message="当前角色没有内容查看权限" /> : <>
        {notice && <Alert closable showIcon type="info" message={notice} onClose={() => setNotice("")} style={{ marginBottom: 18 }} />}
        {!canWrite && !canReview && <Alert showIcon type="warning" message="只读模式" style={{ marginBottom: 18 }} />}
        <Row gutter={[16, 16]} style={{ marginBottom: 20 }}>
          <Col xs={12} lg={6}><Card><Statistic title="全部内容" value={Number(data.pagination?.total ?? data.content.length)} /></Card></Col>
          <Col xs={12} lg={6}><Card><Statistic title="草稿/驳回" value={statusCount("draft") + statusCount("rejected")} /></Card></Col>
          <Col xs={12} lg={6}><Card><Statistic title="待审核" value={statusCount("pending_review")} valueStyle={{ color: "#d97706" }} /></Card></Col>
          <Col xs={12} lg={6}><Card><Statistic title="已发布" value={statusCount("published")} /></Card></Col>
        </Row>
        <Card
          id="content-report-queue"
          title={<Space><span>用户内容报错</span><Tag color={pendingReports.length ? "orange" : "green"}>待处理 {Number(data.reportSummary?.pending ?? pendingReports.length)}</Tag></Space>}
          extra={<Typography.Text type="secondary">已解决 {Number(data.reportSummary?.resolved ?? 0)} · 已驳回 {Number(data.reportSummary?.rejected ?? 0)}</Typography.Text>}
          style={{ marginBottom: 20 }}
        >
          {!pendingReports.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无待处理报错" /> : (
            <List
              dataSource={pendingReports}
              renderItem={(report) => {
                const context = reportContext(report.context_json);
                return <List.Item
                  actions={canResolveReport ? [
                    <Button key="resolved" type="primary" onClick={() => { setHandling({ report, decision: "resolved" }); setResolutionNote(""); }}>标记已修正</Button>,
                    <Button key="rejected" danger onClick={() => { setHandling({ report, decision: "rejected" }); setResolutionNote(""); }}>驳回</Button>,
                  ] : undefined}
                >
                  <List.Item.Meta
                    title={<Space wrap><Tag color="volcano">{reportReasonLabels[report.reason_code] ?? report.reason_code}</Tag><Typography.Text code>{report.content_key}</Typography.Text><Typography.Text type="secondary">{context.bankName || "题库"}{context.module ? ` · ${context.module}` : ""}</Typography.Text></Space>}
                    description={<Space direction="vertical" size={3} style={{ width: "100%" }}>
                      <Typography.Text>{report.stem || "题干快照未入库，请按题目编号核对"}</Typography.Text>
                      {report.detail && <Typography.Text type="warning">用户补充：{report.detail}</Typography.Text>}
                      <Typography.Text type="secondary">提交者 {report.reporter} · {report.created_at}{report.source ? ` · 题源 ${report.source}` : ""}</Typography.Text>
                    </Space>}
                  />
                </List.Item>;
              }}
            />
          )}
        </Card>
        <AdminContentManager
          scope="content"
          items={data.content}
          contentImports={data.contentImports}
          mediaAssets={data.mediaAssets}
          canEdit={canWrite}
          canReview={canReview}
          canPublish={canPublish}
          canUpload={can("media.upload")}
          initialType={entryQuery.type as Parameters<typeof AdminContentManager>[0]["initialType"]}
          initialStatus={entryQuery.status as Parameters<typeof AdminContentManager>[0]["initialStatus"]}
          onReload={reload}
          onMessage={setNotice}
        />
      </>}
      <Modal
        open={Boolean(handling)}
        title={handling?.decision === "resolved" ? "确认已修正" : "确认驳回报错"}
        okText={handling?.decision === "resolved" ? "确认已修正" : "确认驳回"}
        cancelText="取消"
        confirmLoading={resolving}
        okButtonProps={{ disabled: resolutionNote.trim().length < 2, danger: handling?.decision === "rejected" }}
        onOk={() => void resolveReport()}
        onCancel={() => { if (!resolving) { setHandling(null); setResolutionNote(""); } }}
      >
        <Typography.Paragraph type="secondary">处理说明会关联管理员身份写入审计日志，便于内容复核。</Typography.Paragraph>
        <Input.TextArea
          autoFocus
          rows={4}
          maxLength={1000}
          showCount
          value={resolutionNote}
          placeholder={handling?.decision === "resolved" ? "例如：已更正答案并发布题目新版本" : "例如：核对原卷后内容无误，维持现状"}
          onChange={(event) => setResolutionNote(event.target.value)}
        />
      </Modal>
    </AdminPageFrame>
  );
}
