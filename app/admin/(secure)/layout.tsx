import AdminShell from "../AdminShell";

export default function SecureAdminLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <AdminShell>{children}</AdminShell>;
}
