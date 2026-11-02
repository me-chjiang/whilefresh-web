import { useEffect, useState, type FormEvent } from "react";

import type {
  NameMappingDto,
  PreferencesDto,
} from "../../shared/api";
import { api } from "../api";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Icon } from "../components/Icon";
import { InkButton } from "../components/InkButton";
import { PageHeader } from "../components/PageHeader";
import { useAppShell } from "../App";

const cardStyle = {
  width: "100%",
  borderRadius: "var(--radius-card)",
  background: "var(--card)",
  boxShadow: "var(--shadow-one)",
} as const;

export function PreferencesPage() {
  const { state, goBack } = useAppShell();
  const [preferences, setPreferences] = useState<PreferencesDto | null>(
    null,
  );
  const [nameMappings, setNameMappings] = useState<NameMappingDto[]>([]);
  const [text, setText] = useState("");
  const [addError, setAddError] = useState("");
  const [busy, setBusy] = useState(false);
  const [summaryBusy, setSummaryBusy] = useState(false);
  const [clearAllOpen, setClearAllOpen] = useState(false);

  useEffect(() => {
    let active = true;
    void Promise.all([api.preferences(), api.nameMappings()])
      .then(([nextPreferences, nextMappings]) => {
        if (active) {
          setPreferences(nextPreferences);
          setNameMappings(nextMappings);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const addPreference = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = text.trim();
    if (!value || busy) {
      return;
    }
    setBusy(true);
    try {
      await api.addPreference(value);
      const next = await api.preferences();
      setText("");
      setAddError("");
      setPreferences(next);
    } catch {
      setAddError("添加失败");
    } finally {
      setBusy(false);
    }
  };

  const deletePreference = async (id: number) => {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      await api.deletePreference(id);
      setPreferences(await api.preferences());
    } catch {
      // The requested row remains visible if the server did not delete it.
    } finally {
      setBusy(false);
    }
  };

  const summarize = async () => {
    if (summaryBusy) {
      return;
    }
    setSummaryBusy(true);
    setPreferences((current) =>
      current ? { ...current, summarizing: true } : current,
    );
    try {
      setPreferences(await api.summarizePreferences());
    } catch {
      setPreferences((current) =>
        current ? { ...current, summarizing: false } : current,
      );
    } finally {
      setSummaryBusy(false);
    }
  };

  const forgetMapping = async (raw: string) => {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      await api.forgetNameMapping(raw);
      setNameMappings(await api.nameMappings());
    } catch {
      // Keep the mapping visible unless the server confirms its removal.
    } finally {
      setBusy(false);
    }
  };

  const clearMappings = async () => {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      await api.clearNameMappings();
      setNameMappings([]);
      setClearAllOpen(false);
    } catch {
      // The confirmation remains open so the user can retry.
    } finally {
      setBusy(false);
    }
  };

  const items = preferences?.items ?? [];
  const summarizing = summaryBusy || (preferences?.summarizing ?? false);

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
        heading="偏好记忆"
        actionText="返回"
        onAction={goBack}
        style={{ marginInline: "calc(-1 * var(--section-padding))" }}
      />

      <div
        style={{
          display: "grid",
          gap: "var(--gap)",
          marginTop: "var(--gap-small)",
        }}
      >
        <div style={{ ...cardStyle, padding: "var(--gap)" }}>
          {items.length > 0 && (
            <ul style={{ marginBottom: "var(--gap-tiny)" }}>
              {items.map((item) => (
                <li
                  key={item.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    minHeight: "var(--touch)",
                    gap: "var(--gap-small)",
                  }}
                >
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      overflow: "hidden",
                      color: "var(--ink)",
                      fontSize: "var(--text-control)",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {item.text}
                  </span>
                  {item.source === "ai" && (
                    <span
                      style={{
                        color: "var(--muted)",
                        fontSize: "var(--text-meta)",
                      }}
                    >
                      AI
                    </span>
                  )}
                  <button
                    type="button"
                    aria-label={`删除偏好${item.text}`}
                    disabled={busy}
                    onClick={() => void deletePreference(item.id)}
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
            onSubmit={(event) => void addPreference(event)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--gap-small)",
            }}
          >
            <input
              type="text"
              aria-label="添加偏好"
              placeholder="添加偏好"
              maxLength={100}
              value={text}
              disabled={busy}
              onChange={(event) => setText(event.target.value)}
              style={{
                flex: 1,
                minWidth: 0,
                minHeight: "var(--touch)",
                padding: "var(--gap-small)",
                border: "1px solid var(--rule)",
                borderRadius: "var(--radius-tag)",
                color: "var(--ink)",
                background: "var(--selected-paper)",
                fontSize: "var(--text-control)",
              }}
            />
            <InkButton
              type="submit"
              text="添加"
              disabled={!text.trim() || busy}
            />
          </form>

          {addError && (
            <p
              role="alert"
              style={{
                margin: "var(--gap-tiny) 0 0",
                color: "var(--tomato)",
                fontSize: "var(--text-meta)",
              }}
            >
              {addError}
            </p>
          )}
        </div>

        <h2
          style={{
            margin: 0,
            fontSize: "var(--text-panel)",
            fontWeight: "var(--weight-black)",
          }}
        >
          摘要
        </h2>
        <div
          style={{
            ...cardStyle,
            display: "grid",
            gap: "var(--gap-small)",
            padding: "var(--gap)",
          }}
        >
          <p
            style={{
              margin: 0,
              color: "var(--ink)",
              fontSize: "var(--text-control)",
              whiteSpace: "pre-wrap",
            }}
          >
            {preferences?.summary || "无"}
          </p>
          {preferences?.stale && (
            <span
              style={{
                color: "var(--muted)",
                fontSize: "var(--text-meta)",
              }}
            >
              待整理
            </span>
          )}
          {!state.recognitionConfigured && (
            <span
              style={{
                color: "var(--muted)",
                fontSize: "var(--text-meta)",
              }}
            >
              未配置
            </span>
          )}
          <InkButton
            text={summarizing ? "整理中" : "整理"}
            disabled={
              !state.recognitionConfigured ||
              summarizing ||
              items.length === 0
            }
            onClick={() => void summarize()}
            style={{ justifySelf: "start" }}
          />
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--gap-small)",
          }}
        >
          <h2
            style={{
              flex: 1,
              margin: 0,
              fontSize: "var(--text-panel)",
              fontWeight: "var(--weight-black)",
            }}
          >
            已记住的名称
          </h2>
          {nameMappings.length > 0 && (
            <InkButton
              outline
              text="全部清除"
              disabled={busy}
              onClick={() => setClearAllOpen(true)}
            />
          )}
        </div>

        {nameMappings.length > 0 ? (
          <div style={{ ...cardStyle, padding: "var(--gap)" }}>
            <ul>
              {nameMappings.map((mapping) => (
                <li
                  key={mapping.raw}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    minHeight: "var(--touch)",
                    gap: "var(--gap-small)",
                  }}
                >
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      overflow: "hidden",
                      color: "var(--ink)",
                      fontSize: "var(--text-control)",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {mapping.raw} → {mapping.canonical}
                  </span>
                  <button
                    type="button"
                    aria-label={`删除名称映射${mapping.raw}`}
                    disabled={busy}
                    onClick={() => void forgetMapping(mapping.raw)}
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
          </div>
        ) : (
          <p
            style={{
              margin: 0,
              color: "var(--muted)",
              fontSize: "var(--text-control)",
            }}
          >
            无
          </p>
        )}
      </div>

      <ConfirmDialog
        open={clearAllOpen}
        message="清除全部已记住的名称？"
        confirmText="全部清除"
        destructive
        onCancel={() => {
          if (!busy) {
            setClearAllOpen(false);
          }
        }}
        onConfirm={() => void clearMappings()}
      />
    </section>
  );
}
