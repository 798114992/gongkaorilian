import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://gongkao-rilian-2026.sanzhu7758.chatgpt.site"),
  applicationName: "公考日练",
  title: "公考日练｜每日30分钟，聚焦重点训练",
  description: "依据报考地区、真题年份、考频、重要星级与拿分率，生成每日10–60分钟训练安排。",
  keywords: ["公考", "公务员考试", "行测真题", "申论", "错题复习", "省考", "国考"],
  alternates: { canonical: "/" },
  robots: { index: true, follow: true },
  icons: { icon: "/favicon.svg" },
  formatDetection: { telephone: false },
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "公考日练",
  },
  openGraph: {
    type: "website",
    locale: "zh_CN",
    siteName: "公考日练",
    title: "公考日练｜每日30分钟，聚焦重点训练",
    description: "国考与多省考真题智能安排，优先训练高频考点、重要题目和薄弱环节，错题按记忆周期复习。",
    images: [{
      url: "/og-v2.png",
      width: 1734,
      height: 907,
      alt: "公考日练：按报考目标组合安排真题日练与错题复习",
    }],
  },
  twitter: {
    card: "summary_large_image",
    title: "公考日练｜每日30分钟，聚焦重点训练",
    description: "国考与多省考真题智能安排，优先训练高频考点、重要题目和薄弱环节，错题按记忆周期复习。",
    images: ["/og-v2.png"],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  colorScheme: "light",
  themeColor: "#163861",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>
        <a className="skip-link" href="#main-content">跳到主要内容</a>
        <div id="main-content" className="site-content-root" tabIndex={-1}>{children}</div>
      </body>
    </html>
  );
}
