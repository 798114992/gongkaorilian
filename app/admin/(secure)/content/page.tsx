"use client";

import { useState } from "react";
import { Alert, Card, Col, Row, Statistic } from "antd";
import AdminContentManager, { type AdminContentItem } from "../../AdminContentManager";
import { useAdminSession } from "../../AdminShell";
import AdminPageFrame from "../_components/AdminPageFrame";
import { useAdminDomain } from "../_components/useAdminDomain";

type ContentDomain = {
  content: AdminContentItem[];
  mediaAssets?: unknown[];
  pagination?: { page?: number; pageSize?: number; total?: number };
  summary?: { statusCounts?: Array<{ status: string; count: number | string }> };
};

const initialData: ContentDomain = { content: [] };

export default function ContentPage() {
  const { can } = useAdminSession();
  const { data, loading, error, reload } = useAdminDomain<ContentDomain>("adminListContent", initialData);
  const [notice, setNotice] = useState("");
  const canRead = can("content.read");
  const canWrite = can("content.write");
  const canReview = can("content.review");
  const canPublish = can("content.publish");
  const summary = data.summary ?? {};
  const statusCount = (status: string) => Number(summary.statusCounts?.find((item) => item.status === status)?.count ?? 0);

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
        <AdminContentManager
          scope="content"
          items={data.content}
          canEdit={canWrite}
          canReview={canReview}
          canPublish={canPublish}
          canUpload={can("media.upload")}
          onReload={reload}
          onMessage={setNotice}
        />
      </>}
    </AdminPageFrame>
  );
}
