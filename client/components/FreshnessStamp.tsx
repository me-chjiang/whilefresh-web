import type { CSSProperties } from "react";

import type { ItemFreshness } from "../../shared/api";

export interface FreshnessStampProps {
  status?: ItemFreshness;
  className?: string;
  style?: CSSProperties;
}

const labels: Record<ItemFreshness, string> = {
  fresh: "新鲜",
  nearing: "临期",
  overdue: "超出估计期限",
  unknown: "未知",
};

export function FreshnessStamp({
  status = "fresh",
  className,
  style,
}: FreshnessStampProps) {
  return (
    <span
      className={["freshness-stamp", className].filter(Boolean).join(" ")}
      data-status={status}
      style={style}
    >
      {labels[status]}
    </span>
  );
}
