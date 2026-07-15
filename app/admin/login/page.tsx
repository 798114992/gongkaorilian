"use client";

import { ArrowLeftOutlined, LockOutlined, SafetyCertificateOutlined, UserOutlined } from "@ant-design/icons";
import { Alert, App, Button, Card, ConfigProvider, Form, Input, Typography } from "antd";
import zhCN from "antd/locale/zh_CN";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

const { Title, Paragraph, Text } = Typography;

type LoginValues = { username: string; password: string };

function safeReturnTo(value: string | null) {
  if (!value || !value.startsWith("/admin") || value.startsWith("//") || value.startsWith("/admin/login")) return "/admin";
  return value;
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { message } = App.useApp();
  const [loading, setLoading] = useState(false);
  const [sessionChecking, setSessionChecking] = useState(true);
  const [error, setError] = useState("");
  const returnTo = safeReturnTo(searchParams.get("returnTo"));

  useEffect(() => {
    let active = true;
    void fetch("/api/app", {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "adminSession" }),
    }).then(async (response) => {
      const data = await response.json().catch(() => ({})) as { authenticated?: boolean };
      if (active && response.ok && data.authenticated) router.replace(returnTo);
    }).catch(() => undefined).finally(() => {
      if (active) setSessionChecking(false);
    });
    return () => { active = false; };
  }, [returnTo, router]);

  const submit = async (values: LoginValues) => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/app", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "adminLogin", username: values.username.trim(), password: values.password }),
      });
      const data = await response.json().catch(() => ({})) as { error?: string; authenticated?: boolean };
      if (!response.ok || !data.authenticated) throw new Error(data.error || "账号或密码错误");
      message.success("登录成功");
      router.replace(returnTo);
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "登录失败，请稍后重试");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="admin-login-page">
      <section className="admin-login-brand-panel" aria-label="公考日练运营后台介绍">
        <Link href="/" className="admin-login-back"><ArrowLeftOutlined /> 返回用户端</Link>
        <div className="admin-login-brand">
          <span className="admin-brand-mark large">公</span>
          <div><strong>公考日练</strong><small>运营管理后台</small></div>
        </div>
        <div className="admin-login-promise">
          <Text>内容、题库、招考数据与用户权益</Text>
          <Title level={1}>一处管理，清楚完成今天的运营工作</Title>
          <Paragraph>登录后只展示与你角色相关的菜单和待办。发布、下架、导入及权限变更均会留下操作记录。</Paragraph>
        </div>
        <div className="admin-login-security"><SafetyCertificateOutlined /><span><strong>安全会话</strong><small>登录状态使用安全 Cookie 保存，管理口令不会存入浏览器。</small></span></div>
      </section>

      <section className="admin-login-form-panel">
        <Card className="admin-login-card" bordered={false}>
          <div className="admin-login-card-heading">
            <Text type="secondary">ADMIN CONSOLE</Text>
            <Title level={2}>管理员登录</Title>
            <Paragraph>使用超级管理员分配的账号进入后台</Paragraph>
          </div>
          {error && <Alert className="admin-login-error" type="error" showIcon message={error} />}
          <Form<LoginValues> layout="vertical" size="large" requiredMark={false} onFinish={submit} disabled={sessionChecking}>
            <Form.Item label="管理员账号" name="username" rules={[{ required: true, message: "请输入管理员账号" }]}>
              <Input prefix={<UserOutlined />} autoComplete="username" placeholder="请输入账号" autoFocus />
            </Form.Item>
            <Form.Item label="登录密码" name="password" rules={[{ required: true, message: "请输入登录密码" }]}>
              <Input.Password prefix={<LockOutlined />} autoComplete="current-password" placeholder="请输入密码" />
            </Form.Item>
            <Button className="admin-login-submit" type="primary" htmlType="submit" loading={loading || sessionChecking} block>
              {sessionChecking ? "正在检查登录状态" : "安全登录"}
            </Button>
          </Form>
          <Alert
            className="admin-login-initial-note"
            type="info"
            showIcon
            message="首次初始化：账号使用 admin，密码使用原管理口令。"
          />
          <div className="admin-login-help"><SafetyCertificateOutlined /><span>无法登录？请联系超级管理员重置账号或权限。</span></div>
        </Card>
      </section>
    </div>
  );
}

export default function AdminLoginPage() {
  return (
    <ConfigProvider locale={zhCN} theme={{ token: { colorPrimary: "#176b87", borderRadius: 10 } }}>
      <App><LoginForm /></App>
    </ConfigProvider>
  );
}
