import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "公考日练",
  description: "每天 20 分钟，完成晨读、行测、时政、错题和申论表达。",
  openGraph: {
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
