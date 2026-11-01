import { useEffect, useState, type CSSProperties } from "react";

import type { ClearPreviewDto } from "../../shared/api";
import { api, ApiError } from "../api";
import { CategoryDot } from "../components/CategoryDot";
import { InkButton } from "../components/InkButton";
import { PageHeader } from "../components/PageHeader";
import { SectionTape } from "../components/SectionTape";
import { useAppShell } from "../App";
import { ClearResultsPage } from "./ClearResultsPage";

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message;
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "请稍后重试";
}

const chipStyle = (selected: boolean): CSSProperties => ({
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: "auto",
  minHeight: "var(--touch)",
  padding: "var(--gap-small)",
  gap: "var(--gap-small)",
  border: `1.5px solid ${selected ? "var(--ink)" : "var(--chip-outline)"}`,
  borderRadius: "var(--radius-row)",
  color: selected ? "var(--ink)" : "var(--chip-muted)",
  background: selected ? "var(--selected-paper)" : "transparent",
});

export function ClearFridgePage() {
  const {
    state,
    clearSelectedIds,
    toggleClearItem,
    resetClearSelection,
    pushPage,
    notify,
  } = useAppShell();
  const [preview, setPreview] = useState<ClearPreviewDto | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [searching, setSearching] = useState(false);
  const selectionKey = clearSelectedIds.join(",");

  useEffect(() => {
    let active = true;
    setPreview(null);
    setPreviewError("");
    void api
      .clearPreview({ selected: [...clearSelectedIds] })
      .then((next) => {
        if (active) {
          setPreview(next);
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setPreviewError(messageFor(error));
        }
      });
    return () => {
      active = false;
    };
  }, [selectionKey]);

  const findRecipes = async () => {
    if (clearSelectedIds.length === 0 || searching) {
      return;
    }
    setSearching(true);
    try {
      const result = await api.searchClearRecipes({
        selected: [...clearSelectedIds],
      });
      const selectedIds = [...clearSelectedIds];
      const resultKey = selectedIds.join(",");
      pushPage({
        key: `clear-results-${resultKey}`,
        title: "清冰箱结果",
        element: (
          <ClearResultsPage
            recipes={result.recipes}
            summary={result.summary}
            selectedIds={selectedIds}
          />
        ),
      });
    } catch (error) {
      notify(`查找失败：${messageFor(error)}`);
    } finally {
      setSearching(false);
    }
  };

  return (
    <section
      className="page"
      style={{
        minHeight: "calc(100dvh - var(--nav-height) - var(--gap-large))",
        margin: "var(--gap-small) var(--gap) var(--gap-large)",
        paddingInline: "var(--section-padding)",
      }}
    >
      <PageHeader
        heading="清冰箱"
        subtitle="用掉临期和先用的食材"
        style={{ marginInline: "calc(-1 * var(--section-padding))" }}
      />

      <div
        className="note-paper"
        style={{
          position: "relative",
          marginTop: "var(--gap-large)",
        }}
      >
        <SectionTape
          label="选料"
          tapeColor="blue"
          angle={0}
          style={{
            position: "absolute",
            top: "calc(-1 * var(--tape-height) / 2)",
            left: "50%",
            transform: "translateX(-50%) rotate(1.5deg)",
          }}
        />

        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            gap: "var(--gap)",
            marginTop: "var(--gap-small)",
          }}
        >
          <h2
            style={{
              margin: 0,
              fontSize: "var(--text-panel)",
              fontWeight: "var(--weight-black)",
            }}
          >
            要用掉的食材
          </h2>
          <span
            style={{
              flex: "none",
              color: "var(--note-muted)",
              fontSize: "var(--text-subtitle)",
            }}
          >
            已选 {clearSelectedIds.length} / {state.items.length}
          </span>
        </div>

        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "var(--gap-small)",
            marginTop: "var(--gap)",
          }}
        >
          {state.items.map((item) => {
            const selected = clearSelectedIds.includes(item.id);
            const tag = item.first
              ? "先用"
              : item.freshness === "nearing"
                ? "临期"
                : "";

            return (
              <button
                key={item.id}
                type="button"
                aria-pressed={selected}
                aria-label={`${item.name}${tag ? `，${tag}` : ""}`}
                onClick={() => toggleClearItem(item.id)}
                style={chipStyle(selected)}
              >
                <span
                  aria-hidden="true"
                  style={{
                    display: "inline-flex",
                    flex: "none",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 19,
                    height: 19,
                    border: `1.5px solid ${selected ? "var(--tomato)" : "var(--chip-outline)"}`,
                    borderRadius: "var(--radius-tag)",
                    color: "var(--text-on-tomato)",
                    background: selected ? "var(--tomato)" : "transparent",
                    fontSize: "var(--text-small)",
                    fontWeight: "var(--weight-bold)",
                    lineHeight: 1,
                  }}
                >
                  {selected ? "✓" : ""}
                </span>
                <CategoryDot category={item.category} size={16} />
                <span
                  style={{
                    fontSize: "var(--text-quantity)",
                    fontWeight: "var(--weight-bold)",
                    whiteSpace: "nowrap",
                  }}
                >
                  {item.name}
                </span>
                {tag && (
                  <span
                    style={{
                      color: item.first ? "var(--ink)" : "var(--nearing)",
                      fontSize: "var(--text-small)",
                      fontWeight: "var(--weight-strong)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {tag}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gap: "var(--gap-small)",
          marginTop: "var(--gap)",
        }}
      >
        <p
          aria-live="polite"
          style={{
            margin: 0,
            color: "var(--muted)",
            fontSize: "var(--text-subtitle)",
          }}
        >
          {clearSelectedIds.length === 0
            ? "选几样食材试试"
            : preview
              ? `按非调料食材计算，预计 ${preview.candidateCount} 道候选菜，其中 ${preview.completeCount} 道用到全部已选食材`
              : "正在估算候选菜…"}
        </p>
        {previewError && (
          <p
            role="alert"
            style={{
              margin: 0,
              color: "var(--overdue)",
              fontSize: "var(--text-meta)",
            }}
          >
            暂时无法估算候选菜：{previewError}
          </p>
        )}
        {preview &&
          clearSelectedIds.length > 0 &&
          preview.uncovered.length > 0 && (
            <p
              style={{
                margin: 0,
                color: "var(--nearing)",
                fontSize: "var(--text-meta)",
              }}
            >
              暂未覆盖：{preview.uncovered.join("、")}
            </p>
          )}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
          gap: "var(--gap-small)",
          marginTop: "var(--gap)",
        }}
      >
        <InkButton fullWidth outline text="重置推荐选料" onClick={resetClearSelection} />
        <InkButton
          fullWidth
          iconName="chef-hat"
          text={searching ? "正在查找…" : "查找菜谱"}
          disabled={clearSelectedIds.length === 0 || searching}
          onClick={() => void findRecipes()}
        />
      </div>
    </section>
  );
}
