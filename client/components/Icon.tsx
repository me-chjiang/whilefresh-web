import type { CSSProperties } from "react";

export interface IconProps {
  name: string;
  size?: number;
  color?: string;
  className?: string;
  style?: CSSProperties;
  label?: string;
}

export function Icon({
  name,
  size = 24,
  color = "currentColor",
  className,
  style,
  label,
}: IconProps) {
  const url = `url("/assets/icons/${name}.svg")`;

  return (
    <span
      className={className}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={{
        display: "block",
        flex: "none",
        width: size,
        height: size,
        backgroundColor: color,
        maskImage: url,
        maskPosition: "center",
        maskRepeat: "no-repeat",
        maskSize: "contain",
        WebkitMaskImage: url,
        WebkitMaskPosition: "center",
        WebkitMaskRepeat: "no-repeat",
        WebkitMaskSize: "contain",
        ...style,
      }}
    />
  );
}
