import { useState, type FormEvent } from "react";

import type { ItemDto, ItemEdits } from "../../shared/api";
import { useAppShell } from "../App";
import { api, ApiError } from "../api";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { InkButton } from "../components/InkButton";
import { NoticeBanner } from "../components/NoticeBanner";
import { PageHeader } from "../components/PageHeader";

const sourceLabels: Record<string, string> = {
  package: "包装标注",
  user: "你的设置",
  reference: "参考表",
  ai: "AI 估计",
  none: "未知",
};

const dateFields = [
  { key: "purchasedAt", label: "购买日期" },
  { key: "storedAt", label: "入库日期" },
  { key: "producedAt", label: "生产日期" },
  { key: "packageExpiresAt", label: "包装到期日" },
] as const;

type DateField = (typeof dateFields)[number]["key"];

interface ItemEditPageProps {
  item: ItemDto;
}

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message;
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "保存失败，请稍后重试";
}

export function ItemEditPage({ item }: ItemEditPageProps) {
  const { goBack, notify, refresh } = useAppShell();
  const [name, setName] = useState(item.name);
  const [quantity, setQuantity] = useState(item.quantity);
  const [location, setLocation] = useState(item.location);
  const [shelfDays, setShelfDays] = useState(item.shelfDays);
  const [dates, setDates] = useState<Record<DateField, string>>({
    purchasedAt: item.purchasedAt,
    storedAt: item.storedAt,
    producedAt: item.producedAt,
    packageExpiresAt: item.packageExpiresAt,
  });
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  const [questionOpen, setQuestionOpen] = useState(false);
  const [answering, setAnswering] = useState(false);

  const setDate = (field: DateField, value: string) => {
    setDates((current) => ({ ...current, [field]: value }));
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      setSaveError("请填写食材名称");
      return;
    }
    if (saving) {
      return;
    }

    const edits: ItemEdits = {
      name: trimmedName,
      quantity: quantity.trim(),
      location,
      shelfDays: shelfDays.trim(),
      ...dates,
    };

    setSaveError("");
    setSaving(true);
    try {
      const result = await api.updateItem({ id: item.id, edits });
      if (!result.ok) {
        setSaveError(result.error || "保存失败，请检查输入");
        return;
      }
      if (result.question) {
        setQuestionOpen(true);
        return;
      }
      await refresh();
      goBack();
    } catch (error) {
      setSaveError(messageFor(error));
    } finally {
      setSaving(false);
    }
  };

  const answerQuestion = async (remember: boolean) => {
    if (answering) {
      return;
    }
    setAnswering(true);
    try {
      if (remember) {
        await api.confirmRememberedRules();
      } else {
        await api.dismissRememberedRules();
      }
      await refresh();
      goBack();
    } catch (error) {
      setQuestionOpen(false);
      setSaveError(messageFor(error));
      notify("食材已保存，但同类食材设置未更新");
    } finally {
      setAnswering(false);
    }
  };

  const sourceLabel = sourceLabels[item.source] ?? "参考表";
  const sourceDetail =
    item.source === "package" ? sourceLabel : `${sourceLabel} · 估计`;

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
        heading="编辑食材"
        backVisible
        onBack={goBack}
        style={{ marginInline: "calc(-1 * var(--section-padding))" }}
      />

      <form
        noValidate
        onSubmit={(event) => void save(event)}
        style={{ display: "grid", gap: "var(--gap)" }}
      >
        <div
          style={{
            display: "grid",
            gap: "var(--gap-small)",
            marginTop: "var(--gap)",
            padding: "var(--gap)",
            borderRadius: "var(--radius-card)",
            background: "var(--card)",
            boxShadow: "var(--shadow-one)",
          }}
        >
          <h2
            style={{
              margin: 0,
              fontFamily: "var(--font-serif)",
              fontSize: "var(--text-panel)",
              fontWeight: "var(--weight-black)",
            }}
          >
            名称与数量
          </h2>
          <label style={{ display: "grid", gap: "var(--gap-tiny)" }}>
            <span style={{ color: "var(--muted)", fontSize: "var(--text-subtitle)" }}>
              名称（必填）
            </span>
            <input
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="食材名称"
              autoComplete="off"
            />
          </label>
          <label style={{ display: "grid", gap: "var(--gap-tiny)" }}>
            <span style={{ color: "var(--muted)", fontSize: "var(--text-subtitle)" }}>
              数量
            </span>
            <input
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
              placeholder="数量原值"
              autoComplete="off"
            />
          </label>
          <label style={{ display: "grid", gap: "var(--gap-tiny)" }}>
            <span style={{ color: "var(--muted)", fontSize: "var(--text-subtitle)" }}>
              存放位置
            </span>
            <select
              value={location}
              onChange={(event) => setLocation(event.target.value)}
            >
              <option value="冷藏">冷藏</option>
              <option value="冷冻">冷冻</option>
              <option value="常温">常温</option>
            </select>
          </label>
          <label style={{ display: "grid", gap: "var(--gap-tiny)" }}>
            <span style={{ color: "var(--muted)", fontSize: "var(--text-subtitle)" }}>
              保质天数 · {sourceDetail}
            </span>
            <input
              type="number"
              min="1"
              step="1"
              inputMode="numeric"
              value={shelfDays}
              onChange={(event) => setShelfDays(event.target.value)}
              placeholder="保质天数"
            />
          </label>
          {item.shelfLifeNote && (
            <p
              style={{
                margin: 0,
                color: "var(--muted)",
                fontSize: "var(--text-meta)",
              }}
            >
              {item.shelfLifeNote}
            </p>
          )}
          <p style={{ margin: 0, fontSize: "var(--text-meta)" }}>
            {item.source === "package" && item.expiryDate
              ? `包装到期：${item.expiryDate}`
              : `${item.startDate ? `从${item.startBasis === "production" ? "生产日期" : item.startBasis === "purchase" ? "购买日期" : "入库日期"} ${item.startDate} 起算 · ` : ""}预计到期：${item.expiryDate || "暂无法估计"}`}
          </p>

          {dateFields.map((field) => (
            <label
              key={field.key}
              style={{
                display: "grid",
                gridTemplateColumns: "90px minmax(0, 1fr)",
                alignItems: "center",
                gap: "var(--gap-small)",
              }}
            >
              <span
                style={{
                  color: "var(--muted)",
                  fontSize: "var(--text-subtitle)",
                }}
              >
                {field.label}
              </span>
              <input
                type="date"
                value={dates[field.key]}
                onChange={(event) => setDate(field.key, event.target.value)}
              />
            </label>
          ))}
        </div>

        <NoticeBanner
          warning={item.freshness === "overdue"}
          message={
            item.freshness === "overdue"
              ? "超出估计期限，请查看后决定"
              : "非包装标注的期限仅为估计，请结合食材状态判断"
          }
        />

        <InkButton
          type="submit"
          fullWidth
          titleStyle
          text={saving ? "保存中…" : "保存修改"}
          disabled={saving || answering}
        />

        {saveError && <NoticeBanner message={saveError} />}
      </form>

      <ConfirmDialog
        open={questionOpen}
        message="以后同类食材都按这个存放位置和保质天数吗？"
        confirmText="记住这个设置"
        onConfirm={() => void answerQuestion(true)}
        onCancel={() => void answerQuestion(false)}
      />
    </section>
  );
}
