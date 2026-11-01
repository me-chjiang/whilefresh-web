import {
  useEffect,
  useId,
  useRef,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { SectionTape } from "./SectionTape";

export interface BottomSheetProps {
  open: boolean;
  heading: string;
  tapeText?: string;
  sheetHeight?: number;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}

export function BottomSheet({
  open,
  heading,
  tapeText = "",
  sheetHeight = 600,
  onClose,
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

  return createPortal(
    <>
      <div className="modal-mask" aria-hidden="true" />
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
          maxHeight: `min(${sheetHeight}px, calc(100dvh - var(--gap-large)))`,
          marginInline: "auto",
          boxShadow: "var(--shadow-two)",
          ...style,
        }}
      >
        {tapeText && (
          <div
            style={{
              position: "absolute",
              zIndex: 2,
              top: 0,
              left: "50%",
              transform: "translateX(-50%)",
            }}
          >
            <SectionTape label={tapeText} />
          </div>
        )}
        <header
          className="sheet__header"
          style={{
            paddingTop:
              "calc(var(--gap-large) + var(--gap-small))",
          }}
        >
          <h1 id={titleId}>{heading}</h1>
        </header>
        <div
          className="sheet__body"
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: "auto",
            paddingBottom: "var(--gap-large)",
          }}
        >
          {children}
        </div>
      </section>
    </>,
    document.body,
  );
}
