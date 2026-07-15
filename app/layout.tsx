import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://gongkao-rilian-2026.bobanbeerbohm2055.chatgpt.site"),
  applicationName: "公考日练",
  title: "公考日练｜每天30分钟，只练最该练的",
  description: "用真题按报考地区、年份、考频、重要星级和拿分率安排每天 10–60 分钟训练；少做无效题，练完就收工。",
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
    title: "公考日练｜每天30分钟，只练最该练的",
    description: "国考＋多省考真题智能安排，优先高频、高星和最值得拿下的题，错题按记忆节奏回炉。",
    images: [{
      url: "/og-v2.png",
      width: 1734,
      height: 907,
      alt: "公考日练：按目标组合安排真题日练与错题回炉",
    }],
  },
  twitter: {
    card: "summary_large_image",
    title: "公考日练｜每天30分钟，只练最该练的",
    description: "国考＋多省考真题智能安排，优先高频、高星和最值得拿下的题，错题按记忆节奏回炉。",
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
