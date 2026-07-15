"use client";

import {
  BarChartOutlined,
  CheckCircleOutlined,
  CrownOutlined,
  RiseOutlined,
  TeamOutlined,
  ThunderboltOutlined,
  UserSwitchOutlined,
} from "@ant-design/icons";
import {
  Alert,
  Card,
  Col,
  Empty,
  Flex,
  Progress,
  Row,
  Segmented,
  Space,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import type { TableColumnsType } from "antd";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAdminSession } from "../../AdminShell";
import AdminPageFrame from "../_components/AdminPageFrame";
import { adminApi } from "../_components/adminApi";

type AnalyticsOverview = {
  totalUsers: number;
  activeUsers7d: number;
  activeUsers30d: number;
  memberUsers: number;
  practiceAnswers30d: number;
  accuracy30d: number;
};

type DailyTrendItem = {
  date: string;
  activeUsers: number;
  opens: number;
  answers: number;
};

type FunnelItem = {
  key: string;
  label: string;
  users: number;
  rate: number;
};

type EventCountItem = {
  eventName: string;
  count: number;
  users: number;
};

type ModuleStatItem = {
  module: string;
  answers: number;
  accuracy: number;
};

type ApiHealth = {
  windowDays: number;
  sampleCount: number;
  p95Ms: number | null;
  error5xxCount: number;
  errorRate5xx: number | null;
  state: "measured" | "collecting";
  message: string;
};

type AnalyticsData = {
  overview: AnalyticsOverview;
  dailyTrend: DailyTrendItem[];
  funnel: FunnelItem[];
  eventCounts: EventCountItem[];
  moduleStats: ModuleStatItem[];
  growth: {
    redemptions30d: number;
    invites30d: number;
  };
  apiHealth: ApiHealth;
  generatedAt?: string;
};

type RawAnalyticsResponse = Record<string, unknown> & {
  analytics?: Record<string, unknown>;
  data?: Record<string, unknown>;
};

const EMPTY_DATA: AnalyticsData = {
  overview: {
    totalUsers: 0,
    activeUsers7d: 0,
    activeUsers30d: 0,
    memberUsers: 0,
    practiceAnswers30d: 0,
    accuracy30d: 0,
  },
  dailyTrend: [],
  funnel: [],
  eventCounts: [],
  moduleStats: [],
  growth: { redemptions30d: 0, invites30d: 0 },
  apiHealth: {
    windowDays: 30,
    sampleCount: 0,
    p95Ms: null,
    error5xxCount: 0,
    errorRate5xx: null,
    state: "collecting",
    message: "等待真实数据",
  },
};

const numberValue = (value: unknown) => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

const percentValue = (value: unknown) => {
  const parsed = numberValue(value);
  return Math.max(0, Math.min(100, parsed));
};

const nullableNumberValue = (value: unknown) => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const recordValue = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const arrayValue = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter((item) => item && typeof item === "object") as Record<string, unknown>[] : [];

const pick = (record: Record<string, unknown>, camel: string, snake: string) => record[camel] ?? record[snake];

