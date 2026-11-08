import { useEffect, useRef, useState, type CSSProperties } from "react";

import type { CategoryCode } from "../../shared/enums";
import { api, ApiError } from "../api";
import { BottomSheet } from "../components/BottomSheet";
import { CategoryDot } from "../components/CategoryDot";
import { EmptyState } from "../components/EmptyState";
import { Icon } from "../components/Icon";
import { InkButton } from "../components/InkButton";
import { PageHeader } from "../components/PageHeader";
import { SectionTape } from "../components/SectionTape";
import { useAppShell } from "../App";

const categories: readonly {
  code: CategoryCode;
  label: string;
}[] = [
  { code: "vegetable", label: "蔬菜" },
  { code: "fruit", label: "水果" },
  { code: "meat", label: "肉类" },
  { code: "seafood", label: "水产" },
  { code: "egg_dairy", label: "蛋奶" },
  { code: "soy", label: "豆制品" },
  { code: "staple", label: "主食" },
  { code: "seasoning", label: "调料" },
  { code: "processed", label: "加工食品" },
  { code: "other", label: "其他" },
];

const cardStyle: CSSProperties = {
  position: "relative",
  marginTop: "var(--gap-large)",
  borderRadius: "var(--radius-card)",
  background: "var(--note)",
  boxShadow: "var(--shadow-one)",
};

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message;
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "请稍后重试";
}

function legacyCopy(text: string): boolean {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("aria-hidden", "true");
  area.style.cssText =
    "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;font-size:16px";
  document.body.appendChild(area);
  try {
    area.focus();
    area.select();
    area.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

async function copyText(text: string): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission denied or unfocused page: try the legacy path next.
    }
  }
  return legacyCopy(text);
}

export function ShoppingPage() {
  const { state, refresh, notify } = useAppShell();
  const [removingId, setRemovingId] = useState<number | null>(null);
  const [sharing, setSharing] = useState<"copy" | "share" | null>(null);
  const [listText, setListText] = useState<string | null>(null);
  const [manualText, setManualText] = useState<string | null>(null);
  const manualRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let current = true;
    api
      .shoppingText()
      .then(({ text }) => current && setListText(text))
      .catch(() => current && setListText(null));
    return () => {
      current = false;
    };
  }, [state.shopping]);

  useEffect(() => {
    if (manualText !== null) {
      manualRef.current?.focus();
      manualRef.current?.select();
    }
  }, [manualText]);

  const removeItem = async (id: number) => {
    if (removingId !== null) {
      return;
    }
    setRemovingId(id);
    try {
      await api.removeShoppingItem({ id });
      await refresh();
    } catch (error) {
      notify(`移除失败：${messageFor(error)}`);
    } finally {
      setRemovingId(null);
    }
  };

  const loadText = async (): Promise<string> =>
    listText ?? (await api.shoppingText()).text;

  const copyOrShow = async (message: string) => {
    const text = await loadText();
    if (await copyText(text)) {
      notify(message);
    } else {
      setManualText(text);
    }
  };

  const copy = async () => {
    if (sharing) {
      return;
    }
    setSharing("copy");
    try {
      await copyOrShow("已复制待买清单");
    } catch (error) {
      notify(
        error instanceof ApiError ? error.message : "复制失败，请手动复制",
      );
    } finally {
      setSharing(null);
    }
  };

  const share = async () => {
    if (sharing) {
      return;
    }
    setSharing("share");
    try {
      const text = await loadText();
      const fallback = "当前浏览器不支持系统分享，已复制待买清单";
      if (typeof navigator.share !== "function") {
        await copyOrShow(fallback);
        return;
      }
      try {
        await navigator.share({ title: "待买清单", text });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        await copyOrShow(fallback);
      }
    } catch (error) {
      notify(
        error instanceof ApiError ? error.message : "分享失败，请稍后重试",
      );
    } finally {
      setSharing(null);
    }
  };

  const sections = categories
    .map((category) => ({
      ...category,
      entries: state.shopping.filter(
        (entry) => entry.category === category.code,
      ),
    }))
    .filter((section) => section.entries.length > 0);

  return (
    <section className="page-shell">
      <PageHeader
        heading="待买"
        subtitle="做菜缺的料"
      />

      {state.shopping.length === 0 ? (
        <EmptyState
          iconName="list-check"
          heading="暂时没有待买的食材"
          detail=""
          style={{ paddingBlock: "calc(var(--gap-large) * 3)" }}
        />
      ) : (
        <>
          <div style={{ paddingBottom: "var(--gap-small)" }}>
            {sections.map((section) => (
              <div key={section.code} style={cardStyle}>
                <div
                  style={{
                    position: "absolute",
                    zIndex: 2,
                    top: "calc(-1 * var(--tape-height) / 2)",
                    left: "var(--gap)",
                  }}
                >
                  <SectionTape
                    label={section.label}
                    count={section.entries.length}
                    tapeColor="sand"
                  />
                </div>
                <ul
                  style={{
                    padding:
                      "calc(var(--tape-height) / 2 + var(--gap-large)) var(--gap) var(--gap)",
                  }}
                >
                  {section.entries.map((entry) => (
                    <li
                      key={entry.id}
                      className="item"
                      style={{ gap: "var(--gap-small)" }}
                    >
                      <CategoryDot category={entry.category} />
                      <span
                        style={{
                          flex: 1,
                          minWidth: 0,
                          overflow: "hidden",
                          color: "var(--ink)",
                          fontSize: "var(--text-body)",
                          fontWeight: "var(--weight-bold)",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {entry.name}
                      </span>
                      <button
                        type="button"
                        aria-label={`移除${entry.name}`}
                        disabled={removingId !== null}
                        onClick={() => void removeItem(entry.id)}
                        style={{
                          display: "inline-flex",
                          flex: "none",
                          alignItems: "center",
                          justifyContent: "center",
                          width: "var(--touch)",
                          height: "var(--touch)",
                          opacity:
                            removingId === entry.id ? 0.45 : undefined,
                        }}
                      >
                        <Icon
                          name="x"
                          size={20}
                          color="var(--muted)"
                        />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
              gap: "var(--gap-small)",
              marginTop: "var(--gap)",
            }}
          >
            <InkButton
              fullWidth
              iconName="copy"
              text={sharing === "copy" ? "正在复制…" : "复制清单"}
              disabled={sharing !== null}
              onClick={() => void copy()}
            />
            <InkButton
              fullWidth
              outline
              iconName="share"
              text={sharing === "share" ? "正在分享…" : "分享清单"}
              disabled={sharing !== null}
              onClick={() => void share()}
            />
          </div>
        </>
      )}

      <BottomSheet
        open={manualText !== null}
        heading="复制待买清单"
        tapeText="待买清单"
        subtitle="请长按文字，全选后复制"
        sheetHeight={420}
        onClose={() => setManualText(null)}
        footer={
          <InkButton fullWidth text="关闭" onClick={() => setManualText(null)} />
        }
      >
        <textarea
          ref={manualRef}
          className="field-input"
          readOnly
          rows={8}
          aria-label="待买清单文本"
          value={manualText ?? ""}
          style={{ width: "100%", resize: "none" }}
        />
      </BottomSheet>
    </section>
  );
}
