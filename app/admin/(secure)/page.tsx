"use client";

import {
  AlertOutlined,
  BookOutlined,
  CheckCircleOutlined,
  CloudUploadOutlined,
  FileDoneOutlined,
  FileTextOutlined,
  GiftOutlined,
  RadarChartOutlined,
  ReloadOutlined,
  RightOutlined,
  TeamOutlined,
} from "@ant-design/icons";
import { ProCard, StatisticCard } from "@ant-design/pro-components";
import { Alert, App, Button, Empty, Progress, Skeleton, Space, Tag, Timeline, Typography } from "antd";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAdminSession } from "../AdminShell";

const { Title, Paragraph, Text } = Typography;

type DashboardMetrics = {
  users: number;
  activeUsers7d: number;
  publishedContent: number;
  pendingReview: number;
  pendingQuestions: number;
  questionBanks: number;
  questions: number;
  redemptions7d: number;
};

type Funnel7d = {
  goals: number; banks: number; snapshotStarted: number; snapshotCompleted: number; loginGateViewed: number;
  formalStarted: number; practiceCompleted: number; reviewViewed: number; nextDayReturned: number; paywallViewed: number; redeemed: number;
  quizStarted: number; quizCompleted: number; quizShared: number; quizFriendOpened: number; quizFriendStarted: number; quizToDaily: number;
};
const EMPTY_FUNNEL: Funnel7d = { goals: 0, banks: 0, snapshotStarted: 0, snapshotCompleted: 0, loginGateViewed: 0, formalStarted: 0, practiceCompleted: 0, reviewViewed: 0, nextDayReturned: 0, paywallViewed: 0, redeemed: 0, quizStarted: 0, quizCompleted: 0, quizShared: 0, quizFriendOpened: 0, quizFriendStarted: 0, quizToDaily: 0 };
type FrameworkConfig = Record<"resource_card" | "campaign_slot" | "paywall_policy", { published: number; pending: number; draft: number }>;

type DashboardNotice = {
  id: string | number;
  type: string;
  title: string;
  description: string;
  count: number;
  href: string;
  priority?: "high" | "medium" | "low" | string;
  severity?: "error" | "warning" | "info" | string;
};

type ActivityItem = {
  id: string | number;
  action: string;
  description: string;
  actor: string;
  createdAt: string;
};

type DashboardData = {
  metrics: DashboardMetrics;
  todos: DashboardNotice[];
  anomalies: DashboardNotice[];
  recentActivity: ActivityItem[];
  funnel7d: Funnel7d;
  frameworkConfig: FrameworkConfig;
  coreFlow7d: { started: number; succeeded: number; failed: number; successRate: number | null; medianFirstQuestionMs: number | null; firstQuestionWithin60s: boolean | null };
};

const EMPTY_METRICS: DashboardMetrics = {
  users: 0,
  activeUsers7d: 0,
  publishedContent: 0,
  pendingReview: 0,
  pendingQuestions: 0,
  questionBanks: 0,
  questions: 0,
  redemptions7d: 0,
};

function number(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeNotices(value: unknown): DashboardNotice[] {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    const data = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    return {
      id: (data.id as string | number | undefined) ?? index,
      type: String(data.type ?? "general"),
      title: String(data.title ?? "待处理事项"),
      description: String(data.description ?? ""),
      count: number(data.count),
      href: String(data.href ?? "/admin"),
      priority: data.priority ? String(data.priority) : undefined,
      severity: data.severity ? String(data.severity) : undefined,
    };
  });
}

function normalizeActivities(value: unknown): ActivityItem[] {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    const data = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    return {
      id: (data.id as string | number | undefined) ?? index,
      action: String(data.action ?? data.actionType ?? data.type ?? "后台操作"),
      description: String(data.description ?? data.summary ?? data.resourceTitle ?? ""),
      actor: String(data.actor ?? data.adminName ?? data.username ?? "系统"),
      createdAt: String(data.createdAt ?? data.created_at ?? ""),
    };
  });
}

