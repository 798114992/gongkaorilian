import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://gongkao-rilian-2026.bobanbeerbohm2055.chatgpt.site"),
  title: "公考日练｜国考＋多省考每日安排",
  description: "按报考目标、到期错题和薄弱模块自动安排每天 30–60 分钟训练；忙时 10 分钟保底，练完就收工。",
  openGraph: {
    title: "公考日练｜每天练什么，系统直接安排",
    description: "国考＋多省考智能混练，错题按 1/3/7/14/30 天回炉，忙时 10 分钟也不断档。",
    images: ["/og-v2.png"],
  },
  twitter: {
    card: "summary_large_image",
    title: "公考日练｜每天练什么，系统直接安排",
    description: "国考＋多省考智能混练，错题按 1/3/7/14/30 天回炉，忙时 10 分钟也不断档。",
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
