"use client";

import { useEffect, useState } from "react";
import styles from "./CommercePaywall.module.css";

export type PaywallReason = "daily_limit" | "second_bank" | "essay" | "radar" | "value_loop";

type CommerceProduct = {
  id: string;
  name: string;
  description: string;
  priceCents: number;
  currency: string;
  grantType: "duration" | "lifetime";
  durationDays: number | null;
  publicPromise: string;
};

type CommerceOrder = {
  id: string;
  orderNo: string;
  productId: string;
  productName: string;
  amountCents: number;
  currency: string;
  status: string;
};

type ProductsResponse = {
  products: CommerceProduct[];
  checkoutMode: "test" | "unavailable";
  testMode: boolean;
  membershipActive: boolean;
  notice: string;
};

type OrderResponse = {
  order: CommerceOrder;
  testMode: boolean;
  notice?: string;
};

type PaywallValue = {
  completedQuestions: number;
  wrongQuestions: number;
  tomorrowDue: number;
  tomorrowMinutes: number;
  bankCount: number;
};

type CommercePaywallProps = {
  reason: PaywallReason;
  signedIn: boolean;
  returnContext?: Record<string, unknown>;
  value: PaywallValue;
  request: <T,>(payload: Record<string, unknown>) => Promise<T>;
  trackEvent: (eventName: string, eventData?: Record<string, unknown>) => void;
  notify: (message: string) => void;
  onClose: () => void;
  onActivated: () => Promise<void> | void;
  onOpenRedemption: () => void;
  loginHref: string;
  onLogin: () => void;
  copyOverride?: { eyebrow?: string; title?: string; detail?: string };
  policyId?: string;
  triggerEvent?: string;
};

const reasonCopy: Record<PaywallReason, { eyebrow: string; title: string; detail: string }> = {
  daily_limit: {
    eyebrow: "今日免费真题已完成",
    title: "继续完成今日训练",
    detail: "当前作答记录和错题进度已保存。激活会员权益后，可从当前练习进度继续。",
  },
  second_bank: {
    eyebrow: "备考组合扩展",
    title: "扩展国考与多省考备考组合",
    detail: "免费版可保留1套题库；会员可按实际报考组合添加多套题库，并参与每日组题。",
  },
  essay: {
    eyebrow: "申论真题微练",
    title: "继续申论作答、自评与第二版作答",
    detail: "激活会员权益后可继续当前申论真题，草稿、自评和后续复习计划均会保留。",
  },
  radar: {
    eyebrow: "公考雷达完整筛选",
    title: "根据报考条件筛选职位",
    detail: "开通后可同时筛国考和多个省考，按学历、专业、身份等条件匹配，并收藏、横向对比职位。",
  },
  value_loop: {
    eyebrow: "公考日练终身会员",
    title: "按每日10–60分钟完成重点训练",
    detail: "会员可使用多题库组合、每日真题、申论微练、错题间隔复习和学习诊断。",
  },
};

function clientKey(prefix: string) {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  return `${prefix}:${random}`;
}

function priceText(cents: number) {
  const amount = Math.max(0, Number(cents) || 0) / 100;
  return amount.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
}

