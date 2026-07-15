import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://gongkao-rilian-2026.bobanbeerbohm2055.chatgpt.site"),
  title: "公考日练｜每天30分钟，只练最该练的",
  description: "用真题按报考地区、年份、考频、重要星级和拿分率安排每天 10–60 分钟训练；少做无效题，练完就收工。",
  openGraph: {
    title: "公考日练｜每天30分钟，只练最该练的",
    description: "国考＋多省考真题智能安排，优先高频、高星和最值得拿下的题，错题按记忆节奏回炉。",
    images: ["/og-v2.png"],
  },
  twitter: {
    card: "summary_large_image",
    title: "公考日练｜每天30分钟，只练最该练的",
    description: "国考＋多省考真题智能安排，优先高频、高星和最值得拿下的题，错题按记忆节奏回炉。",
    images: ["/og-v2.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
