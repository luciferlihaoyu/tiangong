import { useState, useEffect } from "react";

export interface VersionInfo {
  ok: boolean;
  version: string;
  commit: string | null;
  shortCommit: string | null;
  buildTime: string;
  deployedAt: string | null;
  source: string;
  timestamp: string;
}

export function useVersion() {
  const [data, setData] = useState<VersionInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/version")
      .then((res) => res.json())
      .then((json) => {
        if (!cancelled) {
          setData(json);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e.message);
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, []);

  return { data, loading, error };
}
