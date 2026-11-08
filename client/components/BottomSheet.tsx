import {
  useEffect,
  useId,
  useRef,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { Icon } from "./Icon";
import { SectionTape } from "./SectionTape";

export interface BottomSheetProps {
  open: boolean;
  heading: string;
  tapeText?: string;
  subtitle?: ReactNode;
  footer?: ReactNode;
  sheetHeight?: number;
  onClose: () => void;
  onMaskClick?: () => void;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}

export function BottomSheet({
  open,
  heading,
  tapeText = "",
  subtitle,
  footer,
  sheetHeight = 600,
  onClose,
  onMaskClick,
  children,
  className,
  style,
}: BottomSheetProps) {
  const panelRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  const titleId = useId();
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) {
      return;
    }

    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    panelRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previousFocus?.focus();
    };
  }, [open]);

  if (!open) {
    return null;
  }

  const height = `min(${sheetHeight}px, calc(100dvh - 48px))`;

  return createPortal(
    <>
      <div className="modal-mask" aria-hidden="true" onClick={onMaskClick ?? onClose} />
      <section
        ref={panelRef}
        className={["sheet", className].filter(Boolean).join(" ")}
        role="dialog"
        aria-modal="true"
        aria-labelledby={heading ? titleId : undefined}
        tabIndex={-1}
        style={{
          position: "fixed",
          zIndex: 41,
          right: 0,
          bottom: 0,
          left: 0,
          width: "min(100%, var(--app-max-width))",
          maxHeight: height,
          marginInline: "auto",
          ...style,
        }}
      >
        {tapeText && (
          <div className="sheet__tape">
            <SectionTape label={tapeText} />
          </div>
        )}
        <header className="sheet__header">
          <h1 id={titleId}>{heading}</h1>
          {subtitle && <p className="sheet__subtitle">{subtitle}</p>}
          <button
            type="button"
            className="sheet__close"
            aria-label="关闭"
            onClick={onClose}
          >
            <Icon name="x" size={22} />
          </button>
        </header>
        <div className="sheet__body">{children}</div>
        {footer && <div className="sheet__foot">{footer}</div>}
      </section>
    </>,
    document.body,
  );
}
