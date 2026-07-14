import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://gongkao-rilian-2026.bobanbeerbohm2055.chatgpt.site"),
  title: "公考日练",
  description: "每天 30–60 分钟，完成晨读、行测、时政、错题复习、申论表达和语音听练。",
  openGraph: {
    title: "公考日练",
    description: "每天 30–60 分钟，精简高效地完成公考日练",
    images: ["/og.png"],
  },
  twitter: {
    card: "summary_large_image",
    title: "公考日练",
    description: "每天 30–60 分钟，精简高效地完成公考日练",
    images: ["/og.png"],
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
