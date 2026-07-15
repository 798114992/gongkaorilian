"use client";

import { useMemo, useState } from "react";
import { Alert, Button, Card, Descriptions, Form, Input, Modal, Popconfirm, Select, Space, Table, Tabs, Tag, Typography } from "antd";
import { PlusOutlined, SafetyCertificateOutlined } from "@ant-design/icons";
import { useAdminSession } from "../../AdminShell";
import AdminPageFrame from "../_components/AdminPageFrame";
import { adminApi } from "../_components/adminApi";
import { useAdminDomain } from "../_components/useAdminDomain";

type AdminUser = {
  id: number;
  username: string;
  displayName: string;
  role: AdminRole;
  status: "active" | "disabled";
  lastLoginAt: string | null;
  createdAt: string;
};

type AuditLog = {
  id: number;
  adminUserId: number | null;
  username: string;
  role: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  summary: string;
  result: "success" | "failed";
  details: string | null;
  ipAddress: string | null;
  createdAt: string;
};

type AdminRole = "super_admin" | "content_editor" | "question_editor" | "radar_editor" | "growth_operator" | "reviewer" | "read_only";
type SystemDomain = { admins: AdminUser[]; auditLogs: AuditLog[]; pagination?: { page: number; pageSize: number; total: number } };
type UserForm = { username: string; displayName: string; role: AdminRole; password?: string };
const initialData: SystemDomain = { admins: [], auditLogs: [] };

const ROLE_OPTIONS: Array<{ value: AdminRole; label: string; description: string; capabilities: string[] }> = [
  { value: "super_admin", label: "超级管理员", description: "完整管理权限", capabilities: ["全部业务", "账号与权限", "操作日志"] },
  { value: "content_editor", label: "内容运营", description: "制作内容并提交审核", capabilities: ["晨读/时政/申论", "电台与媒体", "提交审核"] },
  { value: "question_editor", label: "题库运营", description: "维护题库及导入真题", capabilities: ["题库配置", "题目导入", "导入记录"] },
  { value: "radar_editor", label: "招考运营", description: "维护公告、节点和职位", capabilities: ["招考公告", "考试节点", "职位表"] },
  { value: "growth_operator", label: "增长运营", description: "管理兑换码与邀请奖励", capabilities: ["兑换码", "兑换记录", "邀请奖励"] },
  { value: "reviewer", label: "审核发布", description: "审核内容与真题，负责发布、下架及回滚", capabilities: ["内容审核", "真题核验", "发布/下架", "版本回滚"] },
  { value: "read_only", label: "只读人员", description: "只查看已授权业务数据", capabilities: ["查看工作台", "查看业务数据", "不可修改"] },
];
const roleLabel = (role: string) => ROLE_OPTIONS.find((item) => item.value === role)?.label ?? role;

