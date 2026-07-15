export type AdminApiPayload = Record<string, unknown> & { action: string };

export async function adminApi<T extends Record<string, unknown>>(payload: AdminApiPayload): Promise<T> {
  const response = await fetch("/api/app", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json() as T & { error?: string };
  if (!response.ok) {
    if (response.status === 401 && typeof window !== "undefined") {
      const returnTo = `${window.location.pathname}${window.location.search}`;
      window.location.assign(`/admin/login?returnTo=${encodeURIComponent(returnTo)}`);
    }
    throw new Error(data.error || "操作失败，请稍后重试");
  }
  return data;
}

