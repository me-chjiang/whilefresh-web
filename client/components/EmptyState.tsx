import type { CSSProperties } from "react";

import { Icon } from "./Icon";
import { InkButton } from "./InkButton";

export interface EmptyStateProps {
  iconName?: string;
  heading?: string;
  detail?: string;
  actionText?: string;
  onAction?: () => void;
  className?: string;
  style?: CSSProperties;
}

export function EmptyState({
  iconName = "fridge",
  heading = "这里还没有内容",
  detail = "可以继续添加",
  actionText = "",
  onAction,
  className,
  style,
}: EmptyStateProps) {
  return (
    <div
      className={className}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: "var(--gap)",
        paddingBlock: "var(--gap-large)",
        textAlign: "center",
        ...style,
      }}
    >
      <Icon name={iconName} size={36} color="var(--muted)" />
      <h2
        style={{
          margin: 0,
          color: "var(--ink)",
          fontFamily: "var(--font-serif)",
          fontSize: "var(--text-panel)",
          fontWeight: "var(--weight-normal)",
        }}
      >
        {heading}
      </h2>
      <p
        style={{
          maxWidth: "calc(100% - var(--gap-large))",
          margin: 0,
          color: "var(--muted)",
          fontSize: "var(--text-subtitle)",
        }}
      >
        {detail}
      </p>
      {actionText && (
        <InkButton text={actionText} onClick={onAction} />
      )}
    </div>
  );
}
