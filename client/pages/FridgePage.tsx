import { useState, type CSSProperties } from "react";

import type { ItemDto } from "../../shared/api";
import { api, ApiError } from "../api";
import { EmptyState } from "../components/EmptyState";
import { InkButton } from "../components/InkButton";
import { PageHeader } from "../components/PageHeader";
import { PantryRow } from "../components/PantryRow";
import { SectionTape } from "../components/SectionTape";
import { useAppShell } from "../App";
import { ItemEditPage } from "./ItemEditPage";

const sections = [
  {
    location: "冷藏",
    iconName: "fridge",
    tapeColor: "sage",
  },
  {
    location: "冷冻",
    iconName: "snowflake",
    tapeColor: "blue",
  },
  {
    location: "常温",
    iconName: "sun",
    tapeColor: "sand",
  },
] as const;

const cardStyle: CSSProperties = {
  position: "relative",
  marginTop: "var(--gap-large)",
  borderRadius: "var(--radius-card)",
  background: "var(--card)",
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

export function FridgePage() {
  const {
    state,
    openImport,
    pushPage,
    notify,
    refresh,
  } = useAppShell();
  const [multiSelect, setMultiSelect] = useState(false);
  const [checkedIds, setCheckedIds] = useState<number[]>([]);
  const [removing, setRemoving] = useState(false);

  const toggleSelection = (item: ItemDto) => {
    setMultiSelect(true);
    setCheckedIds((current) =>
      current.includes(item.id)
        ? current.filter((id) => id !== item.id)
        : [...current, item.id],
    );
  };

  const finishSelection = () => {
    setMultiSelect(false);
    setCheckedIds([]);
  };

  const editItem = (item: ItemDto) => {
    pushPage({
      key: `edit-item-${item.id}`,
      title: "编辑食材",
      element: <ItemEditPage item={item} />,
    });
  };

  const runItemAction = async (
    action: () => Promise<unknown>,
    successMessage?: string,
  ) => {
    try {
      await action();
      await refresh();
      if (successMessage) {
        notify(successMessage);
      }
    } catch (error) {
      notify(messageFor(error));
    }
  };

  const removeSelected = async () => {
    if (checkedIds.length === 0 || removing) {
      return;
    }
    setRemoving(true);
    try {
      await api.removeItems({ ids: checkedIds });
      finishSelection();
      await refresh();
    } catch (error) {
      notify(`移除失败：${messageFor(error)}`);
    } finally {
      setRemoving(false);
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
        heading={`冰箱 · 共 ${state.items.length} 件`}
        actionText="＋ 入库"
        onAction={openImport}
        style={{ marginInline: "calc(-1 * var(--section-padding))" }}
      />

      {state.items.length === 0 ? (
        <EmptyState
          iconName="fridge"
          heading="冰箱里还没有食材"
          detail="从截图入库，或手动记下一件食材"
          actionText="＋ 入库 / 手动添加"
          onAction={openImport}
          style={{ paddingBlock: "calc(var(--gap-large) * 2)" }}
        />
      ) : (
        <div style={{ paddingBottom: "var(--gap-small)" }}>
          {sections.map((section) => {
            const items = state.items.filter(
              (item) => item.location === section.location,
            );
            if (items.length === 0) {
              return null;
            }

            return (
              <div key={section.location} style={cardStyle}>
                <div
                  style={{
                    position: "absolute",
                    zIndex: 2,
                    top: "calc(-1 * var(--tape-height) / 2)",
                    left: "var(--gap-large)",
                  }}
                >
                  <SectionTape
                    label={section.location}
                    iconName={section.iconName}
                    count={items.length}
                    tapeColor={section.tapeColor}
                  />
                </div>
                <div
                  style={{
                    display: "grid",
                    gap: 2,
                    padding:
                      "calc(var(--tape-height) / 2 + var(--gap-large)) var(--gap) var(--gap)",
                  }}
                >
                  {items.map((item) => (
                    <PantryRow
                      key={item.id}
                      ingredient={item}
                      multiSelect={multiSelect}
                      checked={checkedIds.includes(item.id)}
                      onEditRequested={editItem}
                      onSelectionRequested={toggleSelection}
                      onUsed={(ingredient) =>
                        void runItemAction(
                          () => api.useItem({ id: ingredient.id }),
                          ingredient.bulk
                            ? `${ingredient.name}默认存量多，已保留；需要时请标记家里没有`
                            : undefined,
                        )
                      }
                      onUnavailable={(ingredient) =>
                        void runItemAction(() =>
                          api.markItemAbsent({ id: ingredient.id }),
                        )
                      }
                      onFirstRequested={(ingredient) =>
                        void runItemAction(() =>
                          api.setItemUseFirst({
                            id: ingredient.id,
                            enabled: !ingredient.first,
                          }),
                        )
                      }
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {multiSelect && (
        <div
          style={{
            display: "grid",
            gap: "var(--gap-small)",
            marginTop: "var(--gap-large)",
          }}
        >
          <InkButton
            fullWidth
            text={`移除选中 ${checkedIds.length} 件`}
            accent="var(--tomato)"
            disabled={checkedIds.length === 0 || removing}
            onClick={() => void removeSelected()}
          />
          <InkButton
            fullWidth
            text="完成多选"
            outline
            onClick={finishSelection}
          />
        </div>
      )}
    </section>
  );
}
