"use client";

import {
  BankOutlined,
  BarChartOutlined,
  BellOutlined,
  BookOutlined,
  CloudUploadOutlined,
  DashboardOutlined,
  FileTextOutlined,
  GiftOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  RadarChartOutlined,
  SafetyCertificateOutlined,
  SearchOutlined,
  SettingOutlined,
  SmileOutlined,
  UserOutlined,
} from "@ant-design/icons";
import {
  App as AntApp,
  AutoComplete,
  Avatar,
  Badge,
  Breadcrumb,
  Button,
  ConfigProvider,
  Drawer,
  Dropdown,
  Layout,
  Menu,
  Skeleton,
  Space,
  Spin,
  Typography,
} from "antd";
import type { MenuProps } from "antd";
import zhCN from "antd/locale/zh_CN";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

const { Header, Sider, Content } = Layout;
const { Text } = Typography;

export type AdminRole =
  | "super_admin"
  | "content_editor"
  | "question_editor"
  | "radar_editor"
  | "growth_operator"
  | "reviewer"
  | "read_only"
  | string;

export type AdminIdentity = {
  id: number | string;
  username: string;
  displayName: string;
  role: AdminRole;
  permissions: string[];
  pendingCount?: number;
};

type AdminSessionContextValue = {
  admin: AdminIdentity;
  permissions: string[];
  can: (permission: string) => boolean;
  refreshSession: () => Promise<void>;
};

const AdminSessionContext = createContext<AdminSessionContextValue | null>(null);

export function useAdminSession() {
  const value = useContext(AdminSessionContext);
  if (!value) throw new Error("useAdminSession 必须在受保护的管理后台中使用");
  return value;
}

type NavigationItem = {
  key: string;
  label: string;
  path: string;
  permission: string;
  icon: ReactNode;
  section: string;
  keywords: string;
};

const NAVIGATION: NavigationItem[] = [
  {
    key: "dashboard",
    label: "工作台",
    path: "/admin",
    permission: "dashboard.read",
    icon: <DashboardOutlined />,
    section: "总览",
    keywords: "首页 数据 待办 异常",
  },
  {
    key: "content",
    label: "内容库",
    path: "/admin/content",
    permission: "content.read",
    icon: <FileTextOutlined />,
    section: "内容运营",
    keywords: "晨读 时政 申论 电台 发布 审核",
  },
  {
    key: "quizzes",
    label: "趣味测试",
    path: "/admin/quizzes",
    permission: "content.read",
    icon: <SmileOutlined />,
    section: "内容运营",
    keywords: "局长思维 测试 分享 裂变 题目 段位",
  },
  {
    key: "question-banks",
    label: "题库与题目",
    path: "/admin/question-banks",
    permission: "question.read",
    icon: <BookOutlined />,
    section: "题库与训练",
    keywords: "题库 真题 题目 专项微练 训练策略",
  },
  {
    key: "imports",
    label: "导入任务",
    path: "/admin/imports",
    permission: "question.import",
    icon: <CloudUploadOutlined />,
    section: "题库与训练",
    keywords: "Excel CSV 上传 导入 校验 失败",
  },
  {
    key: "radar",
    label: "公考雷达",
    path: "/admin/radar",
    permission: "radar.read",
    icon: <RadarChartOutlined />,
    section: "招考数据",
    keywords: "公告 节点 职位表 报名 提醒",
  },
  {
    key: "growth",
    label: "增长与权益",
    path: "/admin/growth",
    permission: "growth.read",
    icon: <GiftOutlined />,
    section: "增长与权益",
    keywords: "用户 会员 兑换码 邀请 奖励",
  },
  {
    key: "analytics",
    label: "数据分析",
    path: "/admin/analytics",
    permission: "analytics.read",
    icon: <BarChartOutlined />,
    section: "数据中心",
    keywords: "活跃 留存 答题 正确率 转化 漏斗 事件 趋势",
  },
  {
    key: "system",
    label: "系统管理",
    path: "/admin/system",
    permission: "system.read",
    icon: <SettingOutlined />,
    section: "系统管理",
    keywords: "管理员 角色 权限 操作日志 配置",
  },
];

const ROLE_PERMISSIONS: Record<string, string[]> = {
  super_admin: [
    "dashboard.read", "content.read", "content.write", "content.review", "content.publish",
    "question.read", "question.write", "question.import", "question.review", "radar.read", "radar.write",
    "growth.read", "growth.write", "media.upload", "analytics.read", "system.read",
    "users.manage", "audit.read",
  ],
  content_editor: ["dashboard.read", "content.read", "content.write", "media.upload"],
  question_editor: ["dashboard.read", "question.read", "question.write", "question.import", "media.upload"],
  radar_editor: ["dashboard.read", "radar.read", "radar.write", "media.upload"],
  growth_operator: ["dashboard.read", "growth.read", "growth.write", "analytics.read"],
  reviewer: ["dashboard.read", "content.read", "content.review", "content.publish", "question.read", "question.review", "radar.read", "audit.read"],
  read_only: ["dashboard.read", "content.read", "question.read", "radar.read", "growth.read", "analytics.read", "system.read", "audit.read"],
};

