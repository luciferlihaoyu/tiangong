interface HealthLightProps {
  status: "ok" | "down" | "unknown";
  latencyMs?: number;
  reason?: string;
}

const STATUS_COLORS: Record<HealthLightProps["status"], string> = {
  ok: "var(--success)",
  down: "var(--accent-red)",
  unknown: "var(--text-muted)",
};

export default function HealthLight({ status, latencyMs, reason }: HealthLightProps) {
  const title =
    status === "ok" && latencyMs !== undefined
      ? `延迟 ${latencyMs}ms`
      : reason;

  return (
    <span
      className="inline-block w-2 h-2 rounded-full flex-shrink-0"
      style={{ background: STATUS_COLORS[status] }}
      title={title}
    />
  );
}
