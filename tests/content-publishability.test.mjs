import assert from "node:assert/strict";
import test from "node:test";
import { validatePublishableContent } from "../app/api/app/content-publishability.mjs";

const source = { source: "权威发布", sourceUrl: "https://example.gov.cn/source", sourceDate: "2026-07-15" };
const valid = {
  morning_read: { title: "晨读", date: "2026-07-15", body: "规范表达正文", ...source },
  current_affairs: { title: "热点", date: "2026-07-15", summary: "摘要", body: "解读正文", importanceStars: 4, ...source },
  essay_micro: { title: "申论微练", date: "2026-07-15", theme: "基层治理", material: "材料",
    prompt: "概括问题", referenceAnswer: "参考答案", wordLimit: 150, scoringPoints: ["问题", "对策"], ...source },
  audio_track: { title: "时政电台", seriesId: "current", seriesTitle: "时政电台", description: "节目简介",
    text: "音频逐字稿", ...source },
  exam_notice: { targetCode: "national", title: "国考公告", noticeType: "招录公告", summary: "公告摘要",
    sourceUrl: "https://example.gov.cn/notice", publishDate: "2026-07-15" },
  exam_event: { targetCode: "national", title: "报名开始", eventType: "报名开始", reminderDays: 3,
    sourceUrl: "https://example.gov.cn/event", eventDate: "2027-01-01" },
  job_position: { targetCode: "national", examName: "国考", department: "某部门", title: "一级主任科员",
    code: "10001", region: "北京", recruitCount: 1, sourceUrl: "https://example.gov.cn/jobs", dataVersion: 1, updatedAt: "2026-07-15" },
};

const requiredField = {
  morning_read: "body",
  current_affairs: "summary",
  essay_micro: "referenceAnswer",
  audio_track: "text",
  exam_notice: "summary",
  exam_event: "eventType",
  job_position: "code",
};

test("every learner-facing content renderer has a shared core-field release gate", () => {
  for (const [contentType, payload] of Object.entries(valid)) {
    assert.deepEqual(validatePublishableContent(contentType, payload), [], `${contentType} valid fixture must publish`);
    const missing = { ...payload };
    delete missing[requiredField[contentType]];
    assert.ok(validatePublishableContent(contentType, missing).length > 0, `${contentType} must reject a missing core field`);
  }
});

test("essay scoring, word limit and content dates cannot be fabricated or empty", () => {
  assert.match(validatePublishableContent("essay_micro", { ...valid.essay_micro, scoringPoints: [] }).join("；"), /评分要点/);
  assert.match(validatePublishableContent("essay_micro", { ...valid.essay_micro, wordLimit: 0 }).join("；"), /字数限制/);
  assert.match(validatePublishableContent("morning_read", { ...valid.morning_read, sourceDate: "2099-01-01" }).join("；"), /不能晚于今天/);
  assert.match(validatePublishableContent("exam_notice", { ...valid.exam_notice, sourceUrl: "http://example.com" }).join("；"), /HTTPS/);
});
