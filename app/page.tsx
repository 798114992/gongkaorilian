import type { Metadata } from "next";
import DailyPracticeApp from "./DailyPracticeApp";

export const metadata: Metadata = {
  title: "公考日练｜每天 30–60 分钟高效备考",
  description: "晨读、行测、错题复习、申论表达和语音听练，一个精简高效的每日公考学习工具。",
};

export default function Home() {
  return <DailyPracticeApp />;
}
