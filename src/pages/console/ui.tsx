/**
 * Phase 1 Task 7: Shared UI primitives for the metadata console.
 *
 * Small components reused across console tabs. Styles follow DESIGN.md:
 * glass panels, sci-border, var(--*) tokens, mono labels, no gradients.
 */
import type { ReactNode, CSSProperties } from "react";
import { X } from "lucide-react";

type ModalProps = {
  readonly title: string;
  readonly children: ReactNode;
  readonly onClose: () => void;
  readonly footer: ReactNode;
};

export function Modal({ title, children, onClose, footer }: ModalProps) {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.6)" }}>
      <div className="glass-panel p-6 sci-border w-full max-w-md">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-bold font-mono" style={{ color: "var(--text-primary)" }}>{title}</h3>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-[rgba(180,200,255,0.05)] transition-colors"
            style={{ color: "var(--text-muted)" }}
            title="关闭"
          >
            <X size={14} />
          </button>
        </div>
        {children}
        <div className="flex items-center justify-end gap-2 mt-5">{footer}</div>
      </div>
    </div>
  );
}

type TextFieldProps = {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly type?: "text" | "number" | "password" | "datetime-local";
  readonly placeholder?: string;
  readonly disabled?: boolean;
};

export function TextField({ label, value, onChange, type = "text", placeholder, disabled }: TextFieldProps) {
  return (
    <div>
      <label className="text-[10px] font-mono mb-1 block" style={{ color: "var(--text-muted)" }}>{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        placeholder={placeholder}
        className="w-full px-3 py-2 rounded text-xs outline-none disabled:opacity-50"
        style={{ background: "rgba(0,0,0,0.2)", border: "1px solid var(--border-default)", color: "var(--text-primary)" }}
      />
    </div>
  );
}

type SelectOption = {
  readonly value: string;
  readonly label: string;
};

type SelectFieldProps = {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly options: readonly SelectOption[];
};

export function SelectField({ label, value, onChange, options }: SelectFieldProps) {
  return (
    <div>
      <label className="text-[10px] font-mono mb-1 block" style={{ color: "var(--text-muted)" }}>{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-3 py-2 rounded text-xs outline-none"
        style={{ background: "rgba(0,0,0,0.2)", border: "1px solid var(--border-default)", color: "var(--text-primary)" }}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
    </div>
  );
}

type ButtonProps = {
  readonly children: ReactNode;
  readonly onClick: () => void;
  readonly variant?: "primary" | "secondary" | "danger" | "ghost";
  readonly disabled?: boolean;
  readonly title?: string;
};

export function Button({ children, onClick, variant = "secondary", disabled, title }: ButtonProps) {
  const base = "text-xs px-3 py-1.5 rounded font-mono transition-colors disabled:opacity-50";
  const style: Record<Exclude<ButtonProps["variant"], undefined>, CSSProperties> = {
    primary: { background: "var(--accent-cyan)", color: "#000" },
    secondary: { border: "1px solid var(--border-default)", color: "var(--text-muted)" },
    danger: { background: "var(--accent-red)", color: "#fff" },
    ghost: { border: "1px solid var(--border-default)", color: "var(--text-muted)" },
  };
  const hover = variant === "secondary" || variant === "ghost" ? "hover:bg-[rgba(180,200,255,0.05)]" : "";
  return (
    <button onClick={onClick} disabled={disabled} title={title} className={`${base} ${hover}`} style={style[variant ?? "secondary"]}>
      {children}
    </button>
  );
}

type SectionLabelProps = {
  readonly children: ReactNode;
};

export function SectionLabel({ children }: SectionLabelProps) {
  return (
    <div className="text-[10px] font-mono mb-3 uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
      {children}
    </div>
  );
}

type EmptyStateProps = {
  readonly title: string;
  readonly desc: string;
  readonly icon: ReactNode;
};

export function EmptyState({ title, desc, icon }: EmptyStateProps) {
  return (
    <div className="text-center py-12" style={{ color: "var(--text-muted)" }}>
      <div className="mx-auto mb-3 opacity-30">{icon}</div>
      <div className="text-sm font-mono mb-1">{title}</div>
      <div className="text-[10px]">{desc}</div>
    </div>
  );
}

type InlineButtonProps = {
  readonly onClick: () => void;
  readonly icon: ReactNode;
  readonly title: string;
  readonly danger?: boolean;
};

export function InlineButton({ onClick, icon, title, danger }: InlineButtonProps) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`p-1 rounded transition-colors ${danger ? "hover:bg-[rgba(255,50,50,0.1)]" : "hover:bg-[rgba(180,200,255,0.05)]"}`}
      style={{ color: danger ? "var(--accent-red-bright)" : "var(--text-muted)" }}
    >
      {icon}
    </button>
  );
}

type BadgeProps = {
  readonly children: ReactNode;
  readonly color?: "cyan" | "gold" | "green" | "red" | "muted";
};

export function Badge({ children, color = "muted" }: BadgeProps) {
  const map: Record<Exclude<BadgeProps["color"], undefined>, { bg: string; fg: string }> = {
    cyan: { bg: "rgba(74,158,255,0.1)", fg: "var(--accent-cyan)" },
    gold: { bg: "rgba(255,200,50,0.1)", fg: "var(--accent-gold)" },
    green: { bg: "rgba(76,175,125,0.1)", fg: "var(--success)" },
    red: { bg: "rgba(255,50,50,0.1)", fg: "var(--accent-red-bright)" },
    muted: { bg: "rgba(255,255,255,0.03)", fg: "var(--text-muted)" },
  };
  const { bg, fg } = map[color ?? "muted"];
  return (
    <span className="text-[9px] px-1.5 py-0.5 rounded font-mono" style={{ background: bg, color: fg }}>
      {children}
    </span>
  );
}
