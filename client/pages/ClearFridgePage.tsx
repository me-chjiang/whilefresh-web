import type { CSSProperties } from "react";

import { CategoryDot } from "../components/CategoryDot";
import { EmptyState } from "../components/EmptyState";
import { InkButton } from "../components/InkButton";
import { PageHeader } from "../components/PageHeader";
import { SectionTape } from "../components/SectionTape";
import { useAppShell } from "../App";

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
    switchTab,
  } = useAppShell();

  const searchKitchen = () => {
    const keyword = state.items
      .filter((item) => clearSelectedIds.includes(item.id))
      .map((item) => item.name)
      .join(" ");
    switchTab(1, keyword);
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

      <InkButton
        fullWidth
        iconName="notes"
        text="搜下厨房"
        disabled={clearSelectedIds.length === 0}
        onClick={searchKitchen}
        style={{ marginTop: "var(--gap)" }}
      />
      {clearSelectedIds.length === 0 && (
        <EmptyState
          iconName="chef-hat"
          heading="选几样食材试试"
          detail=""
          style={{ paddingBlock: "var(--gap-large)" }}
        />
      )}
    </section>
  );
}
