import type { Metadata } from "next";
import "antd/dist/reset.css";
import "./admin.css";

export const metadata: Metadata = {
  title: "公考日练运营后台",
  description: "公考日练内容、题库、招考数据与用户权益管理后台",
};

export default function AdminRootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