export default function CommercePaywall({
  reason,
  signedIn,
  returnContext = {},
  value,
  request,
  trackEvent,
  notify,
  onClose,
  onActivated,
  onOpenRedemption,
  loginHref,
  onLogin,
  copyOverride,
  policyId = "",
  triggerEvent = "",
}: CommercePaywallProps) {
  const [catalog, setCatalog] = useState<ProductsResponse | null>(null);
  const [order, setOrder] = useState<CommerceOrder | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [idempotencyKey] = useState(() => clientKey("checkout"));
  const [callbackId] = useState(() => clientKey("callback"));
  const baseCopy = reasonCopy[reason];
  const copy = {
    eyebrow: copyOverride?.eyebrow?.trim() || baseCopy.eyebrow,
    title: copyOverride?.title?.trim() || baseCopy.title,
    detail: copyOverride?.detail?.trim() || baseCopy.detail,
  };

  useEffect(() => {
    let active = true;
    trackEvent("paywall_view", { reason, signedIn, source: "entitlement_gate", policyId, triggerEvent });
    void request<ProductsResponse>({ action: "getCommerceProducts" })
      .then((result) => { if (active) setCatalog(result); })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "权益信息加载失败"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [policyId, reason, request, signedIn, trackEvent, triggerEvent]);

  const product = catalog?.products.find((item) => item.grantType === "lifetime") ?? catalog?.products[0] ?? null;
  const createOrder = async () => {
    if (!product || submitting) return;
    setSubmitting(true);
    setError("");
    trackEvent("paywall_action", { reason, action: "create_test_order", productId: product.id });
    try {
      const result = await request<OrderResponse>({
        action: "createTestOrder",
        productId: product.id,
        idempotencyKey,
        returnContext: { ...returnContext, reason },
      });
      setOrder(result.order);
      notify(result.notice || "测试订单已创建，不会扣款");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "测试订单创建失败");
    } finally {
      setSubmitting(false);
    }
  };

  const completeOrder = async () => {
    if (!order || submitting) return;
    setSubmitting(true);
    setError("");
    trackEvent("paywall_action", { reason, action: "complete_test_payment", orderId: order.id });
    try {
      await request({ action: "completeTestPayment", orderId: order.id, callbackId });
      notify("测试权益已发放，正在继续刚才的学习动作");
      await onActivated();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "测试权益发放失败");
    } finally {
      setSubmitting(false);
    }
  };

  const openRedemption = () => {
    trackEvent("paywall_action", { reason, action: "open_redemption" });
    onOpenRedemption();
  };

  return (
    <div className={styles.backdrop} role="dialog" aria-modal="true" aria-labelledby="commerce-paywall-title">
      <section className={styles.card}>
        <button className={styles.close} type="button" aria-label="关闭权益说明" onClick={onClose}>×</button>
        <div className={styles.hero}>
          <span className={styles.eyebrow}>{copy.eyebrow}</span>
          <h2 id="commerce-paywall-title">{copy.title}</h2>
          <p>{copy.detail}</p>
        </div>

        {value.completedQuestions > 0 && (
          <div className={styles.valueStrip} aria-label="当前学习进度">
            <div><strong>{value.completedQuestions}</strong><span>累计真题</span></div>
            <div><strong>{value.wrongQuestions}</strong><span>待复习</span></div>
            <div><strong>{value.tomorrowDue}</strong><span>明日到期</span></div>
            <div><strong>{reason === "second_bank" ? value.bankCount : value.tomorrowMinutes}</strong><span>{reason === "second_bank" ? "已加题库" : "预计分钟"}</span></div>
          </div>
        )}

        {loading ? <div className={styles.loading}>正在读取权益配置…</div> : product ? (
          <article className={styles.product}>
            <div className={styles.productTop}>
              <div><span>会员方案</span><h3>{product.name}</h3></div>
              <div className={styles.price}><small>¥</small><strong>{priceText(product.priceCents)}</strong><span>/ 终身</span></div>
            </div>
            <p>{product.publicPromise || "29.8元开通终身会员"}</p>
            <ul>
              <li>多套国考、省考与专项题库自由组合</li>
              <li>可按10–60分钟计划完成每日真题训练，错题按记忆周期复习</li>
              <li>可使用申论真题微练、学习诊断与薄弱项强化</li>
            </ul>
          </article>
        ) : <div className={styles.error}>当前暂无可购买的会员方案，请稍后再试。</div>}

        {catalog && (
          <div className={catalog.testMode ? styles.testNotice : styles.unavailableNotice}>
            <b>{catalog.testMode ? "测试支付模式 · 不会扣款" : "当前采用兑换码激活"}</b>
            <span>{catalog.notice}</span>
          </div>
        )}
        {order && <div className={styles.order}><span>测试订单</span><b>{order.orderNo}</b><small>仅用于验证订单与权益链路</small></div>}
        {error && <p className={styles.error} role="alert">{error}</p>}

        <div className={styles.actions}>
          {!signedIn ? (
            <a className={styles.primary} href={loginHref} onClick={onLogin}>登录后兑换并同步权益</a>
          ) : catalog?.testMode ? (
            order
              ? <button className={styles.primary} type="button" disabled={submitting} onClick={() => void completeOrder()}>{submitting ? "发放中…" : "确认测试支付并发放权益（不扣款）"}</button>
              : <button className={styles.primary} type="button" disabled={submitting || !product} onClick={() => void createOrder()}>{submitting ? "创建中…" : "创建测试订单（不会扣款）"}</button>
          ) : (
            <button className={styles.primary} type="button" disabled>请前往官方公众号购买兑换码</button>
          )}
          <button className={styles.secondary} type="button" onClick={openRedemption}>已有兑换码，立即激活</button>
        </div>
        <p className={styles.footnote}>当前不支持应用内直接付款；请通过官方公众号购买兑换码后返回激活。</p>
      </section>
    </div>
  );
}