const ROLE_LABELS: Record<string, string> = {
  super_admin: "超级管理员",
  content_editor: "内容运营",
  question_editor: "题库运营",
  radar_editor: "招考运营",
  growth_operator: "增长运营",
  reviewer: "审核发布",
  read_only: "只读成员",
};

function normalizeAdmin(raw: unknown): AdminIdentity | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;
  const username = String(data.username ?? data.account ?? "").trim();
  if (!username) return null;
  const role = String(data.role ?? "read_only");
  const permissions = Array.isArray(data.permissions)
    ? data.permissions.map(String)
    : ROLE_PERMISSIONS[role] ?? [];
  return {
    id: (data.id as string | number | undefined) ?? username,
    username,
    displayName: String(data.displayName ?? data.display_name ?? username),
    role,
    permissions,
    pendingCount: Number(data.pendingCount ?? data.pending_count ?? 0),
  };
}

function permissionChecker(admin: AdminIdentity | null) {
  return (permission: string) => {
    if (!admin) return false;
    const grants = admin.permissions.length ? admin.permissions : ROLE_PERMISSIONS[admin.role] ?? [];
    return grants.includes("*") || grants.includes(permission);
  };
}

function navigationAllowed(item: NavigationItem, can: (permission: string) => boolean) {
  if (item.key === "system") return can("system.read") || can("users.manage") || can("audit.read");
  return can(item.permission);
}

function selectedNavigation(pathname: string) {
  return [...NAVIGATION]
    .sort((a, b) => b.path.length - a.path.length)
    .find((item) => item.path === "/admin" ? pathname === "/admin" : pathname.startsWith(item.path));
}