export default function SystemPage() {
  const { admin, can } = useAdminSession();
  const { data, loading, error, reload } = useAdminDomain<SystemDomain>("adminListSystem", initialData);
  const [notice, setNotice] = useState("");
  const [userModal, setUserModal] = useState<{ open: boolean; user: AdminUser | null }>({ open: false, user: null });
  const [saving, setSaving] = useState(false);
  const [auditKeyword, setAuditKeyword] = useState("");
  const [userForm] = Form.useForm<UserForm>();
  const canSystemRead = can("system.read");
  const canManageUsers = can("users.manage");
  const canReadAudit = can("audit.read");
  const canRead = canSystemRead || canManageUsers || canReadAudit;

  const openUserModal = (user: AdminUser | null) => {
    setUserModal({ open: true, user });
    userForm.setFieldsValue(user ? { username: user.username, displayName: user.displayName, role: user.role, password: "" } : { username: "", displayName: "", role: "read_only", password: "" });
  };

  const saveUser = async (values: UserForm) => {
    setSaving(true);
    try {
      if (userModal.user) {
        await adminApi({ action: "adminUpdateUser", id: userModal.user.id, displayName: values.displayName, role: values.role, ...(values.password ? { password: values.password } : {}) });
        setNotice("管理员资料与角色已更新");
      } else {
        await adminApi({ action: "adminCreateUser", ...values });
        setNotice("管理员账号已创建");
      }
      setUserModal({ open: false, user: null });
      userForm.resetFields();
      await reload();
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "管理员保存失败");
    } finally {
      setSaving(false);
    }
  };

  const toggleUser = async (user: AdminUser) => {
    try {
      const status = user.status === "active" ? "disabled" : "active";
      await adminApi({ action: "adminSetUserStatus", id: user.id, status });
      setNotice(status === "active" ? "管理员账号已启用" : "管理员账号已停用");
      await reload();
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "账号状态更新失败");
    }
  };

  const filteredAudit = useMemo(() => {
    const keyword = auditKeyword.trim().toLowerCase();
    if (!keyword) return data.auditLogs;
    return data.auditLogs.filter((item) => `${item.username} ${item.action} ${item.summary} ${item.resourceType}`.toLowerCase().includes(keyword));
  }, [auditKeyword, data.auditLogs]);

  const userColumns = [
    { title: "管理员", key: "user", render: (_: unknown, row: AdminUser) => <><Typography.Text strong>{row.displayName}</Typography.Text><br /><Typography.Text type="secondary">{row.username}</Typography.Text></> },
    { title: "角色", dataIndex: "role", key: "role", render: (value: string) => <Tag color={value === "super_admin" ? "gold" : value === "reviewer" ? "purple" : "blue"}>{roleLabel(value)}</Tag> },
    { title: "状态", dataIndex: "status", key: "status", render: (value: string) => <Tag color={value === "active" ? "green" : "default"}>{value === "active" ? "正常" : "已停用"}</Tag> },
    { title: "最近登录", dataIndex: "lastLoginAt", key: "lastLogin", render: (value: string | null) => value ? new Date(value).toLocaleString("zh-CN") : "尚未登录" },
    { title: "操作", key: "action", render: (_: unknown, row: AdminUser) => <Space><Button type="link" disabled={!canManageUsers} onClick={() => openUserModal(row)}>编辑</Button><Popconfirm title={row.status === "active" ? "确认停用这个管理员？" : "确认重新启用？"} onConfirm={() => void toggleUser(row)}><Button danger={row.status === "active"} type="link" disabled={!canManageUsers || String(row.id) === String(admin?.id)}>{row.status === "active" ? "停用" : "启用"}</Button></Popconfirm></Space> },
  ];

  const auditColumns = [
    { title: "时间", dataIndex: "createdAt", key: "time", width: 180, render: (value: string) => new Date(value).toLocaleString("zh-CN") },
    { title: "管理员", key: "admin", render: (_: unknown, row: AuditLog) => <><Typography.Text>{row.username || "系统"}</Typography.Text><br /><Typography.Text type="secondary">{roleLabel(row.role)}</Typography.Text></> },
    { title: "操作", key: "operation", render: (_: unknown, row: AuditLog) => <><Typography.Text strong>{row.summary || row.action}</Typography.Text><br /><Typography.Text type="secondary">{row.action}</Typography.Text></> },
    { title: "对象", key: "resource", render: (_: unknown, row: AuditLog) => `${row.resourceType || "—"}${row.resourceId ? ` #${row.resourceId}` : ""}` },
    { title: "结果", dataIndex: "result", key: "result", render: (value: string) => <Tag color={value === "success" ? "green" : "red"}>{value === "success" ? "成功" : "失败"}</Tag> },
  ];

  const tabs = [
    ...(canSystemRead || canManageUsers ? [
      { key: "users", label: "管理员", children: <Card><Table<AdminUser> rowKey="id" columns={userColumns} dataSource={data.admins} pagination={{ pageSize: 20, showSizeChanger: false }} scroll={{ x: 820 }} /></Card> },
      { key: "roles", label: "角色权限", children: <div style={{ display: "grid", gap: 14 }}>{ROLE_OPTIONS.map((role) => <Card key={role.value} size="small"><Descriptions column={{ xs: 1, sm: 3 }} title={<Space><SafetyCertificateOutlined /><span>{role.label}</span></Space>} items={[{ key: "description", label: "职责", children: role.description }, { key: "capabilities", label: "主要能力", span: 2, children: <Space wrap>{role.capabilities.map((item) => <Tag key={item}>{item}</Tag>)}</Space> }]} /></Card>)}</div> },
    ] : []),
    ...(canReadAudit ? [{ key: "audit", label: "操作日志", children: <Card title="最近审计记录" extra={<Input.Search allowClear placeholder="搜索管理员、操作或对象" value={auditKeyword} onChange={(event) => setAuditKeyword(event.target.value)} style={{ width: 280 }} />}><Table<AuditLog> rowKey="id" columns={auditColumns} dataSource={filteredAudit} pagination={{ pageSize: 20, showSizeChanger: false }} scroll={{ x: 900 }} /></Card> }] : []),
  ];

  return (
    <AdminPageFrame
      eyebrow="系统管理"
      title="管理员、角色与审计"
      description="采用最小权限原则分配角色。关键修改、审核、发布、下架和兑换码操作均进入审计日志。"
      loading={loading}
      error={error}
      onReload={() => void reload()}
      extra={canManageUsers ? <Button type="primary" icon={<PlusOutlined />} onClick={() => openUserModal(null)}>新增管理员</Button> : undefined}
    >
      {!canRead ? <Alert showIcon type="warning" message="当前角色没有系统管理查看权限" /> : <>
        {notice && <Alert closable showIcon type="info" message={notice} onClose={() => setNotice("")} style={{ marginBottom: 18 }} />}
        <Tabs items={tabs} />
      </>}

      <Modal title={userModal.user ? "编辑管理员" : "新增管理员"} open={userModal.open} onCancel={() => setUserModal({ open: false, user: null })} footer={null} destroyOnHidden>
        <Form<UserForm> form={userForm} layout="vertical" onFinish={saveUser}>
          <Form.Item label="登录账号" name="username" rules={[{ required: true, message: "请输入登录账号" }, { pattern: /^[a-zA-Z0-9._-]{3,40}$/, message: "使用3—40位字母、数字、点、下划线或短横线" }]}><Input disabled={Boolean(userModal.user)} autoComplete="off" /></Form.Item>
          <Form.Item label="显示名称" name="displayName" rules={[{ required: true, message: "请输入显示名称" }]}><Input maxLength={40} /></Form.Item>
          <Form.Item label="角色" name="role" rules={[{ required: true }]}><Select options={ROLE_OPTIONS.map((item) => ({ value: item.value, label: `${item.label}｜${item.description}` }))} /></Form.Item>
          <Form.Item label={userModal.user ? "重置密码（留空则不修改）" : "初始密码"} name="password" rules={userModal.user ? [{ min: 10, message: "密码至少10位" }] : [{ required: true, message: "请输入初始密码" }, { min: 10, message: "密码至少10位" }]}><Input.Password autoComplete="new-password" /></Form.Item>
          <Space style={{ width: "100%", justifyContent: "flex-end" }}><Button onClick={() => setUserModal({ open: false, user: null })}>取消</Button><Button type="primary" htmlType="submit" loading={saving}>保存</Button></Space>
        </Form>
      </Modal>
    </AdminPageFrame>
  );
}
