import type { Metadata } from "next";
import DailyPracticeApp from "./DailyPracticeApp";

export const metadata: Metadata = {
  title: "公考日练｜每日30分钟，聚焦重点训练",
  description: "依据报考地区、真题年份、考频、重要星级与拿分率，生成每日10–60分钟训练安排。",
};

export default function Home() {
  return <DailyPracticeApp />;
}
