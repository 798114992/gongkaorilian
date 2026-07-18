"use client";

import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  RocketOutlined,
  SafetyCertificateOutlined,
  WarningOutlined,
} from "@ant-design/icons";
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Descriptions,
  Form,
  Input,
  Progress,
  Row,
  Space,
  Statistic,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography,
} from "antd";
import { useEffect, useState } from "react";
import { useAdminSession } from "../../AdminShell";
import AdminPageFrame from "../_components/AdminPageFrame";
import { adminApi } from "../_components/adminApi";
import { useAdminDomain } from "../_components/useAdminDomain";

type LaunchCheck = {
  id: string;
  category: "framework" | "business" | "operations" | "mini_program";
  target: "h5" | "mini_program" | "both";
  label: string;
  state: "pass" | "warning" | "fail";
  blocking: boolean;
  detail: string;
  href?: string;
};

type OperationPolicy = {
  supportEmail: string;
  supportWechat: string;
  serviceHours: string;
  officialAccountName: string;
  purchaseUrl: string;
  purchaseInstructions: string;
  wrongAccountPolicy: string;
  unusedCodePolicy: string;
  accountMergePolicy: string;
  codeTransferPolicy: string;
};

type MiniProgramConfig = {
  appId: string;
  serviceDomain: string;
  privacyVerified: boolean;
  identityMappingVerified: boolean;
  nativeShareVerified: boolean;
  subscribeMessageVerified: boolean;
  uploadPipelineVerified: boolean;
  paymentMode: "official_account_redemption";
  lastVerifiedAt: string;
};

type LaunchData = {
  readiness: {
    h5Ready: boolean;
    miniProgramReady: boolean;
    checks: LaunchCheck[];
    lastAudit: { target?: string; allowed?: boolean; failedCheckIds?: string[]; checkedAt?: string; checkedBy?: string };
  };
  policy: OperationPolicy;
  miniProgram: MiniProgramConfig;
  scenarios: Array<{ id: string; user: string; expected: string; status: "covered" | "attention" | "blocked"; evidence: string }>;
  scores: { framework: number; business: number; operations: number; miniProgram: number };
  health: { activeUsers7d: number; practiceUsers7d: number; redeemedUsers30d: number; pendingReports: number; failedImports: number };
  generatedAt: string;
};

const EMPTY_POLICY: OperationPolicy = {
  supportEmail: "", supportWechat: "", serviceHours: "工作日 9:00—18:00", officialAccountName: "",
  purchaseUrl: "", purchaseInstructions: "", wrongAccountPolicy: "", unusedCodePolicy: "", accountMergePolicy: "", codeTransferPolicy: "",
};

const EMPTY_MINI: MiniProgramConfig = {
  appId: "", serviceDomain: "", privacyVerified: false, identityMappingVerified: false,
  nativeShareVerified: false, subscribeMessageVerified: false, uploadPipelineVerified: false,
  paymentMode: "official_account_redemption", lastVerifiedAt: "",
};

const EMPTY_DATA: LaunchData = {
  readiness: { h5Ready: false, miniProgramReady: false, checks: [], lastAudit: {} },
  policy: EMPTY_POLICY,
  miniProgram: EMPTY_MINI,
  scenarios: [],
  scores: { framework: 0, business: 0, operations: 0, miniProgram: 0 },
  health: { activeUsers7d: 0, practiceUsers7d: 0, redeemedUsers30d: 0, pendingReports: 0, failedImports: 0 },
  generatedAt: "",
};

const stateTag = (state: LaunchCheck["state"]) => state === "pass"
  ? <Tag color="success" icon={<CheckCircleOutlined />}>通过</Tag>
  : state === "warning" ? <Tag color="warning" icon={<WarningOutlined />}>待完善</Tag>
    : <Tag color="error" icon={<CloseCircleOutlined />}>阻断</Tag>;

const scenarioTag = (status: "covered" | "attention" | "blocked") => status === "covered"
  ? <Tag color="success">已覆盖</Tag>
  : status === "attention" ? <Tag color="warning">待实测</Tag> : <Tag color="error">被阻断</Tag>;

