import type { CSSProperties } from "react";

import { Icon } from "./Icon";

export interface PageHeaderProps {
  heading: string;
  subtitle?: string;
  actionText?: string;
  actionIcon?: string;
  backVisible?: boolean;
  onBack?: () => void;
  onAction?: () => void;
  className?: string;
  style?: CSSProperties;
}

const actionStyle: CSSProperties = {
  display: "inline-flex",
  flex: "none",
  alignItems: "center",
  minWidth: 0,
  minHeight: "var(--touch)",
};

const actionTagStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  height: "var(--compact-control)",
  padding: "0 var(--gap) 0 var(--gap-small)",
  gap: 2,
  border: "1.5px dashed var(--outline)",
  borderRadius: "var(--radius-row)",
  color: "var(--muted)",
  background: "rgb(255 251 240 / 0.7)",
  fontSize: "var(--text-control)",
  fontWeight: "var(--weight-bold)",
};

export function PageHeader({
  heading,
  subtitle = "",
  actionText = "",
  actionIcon,
  backVisible = false,
  onBack,
  onAction,
  className,
  style,
}: PageHeaderProps) {
  return (
    <header
      className={["top-bar", className].filter(Boolean).join(" ")}
      style={{
        minHeight: "var(--top-height)",
        gap: "var(--gap-small)",
        ...style,
      }}
    >
      {backVisible && (
        <button
          type="button"
          aria-label="返回"
          onClick={onBack}
          style={{
            flex: "none",
            width: "var(--touch)",
            height: "var(--touch)",
            padding: "calc(var(--touch) / 2)",
          }}
        >
          <Icon
            name="chevron-right"
            size={22}
            style={{ transform: "rotate(180deg)" }}
          />
        </button>
      )}

      <div
        style={{
          display: "flex",
          flex: 1,
          alignItems: "baseline",
          minWidth: 0,
          gap: "var(--gap)",
        }}
      >
        <h1
          style={{
            flex: "0 1 auto",
            minWidth: 0,
            margin: "0 calc(-1 * var(--gap-tiny))",
            paddingInline: "var(--gap-tiny)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {heading}
        </h1>
        {subtitle && (
          <span
            style={{
              flex: "1 1 auto",
              minWidth: 0,
              overflow: "hidden",
              color: "var(--muted)",
              fontSize: "var(--text-subtitle)",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {subtitle}
          </span>
        )}
      </div>

      {actionText && (
        <button type="button" onClick={onAction} style={actionStyle}>
          <span style={actionTagStyle}>
            {actionIcon && <Icon name={actionIcon} size={18} />}
            {actionText}
          </span>
        </button>
      )}
    </header>
  );
}