function normalizeAnalytics(response: RawAnalyticsResponse): AnalyticsData {
  const root = recordValue(response.analytics ?? response.data ?? response);
  const overview = recordValue(root.overview);
  const growth = recordValue(root.growth);
  const apiHealth = recordValue(pick(root, "apiHealth", "api_health"));
  const apiSampleCount = numberValue(pick(apiHealth, "sampleCount", "sample_count"));
  const apiP95Ms = nullableNumberValue(pick(apiHealth, "p95Ms", "p95_ms"));
  const apiState = apiSampleCount > 0 && apiP95Ms !== null && apiHealth.state === "measured"
    ? "measured"
    : "collecting";

  return {
    overview: {
      totalUsers: numberValue(pick(overview, "totalUsers", "total_users")),
      activeUsers7d: numberValue(pick(overview, "activeUsers7d", "active_users_7d")),
      activeUsers30d: numberValue(pick(overview, "activeUsers30d", "active_users_30d")),
      memberUsers: numberValue(pick(overview, "memberUsers", "member_users")),
      practiceAnswers30d: numberValue(pick(overview, "practiceAnswers30d", "practice_answers_30d")),
      accuracy30d: percentValue(pick(overview, "accuracy30d", "accuracy_30d")),
    },
    dailyTrend: arrayValue(pick(root, "dailyTrend", "daily_trend")).map((item) => ({
      date: String(item.date ?? ""),
      activeUsers: numberValue(pick(item, "activeUsers", "active_users")),
      opens: numberValue(item.opens),
      answers: numberValue(item.answers),
    })).filter((item) => item.date),
    funnel: arrayValue(root.funnel).map((item, index) => ({
      key: String(item.key ?? `step-${index + 1}`),
      label: String(item.label ?? item.key ?? `第${index + 1}步`),
      users: numberValue(item.users),
      rate: percentValue(item.rate),
    })),
    eventCounts: arrayValue(pick(root, "eventCounts", "event_counts")).map((item) => ({
      eventName: String(pick(item, "eventName", "event_name") ?? "未知事件"),
      count: numberValue(item.count),
      users: numberValue(item.users),
    })),
    moduleStats: arrayValue(pick(root, "moduleStats", "module_stats")).map((item) => ({
      module: String(item.module ?? "未分类"),
      answers: numberValue(item.answers),
      accuracy: percentValue(item.accuracy),
    })),
    growth: {
      redemptions30d: numberValue(pick(growth, "redemptions30d", "redemptions_30d")),
      invites30d: numberValue(pick(growth, "invites30d", "invites_30d")),
    },
    apiHealth: {
      windowDays: numberValue(pick(apiHealth, "windowDays", "window_days")) || 30,
      sampleCount: apiSampleCount,
      p95Ms: apiP95Ms,
      error5xxCount: numberValue(pick(apiHealth, "error5xxCount", "error_5xx_count")),
      errorRate5xx: nullableNumberValue(pick(apiHealth, "errorRate5xx", "error_rate_5xx")),
      state: apiState,
      message: apiState === "measured" ? String(apiHealth.message ?? "基于真实接口请求") : "等待真实数据",
    },
    generatedAt: String(pick(root, "generatedAt", "generated_at") ?? "") || undefined,
  };
}

const formatInteger = (value: number | string) => Number(value).toLocaleString("zh-CN");

function shortDate(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return `${parsed.getMonth() + 1}/${parsed.getDate()}`;
}

