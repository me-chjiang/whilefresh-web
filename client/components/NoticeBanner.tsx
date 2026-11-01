import type { CSSProperties, ReactNode } from "react";

import { Icon } from "./Icon";

export interface NoticeBannerProps {
  message?: string;
  warning?: boolean;
  actionText?: string;
  onAction?: () => void;
  className?: string;
  style?: CSSProperties;
}

export function NoticeBanner({
  message = "可能有遗漏，请检查",
  warning = true,
  actionText = "",
  onAction,
  className,
  style,
}: NoticeBannerProps) {
  const content: ReactNode = (
    <>
      <Icon
        name={warning ? "flag-2" : "check"}
        size={20}
        color="var(--ink)"
      />
      <span style={{ flex: 1, minWidth: 0 }}>{message}</span>
      {actionText && (
        <span
          style={{
            flex: "none",
            color: "var(--tomato)",
            fontWeight: "var(--weight-bold)",
          }}
        >
          {actionText}
        </span>
      )}
    </>
  );

  const sharedStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    width: "100%",
    minHeight: "var(--touch)",
    padding: "var(--gap-small) var(--gap-small) var(--gap-small) var(--gap)",
    gap: "var(--gap-small)",
    borderRadius: "var(--radius-row)",
    color: "var(--ink)",
    background: warning ? "var(--note)" : "var(--tape-sage)",
    fontSize: "var(--text-subtitle)",
    lineHeight: 1.35,
    textAlign: "left",
    ...style,
  };

  if (actionText && onAction) {
    return (
      <button
        type="button"
        className={className}
        onClick={onAction}
        style={sharedStyle}
      >
        {content}
      </button>
    );
  }

  return (
    <div
      role={warning ? "alert" : "status"}
      className={className}
      style={sharedStyle}
    >
      {content}
    </div>
  );
}
