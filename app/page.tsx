import type { Metadata } from "next";
import DailyPracticeApp from "./DailyPracticeApp";

export const metadata: Metadata = {
  title: "公考日练｜每天 20 分钟保持备考节奏",
  description: "晨读、行测、时政、错题和申论表达，一个轻量的每日公考学习工具。",
};

export default function Home() {
  return <DailyPracticeApp />;
}
