import { useEffect } from "react";

interface ToastProps {
  noticeId: number;
  message: string;
  onDismiss: (noticeId: number) => void;
}

export function Toast({ noticeId, message, onDismiss }: ToastProps) {
  useEffect(() => {
    const timer = window.setTimeout(() => onDismiss(noticeId), 2_600);
    return () => window.clearTimeout(timer);
  }, [noticeId, onDismiss]);

  if (!message) {
    return null;
  }

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "fixed",
        zIndex: 100,
        bottom: "calc(var(--nav-height) + var(--gap) + env(safe-area-inset-bottom))",
        left: "50%",
        width: "max-content",
        maxWidth: "calc(min(100vw, var(--app-max-width)) - var(--gap-large) * 2)",
        minHeight: "var(--touch)",
        padding: "var(--gap) var(--gap-large)",
        borderRadius: "var(--radius-row)",
        color: "var(--text-on-tomato)",
        background: "var(--ink)",
        boxShadow: "var(--shadow-two)",
        fontSize: "var(--text-subtitle)",
        textAlign: "center",
        transform: "translateX(-50%)",
      }}
    >
      {message}
    </div>
  );
}
