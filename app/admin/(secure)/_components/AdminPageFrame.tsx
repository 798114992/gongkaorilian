"use client";

import type { ReactNode } from "react";
import { Alert, Button, Flex, Skeleton, Space, Typography } from "antd";
import { ReloadOutlined } from "@ant-design/icons";

type Props = {
  eyebrow: string;
  title: string;
  description: string;
  loading?: boolean;
  error?: string;
  onReload?: () => void;
  extra?: ReactNode;
  children: ReactNode;
};

export default function AdminPageFrame({ eyebrow, title, description, loading, error, onReload, extra, children }: Props) {
  return (
    <div style={{ minWidth: 0 }}>
      <Flex justify="space-between" align="flex-start" gap={20} wrap="wrap" style={{ marginBottom: 24 }}>
        <div>
          <Typography.Text type="secondary" style={{ fontWeight: 700, letterSpacing: 1 }}>{eyebrow}</Typography.Text>
          <Typography.Title level={2} style={{ margin: "5px 0 6px" }}>{title}</Typography.Title>
          <Typography.Paragraph type="secondary" style={{ margin: 0, maxWidth: 720 }}>{description}</Typography.Paragraph>
        </div>
        <Space>
          {extra}
          {onReload && <Button icon={<ReloadOutlined />} onClick={onReload} loading={loading}>刷新</Button>}
        </Space>
      </Flex>
      {error && <Alert showIcon type="error" message="页面数据加载失败" description={error} style={{ marginBottom: 20 }} action={onReload ? <Button size="small" onClick={onReload}>重试</Button> : undefined} />}
      {loading && !error ? <Skeleton active paragraph={{ rows: 8 }} /> : children}
    </div>
  );
}