export default function LaunchPage() {
  const { message } = App.useApp();
  const { can } = useAdminSession();
  const { data, loading, error, reload, setData } = useAdminDomain<LaunchData>("adminListLaunch", EMPTY_DATA);
  const [businessForm] = Form.useForm<OperationPolicy>();
  const [miniForm] = Form.useForm<MiniProgramConfig>();
  const [saving, setSaving] = useState(false);
  const [auditing, setAuditing] = useState<"h5" | "mini_program" | "">("");
  const canManage = can("users.manage");

  useEffect(() => { businessForm.setFieldsValue(data.policy); }, [businessForm, data.policy]);
  useEffect(() => { miniForm.setFieldsValue(data.miniProgram); }, [miniForm, data.miniProgram]);

  const savePolicy = async (scope: "business" | "mini_program", values: OperationPolicy | MiniProgramConfig) => {
    setSaving(true);
    try {
      const next = await adminApi<LaunchData>({ action: "adminUpdateLaunchPolicy", scope, values });
      setData(next);
      message.success(scope === "business" ? "商业与售后规则已保存" : "小程序验收状态已保存");
    } catch (reason) {
      message.error(reason instanceof Error ? reason.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const runAudit = async (target: "h5" | "mini_program") => {
    setAuditing(target);
    try {
      const next = await adminApi<LaunchData>({ action: "adminRunLaunchAudit", target });
      setData(next);
      message.success(target === "h5" ? "H5上线验收通过" : "微信小程序上线验收通过");
    } catch (reason) {
      await reload();
      message.warning(reason instanceof Error ? reason.message : "验收未通过");
    } finally {
      setAuditing("");
    }
  };

  const checkColumns = [
    { title: "检查项", dataIndex: "label", key: "label", render: (value: string, row: LaunchCheck) => <Space direction="vertical" size={0}><Typography.Text strong>{value}</Typography.Text><Typography.Text type="secondary" style={{ fontSize: 12 }}>{row.category === "mini_program" ? "微信小程序" : row.category === "business" ? "商业闭环" : row.category === "operations" ? "运营与合规" : "产品框架"}</Typography.Text></Space> },
    { title: "状态", dataIndex: "state", key: "state", width: 105, render: stateTag },
    { title: "是否阻断", dataIndex: "blocking", key: "blocking", width: 100, render: (value: boolean) => value ? <Tag color="red">阻断上线</Tag> : <Tag>提示</Tag> },
    { title: "判断依据", dataIndex: "detail", key: "detail", render: (value: string, row: LaunchCheck) => <Space direction="vertical" size={2}><span>{value}</span>{row.href && <Typography.Link href={row.href}>前往处理</Typography.Link>}</Space> },
  ];

  const scenarioColumns = [
    { title: "用户状态", dataIndex: "user", key: "user", width: 210, render: (value: string) => <Typography.Text strong>{value}</Typography.Text> },
    { title: "系统应有表现", dataIndex: "expected", key: "expected" },
    { title: "验证依据", dataIndex: "evidence", key: "evidence", width: 180 },
    { title: "状态", dataIndex: "status", key: "status", width: 95, render: scenarioTag },
  ];

  const lastAudit = data.readiness.lastAudit;
  const blockingChecks = data.readiness.checks.filter((item) => item.blocking && item.state === "fail");

  return (
    <AdminPageFrame
      eyebrow="上线经营系统"
      title="上线中心"
      description="统一检查账号、权益、售后、运营和微信小程序迁移状态。H5与小程序分别验收，未接通的能力不会显示为已完成。"
      loading={loading}
      error={error}
      onReload={reload}
      extra={<Button type="primary" icon={<RocketOutlined />} loading={auditing === "h5"} onClick={() => void runAudit("h5")}>运行H5验收</Button>}
    >
      <Alert
        showIcon
        type={data.readiness.h5Ready ? "success" : "warning"}
        message={data.readiness.h5Ready ? "H5运行条件已满足" : `仍有${blockingChecks.filter((item) => item.target !== "mini_program").length}项H5阻断条件`}
        description="内容数量不计入本页评分；但已发布却不可练的题库、已支付未发权益等结构性异常仍会阻断上线。"
        style={{ marginBottom: 20 }}
      />

      <Row gutter={[16, 16]}>
        {[{ title: "产品框架", value: data.scores.framework }, { title: "商业闭环", value: data.scores.business }, { title: "运营与合规", value: data.scores.operations }, { title: "小程序准备", value: data.scores.miniProgram }].map((item) => (
          <Col xs={12} lg={6} key={item.title}><Card><Statistic title={item.title} value={item.value} suffix="分" /><Progress percent={item.value} showInfo={false} status={item.value >= 90 ? "success" : "normal"} /></Card></Col>
        ))}
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} lg={12}><Card title="H5上线状态" extra={data.readiness.h5Ready ? <Tag color="success">可以上线</Tag> : <Tag color="error">暂不可上线</Tag>}><Typography.Paragraph type="secondary">沿用当前账号、题库、兑换码和服务端权益体系。</Typography.Paragraph><Button loading={auditing === "h5"} onClick={() => void runAudit("h5")}>重新验收</Button></Card></Col>
        <Col xs={24} lg={12}><Card title="微信小程序状态" extra={data.readiness.miniProgramReady ? <Tag color="success">可以提审</Tag> : <Tag color="warning">待接入</Tag>}><Typography.Paragraph type="secondary">不要求接入小程序内支付，当前策略为公众号购买后兑换激活。</Typography.Paragraph><Button loading={auditing === "mini_program"} onClick={() => void runAudit("mini_program")}>运行小程序验收</Button></Card></Col>
      </Row>

      {lastAudit.checkedAt && <Alert style={{ marginTop: 16 }} showIcon type={lastAudit.allowed ? "success" : "warning"} message={`最近一次${lastAudit.target === "mini_program" ? "小程序" : "H5"}验收：${lastAudit.allowed ? "通过" : "未通过"}`} description={`${new Date(lastAudit.checkedAt).toLocaleString("zh-CN")} · ${lastAudit.checkedBy ?? "管理员"}${lastAudit.failedCheckIds?.length ? ` · 阻断项：${lastAudit.failedCheckIds.join("、")}` : ""}`} />}

      <Tabs
        style={{ marginTop: 22 }}
        items={[
          {
            key: "checks",
            label: "上线检查",
            children: <Card><Table rowKey="id" columns={checkColumns} dataSource={data.readiness.checks} pagination={false} scroll={{ x: 880 }} /></Card>,
          },
          {
            key: "scenarios",
            label: `用户状态模拟（${data.scenarios.length}）`,
            children: <Card><Alert showIcon type="info" message="模拟不改动真实用户数据" description="以服务端规则逐项核对典型状态，重点检查用户是否会被卡死、权益是否会错发、页面承诺是否超过真实能力。" style={{ marginBottom: 16 }} /><Table rowKey="id" columns={scenarioColumns} dataSource={data.scenarios} pagination={false} scroll={{ x: 900 }} /></Card>,
          },
          {
            key: "business",
            label: "商业与售后",
            children: <Card id="business" title="公众号购买—兑换激活—售后承接"><Alert showIcon type="info" message="29.8元终身权益保持不变" description="本页只配置购买入口、售后规则和对外承诺，不会修改现有商品价格或已发放权益。" style={{ marginBottom: 18 }} /><Form form={businessForm} layout="vertical" onFinish={(values) => void savePolicy("business", values)} disabled={!canManage}><Row gutter={16}><Col xs={24} md={12}><Form.Item name="officialAccountName" label="官方公众号名称" rules={[{ required: true, message: "请输入公众号名称" }]}><Input placeholder="用于告诉用户去哪里购买" /></Form.Item></Col><Col xs={24} md={12}><Form.Item name="purchaseUrl" label="购买或说明页（HTTPS）" rules={[{ type: "url", message: "请输入有效网址" }]}><Input placeholder="https://" /></Form.Item></Col><Col xs={24} md={12}><Form.Item name="supportWechat" label="售后微信"><Input /></Form.Item></Col><Col xs={24} md={12}><Form.Item name="supportEmail" label="售后邮箱" rules={[{ type: "email", message: "邮箱格式无效" }]}><Input /></Form.Item></Col><Col xs={24} md={12}><Form.Item name="serviceHours" label="服务时间"><Input /></Form.Item></Col><Col span={24}><Form.Item name="purchaseInstructions" label="购买与返回说明"><Input.TextArea rows={2} /></Form.Item></Col><Col span={24}><Form.Item name="wrongAccountPolicy" label="兑换到错误账号"><Input.TextArea rows={2} /></Form.Item></Col><Col span={24}><Form.Item name="unusedCodePolicy" label="未使用兑换码处理"><Input.TextArea rows={2} /></Form.Item></Col><Col span={24}><Form.Item name="accountMergePolicy" label="账号合并规则"><Input.TextArea rows={2} /></Form.Item></Col><Col span={24}><Form.Item name="codeTransferPolicy" label="兑换码转让规则"><Input.TextArea rows={2} /></Form.Item></Col></Row>{canManage && <Button htmlType="submit" type="primary" loading={saving}>保存商业与售后规则</Button>}</Form></Card>,
          },
          {
            key: "mini",
            label: "小程序迁移",
            children: <Card id="mini-program" title="微信小程序接入验收"><Alert showIcon type="warning" message="这里只记录已实测结果，不保存AppSecret" description="AppID和域名可以记录；登录、订阅提醒、原生分享和上传流程只有完成真机测试后才能勾选。" style={{ marginBottom: 18 }} /><Form form={miniForm} layout="vertical" onFinish={(values) => void savePolicy("mini_program", values)} disabled={!canManage}><Row gutter={16}><Col xs={24} md={12}><Form.Item name="appId" label="小程序AppID"><Input placeholder="wx开头的18位AppID" /></Form.Item></Col><Col xs={24} md={12}><Form.Item name="serviceDomain" label="服务域名（HTTPS）"><Input placeholder="https://" /></Form.Item></Col></Row><Descriptions bordered column={1} size="small" style={{ marginBottom: 18 }}><Descriptions.Item label="开通方式">公众号购买兑换码，小程序内激活</Descriptions.Item><Descriptions.Item label="密钥管理">AppSecret不得填写在本页或提交到代码仓库</Descriptions.Item></Descriptions>{[
              ["privacyVerified", "隐私保护指引已在微信公众平台配置并实测"],
              ["identityMappingVerified", "微信登录、账号合并和权益找回已实测"],
              ["nativeShareVerified", "原生分享及落地页参数已实测"],
              ["subscribeMessageVerified", "订阅授权、服务端发送、失败重试已实测"],
              ["uploadPipelineVerified", "开发版上传、体验版冒烟和回滚已实测"],
            ].map(([name, label]) => <Form.Item key={name} name={name} label={label} valuePropName="checked"><Switch checkedChildren="已核验" unCheckedChildren="未核验" /></Form.Item>)}{canManage && <Button htmlType="submit" type="primary" loading={saving}>保存小程序验收状态</Button>}</Form></Card>,
          },
          {
            key: "health",
            label: "经营健康",
            children: <Row gutter={[16, 16]}><Col xs={12} lg={6}><Card><Statistic title="7日活跃用户" value={data.health.activeUsers7d} /></Card></Col><Col xs={12} lg={6}><Card><Statistic title="7日进入训练" value={data.health.practiceUsers7d} /></Card></Col><Col xs={12} lg={6}><Card><Statistic title="30日兑换用户" value={data.health.redeemedUsers30d} /></Card></Col><Col xs={12} lg={6}><Card><Statistic title="待处理异常" value={data.health.pendingReports + data.health.failedImports} prefix={<SafetyCertificateOutlined />} /></Card></Col></Row>,
          },
        ]}
      />
    </AdminPageFrame>
  );
}