function TrendChart({ items }: { items: DailyTrendItem[] }) {
  if (!items.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="所选周期暂无趋势数据" />;
  const max = {
    activeUsers: Math.max(1, ...items.map((item) => item.activeUsers)),
    opens: Math.max(1, ...items.map((item) => item.opens)),
    answers: Math.max(1, ...items.map((item) => item.answers)),
  };

  return (
    <div className="admin-analytics-trend" role="img" aria-label="每日活跃、打开次数和答题量趋势柱状图">
      <Flex className="admin-analytics-legend" gap={16} wrap="wrap">
        <span><i className="active" />活跃用户</span>
        <span><i className="opens" />打开次数</span>
        <span><i className="answers" />答题量</span>
        <Typography.Text type="secondary">各指标按自身峰值显示走势</Typography.Text>
      </Flex>
      <div className="admin-analytics-plot-scroll">
        <div className="admin-analytics-plot" style={{ minWidth: Math.max(560, items.length * 30) }}>
          {items.map((item, index) => (
            <Tooltip
              key={`${item.date}-${index}`}
              title={<div>{item.date}<br />活跃 {formatInteger(item.activeUsers)}<br />打开 {formatInteger(item.opens)}<br />答题 {formatInteger(item.answers)}</div>}
            >
              <div className="admin-analytics-column">
                <div className="admin-analytics-bars">
                  <span className="active" style={{ height: `${Math.max(2, item.activeUsers / max.activeUsers * 100)}%` }} />
                  <span className="opens" style={{ height: `${Math.max(2, item.opens / max.opens * 100)}%` }} />
                  <span className="answers" style={{ height: `${Math.max(2, item.answers / max.answers * 100)}%` }} />
                </div>
                <small className={items.length <= 15 || index % Math.ceil(items.length / 10) === 0 || index === items.length - 1 ? "" : "is-hidden"}>{shortDate(item.date)}</small>
              </div>
            </Tooltip>
          ))}
        </div>
      </div>
    </div>
  );
}

function Funnel({ items }: { items: FunnelItem[] }) {
  if (!items.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无转化漏斗数据" />;
  const firstUsers = Math.max(1, items[0]?.users ?? 1);
  return (
    <div className="admin-analytics-funnel">
      {items.map((item, index) => {
        const rate = item.rate || Math.max(0, Math.min(100, item.users / firstUsers * 100));
        return (
          <div key={item.key} className="admin-analytics-funnel-step">
            <div className="admin-analytics-funnel-copy">
              <span><b>{index + 1}</b><strong>{item.label}</strong></span>
              <span><strong>{formatInteger(item.users)}</strong><small>人 · {rate.toFixed(1)}%</small></span>
            </div>
            <Progress percent={Number(rate.toFixed(1))} showInfo={false} strokeColor={index === 0 ? "#176b87" : "#2d8c70"} trailColor="#edf2f5" />
          </div>
        );
      })}
    </div>
  );
}

export default function AnalyticsPage() {
  const { can } = useAdminSession();
  const canRead = can("analytics.read");
  const [days, setDays] = useState(30);
  const [data, setData] = useState<AnalyticsData>(EMPTY_DATA);
  const [loading, setLoading] = useState(canRead);
  const [error, setError] = useState("");
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);

  const load = useCallback(async () => {
    if (!canRead) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const result = await adminApi<RawAnalyticsResponse>({ action: "adminListAnalytics", days });
      setData(normalizeAnalytics(result));
      setRefreshedAt(new Date());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "数据分析加载失败");
    } finally {
      setLoading(false);
    }
  }, [canRead, days]);

  useEffect(() => {
    const task = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(task);
  }, [load]);

  const memberRate = data.overview.totalUsers
    ? data.overview.memberUsers / data.overview.totalUsers * 100
    : 0;
  const activeRate = data.overview.totalUsers
    ? data.overview.activeUsers30d / data.overview.totalUsers * 100
    : 0;

  const moduleColumns: TableColumnsType<ModuleStatItem> = useMemo(() => [
    { title: "训练模块", dataIndex: "module", key: "module", render: (value: string) => <Typography.Text strong>{value}</Typography.Text> },
    { title: "30日答题量", dataIndex: "answers", key: "answers", align: "right", render: (value: number) => formatInteger(value) },
    { title: "正确率", dataIndex: "accuracy", key: "accuracy", width: 190, render: (value: number) => <Flex align="center" gap={8}><Progress percent={Number(value.toFixed(1))} size="small" showInfo={false} style={{ minWidth: 82, margin: 0 }} /><Typography.Text>{value.toFixed(1)}%</Typography.Text></Flex> },
  ], []);

  const eventColumns: TableColumnsType<EventCountItem> = useMemo(() => [
    { title: "关键行为", dataIndex: "eventName", key: "eventName", render: (value: string) => <Tag color="blue">{value}</Tag> },
    { title: "发生次数", dataIndex: "count", key: "count", align: "right", render: (value: number) => formatInteger(value) },
    { title: "触发用户", dataIndex: "users", key: "users", align: "right", render: (value: number) => formatInteger(value) },
  ], []);

  const updatedLabel = data.generatedAt
    ? `数据生成于 ${new Date(data.generatedAt).toLocaleString("zh-CN")}`
    : refreshedAt
      ? `刚刚刷新于 ${refreshedAt.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`
      : "";

  return (
    <AdminPageFrame
      eyebrow="数据中心"
      title="产品数据分析"
      description="围绕用户活跃、日练行为、转化漏斗和模块表现判断产品是否真正被高频使用。"
      loading={loading}
      error={error}
      onReload={() => void load()}
      extra={canRead ? <Segmented<number> value={days} options={[{ label: "近14天", value: 14 }, { label: "近30天", value: 30 }]} onChange={setDays} /> : undefined}
    >
      {!canRead ? (
        <Alert showIcon type="warning" message="当前角色没有数据分析查看权限" description="请联系超级管理员授予 analytics.read 权限。" />
      ) : (
        <Space direction="vertical" size={18} style={{ display: "flex" }}>
          {updatedLabel && <Typography.Text type="secondary" className="admin-analytics-updated">{updatedLabel}</Typography.Text>}

          <Row gutter={[14, 14]} className="admin-analytics-overview">
            <Col xs={12} md={8} xl={4}><Card><Statistic title="累计用户" value={data.overview.totalUsers} formatter={formatInteger} prefix={<TeamOutlined />} /></Card></Col>
            <Col xs={12} md={8} xl={4}><Card><Statistic title="7日活跃" value={data.overview.activeUsers7d} formatter={formatInteger} prefix={<ThunderboltOutlined />} /></Card></Col>
            <Col xs={12} md={8} xl={4}><Card><Statistic title="30日活跃" value={data.overview.activeUsers30d} formatter={formatInteger} prefix={<UserSwitchOutlined />} suffix={<small>{activeRate.toFixed(1)}%</small>} /></Card></Col>
            <Col xs={12} md={8} xl={4}><Card><Statistic title="会员用户" value={data.overview.memberUsers} formatter={formatInteger} prefix={<CrownOutlined />} suffix={<small>{memberRate.toFixed(1)}%</small>} /></Card></Col>
            <Col xs={12} md={8} xl={4}><Card><Statistic title="30日答题" value={data.overview.practiceAnswers30d} formatter={formatInteger} prefix={<BarChartOutlined />} /></Card></Col>
            <Col xs={12} md={8} xl={4}><Card><Statistic title="30日正确率" value={data.overview.accuracy30d} precision={1} suffix="%" prefix={<CheckCircleOutlined />} /></Card></Col>
          </Row>

          <Card
            className="admin-analytics-card"
            title="接口健康"
            extra={<Tag color={data.apiHealth.state === "measured" ? "blue" : "default"}>{data.apiHealth.state === "measured" ? "真实观测" : "采集中"}</Tag>}
          >
            <Space direction="vertical" size={16} style={{ display: "flex" }}>
              <Alert
                showIcon
                type="info"
                message={data.apiHealth.message}
                description={data.apiHealth.state === "measured"
                  ? `以下指标来自近${data.apiHealth.windowDays}天 /api/app 的真实请求；是否达标仍以正式验收阈值为准。`
                  : "尚无可用请求样本，不以模拟值或默认值代替达标结论。发布后产生真实请求，刷新本页即可查看。"}
              />
              <Row gutter={[18, 18]}>
                <Col xs={24} sm={8}>
                  <Statistic title={`${data.apiHealth.windowDays}日真实样本`} value={data.apiHealth.sampleCount} formatter={formatInteger} suffix="次" />
                </Col>
                <Col xs={24} sm={8}>
                  {data.apiHealth.p95Ms === null
                    ? <Statistic title="P95 响应耗时" value="--" />
                    : <Statistic title="P95 响应耗时" value={data.apiHealth.p95Ms} precision={2} suffix="ms" />}
                </Col>
                <Col xs={24} sm={8}>
                  {data.apiHealth.errorRate5xx === null
                    ? <Statistic title="5xx 错误率" value="--" />
                    : <Statistic title="5xx 错误率" value={data.apiHealth.errorRate5xx} precision={2} suffix="%" />}
                  <Typography.Text type="secondary">5xx 共 {formatInteger(data.apiHealth.error5xxCount)} 次</Typography.Text>
                </Col>
              </Row>
            </Space>
          </Card>

          <Row gutter={[18, 18]}>
            <Col xs={24} xl={16}>
              <Card className="admin-analytics-card" title={`${days}日使用趋势`} extra={<Typography.Text type="secondary">活跃 / 打开 / 答题</Typography.Text>}>
                <TrendChart items={data.dailyTrend} />
              </Card>
            </Col>
            <Col xs={24} xl={8}>
              <Card className="admin-analytics-card" title="核心转化漏斗" extra={<RiseOutlined />}>
                <Funnel items={data.funnel} />
              </Card>
            </Col>
          </Row>

          <Row gutter={[18, 18]}>
            <Col xs={24} xl={14}>
              <Card className="admin-analytics-card" title="训练模块表现" extra={<Typography.Text type="secondary">答题量与正确率</Typography.Text>}>
                <Table<ModuleStatItem>
                  rowKey="module"
                  columns={moduleColumns}
                  dataSource={data.moduleStats}
                  pagination={false}
                  locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无模块训练数据" /> }}
                  scroll={{ x: 540 }}
                />
              </Card>
            </Col>
            <Col xs={24} xl={10}>
              <Card className="admin-analytics-card" title="关键行为事件" extra={<Typography.Text type="secondary">次数 / 人数</Typography.Text>}>
                <Table<EventCountItem>
                  rowKey={(row) => row.eventName}
                  columns={eventColumns}
                  dataSource={data.eventCounts}
                  pagination={{ pageSize: 8, hideOnSinglePage: true }}
                  locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无关键行为事件" /> }}
                  scroll={{ x: 420 }}
                />
              </Card>
            </Col>
          </Row>

          <Card className="admin-analytics-card" title="增长结果" extra={<Typography.Text type="secondary">近30天</Typography.Text>}>
            <Row gutter={[18, 18]}>
              <Col xs={24} sm={12}>
                <div className="admin-analytics-growth-metric">
                  <span><CrownOutlined /></span>
                  <Statistic title="兑换码成功激活" value={data.growth.redemptions30d} formatter={formatInteger} suffix="次" />
                </div>
              </Col>
              <Col xs={24} sm={12}>
                <div className="admin-analytics-growth-metric">
                  <span><RiseOutlined /></span>
                  <Statistic title="邀请成功" value={data.growth.invites30d} formatter={formatInteger} suffix="次" />
                </div>
              </Col>
            </Row>
          </Card>
        </Space>
      )}
    </AdminPageFrame>
  );
}
