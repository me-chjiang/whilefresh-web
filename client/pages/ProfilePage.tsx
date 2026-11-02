import {
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";

import type {
  ImportRecordDto,
  RuleDto,
  SuggestionDto,
} from "../../shared/api";
import { api, ApiError } from "../api";
import { CategoryDot } from "../components/CategoryDot";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Icon } from "../components/Icon";
import { InkButton } from "../components/InkButton";
import { NoticeBanner } from "../components/NoticeBanner";
import { PageHeader } from "../components/PageHeader";
import { useAppShell } from "../App";
import { ServicesPage } from "./ServicesPage";

const locations = ["冷藏", "冷冻", "常温"] as const;

const cardStyle: CSSProperties = {
  width: "100%",
  borderRadius: "var(--radius-card)",
  background: "var(--card)",
  boxShadow: "var(--shadow-one)",
};

const fieldStyle: CSSProperties = {
  minHeight: "var(--touch)",
  padding: "var(--gap-small)",
  border: "1.5px solid var(--rule)",
  borderRadius: "var(--radius-tag)",
  color: "var(--ink)",
  background: "var(--selected-paper)",
  fontSize: "var(--text-control)",
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

function SectionTitle({
  title,
  detail,
}: {
  title: string;
  detail?: string;
}) {
  return (
    <header style={{ marginTop: "var(--gap-small)" }}>
      <h2
        style={{
          margin: 0,
          fontSize: "var(--text-panel)",
          fontWeight: "var(--weight-black)",
        }}
      >
        {title}
      </h2>
      {detail && (
        <p
          style={{
            margin: "var(--gap-tiny) 0 0",
            color: "var(--muted)",
            fontSize: "var(--text-meta)",
          }}
        >
          {detail}
        </p>
      )}
    </header>
  );
}

function DemoModeRow({
  enabled,
  onToggle,
}: {
  enabled: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      style={{
        ...cardStyle,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        minHeight: "calc(var(--touch) + var(--gap-large))",
        padding: "var(--gap-small) var(--gap)",
        gap: "var(--gap)",
      }}
    >
      <div>
        <div
          style={{
            color: "var(--ink)",
            fontSize: "var(--text-body)",
            fontWeight: "var(--weight-bold)",
          }}
        >
          演示模式
        </div>
        <div
          style={{
            marginTop: 2,
            color: "var(--muted)",
            fontSize: "var(--text-meta)",
          }}
        >
          使用独立数据，不影响真实冰箱
        </div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label="演示模式"
        onClick={onToggle}
        style={{
          position: "relative",
          flex: "none",
          width: 54,
          minWidth: 54,
          height: 32,
          minHeight: 32,
          padding: 3,
          border: "1.5px solid var(--outline)",
          borderRadius: 18,
          background: enabled ? "var(--green)" : "var(--selected-paper)",
        }}
      >
        <span
          aria-hidden="true"
          style={{
            display: "block",
            width: 24,
            height: 24,
            borderRadius: "50%",
            background: enabled ? "var(--text-on-green)" : "var(--outline)",
            boxShadow: "var(--shadow-one)",
            transform: `translateX(${enabled ? 22 : 0}px)`,
          }}
        />
      </button>
    </div>
  );
}

function RuleEditor({
  rule,
  busy,
  onSave,
  onDelete,
}: {
  rule: RuleDto;
  busy: boolean;
  onSave: (days: string, location: string) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [days, setDays] = useState(rule.days);
  const [location, setLocation] = useState(rule.location);

  const save = async () => {
    if (busy) {
      return;
    }
    await onSave(days.trim(), location);
  };

  return (
    <div
      style={{
        ...cardStyle,
        padding: "var(--gap)",
      }}
    >
      <div
        style={{
          overflow: "hidden",
          color: "var(--ink)",
          fontSize: "var(--text-control)",
          fontWeight: "var(--weight-bold)",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {rule.name} · {rule.source}
      </div>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: "var(--gap-small)",
          marginTop: "var(--gap-small)",
        }}
      >
        <input
          type="number"
          inputMode="numeric"
          min={1}
          step={1}
          aria-label={`${rule.name}的保质天数`}
          placeholder="天数"
          value={days}
          disabled={busy}
          onChange={(event) => setDays(event.target.value)}
          style={{
            ...fieldStyle,
            width: 82,
            minWidth: 0,
          }}
        />
        <select
          aria-label={`${rule.name}的存放位置`}
          value={location}
          disabled={busy}
          onChange={(event) => setLocation(event.target.value)}
          style={{
            ...fieldStyle,
            flex: "1 1 100px",
            minWidth: 100,
          }}
        >
          {locations.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        <InkButton
          text="保存"
          disabled={busy}
          onClick={() => void save()}
        />
        <button
          type="button"
          aria-label={`删除${rule.name}的规则`}
          disabled={busy}
          onClick={() => void onDelete()}
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: "var(--touch)",
            height: "var(--touch)",
          }}
        >
          <Icon name="x" size={20} color="var(--muted)" />
        </button>
      </div>
    </div>
  );
}

export function ProfilePage() {
  const { state, refresh, notify, setDemoMode, pushPage } = useAppShell();
  const [pantryName, setPantryName] = useState("");
  const [pantryBusy, setPantryBusy] = useState(false);
  const [suggestionBusy, setSuggestionBusy] = useState<number | null>(
    null,
  );
  const [ruleBusy, setRuleBusy] = useState("");
  const [pendingImport, setPendingImport] =
    useState<ImportRecordDto | null>(null);
  const [deleteAllOpen, setDeleteAllOpen] = useState(false);
  const [deleteAllBusy, setDeleteAllBusy] = useState(false);
  const [deleteHistoryOpen, setDeleteHistoryOpen] = useState(false);
  const [deleteHistoryBusy, setDeleteHistoryBusy] = useState(false);

  const addPantry = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = pantryName.trim();
    if (!name || pantryBusy) {
      return;
    }
    setPantryBusy(true);
    try {
      await api.addPantryItem({ name });
      setPantryName("");
      await refresh();
    } catch (error) {
      notify(`添加失败：${messageFor(error)}`);
    } finally {
      setPantryBusy(false);
    }
  };

  const removePantry = async (name: string) => {
    if (pantryBusy) {
      return;
    }
    setPantryBusy(true);
    try {
      await api.removePantryItem({ name });
      await refresh();
    } catch (error) {
      notify(`移除失败：${messageFor(error)}`);
    } finally {
      setPantryBusy(false);
    }
  };

  const decideSuggestion = async (
    suggestion: SuggestionDto,
    accept: boolean,
  ) => {
    if (suggestionBusy !== null) {
      return;
    }
    setSuggestionBusy(suggestion.id);
    try {
      await api.decideSuggestion({ id: suggestion.id, accept });
      await refresh();
      notify(accept ? "已确认变更" : "已保留原设置");
    } catch (error) {
      notify(`处理建议失败：${messageFor(error)}`);
    } finally {
      setSuggestionBusy(null);
    }
  };

  const saveRule = async (
    rule: RuleDto,
    days: string,
    location: string,
  ) => {
    if (ruleBusy) {
      return;
    }
    const key = `${rule.kind}:${rule.name}:${rule.location}`;
    setRuleBusy(key);
    try {
      await api.saveRule({
        name: rule.name,
        oldLocation: rule.location,
        location,
        days,
      });
      await refresh();
      notify("已保存规则");
    } catch (error) {
      notify(`保存失败：${messageFor(error)}`);
    } finally {
      setRuleBusy("");
    }
  };

  const deleteRule = async (rule: RuleDto) => {
    if (ruleBusy) {
      return;
    }
    const key = `${rule.kind}:${rule.name}:${rule.location}`;
    setRuleBusy(key);
    try {
      await api.deleteRule({
        name: rule.name,
        location: rule.location,
        kind: rule.kind,
      });
      await refresh();
      notify("已删除规则");
    } catch (error) {
      notify(`删除失败：${messageFor(error)}`);
    } finally {
      setRuleBusy("");
    }
  };

  const deleteImport = async () => {
    if (!pendingImport) {
      return;
    }
    const target = pendingImport;
    setPendingImport(null);
    try {
      const result = await api.deleteImport({ id: target.id });
      await refresh();
      notify(result.ok ? "已删除本次导入记录" : "删除失败，请重试");
    } catch (error) {
      notify(`删除失败：${messageFor(error)}`);
    }
  };

  const deleteImportHistory = async () => {
    if (deleteHistoryBusy) {
      return;
    }
    setDeleteHistoryBusy(true);
    try {
      const result = await api.clearImportHistory();
      await refresh();
      setDeleteHistoryOpen(false);
      notify(
        "warning" in result &&
          typeof result.warning === "string"
          ? `已删除导入历史；${result.warning}`
          : "已删除导入历史",
      );
    } catch (error) {
      notify(`删除失败：${messageFor(error)}`);
    } finally {
      setDeleteHistoryBusy(false);
    }
  };

  const deleteAll = async () => {
    if (deleteAllBusy) {
      return;
    }
    setDeleteAllBusy(true);
    try {
      const result = await api.deleteAllData();
      await refresh();
      setDeleteAllOpen(false);
      notify(
        result.warning
          ? `已清空数据；${result.warning}`
          : "已清空数据",
      );
    } catch (error) {
      notify(`删除失败：${messageFor(error)}`);
    } finally {
      setDeleteAllBusy(false);
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
        heading="我的"
        subtitle="习惯与数据"
        style={{ marginInline: "calc(-1 * var(--section-padding))" }}
      />

      <div
        style={{
          display: "grid",
          gap: "var(--gap)",
          marginTop: "var(--gap-small)",
        }}
      >
        <NoticeBanner
          warning={!state.demoMode && !state.recognitionConfigured}
          message={
            state.demoMode
              ? "演示模式：使用独立示例数据和预设识别结果，不联网，不影响真实数据"
              : state.recognitionConfigured
                ? "识别服务已配置。入库识别前会再次提示隐私说明"
                : "未配置识别服务密钥，真实识别不可用；可开启演示模式体验流程"
          }
        />

        <DemoModeRow
          enabled={state.demoMode}
          onToggle={() => void setDemoMode(!state.demoMode)}
        />

        <button
          type="button"
          onClick={() =>
            pushPage({
              key: "profile-services",
              title: "服务",
              element: <ServicesPage />,
            })
          }
          style={{
            ...cardStyle,
            display: "flex",
            alignItems: "center",
            minHeight: "calc(var(--touch) + var(--gap-large))",
            padding: "var(--gap-small) var(--gap)",
            gap: "var(--gap)",
            color: "var(--ink)",
            textAlign: "left",
          }}
        >
          <span
            style={{
              flex: 1,
              fontSize: "var(--text-body)",
              fontWeight: "var(--weight-bold)",
            }}
          >
            服务
          </span>
          <Icon name="chevron-right" size={20} color="var(--muted)" />
        </button>

        <SectionTitle
          title="常备调料 / 常用食材"
          detail="清单内默认家里有；存量多的食材用掉一次仍保留。建议更改需确认。"
        />
        <div style={{ ...cardStyle, padding: "var(--gap)" }}>
          {state.pantry.length > 0 && (
            <ul>
              {state.pantry.map((item) => (
                <li
                  key={item.name}
                  className="item"
                  style={{
                    display: "grid",
                    gridTemplateColumns:
                      "var(--item-dot) minmax(0, 1fr) auto var(--touch)",
                    alignItems: "center",
                    gap: "var(--gap-small)",
                  }}
                >
                  <CategoryDot category={item.category} />
                  <span
                    style={{
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {item.name}
                  </span>
                  <span
                    style={{
                      color: "var(--muted)",
                      fontSize: "var(--text-meta)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {item.bulk ? "默认存量多" : "默认有"}
                  </span>
                  <button
                    type="button"
                    aria-label={`移除常备食材${item.name}`}
                    disabled={pantryBusy}
                    onClick={() => void removePantry(item.name)}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: "var(--touch)",
                      height: "var(--touch)",
                    }}
                  >
                    <Icon name="x" size={20} color="var(--muted)" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <form
            onSubmit={(event) => void addPantry(event)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--gap-small)",
              marginTop:
                state.pantry.length > 0 ? "var(--gap-small)" : 0,
            }}
          >
            <input
              type="text"
              aria-label="添加常备食材"
              placeholder="添加常备食材"
              maxLength={200}
              value={pantryName}
              disabled={pantryBusy}
              onChange={(event) => setPantryName(event.target.value)}
              style={{
                ...fieldStyle,
                flex: 1,
                minWidth: 0,
              }}
            />
            <InkButton
              type="submit"
              text="添加"
              disabled={!pantryName.trim() || pantryBusy}
            />
          </form>
        </div>

        <SectionTitle title="待确认建议" />
        {state.suggestions.length === 0 ? (
          <NoticeBanner warning={false} message="暂无待确认建议" />
        ) : (
          state.suggestions.map((suggestion) => (
            <div
              key={suggestion.id}
              style={{
                padding: "var(--gap)",
                border: "1px solid var(--rule)",
                borderRadius: "var(--radius-row)",
                background: "var(--note)",
              }}
            >
              <p
                style={{
                  margin: 0,
                  color: "var(--ink)",
                  fontSize: "var(--text-subtitle)",
                }}
              >
                {suggestion.name} · {suggestion.note}
              </p>
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: "var(--gap-small)",
                  marginTop: "var(--gap-small)",
                }}
              >
                <InkButton
                  text="确认变更"
                  disabled={suggestionBusy !== null}
                  onClick={() =>
                    void decideSuggestion(suggestion, true)
                  }
                />
                <InkButton
                  outline
                  text="不变更"
                  disabled={suggestionBusy !== null}
                  onClick={() =>
                    void decideSuggestion(suggestion, false)
                  }
                />
              </div>
            </div>
          ))
        )}

        <SectionTitle title="保质期与存放规则" />
        {state.rules.length === 0 ? (
          <NoticeBanner warning={false} message="暂无自定义规则" />
        ) : (
          state.rules.map((rule) => {
            const key = `${rule.kind}:${rule.name}:${rule.location}`;
            return (
              <RuleEditor
                key={key}
                rule={rule}
                busy={ruleBusy !== ""}
                onSave={(days, location) =>
                  saveRule(rule, days, location)
                }
                onDelete={() => deleteRule(rule)}
              />
            );
          })
        )}

        <SectionTitle title="导入记录与本机数据" />
        {state.imports.length === 0 ? (
          <NoticeBanner warning={false} message="暂无导入记录" />
        ) : (
          state.imports.map((record) => (
            <div
              key={record.id}
              style={{
                ...cardStyle,
                display: "flex",
                alignItems: "center",
                gap: "var(--gap-small)",
                padding: "var(--gap-small) var(--gap)",
              }}
            >
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflow: "hidden",
                  fontSize: "var(--text-subtitle)",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {record.name} · {record.date}
              </span>
              <InkButton
                outline
                text="删除本次"
                onClick={() => setPendingImport(record)}
              />
            </div>
          ))
        )}
        {state.imports.length > 0 && (
          <InkButton
            fullWidth
            outline
            text="删除历史"
            onClick={() => setDeleteHistoryOpen(true)}
          />
        )}
        <InkButton
          fullWidth
          text="删除全部数据"
          accent="var(--tomato)"
          onClick={() => setDeleteAllOpen(true)}
        />

        <SectionTitle title="来源与许可" />
        <div
          style={{
            ...cardStyle,
            display: "grid",
            gap: "var(--gap-small)",
            padding: "var(--gap)",
            color: "var(--ink)",
            fontSize: "var(--text-subtitle)",
          }}
        >
          <p style={{ margin: 0 }}>
            菜谱：HowToCook · Unlicense（原文及来源链接见菜谱详情）
          </p>
          <p style={{ margin: 0 }}>
            保质期参考：USDA FoodKeeper。仅作估计，请查看食材后决定。
          </p>
          <p style={{ margin: 0 }}>
            图标：Tabler Icons · MIT；标题字：Noto Serif SC Black ·
            SIL OFL 1.1。许可文本随 App 附带。
          </p>
          <p style={{ margin: 0 }}>
            基于 Qt 6.8.2（LGPL v3，动态链接，源码见 qt.io）与 OpenSSL
            3（Apache 2.0）构建。
          </p>
        </div>
      </div>

      <ConfirmDialog
        open={pendingImport !== null}
        message="删除这次导入记录及其截图？"
        confirmText="删除本次"
        destructive
        onCancel={() => setPendingImport(null)}
        onConfirm={() => void deleteImport()}
      />
      <ConfirmDialog
        open={deleteHistoryOpen}
        message="只删除导入记录和截图，冰箱里的食材不受影响。"
        confirmText={
          deleteHistoryBusy ? "正在删除…" : "删除历史"
        }
        destructive
        onCancel={() => {
          if (!deleteHistoryBusy) {
            setDeleteHistoryOpen(false);
          }
        }}
        onConfirm={() => void deleteImportHistory()}
      />
      <ConfirmDialog
        open={deleteAllOpen}
        message="删除当前模式下的全部食材、待买、规则和导入记录？"
        confirmText={deleteAllBusy ? "正在删除…" : "删除全部"}
        destructive
        onCancel={() => {
          if (!deleteAllBusy) {
            setDeleteAllOpen(false);
          }
        }}
        onConfirm={() => void deleteAll()}
      />
    </section>
  );
}
