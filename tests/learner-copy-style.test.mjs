import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("learner-facing study copy uses consistent professional terminology", async () => {
  const [daily, commerce, audio, quiz] = await Promise.all([
    readFile(new URL("../app/DailyPracticeApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/CommercePaywall.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/AudioHub.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/QuizFeature.tsx", import.meta.url), "utf8"),
  ]);
  const learnerCopy = `${daily}\n${commerce}\n${audio}`;

  for (const phrase of [
    "能力诊断",
    "到期复习",
    "确定掌握",
    "掌握不稳定",
    "猜测作答",
    "专项强化",
    "第二版作答",
    "系统朗读",
  ]) assert.match(learnerCopy, new RegExp(phrase));

  for (const phrase of [
    "安心收工",
    "按顺序做，不用自己想",
    "今天学够了",
    "题已入账",
    "保留今天的手感",
    "今日主线",
    "完成今日主线后解锁",
    "请联系运营人员",
    "本题已在本机排队",
    "答题标识",
    "解锁采分点",
    "解锁参考表达",
    "像选词书一样",
    "今天必须处理",
  ]) assert.doesNotMatch(learnerCopy, new RegExp(phrase));

  assert.match(quiz, /测出了“局长”思维/);
  assert.match(quiz, /体制外自由灵魂/);
});
