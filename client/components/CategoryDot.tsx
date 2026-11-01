import type { CSSProperties } from "react";

import type { CategoryCode } from "../../shared/enums";

export interface CategoryDotProps {
  category?: CategoryCode;
  size?: number;
  className?: string;
  style?: CSSProperties;
}

export function CategoryDot({
  category = "other",
  size,
  className,
  style,
}: CategoryDotProps) {
  return (
    <span
      aria-hidden="true"
      className={[
        "category-dot",
        `category-${category}`,
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      style={{
        ...(size ? { width: size, height: size } : {}),
        ...style,
      }}
    />
  );
}