function AdminNavigation({
  collapsed,
  mobile,
  can,
  onNavigate,
}: {
  collapsed: boolean;
  mobile?: boolean;
  can: (permission: string) => boolean;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const visibleItems = NAVIGATION.filter((item) => navigationAllowed(item, can));
  const sections = Array.from(new Set(visibleItems.map((item) => item.section)));
  const items: MenuProps["items"] = sections.flatMap((section) => {
    const children = visibleItems.filter((item) => item.section === section);
    return [
      {
        type: "group" as const,
        label: section,
        children: children.map((item) => ({
          key: item.key,
          icon: item.icon,
          label: item.label,
        })),
      },
    ];
  });
  const selected = selectedNavigation(pathname)?.key ?? "dashboard";

  return (
    <div className="admin-navigation">
      <Link className={`admin-brand ${collapsed && !mobile ? "is-collapsed" : ""}`} href="/admin" onClick={onNavigate}>
        <span className="admin-brand-mark">公</span>
        {(!collapsed || mobile) && (
          <span className="admin-brand-copy">
            <strong>公考日练</strong>
            <small>运营管理后台</small>
          </span>
        )}
      </Link>
      <Menu
        mode="inline"
        theme="dark"
        inlineCollapsed={collapsed && !mobile}
        selectedKeys={[selected]}
        items={items}
        onClick={({ key }) => {
          const target = visibleItems.find((item) => item.key === key);
          if (target) router.push(target.path);
          onNavigate?.();
        }}
      />
      {(!collapsed || mobile) && (
        <div className="admin-sider-footnote">
          <SafetyCertificateOutlined />
          <span>所有关键操作均记录日志</span>
        </div>
      )}
    </div>
  );
}

function AdminShellInner({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { message } = AntApp.useApp();
  const [admin, setAdmin] = useState<AdminIdentity | null>(null);
  const [checking, setChecking] = useState(true);
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [searchValue, setSearchValue] = useState("");

  const loadSession = useCallback(async () => {
    try {
      const response = await fetch("/api/app", {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "adminSession" }),
      });
      const data = await response.json() as Record<string, unknown>;
      const candidate = normalizeAdmin(data.admin ?? (data.session as Record<string, unknown> | undefined)?.admin);
      if (!response.ok || data.authenticated === false || !candidate) {
        const returnTo = `${window.location.pathname}${window.location.search}`;
        router.replace(`/admin/login?returnTo=${encodeURIComponent(returnTo)}`);
        return;
      }
      candidate.pendingCount = Number(data.pendingCount ?? candidate.pendingCount ?? 0);
      setAdmin(candidate);
    } catch {
      message.error("无法验证管理员会话，请重新登录");
      router.replace("/admin/login");
    } finally {
      setChecking(false);
    }
  }, [message, router]);

  useEffect(() => {
    const task = window.setTimeout(() => void loadSession(), 0);
    return () => window.clearTimeout(task);
  }, [loadSession]);

  const can = useMemo(() => permissionChecker(admin), [admin]);
  const visibleSearchOptions = useMemo(() => NAVIGATION
    .filter((item) => navigationAllowed(item, can))
    .filter((item) => !searchValue.trim() || `${item.label} ${item.keywords}`.includes(searchValue.trim()))
    .map((item) => ({ value: item.path, label: <span><SearchOutlined /> {item.label}<Text type="secondary"> · {item.section}</Text></span> })), [can, searchValue]);
  const current = selectedNavigation(pathname);

  const logout = async () => {
    setLoggingOut(true);
    try {
      await fetch("/api/app", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "adminLogout" }),
      });
    } finally {
      router.replace("/admin/login");
      router.refresh();
      setLoggingOut(false);
    }
  };

  if (checking || !admin) {
    return (
      <div className="admin-session-loading" role="status" aria-live="polite">
        <span className="admin-brand-mark">公</span>
        <Spin size="large" />
        <strong>正在验证管理员身份</strong>
        <Skeleton active paragraph={{ rows: 2 }} title={false} />
      </div>
    );
  }

  const contextValue: AdminSessionContextValue = {
    admin,
    permissions: admin.permissions,
    can,
    refreshSession: loadSession,
  };

  const userMenu: MenuProps["items"] = [
    { key: "identity", label: <div className="admin-user-menu-copy"><strong>{admin.displayName}</strong><small>{admin.username}</small></div>, disabled: true },
    { type: "divider" },
    ...(can("system.read") || can("users.manage") || can("audit.read") ? [{ key: "system", icon: <SettingOutlined />, label: "系统管理" }] : []),
    { key: "frontend", icon: <BankOutlined />, label: "返回用户端" },
    { type: "divider" },
    { key: "logout", danger: true, icon: <LogoutOutlined />, label: "退出登录" },
  ];

  return (
    <AdminSessionContext.Provider value={contextValue}>
      <Layout className="admin-layout">
        <Sider
          className="admin-desktop-sider"
          width={232}
          collapsedWidth={76}
          collapsed={collapsed}
          trigger={null}
          theme="dark"
        >
          <AdminNavigation collapsed={collapsed} can={can} />
        </Sider>
        <Drawer
          className="admin-mobile-drawer"
          placement="left"
          open={mobileOpen}
          onClose={() => setMobileOpen(false)}
          width={276}
          closable={false}
          styles={{ body: { padding: 0, background: "#102a43" } }}
        >
          <AdminNavigation collapsed={false} mobile can={can} onNavigate={() => setMobileOpen(false)} />
        </Drawer>
        <Layout className="admin-main-layout">
          <Header className="admin-topbar">
            <div className="admin-topbar-leading">
              <Button
                className="admin-menu-trigger desktop"
                type="text"
                aria-label={collapsed ? "展开侧边栏" : "收起侧边栏"}
                icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
                onClick={() => setCollapsed((value) => !value)}
              />
              <Button
                className="admin-menu-trigger mobile"
                type="text"
                aria-label="打开菜单"
                icon={<MenuUnfoldOutlined />}
                onClick={() => setMobileOpen(true)}
              />
              <Breadcrumb
                items={[
                  { title: "运营后台" },
                  ...(current && current.path !== "/admin" ? [{ title: current.section }, { title: current.label }] : [{ title: "工作台" }]),
                ]}
              />
            </div>
            <AutoComplete
              className="admin-page-search"
              value={searchValue}
              options={visibleSearchOptions}
              onChange={setSearchValue}
              onSelect={(value) => {
                setSearchValue("");
                router.push(String(value));
              }}
            >
              <input aria-label="搜索后台页面" placeholder="搜索页面或功能" />
            </AutoComplete>
            <Space className="admin-account-tools" size={10}>
              <Button
                className="admin-todo-button"
                type="text"
                onClick={() => router.push("/admin")}
                icon={<Badge size="small" count={admin.pendingCount} overflowCount={99}><BellOutlined /></Badge>}
              >待办</Button>
              <Dropdown
                menu={{
                  items: userMenu,
                  onClick: ({ key }) => {
                    if (key === "logout") void logout();
                    if (key === "system") router.push("/admin/system");
                    if (key === "frontend") window.location.href = "/";
                  },
                }}
                trigger={["click"]}
              >
                <Button className="admin-account-button" type="text" loading={loggingOut}>
                  <Avatar size={32} icon={<UserOutlined />} />
                  <span><strong>{admin.displayName}</strong><small>{ROLE_LABELS[admin.role] ?? admin.role}</small></span>
                </Button>
              </Dropdown>
            </Space>
          </Header>
          <Content className="admin-content">
            <div className="admin-page-container">{children}</div>
          </Content>
        </Layout>
      </Layout>
    </AdminSessionContext.Provider>
  );
}

export default function AdminShell({ children }: { children: ReactNode }) {
  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: "#176b87",
          colorInfo: "#176b87",
          colorSuccess: "#2d8c70",
          colorWarning: "#e88a42",
          colorError: "#d55252",
          borderRadius: 10,
          fontFamily: 'Inter, "PingFang SC", "Microsoft YaHei", sans-serif',
        },
        components: {
          Layout: { headerBg: "#ffffff", siderBg: "#102a43" },
          Menu: { darkItemBg: "#102a43", darkSubMenuItemBg: "#102a43", darkItemSelectedBg: "#176b87", itemBorderRadius: 8 },
        },
      }}
    >
      <AntApp>
        <AdminShellInner>{children}</AdminShellInner>
      </AntApp>
    </ConfigProvider>
  );
}
