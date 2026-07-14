"use client";

import Link from "next/link";
import { useState } from "react";
import QuestionBankManager, { type QuestionBankItem, type QuestionImportItem } from "./QuestionBankManager";

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
type ContentItem = {
  id: number;
  content_type: "practice_day" | "audio_track" | "exam_event";
  content_key: string;
  title: string;
  status: "draft" | "published";
  publish_at: string | null;
  updated_at: string;
};
type EventCount = { event_name: string; count: number | string };
type Analytics = { activeUsers: number; eventCounts: EventCount[] };

const contentExample = JSON.stringify([
  {
    contentType: "audio_track",
    contentKey: "august-hotspot",
    title: "八月热点：示例标题",
    status: "draft",
    publishAt: null,
    payload: {
      id: "august-hotspot",
      category: "current",
      title: "八月热点：示例标题",
      kicker: "月度热点",
      source: "公考日练整理",
      duration: "5分钟",
      description: "一句话说明本期音频价值。",
      text: "在这里填写音频逐字稿。",
      audioUrl: "/audio/august-hotspot.wav",
    },
  },
  {
    contentType: "exam_event",
    contentKey: "gd-2027-registration-end",
    title: "广东省考报名截止",
    status: "draft",
    publishAt: null,
    payload: {
      targetCode: "province:广东",
      targetLabel: "广东省考",
      eventType: "报名截止",
      title: "广东省考报名截止",
      eventDate: "2026-12-31",
      reminderDays: 3,
      sourceUrl: "https://example.com/official-announcement",
    },
  },
], null, 2);

