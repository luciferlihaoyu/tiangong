import HealthLight from "./HealthLight";

interface AppCardProps {
  label: string;
  description: string;
  url?: string;
  status: "ok" | "down" | "unknown";
  latencyMs?: number;
  reason?: string;
  disabled?: boolean;
  badge?: string;
  /** SSO 签票进行中：该卡禁点并显示忙碌态，防止连击 */
  busy?: boolean;
  /** 外部接管点击（如 SSO 联邦登录签票）；缺省时直接 window.open */
  onOpen?: (url: string) => void;
}

export default function AppCard({
  label,
  description,
  url,
  status,
  latencyMs,
  reason,
  disabled,
  badge,
  busy,
  onOpen,
}: AppCardProps) {
  const clickable = !disabled && !!url;

  const handleClick = () => {
    if (!clickable || !url || busy) return;
    if (onOpen) {
      onOpen(url);
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled || busy}
      title={clickable ? url : undefined}
      className={`glass-panel p-4 sci-border transition-all text-left w-full ${
        clickable ? "cursor-pointer hover:border-[var(--accent-gold)]/30 hover:brightness-110" : "cursor-default"
      }`}
      style={{ opacity: disabled ? 0.55 : 1 }}
    >
      <div className="flex items-center justify-between gap-2 mb-2">
        <span
          className="text-sm font-bold tracking-wide truncate"
          style={{ color: disabled ? "var(--text-muted)" : "var(--text-primary)" }}
        >
          {label}
        </span>
        <HealthLight status={status} latencyMs={latencyMs} reason={reason} />
      </div>
      <div className="text-xs truncate" style={{ color: "var(--text-secondary)" }}>
        {description}
      </div>
      {busy && (
        <div className="mt-2">
          <span
            className="text-[10px] px-1.5 py-0.5 rounded font-mono"
            style={{ background: "var(--accent-glow-gold)", color: "var(--accent-gold)" }}
          >
            登录中…
          </span>
        </div>
      )}
      {badge && (
        <div className="mt-2">
          <span
            className="text-[10px] px-1.5 py-0.5 rounded font-mono"
            style={{ background: "var(--accent-glow-gold)", color: "var(--accent-gold)" }}
          >
            {badge}
          </span>
        </div>
      )}
    </button>
  );
}
