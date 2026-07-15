"use client";

import { useEffect, useState } from "react";
import styles from "./CommercePaywall.module.css";

export type PaywallReason = "daily_limit" | "second_bank" | "essay" | "value_loop";

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
};

const reasonCopy: Record<PaywallReason, { eyebrow: string; title: string; detail: string }> = {
  daily_limit: {
    eyebrow: "今日免费真题已完成",
    title: "保留今天的手感，继续练下去",
    detail: "你的作答和错题已经保存。开通后可继续组题，完成后会回到刚才的训练动作。",
  },
  second_bank: {
    eyebrow: "备考组合扩展",
    title: "把国考与多个省考一起加入书架",
    detail: "免费版可保留 1 套题库；开通后可按真实报名组合加入多套题库，并参与每日组题。",
  },
  essay: {
    eyebrow: "申论真题微练",
    title: "解锁申论作答、自评与二次改写",
    detail: "开通后继续刚才的申论真题，草稿、自评和回炉节点都会保留。",
  },
  value_loop: {
    eyebrow: "公考日练终身会员",
    title: "用一套轻量闭环完成每天 10–60 分钟",
    detail: "解锁多题库组合、每日真题、申论微练、错题回炉与电台听练。",
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
}: CommercePaywallProps) {
  const [catalog, setCatalog] = useState<ProductsResponse | null>(null);
  const [order, setOrder] = useState<CommerceOrder | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [idempotencyKey] = useState(() => clientKey("checkout"));
  const [callbackId] = useState(() => clientKey("callback"));
  const copy = reasonCopy[reason];

  useEffect(() => {
    let active = true;
    trackEvent("paywall_view", { reason, signedIn, source: "entitlement_gate" });
    void request<ProductsResponse>({ action: "getCommerceProducts" })
      .then((result) => { if (active) setCatalog(result); })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "权益信息加载失败"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [reason, request, signedIn, trackEvent]);

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
          <div className={styles.valueStrip} aria-label="你的真实学习进度">
            <div><strong>{value.completedQuestions}</strong><span>累计真题</span></div>
            <div><strong>{value.wrongQuestions}</strong><span>待巩固</span></div>
            <div><strong>{value.tomorrowDue}</strong><span>明日到期</span></div>
            <div><strong>{reason === "second_bank" ? value.bankCount : value.tomorrowMinutes}</strong><span>{reason === "second_bank" ? "已加题库" : "预计分钟"}</span></div>
          </div>
        )}

        {loading ? <div className={styles.loading}>正在读取权益配置…</div> : product ? (
          <article className={styles.product}>
            <div className={styles.productTop}>
              <div><span>唯一核心套餐</span><h3>{product.name}</h3></div>
              <div className={styles.price}><small>¥</small><strong>{priceText(product.priceCents)}</strong><span>/ 终身</span></div>
            </div>
            <p>{product.publicPromise || "29.8元一次购买，终身使用"}</p>
            <ul>
              <li>多套国考、省考与专项题库自由组合</li>
              <li>每日真题不限 5 题，错题按记忆周期回炉</li>
              <li>申论真题微练、学习诊断与电台完整解锁</li>
            </ul>
          </article>
        ) : <div className={styles.error}>当前没有可用商品，请联系运营人员检查商品配置。</div>}

        {catalog && (
          <div className={catalog.testMode ? styles.testNotice : styles.unavailableNotice}>
            <b>{catalog.testMode ? "测试支付模式 · 不会扣款" : "真实支付尚未接入"}</b>
            <span>{catalog.notice}</span>
          </div>
        )}
        {order && <div className={styles.order}><span>测试订单</span><b>{order.orderNo}</b><small>仅用于验证订单与权益链路</small></div>}
        {error && <p className={styles.error} role="alert">{error}</p>}

        <div className={styles.actions}>
          {!signedIn ? (
            <a className={styles.primary} href={loginHref} onClick={onLogin}>登录后开通并同步权益</a>
          ) : catalog?.testMode ? (
            order
              ? <button className={styles.primary} type="button" disabled={submitting} onClick={() => void completeOrder()}>{submitting ? "发放中…" : "确认测试支付并发放权益（不扣款）"}</button>
              : <button className={styles.primary} type="button" disabled={submitting || !product} onClick={() => void createOrder()}>{submitting ? "创建中…" : "创建测试订单（不会扣款）"}</button>
          ) : (
            <button className={styles.primary} type="button" disabled>在线支付待接入</button>
          )}
          <button className={styles.secondary} type="button" onClick={openRedemption}>已有兑换码，去激活</button>
        </div>
        <p className={styles.footnote}>测试环境不会产生真实交易；正式支付接入前，不会展示虚假的支付成功状态。</p>
      </section>
    </div>
  );
}
