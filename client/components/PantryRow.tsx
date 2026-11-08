import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import type { ItemDto } from "../../shared/api";
import { CategoryDot } from "./CategoryDot";
import { CheckBox } from "./CheckBox";
import { FreshnessStamp } from "./FreshnessStamp";
import { Icon } from "./Icon";

const ACTION_BUTTON_WIDTH = 75;
const MAX_ACTIONS_WIDTH = 3 * ACTION_BUTTON_WIDTH;
const FIRST_SWIPE_THRESHOLD = 55;
const RIGHT_DRAG_LIMIT = 90;
const DRAG_SLOP = 6;
const LONG_PRESS_MS = 550;

export interface PantryRowProps {
  ingredient: ItemDto;
  multiSelect?: boolean;
  checked?: boolean;
  onEditRequested?: (ingredient: ItemDto) => void;
  onSelectionRequested?: (ingredient: ItemDto) => void;
  onUsed?: (ingredient: ItemDto) => void;
  onUnavailable?: (ingredient: ItemDto) => void;
  onDiscarded?: (ingredient: ItemDto) => void;
  onSnoozed?: (ingredient: ItemDto) => void;
  onFirstRequested?: (ingredient: ItemDto) => void;
  forceClosed?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  style?: CSSProperties;
}

interface Gesture {
  pointerId: number;
  startX: number;
  startY: number;
  startOffset: number;
  axis: "pending" | "horizontal" | "vertical";
  dragged: boolean;
}

function clampOffset(value: number, actionWidth: number): number {
  return Math.min(RIGHT_DRAG_LIMIT, Math.max(-actionWidth, value));
}

