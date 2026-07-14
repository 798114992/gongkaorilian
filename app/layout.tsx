import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://gongkao-rilian-2026.bobanbeerbohm2055.chatgpt.site"),
  title: "公考日练",
  description: "每天 20 分钟，完成晨读、行测、时政、错题、申论表达和语音听练。",
  openGraph: {
    title: "公考日练",
    description: "每天 20 分钟，稳步接近上岸",
    images: ["/og-gongkao-rilian.png"],
  },
  twitter: {
    card: "summary_large_image",
    title: "公考日练",
    description: "每天 20 分钟，稳步接近上岸",
    images: ["/og-gongkao-rilian.png"],
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
