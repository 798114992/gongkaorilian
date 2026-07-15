"use client";

import { useEffect, useState } from "react";
import { Alert, Button, Card, Col, Form, Input, InputNumber, Modal, Popconfirm, Row, Select, Space, Statistic, Table, Tabs, Tag, Typography } from "antd";
import { CopyOutlined, PlusOutlined } from "@ant-design/icons";
import { useAdminSession } from "../../AdminShell";
import AdminPageFrame from "../_components/AdminPageFrame";
import { adminApi } from "../_components/adminApi";
import { useAdminDomain } from "../_components/useAdminDomain";

type CodeItem = {
  id: number;
  code_preview: string;
  batch_name: string;
  duration_days: number;
  max_uses: number;
  used_count: number;
  status: string;
  valid_until: string | null;
  created_at: string;
};

type Redemption = { redeemed_at: string; user_id: string; code_preview: string; duration_days: number };
type EventCount = { event_name: string; count: number | string };
type GrowthDomain = {
  codes: CodeItem[];
  redemptions: Redemption[];
  config?: { rewardDays?: number; monthlyCap?: number };
  analytics?: { activeUsers?: number; eventCounts?: EventCount[] };
};

type CodeForm = { batchName: string; durationDays: number; count: number; maxUses: number; validUntil?: string };
type InviteForm = { rewardDays: number; monthlyCap: number };
const initialData: GrowthDomain = { codes: [], redemptions: [] };

