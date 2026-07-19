const STATE_COPY = {
  guest: { title: "初始作答快照可直接开始", restriction: "正式训练需要登录后保存到账号", action: "开始初始作答快照", destination: "snapshot" },
  signed_in_no_target: { title: "尚未设置报考目标", restriction: "系统无法匹配地区和年份题库", action: "完善备考组合", destination: "onboarding" },
  no_bank: { title: "当前目标暂无可练题库", restriction: "只有已审核且与目标匹配的真题才能进入日练", action: "完善备考组合", destination: "banks" },
  partial_coverage: { title: "已有部分目标可以开始", restriction: "未覆盖目标暂不参与组题，不影响其他目标训练", action: "开始今日训练", destination: "today" },
  full_coverage: { title: "全部报考目标均已覆盖", restriction: "", action: "开始今日训练", destination: "today" },
  free: { title: "当前为免费用户", restriction: "每日任务按免费额度完成，不设置冲突门槛", action: "开始今日训练", destination: "today" },
  trial: { title: "体验会员生效中", restriction: "到期后保留记录，受限题库暂停新增训练", action: "继续今日训练", destination: "today" },
  member: { title: "正式会员生效中", restriction: "", action: "继续今日训练", destination: "today" },
  expiring: { title: "会员即将到期", restriction: "到期后学习记录保留，会员训练额度停止", action: "查看权益", destination: "membership" },
  expired: { title: "会员权益已到期", restriction: "历史记录保留，今日任务按免费额度重新计算", action: "兑换激活", destination: "redeem" },
  invited: { title: "邀请关系已绑定", restriction: "完成首次有效日练后奖励才会生效", action: "开始今日训练", destination: "today" },
  redeemed: { title: "兑换权益已到账", restriction: "", action: "返回原页面", destination: "return" },
  cross_device: { title: "学习数据已同步", restriction: "以服务端账号中的最新进度和权益为准", action: "继续原进度", destination: "resume" },
  load_error: { title: "学习数据暂时未加载成功", restriction: "失败期间不更新或覆盖本地学习进度", action: "立即重试", destination: "retry" },
};

export const LEARNER_STATE_KEYS = Object.freeze(Object.keys(STATE_COPY));

/**
 * The learner can have several flags at once (for example member + partial
 * coverage). `primary` is the one state that controls the home-page action;
 * `flags` preserves the remaining business context for analytics and support.
 */
export function resolveLearnerState(input) {
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  const membershipEnd = input.membershipEnd ? Date.parse(String(input.membershipEnd)) : Number.NaN;
  const daysLeft = Number.isFinite(membershipEnd) ? Math.ceil((membershipEnd - now) / 86_400_000) : null;
  const coverage = input.targetCount > 0
    ? input.coveredTargetCount <= 0 ? "no_bank"
      : input.coveredTargetCount < input.targetCount ? "partial_coverage" : "full_coverage"
    : null;
  const membership = input.membershipActive
    ? input.membershipSource === "trial" ? "trial"
      : daysLeft !== null && daysLeft <= 7 ? "expiring" : "member"
    : input.hadMembership ? "expired" : "free";
  const flags = [coverage, membership, input.invited ? "invited" : null, input.redeemed ? "redeemed" : null,
    input.crossDevice ? "cross_device" : null].filter(Boolean);

  let primary;
  if (input.loadError) primary = "load_error";
  else if (!input.signedIn) primary = "guest";
  else if (!input.onboarded || input.targetCount < 1) primary = "signed_in_no_target";
  else if (coverage === "no_bank") primary = "no_bank";
  else if (input.redeemed) primary = "redeemed";
  else if (input.crossDevice) primary = "cross_device";
  else if (input.invited) primary = "invited";
  else if (membership === "expiring" || membership === "expired") primary = membership;
  else if (coverage === "partial_coverage") primary = "partial_coverage";
  else if (membership === "trial" || membership === "member" || membership === "free") primary = membership;
  else primary = "full_coverage";

  return { primary, flags: Array.from(new Set(flags)), daysLeft, ...STATE_COPY[primary] };
}
