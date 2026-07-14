"use client";

import { useEffect, useState } from "react";

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

export default function AdminPage() {
  const [token, setToken] = useState("");
  const [codes, setCodes] = useState<CodeItem[]>([]);
  const [redemptions, setRedemptions] = useState<Redemption[]>([]);
  const [generated, setGenerated] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [batchName, setBatchName] = useState("渠道体验码");
  const [durationDays, setDurationDays] = useState(7);
  const [count, setCount] = useState(10);
  const [maxUses, setMaxUses] = useState(1);
  const [validUntil, setValidUntil] = useState("");
  const [rewardDays, setRewardDays] = useState(3);
  const [monthlyCap, setMonthlyCap] = useState(30);

  useEffect(() => {
    const remembered = window.sessionStorage.getItem("gkrl-admin-token");
    if (remembered) setToken(remembered);
  }, []);

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

  const copyGenerated = async () => {
    await navigator.clipboard.writeText(generated.join("\n"));
    setMessage("本批兑换码已复制");
  };

  return (
    <main className="admin-shell">
      <header className="admin-header"><div><span>公考日练</span><h1>运营管理后台</h1><p>配置兑换码、会员时长和邀请奖励</p></div><a href="/">返回用户端</a></header>

      <section className="admin-auth"><label>管理员口令<input type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="输入部署时配置的管理员口令" /></label><button onClick={load}>进入后台</button></section>
      {message && <div className="admin-message">{message}</div>}

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
          {generated.length > 0 && <div className="generated-box"><div><strong>本批明文兑换码</strong><button onClick={copyGenerated}>复制全部</button></div><pre>{generated.join("\n")}</pre><small>安全起见，数据库只保存哈希；离开页面前请复制本批明文兑换码。</small></div>}
        </section>

        <section className="admin-panel">
          <div className="admin-panel-title"><div><span>裂变活动</span><h2>邀请奖励配置</h2></div></div>
          <div className="form-grid">
            <label>双方奖励天数<input type="number" min="0" max="365" value={rewardDays} onChange={(event) => setRewardDays(Number(event.target.value))} /></label>
            <label>邀请人月度上限<input type="number" min="0" max="3650" value={monthlyCap} onChange={(event) => setMonthlyCap(Number(event.target.value))} /></label>
          </div>
          <p className="admin-note">好友首次成功兑换会员码后，邀请人与被邀请人获得相同时长。仅计算直接邀请，不形成多级关系。</p>
          <button className="admin-primary" onClick={updateInvite}>保存邀请配置</button>
        </section>
      </div>

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