function normalizeDashboard(raw: Record<string, unknown>): DashboardData {
  const source = (raw.metrics && typeof raw.metrics === "object" ? raw.metrics : {}) as Record<string, unknown>;
  return {
    metrics: {
      users: number(source.users),
      activeUsers7d: number(source.activeUsers7d ?? source.active_users_7d),
      publishedContent: number(source.publishedContent ?? source.published_content),
      pendingReview: number(source.pendingReview ?? source.pending_review),
      pendingQuestions: number(source.pendingQuestions ?? source.pending_questions),
      questionBanks: number(source.questionBanks ?? source.question_banks),
      questions: number(source.questions),
      redemptions7d: number(source.redemptions7d ?? source.redemptions_7d),
    },
    todos: normalizeNotices(raw.todos),
    anomalies: normalizeNotices(raw.anomalies),
    recentActivity: normalizeActivities(raw.recentActivity ?? raw.recent_activity),
    funnel7d: (() => { const value = (raw.funnel7d && typeof raw.funnel7d === "object" ? raw.funnel7d : {}) as Record<string, unknown>; return Object.fromEntries(Object.keys(EMPTY_FUNNEL).map((key) => [key, number(value[key])])) as unknown as Funnel7d; })(),
    coreFlow7d: (() => { const value = (raw.coreFlow7d && typeof raw.coreFlow7d === "object" ? raw.coreFlow7d : {}) as Record<string, unknown>; return { started: number(value.started), succeeded: number(value.succeeded), failed: number(value.failed), successRate: value.successRate === null || value.successRate === undefined ? null : number(value.successRate), medianFirstQuestionMs: value.medianFirstQuestionMs === null || value.medianFirstQuestionMs === undefined ? null : number(value.medianFirstQuestionMs), firstQuestionWithin60s: typeof value.firstQuestionWithin60s === "boolean" ? value.firstQuestionWithin60s : null }; })(),
    frameworkConfig: (() => {
      const value = (raw.frameworkConfig && typeof raw.frameworkConfig === "object" ? raw.frameworkConfig : {}) as Record<string, unknown>;
      const row = (key: string) => { const item = (value[key] && typeof value[key] === "object" ? value[key] : {}) as Record<string, unknown>; return { published: number(item.published), pending: number(item.pending), draft: number(item.draft) }; };
      return { resource_card: row("resource_card"), campaign_slot: row("campaign_slot"), paywall_policy: row("paywall_policy") };
    })(),
  };
}

const PRIORITY_LABEL: Record<string, { label: string; color: string }> = {
  high: { label: "优先处理", color: "error" },
  medium: { label: "今日处理", color: "warning" },
  low: { label: "待处理", color: "default" },
};

const SEVERITY_LABEL: Record<string, { label: string; color: string }> = {
  error: { label: "异常", color: "error" },
  warning: { label: "需关注", color: "warning" },
  info: { label: "提示", color: "processing" },
};

function formatActivityTime(value: string) {
  if (!value) return "刚刚";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}

