import {
  useEffect,
  useId,
  useRef,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";

import { InkButton } from "./InkButton";

export interface ConfirmDialogProps {
  open: boolean;
  message: string;
  confirmText?: string;
  cancelText?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  className?: string;
  style?: CSSProperties;
}

export function ConfirmDialog({
  open,
  message,
  confirmText = "确认",
  cancelText = "取消",
  destructive = false,
  onConfirm,
  onCancel,
  className,
  style,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const onCancelRef = useRef(onCancel);
  const messageId = useId();
  onCancelRef.current = onCancel;

  useEffect(() => {
    if (!open) {
      return;
    }

    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    cancelRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        // Capture + stop so an underlying sheet's Escape handler doesn't also fire.
        event.stopPropagation();
        onCancelRef.current();
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      previousFocus?.focus();
    };
  }, [open]);

  if (!open) {
    return null;
  }

  return createPortal(
    <>
      <div
        className="modal-mask"
        aria-hidden="true"
        style={{ zIndex: 60 }}
      />
      <section
        className={className}
        role="alertdialog"
        aria-modal="true"
        aria-label="确认操作"
        aria-describedby={messageId}
        style={{
          position: "fixed",
          zIndex: 61,
          top: "50%",
          left: "50%",
          width: "min(calc(100% - var(--gap-large) * 2), 400px)",
          padding: "var(--gap-large)",
          borderRadius: "var(--radius-card)",
          background: "var(--card)",
          boxShadow: "var(--shadow-two)",
          transform: "translate(-50%, -50%)",
          ...style,
        }}
      >
        <p
          id={messageId}
          style={{
            margin: 0,
            color: "var(--ink)",
            fontSize: "var(--text-group)",
          }}
        >
          {message}
        </p>
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            marginTop: "var(--gap-large)",
            gap: "var(--gap-small)",
          }}
        >
          <InkButton
            ref={cancelRef}
            text={cancelText}
            outline
            onClick={onCancel}
          />
          <InkButton
            text={confirmText}
            accent={destructive ? "var(--tomato)" : "var(--green)"}
            onClick={onConfirm}
          />
        </div>
      </section>
    </>,
    document.body,
  );
}
