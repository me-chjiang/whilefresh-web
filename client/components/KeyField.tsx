import { useState, type CSSProperties } from "react";

import type {
  ServiceSource,
  ServiceSourcesDto,
} from "../../shared/api";
import { api } from "../api";
import { InkButton } from "./InkButton";

const cardStyle: CSSProperties = {
  width: "100%",
  padding: "var(--gap)",
  borderRadius: "var(--radius-card)",
  background: "var(--card)",
  boxShadow: "var(--shadow-one)",
};

const inputStyle: CSSProperties = {
  width: "100%",
  minHeight: "var(--touch)",
  padding: "var(--gap-small)",
  border: "1px solid var(--rule)",
  borderRadius: "var(--radius-tag)",
  color: "var(--ink)",
  background: "var(--selected-paper)",
  fontSize: "var(--text-control)",
};

export interface KeyFieldProps {
  label: string;
  field: keyof ServiceSourcesDto;
  source: ServiceSource;
  onRefresh: () => Promise<void>;
}

function sourceLabel(source: ServiceSource): string {
  if (source === "user") {
    return "已配置";
  }
  if (source === "builtin") {
    return "内置";
  }
  return "未配置";
}

export function KeyField({
  label,
  field,
  source,
  onRefresh,
}: KeyFieldProps) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const trimmed = value.trim();
    if (!trimmed || busy) {
      return;
    }
    setBusy(true);
    try {
      await api.setService(field, trimmed);
      setValue("");
      setError("");
      await onRefresh();
    } catch {
      setError("保存失败");
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    if (source === "none" || busy) {
      return;
    }
    setBusy(true);
    try {
      await api.clearService(field);
      setError("");
      await onRefresh();
    } catch {
      setError("清除失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={cardStyle}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--gap-small)",
        }}
      >
        <label
          htmlFor={`service-${field}`}
          style={{
            flex: 1,
            color: "var(--ink)",
            fontSize: "var(--text-body)",
            fontWeight: "var(--weight-bold)",
          }}
        >
          {label}
        </label>
        <span
          style={{
            color: source === "none" ? "var(--muted)" : "var(--green)",
            fontSize: "var(--text-meta)",
          }}
        >
          {sourceLabel(source)}
        </span>
      </div>

      <input
        id={`service-${field}`}
        type="password"
        autoComplete="off"
        value={value}
        disabled={busy}
        onChange={(event) => setValue(event.target.value)}
        style={{
          ...inputStyle,
          marginTop: "var(--gap-small)",
        }}
      />

      {error && (
        <p
          role="alert"
          style={{
            margin: "var(--gap-small) 0 0",
            color: "var(--tomato)",
            fontSize: "var(--text-meta)",
          }}
        >
          {error}
        </p>
      )}

      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "var(--gap-small)",
          marginTop: "var(--gap-small)",
        }}
      >
        <InkButton
          text="保存"
          disabled={!value.trim() || busy}
          onClick={() => void save()}
        />
        <InkButton
          outline
          text="清除"
          disabled={source === "none" || busy}
          onClick={() => void clear()}
        />
      </div>
    </div>
  );
}
