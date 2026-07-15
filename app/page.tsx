import type { Metadata } from "next";
import DailyPracticeApp from "./DailyPracticeApp";

export const metadata: Metadata = {
  title: "公考日练｜每天30分钟，只练最该练的",
  description: "用真题按报考地区、年份、考频、重要星级和拿分率安排每天 10–60 分钟训练；少做无效题，练完就收工。",
};

export default function Home() {
  return <DailyPracticeApp />;
}
