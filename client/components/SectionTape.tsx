import type { CSSProperties } from "react";

import { Icon } from "./Icon";

export interface SectionTapeProps {
  label: string;
  iconName?: string;
  count?: string | number;
  tapeColor?: "sage" | "blue" | "sand" | string;
  angle?: number;
  className?: string;
  style?: CSSProperties;
}

function tapeColorValue(color: string): string {
  if (color === "sage" || color === "blue" || color === "sand") {
    return `var(--tape-${color})`;
  }
  return color;
}

export function SectionTape({
  label,
  iconName = "",
  count = "",
  tapeColor = "sage",
  angle = -1.5,
  className,
  style,
}: SectionTapeProps) {
  const visibleCount = count === "" || count === undefined ? "" : String(count);

  return (
    <span
      className={["tape", className].filter(Boolean).join(" ")}
      style={
        {
          "--tape-color": tapeColorValue(tapeColor),
          transform: `rotate(${angle}deg)`,
          ...style,
        } as CSSProperties
      }
    >
      {iconName && <Icon name={iconName} size={18} />}
      <span>{label}</span>
      {visibleCount && <span className="tape__count">{visibleCount}</span>}
    </span>
  );
}
