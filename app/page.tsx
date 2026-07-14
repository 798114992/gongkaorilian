import type { Metadata } from "next";
import DailyPracticeApp from "./DailyPracticeApp";

export const metadata: Metadata = {
  title: "公考日练｜国考＋多省考的每日训练处方",
  description: "按报考目标、到期错题和薄弱模块自动安排每天 30–60 分钟训练；忙时 10 分钟保底，练完就收工。",
};

export default function Home() {
  return <DailyPracticeApp />;
}
