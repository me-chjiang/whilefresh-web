import { CategoryDot } from "../components/CategoryDot";
import { CheckBox } from "../components/CheckBox";
import { EmptyState } from "../components/EmptyState";
import { InkButton } from "../components/InkButton";
import { PageHeader } from "../components/PageHeader";
import { SectionTape } from "../components/SectionTape";
import { useAppShell } from "../App";

export function ClearFridgePage() {
  const {
    state,
    clearSelectedIds,
    toggleClearItem,
    openRecipeSearch,
  } = useAppShell();

  const searchKitchen = () => {
    const keyword = state.items
      .filter((item) => clearSelectedIds.includes(item.id))
      .map((item) => item.name)
      .join(" ");
    openRecipeSearch(keyword);
  };

  return (
    <section className="page-shell">
      <PageHeader
        heading="清冰箱"
        subtitle="用掉临期和先用的食材"
      />

      <div
        className="note-paper"
        style={{ marginTop: "var(--gap-large)" }}
      >
        <SectionTape
          label="选料"
          tapeColor="blue"
          angle={0}
          style={{
            position: "absolute",
            top: -12,
            left: "50%",
            transform: "translateX(-50%) rotate(1.5deg)",
            minHeight: 22,
            height: 22,
            paddingInline: 22,
          }}
        />

        <div className="panel-head">
          <h2>要用掉的食材</h2>
          <span>
            已选 {clearSelectedIds.length} / {state.items.length}
          </span>
        </div>

        <div className="pick-chips">
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
                className={`pick-chip${selected ? " pick-chip--on" : ""}`}
                aria-pressed={selected}
                aria-label={`${item.name}${tag ? `，${tag}` : ""}`}
                onClick={() => toggleClearItem(item.id)}
              >
                <CheckBox checked={selected} />
                <CategoryDot category={item.category} size={15} />
                <span>{item.name}</span>
                {tag && (
                  <small
                    className={
                      item.first
                        ? "pick-chip__tag"
                        : "pick-chip__tag pick-chip__tag--near"
                    }
                  >
                    {tag}
                  </small>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <InkButton
        fullWidth
        iconName="search"
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