export default function GrowthPage() {
  const { can } = useAdminSession();
  const { data, loading, error, reload } = useAdminDomain<GrowthDomain>("adminListGrowth", initialData);
  const [notice, setNotice] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [generated, setGenerated] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [codeForm] = Form.useForm<CodeForm>();
  const [inviteForm] = Form.useForm<InviteForm>();
  const canRead = can("growth.read");
  const canWrite = can("growth.write");

  useEffect(() => {
    inviteForm.setFieldsValue({ rewardDays: data.config?.rewardDays ?? 3, monthlyCap: data.config?.monthlyCap ?? 30 });
  }, [data.config, inviteForm]);

  const eventCount = (name: string) => Number(data.analytics?.eventCounts?.find((item) => item.event_name === name)?.count ?? 0);
  const codeColumns = [
    { title: "兑换码", dataIndex: "code_preview", key: "code", render: (value: string) => <Typography.Text code>{value}</Typography.Text> },
    { title: "批次", dataIndex: "batch_name", key: "batch" },
    { title: "权益", dataIndex: "duration_days", key: "days", render: (value: number) => `${value}天` },
    { title: "使用", key: "uses", render: (_: unknown, row: CodeItem) => `${row.used_count}/${row.max_uses}` },
    { title: "有效期", dataIndex: "valid_until", key: "validUntil", render: (value: string | null) => value ? new Date(value).toLocaleDateString("zh-CN") : "长期" },
    { title: "状态", dataIndex: "status", key: "status", render: (value: string) => <Tag color={value === "active" ? "green" : "default"}>{value === "active" ? "可用" : "已停用"}</Tag> },
    { title: "操作", key: "action", render: (_: unknown, row: CodeItem) => row.status === "active" && <Popconfirm title="确认停用这个兑换码？" onConfirm={() => void disableCode(row.id)}><Button disabled={!canWrite} danger type="link">停用</Button></Popconfirm> },
  ];

  const createCodes = async (values: CodeForm) => {
    setSaving(true);
    try {
      const result = await adminApi<{ codes?: string[] }>({ action: "adminCreateCodes", ...values, validUntil: values.validUntil || null });
      setGenerated(result.codes ?? []);
      setCreateOpen(false);
      setNotice(`已生成 ${result.codes?.length ?? 0} 个兑换码，请立即复制保存明文`);
      codeForm.resetFields();
      await reload();
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "兑换码生成失败");
    } finally {
      setSaving(false);
    }
  };

  const disableCode = async (id: number) => {
    try {
      await adminApi({ action: "adminDisableCode", id });
      setNotice("兑换码已停用");
      await reload();
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "停用失败");
    }
  };

  const updateInvite = async (values: InviteForm) => {
    setSaving(true);
    try {
      await adminApi({ action: "adminUpdateConfig", ...values });
      setNotice("邀请奖励配置已保存，并会记录到操作日志");
      await reload();
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const redemptionColumns = [
    { title: "兑换时间", dataIndex: "redeemed_at", key: "time", render: (value: string) => new Date(value).toLocaleString("zh-CN") },
    { title: "用户", dataIndex: "user_id", key: "user", render: (value: string) => <Typography.Text copyable={{ text: value }}>{value.slice(0, 12)}…</Typography.Text> },
    { title: "兑换码", dataIndex: "code_preview", key: "code" },
    { title: "增加时长", dataIndex: "duration_days", key: "days", render: (value: number) => <Tag color="blue">+{value}天</Tag> },
  ];

  return (
    <AdminPageFrame
      eyebrow="增长与权益"
      title="兑换码与邀请奖励"
      description="管理会员兑换码、使用记录和邀请双方奖励。明文兑换码只在生成后展示一次。"
      loading={loading}
      error={error}
      onReload={() => void reload()}
      extra={canWrite ? <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>生成兑换码</Button> : undefined}
    >
      {!canRead ? <Alert showIcon type="warning" message="当前角色没有增长数据查看权限" /> : <>
        {notice && <Alert closable showIcon type="info" message={notice} onClose={() => setNotice("")} style={{ marginBottom: 18 }} />}
        {!canWrite && <Alert showIcon type="warning" message="只读模式" style={{ marginBottom: 18 }} />}
        <Row gutter={[16, 16]} style={{ marginBottom: 20 }}>
          <Col xs={12} lg={6}><Card><Statistic title="可用兑换码" value={data.codes.filter((item) => item.status === "active").length} /></Card></Col>
          <Col xs={12} lg={6}><Card><Statistic title="最近兑换" value={data.redemptions.length} /></Card></Col>
          <Col xs={12} lg={6}><Card><Statistic title="7日活跃用户" value={data.analytics?.activeUsers ?? 0} /></Card></Col>
          <Col xs={12} lg={6}><Card><Statistic title="兑换成功事件" value={eventCount("redeem_success")} /></Card></Col>
        </Row>
        <Tabs items={[
          { key: "codes", label: "兑换码管理", children: <Card><Table<CodeItem> rowKey="id" columns={codeColumns} dataSource={data.codes} pagination={{ pageSize: 20, showSizeChanger: false }} scroll={{ x: 880 }} /></Card> },
          { key: "records", label: "兑换记录", children: <Card><Table<Redemption> rowKey={(row) => `${row.redeemed_at}-${row.user_id}-${row.code_preview}`} columns={redemptionColumns} dataSource={data.redemptions} pagination={{ pageSize: 20, showSizeChanger: false }} scroll={{ x: 720 }} /></Card> },
          { key: "invite", label: "邀请奖励", children: <Card title="邀请双方奖励配置"><Typography.Paragraph type="secondary">好友首次成功激活会员码后，邀请人和被邀请人获得相同时长；只记录直接邀请，不形成多级分销。</Typography.Paragraph><Form<InviteForm> form={inviteForm} layout="vertical" onFinish={updateInvite} style={{ maxWidth: 640 }}><Row gutter={16}><Col xs={24} sm={12}><Form.Item label="双方奖励天数" name="rewardDays" rules={[{ required: true }]}><InputNumber min={0} max={365} style={{ width: "100%" }} /></Form.Item></Col><Col xs={24} sm={12}><Form.Item label="邀请人月度奖励上限" name="monthlyCap" rules={[{ required: true }]}><InputNumber min={0} max={3650} style={{ width: "100%" }} /></Form.Item></Col></Row><Button type="primary" htmlType="submit" disabled={!canWrite} loading={saving}>保存配置</Button></Form></Card> },
        ]} />
      </>}

      <Modal title="生成兑换码批次" open={createOpen} onCancel={() => setCreateOpen(false)} footer={null} destroyOnHidden>
        <Form<CodeForm> form={codeForm} layout="vertical" initialValues={{ batchName: "渠道体验码", durationDays: 7, count: 10, maxUses: 1 }} onFinish={createCodes}>
          <Form.Item label="批次名称" name="batchName" rules={[{ required: true, message: "请输入批次名称" }]}><Input maxLength={60} /></Form.Item>
          <Form.Item label="会员时长" name="durationDays" rules={[{ required: true }]}><Select options={[7, 30, 365].map((value) => ({ value, label: `${value}天` }))} /></Form.Item>
          <Row gutter={16}><Col span={12}><Form.Item label="生成数量" name="count" rules={[{ required: true }]}><InputNumber min={1} max={200} style={{ width: "100%" }} /></Form.Item></Col><Col span={12}><Form.Item label="每码可用次数" name="maxUses" rules={[{ required: true }]}><InputNumber min={1} max={1000} style={{ width: "100%" }} /></Form.Item></Col></Row>
          <Form.Item label="兑换截止日期" name="validUntil"><Input type="date" /></Form.Item>
          <Space style={{ width: "100%", justifyContent: "flex-end" }}><Button onClick={() => setCreateOpen(false)}>取消</Button><Button type="primary" htmlType="submit" loading={saving}>生成</Button></Space>
        </Form>
      </Modal>

      <Modal title="本批明文兑换码" open={generated.length > 0} onCancel={() => setGenerated([])} footer={<Space><Button icon={<CopyOutlined />} onClick={() => { void navigator.clipboard.writeText(generated.join("\n")); setNotice("本批兑换码已复制"); }}>复制全部</Button><Button type="primary" onClick={() => setGenerated([])}>我已保存</Button></Space>}>
        <Alert showIcon type="warning" message="关闭后无法再次查看完整明文" style={{ marginBottom: 14 }} />
        <Input.TextArea readOnly autoSize={{ minRows: 8, maxRows: 16 }} value={generated.join("\n")} />
      </Modal>
    </AdminPageFrame>
  );
}
