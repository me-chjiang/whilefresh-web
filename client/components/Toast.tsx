import { useEffect } from "react";

import type { NoticeAction } from "../App";

interface ToastProps {
  noticeId: number;
  message: string;
  action?: NoticeAction;
  onDismiss: (noticeId: number) => void;
}

export function Toast({ noticeId, message, action, onDismiss }: ToastProps) {
  useEffect(() => {
    const timer = window.setTimeout(
      () => onDismiss(noticeId),
      action ? 6_000 : 2_600,
    );
    return () => window.clearTimeout(timer);
  }, [noticeId, action, onDismiss]);

  if (!message) {
    return null;
  }

  return (
    <div role="status" aria-live="polite" className="toast">
      <span className="toast__message">{message}</span>
      {action && (
        <button
          type="button"
          className="toast__action"
          onClick={() => {
            onDismiss(noticeId);
            action.run();
          }}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
