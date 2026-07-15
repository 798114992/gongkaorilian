"use client";

import { useCallback, useEffect, useState } from "react";
import { adminApi } from "./adminApi";

export function useAdminDomain<T extends Record<string, unknown>>(action: string, initialValue: T) {
  const [data, setData] = useState<T>(initialValue);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const reload = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setData(await adminApi<T>({ action }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "数据加载失败");
    } finally {
      setLoading(false);
    }
  }, [action]);

  useEffect(() => {
    const task = window.setTimeout(() => { void reload(); }, 0);
    return () => window.clearTimeout(task);
  }, [reload]);

  return { data, setData, loading, error, setError, reload };
}
