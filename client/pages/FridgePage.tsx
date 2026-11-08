import { useEffect, useState } from "react";

import type { ItemActionResult, ItemDto } from "../../shared/api";
import { api, ApiError } from "../api";
import { ConfirmDialog } from "../components/ConfirmDialog";
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
  {
    location: "常备调料",
    iconName: "star",
    tapeColor: "sand",
  },
  {
    location: "常备食材",
    iconName: "star",
    tapeColor: "sand",
  },
] as const;

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
  const [removeConfirmOpen, setRemoveConfirmOpen] = useState(false);
  const [openRowId, setOpenRowId] = useState<number | null>(null);
  const [importActionBusy, setImportActionBusy] = useState(false);

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

  useEffect(() => {
    if (!multiSelect) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !removeConfirmOpen) {
        finishSelection();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [multiSelect, removeConfirmOpen]);

  const editItem = (item: ItemDto) => {
    pushPage({
      key: `edit-item-${item.id}`,
      title: "编辑食材",
      element: <ItemEditPage item={item} />,
    });
  };

  const undo = async (token: string) => {
    try {
      await api.undoItemAction({ token });
      await refresh();
      notify("已撤销");
    } catch (error) {
      notify(messageFor(error));
    }
  };

  const runItemAction = async (
    action: () => Promise<ItemActionResult>,
    describe: (result: ItemActionResult) => { message: string; undo: boolean },
  ) => {
    try {
      const result = await action();
      await refresh();
      const { message, undo: undoable } = describe(result);
      notify(
        message,
        undoable && result.undoToken
          ? { label: "撤销", run: () => void undo(result.undoToken) }
          : undefined,
      );
    } catch (error) {
      notify(messageFor(error));
    }
  };

  const setFirst = async (ingredient: ItemDto) => {
    try {
      await api.setItemUseFirst({
        id: ingredient.id,
        enabled: !ingredient.first,
      });
      await refresh();
    } catch (error) {
      notify(messageFor(error));
    }
  };

  const removeSelected = async () => {
    setRemoveConfirmOpen(false);
    if (checkedIds.length === 0 || removing) {
      return;
    }
    setRemoving(true);
    try {
      const count = checkedIds.length;
      const result = await api.removeItems({ ids: checkedIds });
      finishSelection();
      await refresh();
      const note =
        result.suggestions.length > 0
          ? `，其中 ${result.suggestions.length} 件已在「我的」生成待买建议`
          : "";
      notify(
        `已移除 ${count} 件${note}`,
        result.undoToken
          ? { label: "撤销", run: () => void undo(result.undoToken) }
          : undefined,
      );
    } catch (error) {
      notify(`移除失败：${messageFor(error)}`);
    } finally {
      setRemoving(false);
    }
  };

  const continueImport = async () => {
    if (importActionBusy) {
      return;
    }
    setImportActionBusy(true);
    try {
      await api.resumeImport();
      openImport();
    } catch (error) {
      notify(messageFor(error));
    } finally {
      setImportActionBusy(false);
    }
  };

  const discardImport = async () => {
    if (importActionBusy) {
      return;
    }
    setImportActionBusy(true);
    try {
      await api.discardUnfinishedImport();
      await refresh();
    } catch (error) {
      notify(messageFor(error));
    } finally {
      setImportActionBusy(false);
    }
  };

  return (
    <section className="page-shell">
      <PageHeader
        heading="冰箱"
        subtitle={`共 ${state.items.length} 件`}
        actionIcon="plus"
        actionText="入库"
        onAction={openImport}
      />

      {state.hasUnfinishedImport && (
        <div
          role="status"
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            marginTop: "var(--gap-small)",
            padding: "var(--gap-small) var(--gap)",
            gap: "var(--gap-small)",
            borderRadius: "var(--radius-row)",
            background: "var(--note)",
            color: "var(--ink)",
            fontSize: "var(--text-subtitle)",
          }}
        >
          <span style={{ flex: "1 1 120px" }}>有未完成的导入</span>
          <div
            style={{
              display: "flex",
              flex: "none",
              gap: "var(--gap-small)",
            }}
          >
            <InkButton
              text="继续"
              disabled={importActionBusy}
              onClick={() => void continueImport()}
            />
            <InkButton
              text="放弃"
              outline
              disabled={importActionBusy}
              onClick={() => void discardImport()}
            />
          </div>
        </div>
      )}

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
        <div style={{ paddingTop: "var(--gap)" }}>
          {sections.map((section) => {
            const items = state.items.filter(
              (item) => item.group === section.location,
            );
            if (items.length === 0) {
              return null;
            }

            return (
              <div key={section.location} className="page">
                <div
                  style={{
                    position: "absolute",
                    zIndex: 2,
                    top: "calc(-1 * var(--tape-height) / 2)",
                    left: "var(--page-inset)",
                  }}
                >
                  <SectionTape
                    label={section.location}
                    iconName={section.iconName}
                    count={items.length}
                    tapeColor={section.tapeColor}
                  />
                </div>
                <div style={{ display: "grid" }}>
                  {items.map((item) => (
                    <PantryRow
                      key={item.id}
                      ingredient={item}
                      multiSelect={multiSelect}
                      checked={checkedIds.includes(item.id)}
                      forceClosed={openRowId !== null && openRowId !== item.id}
                      onOpenChange={(open) =>
                        setOpenRowId((current) =>
                          open
                            ? item.id
                            : current === item.id
                              ? null
                              : current,
                        )
                      }
                      onEditRequested={editItem}
                      onSelectionRequested={toggleSelection}
                      onUsed={(ingredient) =>
                        void runItemAction(
                          () => api.useItem({ id: ingredient.id }),
                          () =>
                            ingredient.bulk
                              ? {
                                  message: `「${ingredient.name}」默认存量多，已保留；需要时请标记家里没有`,
                                  undo: false,
                                }
                              : {
                                  message: `已用掉「${ingredient.name}」`,
                                  undo: true,
                                },
                        )
                      }
                      onUnavailable={(ingredient) =>
                        void runItemAction(
                          () => api.markItemAbsent({ id: ingredient.id }),
                          (result) => ({
                            message:
                              result.suggestions.length > 0
                                ? `「${ingredient.name}」家里没有，已在「我的」生成加入待买的建议`
                                : `「${ingredient.name}」已标记为家里没有`,
                            undo: true,
                          }),
                        )
                      }
                      onDiscarded={(ingredient) =>
                        void runItemAction(
                          () => api.discardItem({ id: ingredient.id }),
                          () => ({
                            message: `已扔掉「${ingredient.name}」`,
                            undo: true,
                          }),
                        )
                      }
                      onSnoozed={(ingredient) =>
                        void runItemAction(
                          () => api.snoozeItem({ id: ingredient.id }),
                          () => ({
                            message: `已忽略「${ingredient.name}」的临期提醒，明天再提醒`,
                            undo: true,
                          }),
                        )
                      }
                      onFirstRequested={(ingredient) =>
                        void setFirst(ingredient)
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
        <div className="select-tray">
          <InkButton
            fullWidth
            text={`移除选中 ${checkedIds.length} 件`}
            accent="var(--tomato)"
            disabled={checkedIds.length === 0 || removing}
            onClick={() => setRemoveConfirmOpen(true)}
          />
          <InkButton
            fullWidth
            text="完成多选"
            outline
            onClick={finishSelection}
          />
        </div>
      )}

      <ConfirmDialog
        open={removeConfirmOpen}
        message={`移除选中的 ${checkedIds.length} 件食材？它们会被标记为家里没有。`}
        confirmText="移除"
        destructive
        onCancel={() => setRemoveConfirmOpen(false)}
        onConfirm={() => void removeSelected()}
      />
    </section>
  );
}
