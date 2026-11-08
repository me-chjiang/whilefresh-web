import {
  forwardRef,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";

import { Icon } from "./Icon";

export interface InkButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "color"> {
  text?: ReactNode;
  iconName?: string;
  iconSize?: number;
  accent?: string;
  outline?: boolean;
  titleStyle?: boolean;
  fullWidth?: boolean;
}

export const InkButton = forwardRef<HTMLButtonElement, InkButtonProps>(
  function InkButton(
    {
      text,
      iconName = "",
      iconSize = 24,
      accent = "var(--green)",
      outline = false,
      titleStyle = false,
      fullWidth = false,
      children,
      type = "button",
      disabled,
      style,
      ...props
    },
    ref,
  ) {
    const solidAccent = disabled
      ? `color-mix(in srgb, ${accent} 50%, var(--card))`
      : accent;
    return (
      <button
        {...props}
        ref={ref}
        type={type}
        disabled={disabled}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: fullWidth ? "100%" : undefined,
          minHeight: "var(--touch)",
          padding: "var(--gap-small) var(--gap-large)",
          gap: iconName ? "var(--gap-small)" : 0,
          border: outline
            ? "1.5px solid var(--outline)"
            : `1.5px solid ${solidAccent}`,
          borderRadius: "var(--radius-row)",
          color: !outline
            ? "var(--text-on-green)"
            : disabled
              ? "var(--muted)"
              : "var(--ink)",
          background: outline ? "var(--card)" : solidAccent,
          fontFamily: titleStyle ? "var(--font-serif)" : "var(--font-sans)",
          fontSize: titleStyle
            ? "var(--text-recipe)"
            : "var(--text-control)",
          fontWeight: titleStyle
            ? "var(--weight-black)"
            : "var(--weight-bold)",
          lineHeight: 1.25,
          cursor: disabled ? "default" : undefined,
          ...style,
        }}
      >
        {iconName && (
          <Icon
            name={iconName}
            size={iconSize}
            color={outline ? "var(--ink)" : "var(--text-on-green)"}
          />
        )}
        {children ?? text}
      </button>
    );
  },
);