export default function AdminDashboardPage() {
  const { admin, can } = useAdminSession();
  const { message } = App.useApp();
  const [data, setData] = useState<DashboardData>({ metrics: EMPTY_METRICS, todos: [], anomalies: [], recentActivity: [], funnel7d: EMPTY_FUNNEL, coreFlow7d: { started: 0, succeeded: 0, failed: 0, successRate: null, medianFirstQuestionMs: null, firstQuestionWithin60s: null }, frameworkConfig: { resource_card: { published: 0, pending: 0, draft: 0 }, campaign_slot: { published: 0, pending: 0, draft: 0 }, paywall_policy: { published: 0, pending: 0, draft: 0 } } });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/app", {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "adminDashboard" }),
      });
      const payload = await response.json().catch(() => ({})) as Record<string, unknown> & { error?: string };
      if (!response.ok) throw new Error(payload.error || "工作台加载失败");
      setData(normalizeDashboard(payload));
    } catch (reason) {
      message.error(reason instanceof Error ? reason.message : "工作台加载失败");
    } finally {
      setLoading(false);
    }
  }, [message]);

  const refresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  useEffect(() => {
    const task = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(task);
  }, [load]);

  const activeRate = data.metrics.users > 0
    ? Math.min(100, Math.round(data.metrics.activeUsers7d / data.metrics.users * 100))
    : 0;
  const questionsPerBank = data.metrics.questionBanks > 0
    ? Math.round(data.metrics.questions / data.metrics.questionBanks)
    : 0;
  const greeting = useMemo(() => {
    const hour = new Date().getHours();
    if (hour < 11) return "早上好";
    if (hour < 14) return "中午好";
    if (hour < 18) return "下午好";
    return "晚上好";
  }, []);

  const quickActions = [
    can("content.read") && { label: "新建内容", description: "晨读、时政、申论或电台", href: "/admin/content", icon: <FileTextOutlined /> },
    can("question.import") && { label: "导入真题", description: "上传、校验并确认入库", href: "/admin/imports", icon: <CloudUploadOutlined /> },
    can("radar.read") && { label: "更新公考雷达", description: "公告、节点与职位数据", href: "/admin/radar", icon: <RadarChartOutlined /> },
    can("growth.read") && { label: "生成兑换码", description: "配置会员时长与批次", href: "/admin/growth", icon: <GiftOutlined /> },
  ].filter(Boolean) as Array<{ label: string; description: string; href: string; icon: React.ReactNode }>;
  const learningFunnelStages = [
    ["选择目标", data.funnel7d.goals], ["开始快照", data.funnel7d.snapshotStarted], ["完成快照", data.funnel7d.snapshotCompleted],
    ["进入登录", data.funnel7d.loginGateViewed], ["正式训练", data.funnel7d.formalStarted], ["完成日练", data.funnel7d.practiceCompleted],
    ["查看复盘", data.funnel7d.reviewViewed], ["次日返回", data.funnel7d.nextDayReturned], ["兑换激活", data.funnel7d.redeemed],
  ] as Array<[string, number]>;
  const quizFunnelStages = [
    ["开始测试", data.funnel7d.quizStarted], ["生成结果", data.funnel7d.quizCompleted], ["点击分享", data.funnel7d.quizShared],
    ["好友打开", data.funnel7d.quizFriendOpened], ["好友开测", data.funnel7d.quizFriendStarted], ["进入日练", data.funnel7d.quizToDaily],
  ] as Array<[string, number]>;
  const configRows = [
    ["资料入口", "resource_card"], ["营销活动", "campaign_slot"], ["权益策略", "paywall_policy"],
  ] as Array<[string, keyof FrameworkConfig]>;

  return (
    <div className="admin-dashboard">
      <header className="admin-page-heading">
        <div>
          <Text className="admin-page-kicker">运营工作台</Text>
          <Title level={2}>{greeting}，{admin.displayName}</Title>
          <Paragraph>优先处理审核、导入失败和空题库，其他运营工作按模块进入。</Paragraph>
        </div>
        <Button icon={<ReloadOutlined />} loading={refreshing} onClick={() => void refresh()}>刷新数据</Button>
      </header>

      {loading ? <Skeleton active paragraph={{ rows: 8 }} /> : (
        <>
          {data.anomalies.some((item) => item.severity === "error") && (
            <Alert
              className="admin-dashboard-alert"
              type="error"
              showIcon
              message="存在影响用户训练的异常"
              description="请优先处理导入失败、空题库或未发布内容，避免用户端出现无题可练。"
              action={<Button size="small" onClick={() => document.getElementById("admin-anomalies")?.scrollIntoView({ behavior: "smooth" })}>查看异常</Button>}
            />
          )}

          <div className="admin-metric-grid" aria-label="核心运营数据">
            <StatisticCard statistic={{ title: "用户总量", value: data.metrics.users, icon: <TeamOutlined /> }} />
            <StatisticCard statistic={{ title: "7日活跃用户", value: data.metrics.activeUsers7d, suffix: <small>人</small>, icon: <CheckCircleOutlined /> }} />
            <StatisticCard statistic={{ title: "已发布内容", value: data.metrics.publishedContent, icon: <FileDoneOutlined /> }} />
            <StatisticCard statistic={{ title: "待审核", value: data.metrics.pendingReview, valueStyle: data.metrics.pendingReview > 0 ? { color: "#d46b08" } : undefined, icon: <AlertOutlined /> }} />
            <StatisticCard statistic={{ title: "真题总量", value: data.metrics.questions, icon: <BookOutlined /> }} />
            <StatisticCard statistic={{ title: "7日兑换", value: data.metrics.redemptions7d, suffix: <small>次</small>, icon: <GiftOutlined /> }} />
          </div>

          <div className="admin-dashboard-grid primary admin-framework-overview">
            <ProCard className="admin-work-card" title="核心流程验收" extra={<Text type="secondary">近7日真实用户</Text>}>
              <div className="admin-health-list">
                <div><span><strong>首次进入第一题中位时间</strong><small>目标不超过60秒</small></span><b className={data.coreFlow7d.firstQuestionWithin60s === false ? "warning" : "success"}>{data.coreFlow7d.medianFirstQuestionMs === null ? "待积累" : `${Math.round(data.coreFlow7d.medianFirstQuestionMs / 100) / 10}秒`}</b></div>
                <div><span><strong>核心流程成功率</strong><small>{data.coreFlow7d.succeeded}/{data.coreFlow7d.started} 次</small></span><b className={(data.coreFlow7d.successRate ?? 100) < 99.5 ? "warning" : "success"}>{data.coreFlow7d.successRate === null ? "待积累" : `${data.coreFlow7d.successRate}%`}</b></div>
              </div>
            </ProCard>
            <ProCard className="admin-work-card" title="关键转化漏斗（学习）" extra={<Text type="secondary">近7日去重用户</Text>}>
              <div className="admin-funnel-row">{learningFunnelStages.map(([label, value], index) => {
                const previous = index > 0 ? learningFunnelStages[index - 1][1] : value;
                const rate = previous > 0 ? Math.min(100, Math.round(value / previous * 100)) : 0;
                return <article key={label}><span>{index + 1}</span><b>{value}</b><small>{label}</small>{index > 0 && <em>{rate}%</em>}</article>;
              })}</div>
            </ProCard>
            <ProCard className="admin-work-card" title="局长思维传播漏斗" extra={<Text type="secondary">独立于学习诊断</Text>}>
              <div className="admin-funnel-row">{quizFunnelStages.map(([label, value], index) => {
                const previous = index > 0 ? quizFunnelStages[index - 1][1] : value;
                const rate = previous > 0 ? Math.min(100, Math.round(value / previous * 100)) : 0;
                return <article key={label}><span>{index + 1}</span><b>{value}</b><small>{label}</small>{index > 0 && <em>{rate}%</em>}</article>;
              })}</div>
            </ProCard>
            <ProCard className="admin-work-card" title="框架配置运行状态" extra={<Link href="/admin/content">进入配置</Link>}>
              <div className="admin-health-list">
                {configRows.map(([label, key]) => {
                  const item = data.frameworkConfig[key];
                  return <div key={key}>
                    <span><strong>{label}</strong><small>待审核 {item.pending} · 草稿 {item.draft}</small></span>
                    <b className={item.published > 0 ? "success" : "warning"}>{item.published > 0 ? `已发布 ${item.published}` : "暂无已发布配置"}</b>
                  </div>;
                })}
              </div>
            </ProCard>
          </div>

          <div className="admin-dashboard-grid primary">
            <ProCard className="admin-work-card" title="今日待办" extra={<Tag color={data.todos.length ? "warning" : "success"}>{data.todos.length} 项</Tag>}>
              {data.todos.length ? (
                <div className="admin-notice-list">
                  {data.todos.map((item) => {
                    const priority = PRIORITY_LABEL[item.priority ?? "low"] ?? PRIORITY_LABEL.low;
                    return (
                      <article key={item.id}>
                        <span className="admin-notice-icon"><FileDoneOutlined /></span>
                        <div><Space size={6}><strong>{item.title}</strong>{item.count > 0 && <Tag>{item.count}</Tag>}</Space><p>{item.description}</p></div>
                        <Tag color={priority.color}>{priority.label}</Tag>
                        <Link href={item.href}>去处理 <RightOutlined /></Link>
                      </article>
                    );
                  })}
                </div>
              ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="今天没有待处理事项" />}
            </ProCard>

            <ProCard className="admin-work-card" title="运营概览" extra={<Text type="secondary">近7日</Text>}>
              <div className="admin-health-list">
                <div><span><strong>用户活跃率</strong><small>{data.metrics.activeUsers7d}/{data.metrics.users} 人</small></span><Progress percent={activeRate} strokeColor="#176b87" /></div>
                <div><span><strong>平均题库题量</strong><small>{data.metrics.questionBanks} 个题库</small></span><b>{questionsPerBank}<small>题/库</small></b></div>
                <div><span><strong>审核队列</strong><small>待审核内容与数据</small></span><b className={data.metrics.pendingReview ? "warning" : "success"}>{data.metrics.pendingReview}<small>项</small></b></div>
              </div>
            </ProCard>
          </div>

          <ProCard className="admin-work-card admin-quick-card" title="快捷入口" extra={<Text type="secondary">按你的角色展示</Text>}>
            <div className="admin-quick-grid">
              {quickActions.map((item) => <Link key={item.href} href={item.href}><span>{item.icon}</span><div><strong>{item.label}</strong><small>{item.description}</small></div><RightOutlined /></Link>)}
            </div>
          </ProCard>

          <div className="admin-dashboard-grid secondary">
            <ProCard id="admin-anomalies" className="admin-work-card" title="异常与提醒" extra={<Tag color={data.anomalies.length ? "error" : "success"}>{data.anomalies.length ? `${data.anomalies.length} 项需关注` : "运行正常"}</Tag>}>
              {data.anomalies.length ? (
                <div className="admin-anomaly-list">
                  {data.anomalies.map((item) => {
                    const severity = SEVERITY_LABEL[item.severity ?? "info"] ?? SEVERITY_LABEL.info;
                    return <article key={item.id}><span><Tag color={severity.color}>{severity.label}</Tag><strong>{item.title}</strong></span><p>{item.description}</p><Link href={item.href}>{item.count > 0 ? `${item.count} 项 · ` : ""}立即查看 <RightOutlined /></Link></article>;
                  })}
                </div>
              ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂未发现异常" />}
            </ProCard>

            <ProCard className="admin-work-card" title="最近操作" extra={can("audit.read") || can("system.read") ? <Link href="/admin/system">全部日志</Link> : undefined}>
              {data.recentActivity.length ? (
                <Timeline items={data.recentActivity.slice(0, 6).map((item) => ({
                  color: "#176b87",
                  children: <div className="admin-activity"><strong>{item.action}</strong><p>{item.description || "已完成后台操作"}</p><small>{item.actor} · {formatActivityTime(item.createdAt)}</small></div>,
                }))} />
              ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无操作记录" />}
            </ProCard>
          </div>
        </>
      )}
    </div>
  );
}