export default function AdminPage() {
  const [token, setToken] = useState(() => typeof window === "undefined" ? "" : window.sessionStorage.getItem("gkrl-admin-token") ?? "");
  const [codes, setCodes] = useState<CodeItem[]>([]);
  const [redemptions, setRedemptions] = useState<Redemption[]>([]);
  const [content, setContent] = useState<ContentItem[]>([]);
  const [analytics, setAnalytics] = useState<Analytics>({ activeUsers: 0, eventCounts: [] });
  const [questionBanks, setQuestionBanks] = useState<QuestionBankItem[]>([]);
  const [questionImports, setQuestionImports] = useState<QuestionImportItem[]>([]);
  const [generated, setGenerated] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [batchName, setBatchName] = useState("渠道体验码");
  const [durationDays, setDurationDays] = useState(7);
  const [count, setCount] = useState(10);
  const [maxUses, setMaxUses] = useState(1);
  const [validUntil, setValidUntil] = useState("");
  const [rewardDays, setRewardDays] = useState(3);
  const [monthlyCap, setMonthlyCap] = useState(30);
  const [contentJson, setContentJson] = useState(contentExample);

  const api = async (payload: Record<string, unknown>) => {
    const response = await fetch("/api/app", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, adminToken: token }),
    });
    const data = await response.json() as Record<string, unknown> & { error?: string };
    if (!response.ok) throw new Error(data.error || "操作失败");
    return data;
  };

  const load = async () => {
    try {
      window.sessionStorage.setItem("gkrl-admin-token", token);
      const data = await api({ action: "adminList" });
      setCodes((data.codes ?? []) as CodeItem[]);
      setRedemptions((data.redemptions ?? []) as Redemption[]);
      setContent((data.content ?? []) as ContentItem[]);
      setAnalytics((data.analytics ?? { activeUsers: 0, eventCounts: [] }) as Analytics);
      setQuestionBanks((data.questionBanks ?? []) as QuestionBankItem[]);
      setQuestionImports((data.questionImports ?? []) as QuestionImportItem[]);
      const config = data.config as { rewardDays?: number; monthlyCap?: number } | undefined;
      setRewardDays(config?.rewardDays ?? 3);
      setMonthlyCap(config?.monthlyCap ?? 30);
      setMessage("管理数据已更新");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "加载失败");
    }
  };

  const createCodes = async () => {
    try {
      const data = await api({ action: "adminCreateCodes", batchName, durationDays, count, maxUses, validUntil: validUntil || null });
      setGenerated((data.codes ?? []) as string[]);
      setMessage(`已生成 ${count} 个兑换码，请立即复制保存`);
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "生成失败");
    }
  };

  const disableCode = async (id: number) => {
    try {
      await api({ action: "adminDisableCode", id });
      setMessage("兑换码已停用");
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "停用失败");
    }
  };

  const updateInvite = async () => {
    try {
      await api({ action: "adminUpdateConfig", rewardDays, monthlyCap });
      setMessage("邀请奖励配置已保存");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存失败");
    }
  };

  const importContent = async () => {
    try {
      const parsed = JSON.parse(contentJson) as unknown;
      if (!Array.isArray(parsed)) throw new Error("内容必须是 JSON 数组");
      await api({ action: "adminUpsertContentBatch", items: parsed });
      setMessage(`已导入 ${parsed.length} 条内容；published 状态会立即生效`);
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "内容导入失败");
    }
  };

  const disableContent = async (id: number) => {
    try {
      await api({ action: "adminDisableContent", id });
      setMessage("内容已转为草稿，不再向用户展示");
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "内容下线失败");
    }
  };

  const copyGenerated = async () => {
    await navigator.clipboard.writeText(generated.join("\n"));
    setMessage("本批兑换码已复制");
  };

  const metric = (name: string) => Number(analytics.eventCounts.find((item) => item.event_name === name)?.count ?? 0);

  return (
    <main className="admin-shell">
      <header className="admin-header"><div><span>公考日练</span><h1>运营管理后台</h1><p>管理兑换码、内容发布、邀请奖励和运营数据</p></div><Link href="/">返回用户端</Link></header>

      <section className="admin-auth"><label>管理员口令<input type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="输入部署时配置的管理员口令" /></label><button onClick={load}>进入后台</button></section>
      {message && <div className="admin-message">{message}</div>}

      <section className="analytics-grid" aria-label="近七日运营数据">
        <article><span>7日活跃用户</span><strong>{analytics.activeUsers}</strong></article>
        <article><span>打开次数</span><strong>{metric("app_open")}</strong></article>
        <article><span>行测交卷</span><strong>{metric("quiz_submit")}</strong></article>
        <article><span>音频播放</span><strong>{metric("audio_play")}</strong></article>
        <article><span>兑换成功</span><strong>{metric("redeem_success")}</strong></article>
      </section>

      <QuestionBankManager
        adminToken={token}
        banks={questionBanks}
        imports={questionImports}
        onReload={load}
        onMessage={setMessage}
      />

      <div className="admin-grid">
        <section className="admin-panel">
          <div className="admin-panel-title"><div><span>兑换码</span><h2>创建新批次</h2></div></div>
          <div className="form-grid">
            <label>批次名称<input value={batchName} onChange={(event) => setBatchName(event.target.value)} /></label>
            <label>会员天数<select value={durationDays} onChange={(event) => setDurationDays(Number(event.target.value))}><option value={7}>7 天</option><option value={30}>30 天</option><option value={365}>365 天</option></select></label>
            <label>生成数量<input type="number" min="1" max="200" value={count} onChange={(event) => setCount(Number(event.target.value))} /></label>
            <label>每码可用次数<input type="number" min="1" value={maxUses} onChange={(event) => setMaxUses(Number(event.target.value))} /></label>
            <label className="wide">兑换截止日期<input type="date" value={validUntil} onChange={(event) => setValidUntil(event.target.value)} /></label>
          </div>
          <button className="admin-primary" onClick={createCodes}>生成随机兑换码</button>
          {generated.length > 0 && <div className="generated-box"><div><strong>本批明文兑换码</strong><button onClick={copyGenerated}>复制全部</button></div><pre>{generated.join("\n")}</pre><small>数据库只保存哈希；离开页面前请复制本批明文兑换码。</small></div>}
        </section>

        <section className="admin-panel">
          <div className="admin-panel-title"><div><span>邀请活动</span><h2>邀请奖励配置</h2></div></div>
          <div className="form-grid">
            <label>双方奖励天数<input type="number" min="0" max="365" value={rewardDays} onChange={(event) => setRewardDays(Number(event.target.value))} /></label>
            <label>邀请人月度上限<input type="number" min="0" max="3650" value={monthlyCap} onChange={(event) => setMonthlyCap(Number(event.target.value))} /></label>
          </div>
          <p className="admin-note">好友首次成功激活会员码后，邀请人与被邀请人获得相同时长。只计算直接邀请，不形成多级关系。</p>
          <button className="admin-primary" onClick={updateInvite}>保存邀请配置</button>
        </section>
      </div>

      <section className="admin-panel content-editor">
        <div className="admin-panel-title"><div><span>内容发布</span><h2>批量导入日练、电台或考试节点</h2></div><small>先用 draft 预存，确认后改为 published</small></div>
        <textarea value={contentJson} onChange={(event) => setContentJson(event.target.value)} spellCheck={false} />
        <div className="content-editor-actions"><p>支持 <code>practice_day</code>、<code>audio_track</code> 和 <code>exam_event</code>；同一 contentKey 再次导入会更新原内容。</p><button className="admin-primary" onClick={importContent}>校验并导入</button></div>
      </section>

      <section className="admin-panel table-panel">
        <div className="admin-panel-title"><div><span>内容库</span><h2>已导入内容</h2></div><button onClick={load}>刷新</button></div>
        <div className="admin-table-wrap"><table><thead><tr><th>类型</th><th>标识</th><th>标题</th><th>状态</th><th>更新时间</th><th>操作</th></tr></thead><tbody>{content.length ? content.map((item) => <tr key={item.id}><td>{item.content_type === "audio_track" ? "电台" : item.content_type === "exam_event" ? "考试节点" : "日练"}</td><td>{item.content_key}</td><td>{item.title}</td><td><span className={`status ${item.status}`}>{item.status === "published" ? "已发布" : "草稿"}</span></td><td>{new Date(item.updated_at).toLocaleString("zh-CN")}</td><td>{item.status === "published" && <button onClick={() => disableContent(item.id)}>转为草稿</button>}</td></tr>) : <tr><td colSpan={6}>暂无自定义内容，系统默认内容仍正常展示。</td></tr>}</tbody></table></div>
      </section>

      <section className="admin-panel table-panel">
        <div className="admin-panel-title"><div><span>最近批次</span><h2>兑换码状态</h2></div><button onClick={load}>刷新</button></div>
        <div className="admin-table-wrap"><table><thead><tr><th>兑换码</th><th>批次</th><th>权益</th><th>使用</th><th>状态</th><th>操作</th></tr></thead><tbody>{codes.map((code) => <tr key={code.id}><td>{code.code_preview}</td><td>{code.batch_name}</td><td>{code.duration_days}天</td><td>{code.used_count}/{code.max_uses}</td><td><span className={`status ${code.status}`}>{code.status === "active" ? "可用" : "已停用"}</span></td><td>{code.status === "active" && <button onClick={() => disableCode(code.id)}>停用</button>}</td></tr>)}</tbody></table></div>
      </section>

      <section className="admin-panel table-panel">
        <div className="admin-panel-title"><div><span>使用记录</span><h2>最近兑换</h2></div></div>
        <div className="admin-table-wrap"><table><thead><tr><th>时间</th><th>用户</th><th>兑换码</th><th>增加</th></tr></thead><tbody>{redemptions.map((item, index) => <tr key={`${item.redeemed_at}-${index}`}><td>{new Date(item.redeemed_at).toLocaleString("zh-CN")}</td><td>{item.user_id.slice(0, 8)}</td><td>{item.code_preview}</td><td>+{item.duration_days}天</td></tr>)}</tbody></table></div>
      </section>
    </main>
  );
}