export function PantryRow({
  ingredient,
  multiSelect = false,
  checked = false,
  onEditRequested,
  onSelectionRequested,
  onUsed,
  onUnavailable,
  onDiscarded,
  onSnoozed,
  onFirstRequested,
  forceClosed = false,
  onOpenChange,
  className,
  style,
}: PantryRowProps) {
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const offsetRef = useRef(0);
  const gestureRef = useRef<Gesture | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const longPressedRef = useRef(false);
  const suppressClickRef = useRef(false);
  const contentRef = useRef<HTMLButtonElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const focusActionRef = useRef(false);
  const canSnooze = ingredient.freshness === "nearing" && !ingredient.snoozed;
  const actionCount = canSnooze ? 4 : 3;
  const actionButtonWidth = Math.min(
    ACTION_BUTTON_WIDTH,
    MAX_ACTIONS_WIDTH / actionCount,
  );
  const actionWidth = actionCount * actionButtonWidth;

  const updateOffset = (nextOffset: number) => {
    offsetRef.current = nextOffset;
    setOffset(nextOffset);
  };

  const clearLongPressTimer = () => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  useEffect(() => {
    if (multiSelect) {
      clearLongPressTimer();
      gestureRef.current = null;
      setDragging(false);
      updateOffset(0);
    }
  }, [multiSelect]);

  useEffect(
    () => () => {
      clearLongPressTimer();
    },
    [],
  );

  const finishGesture = (
    event: ReactPointerEvent<HTMLButtonElement>,
    cancelled = false,
  ) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) {
      return;
    }

    clearLongPressTimer();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    gestureRef.current = null;
    setDragging(false);

    if (longPressedRef.current) {
      longPressedRef.current = false;
      return;
    }

    if (!gesture.dragged) {
      return;
    }

    suppressClickRef.current = true;
    if (!cancelled && offsetRef.current > FIRST_SWIPE_THRESHOLD) {
      updateOffset(0);
      onFirstRequested?.(ingredient);
      return;
    }

    updateOffset(
      offsetRef.current < -FIRST_SWIPE_THRESHOLD ? -actionWidth : 0,
    );
  };

  const handlePointerDown = (
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    if (
      multiSelect ||
      !event.isPrimary ||
      (event.pointerType === "mouse" && event.button !== 0)
    ) {
      return;
    }

    clearLongPressTimer();
    longPressedRef.current = false;
    suppressClickRef.current = false;
    gestureRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startOffset: offsetRef.current,
      axis: "pending",
      dragged: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);

    if (offsetRef.current === 0) {
      longPressTimerRef.current = window.setTimeout(() => {
        longPressTimerRef.current = null;
        longPressedRef.current = true;
        suppressClickRef.current = true;
        onSelectionRequested?.(ingredient);
      }, LONG_PRESS_MS);
    }
  };

  const handlePointerMove = (
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) {
      return;
    }

    const deltaX = event.clientX - gesture.startX;
    const deltaY = event.clientY - gesture.startY;

    if (gesture.axis === "pending") {
      if (Math.max(Math.abs(deltaX), Math.abs(deltaY)) < DRAG_SLOP) {
        return;
      }
      clearLongPressTimer();
      gesture.axis =
        Math.abs(deltaX) > Math.abs(deltaY) ? "horizontal" : "vertical";

      if (gesture.axis === "vertical") {
        gestureRef.current = null;
        setDragging(false);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        return;
      }
    }

    if (gesture.axis !== "horizontal") {
      return;
    }

    event.preventDefault();
    gesture.dragged = true;
    setDragging(true);
    updateOffset(clampOffset(gesture.startOffset + deltaX, actionWidth));
  };

  const handlePointerUp = (
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    finishGesture(event);
  };

  const handlePointerCancel = (
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    finishGesture(event, true);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (multiSelect) {
      return;
    }
    if (event.key === "ArrowLeft" && offsetRef.current === 0) {
      event.preventDefault();
      focusActionRef.current = true;
      updateOffset(-actionWidth);
    } else if (
      (event.key === "ArrowRight" || event.key === "Escape") &&
      offsetRef.current < 0
    ) {
      event.preventDefault();
      updateOffset(0);
    }
  };

  const handleActionKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" || event.key === "ArrowRight") {
      event.preventDefault();
      event.stopPropagation();
      updateOffset(0);
      contentRef.current?.focus();
    }
  };

  const handleClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    if (offsetRef.current < 0) {
      updateOffset(0);
      return;
    }
    if (event.shiftKey && !multiSelect) {
      onSelectionRequested?.(ingredient);
      return;
    }
    if (multiSelect) {
      onSelectionRequested?.(ingredient);
      return;
    }
    onEditRequested?.(ingredient);
  };

  const runAction = (action: (ingredient: ItemDto) => void | undefined) => {
    updateOffset(0);
    action(ingredient);
  };

  const actionsVisible = offset < 0 && !multiSelect;

  useEffect(() => {
    onOpenChange?.(actionsVisible);
    if (actionsVisible && focusActionRef.current) {
      focusActionRef.current = false;
      actionsRef.current
        ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
        ?.focus();
    }
  }, [actionsVisible]);

  useEffect(() => {
    if (forceClosed && offsetRef.current < 0) {
      updateOffset(0);
    }
  }, [forceClosed]);

  return (
    <div
      className={["pantry-row", actionsVisible && "pantry-row--open", className]
        .filter(Boolean)
        .join(" ")}
      style={style}
    >
      <div
        ref={actionsRef}
        aria-hidden={!actionsVisible}
        onKeyDown={handleActionKeyDown}
        style={{
          position: "absolute",
          top: 0,
          right: 0,
          bottom: 0,
          display: "flex",
          width: actionWidth,
          visibility: actionsVisible ? "visible" : "hidden",
        }}
      >
        <button
          type="button"
          disabled={!actionsVisible}
          aria-label={`用掉${ingredient.name}`}
          onClick={() => runAction((item) => onUsed?.(item))}
          style={{
            display: "flex",
            width: actionButtonWidth,
            height: "100%",
            minWidth: 0,
            minHeight: 0,
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 1,
            color: "var(--text-on-green)",
            background: "var(--green)",
            fontSize: "var(--text-subtitle)",
            fontWeight: "var(--weight-bold)",
          }}
        >
          <Icon name="check" size={20} color="currentColor" />
          <span>用掉</span>
        </button>
        <button
          type="button"
          disabled={!actionsVisible}
          aria-label={`扔掉${ingredient.name}`}
          onClick={() => runAction((item) => onDiscarded?.(item))}
          style={{
            display: "flex",
            width: actionButtonWidth,
            height: "100%",
            minWidth: 0,
            minHeight: 0,
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 1,
            color: "var(--text-on-tomato)",
            background: "var(--tomato)",
            fontSize: "var(--text-subtitle)",
            fontWeight: "var(--weight-bold)",
          }}
        >
          <Icon name="x" size={20} color="currentColor" />
          <span>扔掉</span>
        </button>
        <button
          type="button"
          disabled={!actionsVisible}
          aria-label={`${ingredient.name}家里没有`}
          onClick={() => runAction((item) => onUnavailable?.(item))}
          style={{
            display: "flex",
            width: actionButtonWidth,
            height: "100%",
            minWidth: 0,
            minHeight: 0,
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 1,
            color: "var(--text-on-green)",
            background: "var(--none)",
            fontSize: "var(--text-subtitle)",
            fontWeight: "var(--weight-bold)",
          }}
        >
          <Icon name="ban" size={20} color="currentColor" />
          <span>家里没有</span>
        </button>
        {canSnooze && (
          <button
            type="button"
            disabled={!actionsVisible}
            aria-label={`忽略${ingredient.name}`}
            onClick={() => runAction((item) => onSnoozed?.(item))}
            style={{
              display: "flex",
              width: actionButtonWidth,
              height: "100%",
              minWidth: 0,
              minHeight: 0,
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 1,
              color: "var(--ink)",
              background: "var(--mustard)",
              fontSize: "var(--text-subtitle)",
              fontWeight: "var(--weight-bold)",
            }}
          >
            <Icon name="flag-2" size={20} color="currentColor" />
            <span>忽略</span>
          </button>
        )}
      </div>

      <button
        ref={contentRef}
        type="button"
        onKeyDown={handleKeyDown}
        aria-pressed={multiSelect ? checked : undefined}
        aria-label={
          ingredient.days
            ? `${ingredient.name}，${ingredient.days}`
            : ingredient.name
        }
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onContextMenu={(event) => event.preventDefault()}
        onClick={handleClick}
        style={{
          position: "relative",
          zIndex: 1,
          display: "flex",
          width: actionsVisible ? `calc(100% + ${offset}px)` : "100%",
          height: "100%",
          minHeight: 0,
          alignItems: "center",
          gap: "var(--row-gap)",
          paddingInline: "var(--gap-tiny)",
          overflow: "hidden",
          border: checked ? "1px solid var(--tomato)" : "1px solid transparent",
          borderRadius: actionsVisible ? 0 : "var(--radius-row)",
          color: "var(--ink)",
          background: "var(--card)",
          textAlign: "left",
          touchAction: "pan-y",
          transform: offset > 0 ? `translateX(${offset}px)` : undefined,
          transition: dragging ? "none" : "transform 160ms ease, width 160ms ease",
          userSelect: "none",
          WebkitUserSelect: "none",
        }}
      >
        {multiSelect && <CheckBox checked={checked} />}

        <CategoryDot category={ingredient.category} />

        <span
          style={{
            display: "flex",
            minWidth: 0,
            flex: 1,
            flexDirection: "column",
          }}
        >
          <span
            style={{
              display: "flex",
              minWidth: 0,
              alignItems: "center",
              gap: "var(--gap-small)",
            }}
          >
            <span
              style={{
                minWidth: 0,
                flex: "0 1 auto",
                overflow: "hidden",
                fontSize: "var(--text-body)",
                fontWeight: "var(--weight-bold)",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {ingredient.name}
            </span>
            {ingredient.first && (
              <span className="badge">先用</span>
            )}
          </span>
          {!actionsVisible && (
            <span
              style={{
                display: "block",
                marginTop: 1,
                overflow: "hidden",
                color: "var(--muted)",
                fontSize: "var(--text-meta)",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {ingredient.days}
            </span>
          )}
        </span>

        <span
          style={{
            flex: "none",
            fontSize: "var(--text-quantity)",
            fontWeight: "var(--weight-bold)",
          }}
        >
          {ingredient.quantity}
        </span>
        {!actionsVisible && <FreshnessStamp status={ingredient.freshness} />}
      </button>
    </div>
  );
}
