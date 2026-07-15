const text = (value, max = 8_000) => String(value ?? "").trim().slice(0, max);

const chinaDateKey = (date = new Date()) => new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(date);

export function validatePublishableContent(contentType, content) {
  const issues = [];
  const requiredText = (field, label) => {
    if (!text(content[field])) issues.push(`${label}不能为空`);
  };
  const requiredDate = (field, label, allowFuture = false) => {
    const value = text(content[field], 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) issues.push(`${label}需使用YYYY-MM-DD`);
    else if (!allowFuture && value > chinaDateKey()) issues.push(`${label}不能晚于今天`);
  };
  const requiredHttps = (field, label) => {
    const value = text(content[field], 600);
    try {
      if (!value || new URL(value).protocol !== "https:") issues.push(`${label}必须是HTTPS官方来源`);
    } catch { issues.push(`${label}必须是HTTPS官方来源`); }
  };
  const requiredInteger = (field, label, min, max) => {
    const value = Number(content[field]);
    if (!Number.isInteger(value) || value < min || value > max) issues.push(`${label}必须是${min}—${max}的整数`);
  };
  const requireAuthority = () => {
    requiredText("source", "权威来源");
    requiredHttps("sourceUrl", "来源链接");
    requiredDate("sourceDate", "来源发布日期");
  };

  if (contentType === "morning_read") {
    requiredText("title", "标题");
    requiredDate("date", "展示日期");
    requiredText("body", "晨读正文");
    requireAuthority();
  } else if (contentType === "current_affairs") {
    requiredText("title", "标题");
    requiredDate("date", "展示日期");
    requiredText("summary", "热点摘要");
    requiredText("body", "热点正文");
    requiredInteger("importanceStars", "重要星级", 1, 5);
    requireAuthority();
  } else if (contentType === "essay_micro") {
    requiredText("title", "标题");
    requiredDate("date", "展示日期");
    requiredText("theme", "申论主题");
    requiredText("material", "申论材料");
    requiredText("prompt", "作答任务");
    requiredText("referenceAnswer", "参考答案");
    requiredInteger("wordLimit", "字数限制", 50, 2_000);
    const points = Array.isArray(content.scoringPoints)
      ? content.scoringPoints.map((value) => text(value, 500)).filter(Boolean)
      : text(content.scoringPoints, 8_000).split(/[,，、|｜;；\n]+/).map((value) => value.trim()).filter(Boolean);
    if (!points.length) issues.push("评分要点至少填写1项");
    requireAuthority();
  } else if (contentType === "audio_track") {
    requiredText("title", "节目标题");
    requiredText("seriesId", "栏目编码");
    requiredText("seriesTitle", "栏目名称");
    requiredText("description", "节目简介");
    requiredText("text", "音频逐字稿");
    requireAuthority();
  } else if (contentType === "exam_notice") {
    requiredText("targetCode", "考试目标");
    requiredText("title", "公告标题");
    requiredText("noticeType", "公告类型");
    requiredText("summary", "公告摘要");
    requiredHttps("sourceUrl", "公告来源链接");
    requiredDate("publishDate", "公告日期");
  } else if (contentType === "exam_event") {
    requiredText("targetCode", "考试目标");
    requiredText("title", "节点标题");
    requiredText("eventType", "节点类型");
    requiredHttps("sourceUrl", "节点来源链接");
    requiredDate("eventDate", "节点日期", true);
    requiredInteger("reminderDays", "提前提醒天数", 0, 30);
  } else if (contentType === "job_position") {
    for (const [field, label] of [
      ["targetCode", "考试目标"], ["examName", "考试名称"], ["department", "招录机关/部门"],
      ["title", "职位名称"], ["code", "职位代码"], ["region", "工作地区"],
    ]) requiredText(field, label);
    requiredInteger("recruitCount", "招录人数", 1, 9_999);
    requiredHttps("sourceUrl", "职位表来源链接");
    requiredDate("updatedAt", "职位数据更新时间");
    requiredInteger("dataVersion", "职位数据版本", 1, 1_000_000);
  } else if (contentType === "drill_preset") {
    requiredText("id", "专项编码");
    requiredText("title", "专项名称");
    requiredText("subject", "科目");
    requiredText("module", "模块");
    requiredInteger("questionCount", "每组题量", 1, 50);
    requiredInteger("minutes", "预计分钟", 1, 120);
  } else if (contentType === "strategy_config") {
    const plans = content.timePlans;
    if (!plans || typeof plans !== "object" || Array.isArray(plans)) issues.push("日练时间方案不能为空");
    else {
      for (const duration of ["10", "30", "45", "60"]) {
        const plan = plans[duration];
        if (!plan || typeof plan !== "object" || Array.isArray(plan)
          || !Number.isInteger(Number(plan.questionCount)) || Number(plan.questionCount) < 1) {
          issues.push(`${duration}分钟方案必须配置正整数题量`);
        }
      }
    }
  }
  return issues;
}
