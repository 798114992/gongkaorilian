"use client";

import { useState } from "react";
import { Alert, Card, Col, Row, Statistic } from "antd";
import AdminContentManager, { type AdminContentItem, type ContentImportItem } from "../../AdminContentManager";
import { useAdminSession } from "../../AdminShell";
import AdminPageFrame from "../_components/AdminPageFrame";
import { useAdminDomain } from "../_components/useAdminDomain";

type RadarDomain = {
  content: AdminContentItem[];
  contentImports?: ContentImportItem[];
  summary?: Array<{ content_type: string; status: string; count: number | string }>;
};

const initialData: RadarDomain = { content: [] };

export default function RadarPage() {
  const { can } = useAdminSession();
  const { data, loading, error, reload } = useAdminDomain<RadarDomain>("adminListRadar", initialData);
  const [notice, setNotice] = useState("");
  const canRead = can("radar.read");
  const canWrite = can("radar.write");
  const summary = data.summary ?? [];
  const typeCount = (type: string) => summary.filter((item) => item.content_type === type).reduce((total, item) => total + Number(item.count || 0), 0);
  const statusCount = (status: string) => summary.filter((item) => item.status === status).reduce((total, item) => total + Number(item.count || 0), 0);

  return (
    <AdminPageFrame
      eyebrow="招考数据"
      title="公考雷达"
      description="集中维护官方公告、报名与考试节点、职位表和报考条件。所有外部信息均应保留官方来源。"
      loading={loading}
      error={error}
      onReload={() => void reload()}
    >
      {!canRead ? <Alert showIcon type="warning" message="当前角色没有招考数据查看权限" /> : <>
        {notice && <Alert closable showIcon type="info" message={notice} onClose={() => setNotice("")} style={{ marginBottom: 18 }} />}
        {!canWrite && <Alert showIcon type="warning" message="只读模式" description="你可以核对公告、节点和职位数据，但不能修改。" style={{ marginBottom: 18 }} />}
        <Row gutter={[16, 16]} style={{ marginBottom: 20 }}>
          <Col xs={12} lg={6}><Card><Statistic title="招考公告" value={typeCount("exam_notice")} /></Card></Col>
          <Col xs={12} lg={6}><Card><Statistic title="考试节点" value={typeCount("exam_event")} /></Card></Col>
          <Col xs={12} lg={6}><Card><Statistic title="职位数据" value={typeCount("job_position")} /></Card></Col>
          <Col xs={12} lg={6}><Card><Statistic title="待审核" value={statusCount("pending_review")} valueStyle={{ color: "#d97706" }} /></Card></Col>
        </Row>
        <AdminContentManager
          scope="radar"
          items={data.content}
          contentImports={data.contentImports}
          canEdit={canWrite}
          canReview={can("content.review")}
          canPublish={can("content.publish")}
          canUpload={false}
          onReload={reload}
          onMessage={setNotice}
        />
      </>}
    </AdminPageFrame>
  );
}
