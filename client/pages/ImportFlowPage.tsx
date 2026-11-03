import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";

import type {
  DraftItemDto,
  DraftItemGroup,
  ImportStatusDto,
  ItemEdits,
} from "../../shared/api";
import { ImportState } from "../../shared/enums";
import { useAppShell } from "../App";
import { api, ApiError } from "../api";
import { BottomSheet } from "../components/BottomSheet";
import { CategoryDot } from "../components/CategoryDot";
import { InkButton } from "../components/InkButton";
import { NoticeBanner } from "../components/NoticeBanner";

type Stage = "choose" | "privacy" | "manual";
type ImportMethod = "gallery" | "camera" | "text";

interface ImportFlowPageProps {
  open: boolean;
}

const locationOptions = [
  { value: "冷藏", label: "冷藏" },
  { value: "冷冻", label: "冷冻" },
  { value: "常温", label: "常温" },
] as const;

const dateFields = [
  { key: "purchasedAt", label: "购买" },
  { key: "storedAt", label: "入库" },
  { key: "producedAt", label: "生产" },
  { key: "packageExpiresAt", label: "包装到期" },
] as const;

type DateField = (typeof dateFields)[number]["key"];

const fieldStyle: CSSProperties = {
  width: "100%",
  minHeight: "var(--touch)",
  padding: "var(--gap-small)",
  border: "1.5px solid var(--rule)",
  borderRadius: "var(--radius-row)",
  color: "var(--ink)",
  background: "var(--selected-paper)",
};

const sectionStyle: CSSProperties = {
  display: "grid",
  gap: "var(--gap-small)",
};

const groupHeadingStyle: CSSProperties = {
  margin: 0,
  fontFamily: "var(--font-serif)",
  fontSize: "var(--text-group)",
  fontWeight: "var(--weight-black)",
};

function initialStatus(state: ReturnType<typeof useAppShell>["state"]): ImportStatusDto {
  return {
    importState: state.importState,
    importError: state.importError,
    draftItems: state.draftItems,
    draftWarning: state.draftWarning,
    draftDuplicate: state.draftDuplicate,
    draftFoodCount: state.draftFoodCount,
  };
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    return error.message;
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
}

function sourceLabel(source: string): string {
  const labels: Record<string, string> = {
    package: "包装标注",
    user: "你的设置",
    reference: "参考表",
    ai: "AI 估计",
    none: "未知",
  };
  return labels[source] ?? "参考表";
}

function startBasisLabel(basis: DraftItemDto["startBasis"]): string {
  if (basis === "production") {
    return "生产日期";
  }
  if (basis === "purchase") {
    return "购买日期";
  }
  if (basis === "entry") {
    return "入库日期";
  }
  return "起算日期";
}

function statusTitle(state: ImportStatusDto["importState"] | Stage): string {
  if (state === "choose") {
    return "选择入库方式";
  }
  if (state === "privacy" || state === "prepared") {
    return "上传前请确认";
  }
  if (state === "recognizing") {
    return "识别中";
  }
  if (state === "duplicate") {
    return "疑似重复导入";
  }
  if (state === "failed") {
    return "没有识别出食材";
  }
  if (state === "manual") {
    return "手动添加食材";
  }
  return "请检查并修改";
}

interface DraftItemCardProps {
  item: DraftItemDto;
  disabled: boolean;
  onEdit: (index: number, edits: ItemEdits) => void;
  onMove: (index: number, group: Exclude<DraftItemGroup, "ignored">) => void;
  onIgnore: (index: number) => void;
}

function DraftItemCard({
  item,
  disabled,
  onEdit,
  onMove,
  onIgnore,
}: DraftItemCardProps) {
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

  useEffect(() => {
    setName(item.name);
    setQuantity(item.quantity);
    setLocation(item.location);
    setShelfDays(item.shelfDays);
    setDates({
      purchasedAt: item.purchasedAt,
      storedAt: item.storedAt,
      producedAt: item.producedAt,
      packageExpiresAt: item.packageExpiresAt,
    });
  }, [
    item.name,
    item.quantity,
    item.location,
    item.shelfDays,
    item.purchasedAt,
    item.storedAt,
    item.producedAt,
    item.packageExpiresAt,
  ]);

  const blurOnEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.currentTarget.blur();
    }
  };

  const expiryText =
    item.source === "package" && item.expiryDate
      ? `包装到期：${item.expiryDate}`
      : `${item.startDate ? `从${startBasisLabel(item.startBasis)} ${item.startDate} 起算 · ` : ""}预计到期：${item.expiryDate || "暂无法估计"}`;

  return (
    <article
      style={{
        display: "grid",
        gap: "var(--gap-small)",
        padding: "var(--gap)",
        borderRadius: "var(--radius-row)",
        background: "var(--card)",
        boxShadow: "var(--shadow-one)",
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "auto minmax(0, 1fr) 88px 96px",
          alignItems: "center",
          gap: "var(--gap-small)",
        }}
      >
        <CategoryDot category={item.category} />
        <div
          style={{
            display: "flex",
            minWidth: 0,
            alignItems: "center",
            gap: "var(--gap-small)",
          }}
        >
          <input
            aria-label={`${item.name}的名称`}
            value={name}
            disabled={disabled}
            autoComplete="off"
            style={{
              ...fieldStyle,
              minWidth: 0,
              flex: 1,
              fontWeight: "var(--weight-bold)",
            }}
            onChange={(event) => setName(event.target.value)}
            onBlur={() => {
              const next = name.trim();
              if (!next) {
                setName(item.name);
                return;
              }
              onEdit(item.index, { name: next });
            }}
            onKeyDown={blurOnEnter}
          />
          {item.aiClassified && <span className="badge">AI 归类</span>}
        </div>
        <input
          aria-label={`${item.name}的数量`}
          value={quantity}
          disabled={disabled}
          autoComplete="off"
          style={fieldStyle}
          onChange={(event) => setQuantity(event.target.value)}
          onBlur={() => onEdit(item.index, { quantity: quantity.trim() })}
          onKeyDown={blurOnEnter}
        />
        <select
          aria-label={`${item.name}的存放位置`}
          value={location}
          disabled={disabled}
          style={fieldStyle}
          onChange={(event) => {
            setLocation(event.target.value);
            onEdit(item.index, { location: event.target.value });
          }}
        >
          {locationOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <p style={{ margin: 0, color: "var(--muted)", fontSize: "var(--text-meta)" }}>
        {sourceLabel(item.source)}
        {item.shelfDays
          ? `${item.source === "package" ? " · 标注保质 " : " · 建议保质 "}${item.shelfDays} 天`
          : ""}
      </p>

      {item.shelfLifeNote && (
        <p style={{ margin: 0, color: "var(--muted)", fontSize: "var(--text-meta)" }}>
          {item.shelfLifeNote}
        </p>
      )}
      {item.needsShelfLife && (
        <p style={{ margin: 0, color: "var(--overdue)", fontSize: "var(--text-meta)" }}>
          待录保质期
        </p>
      )}

      <p style={{ margin: 0, fontSize: "var(--text-meta)" }}>{expiryText}</p>
      {item.needsDate && (
        <p style={{ margin: 0, color: "var(--overdue)", fontSize: "var(--text-meta)" }}>
          日期写法需要拍摄日期才能换算，请填写具体日期
        </p>
      )}

      <label style={sectionStyle}>
        <span style={{ color: "var(--muted)", fontSize: "var(--text-meta)" }}>
          保质天数
        </span>
        <input
          type="number"
          min="1"
          step="1"
          inputMode="numeric"
          value={shelfDays}
          disabled={disabled}
          placeholder="包装标注可留空"
          style={fieldStyle}
          onChange={(event) => setShelfDays(event.target.value)}
          onBlur={() => onEdit(item.index, { shelfDays: shelfDays.trim() })}
          onKeyDown={blurOnEnter}
        />
      </label>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
          gap: "var(--gap-small)",
        }}
      >
        {dateFields.map((field) => (
          <label key={field.key} style={sectionStyle}>
            <span style={{ color: "var(--muted)", fontSize: "var(--text-small)" }}>
              {field.label}
            </span>
            <input
              type="date"
              aria-label={`${item.name}的${field.label}日期`}
              value={dates[field.key]}
              disabled={disabled}
              style={{ ...fieldStyle, minHeight: 40, fontSize: "var(--text-small)" }}
              onChange={(event) =>
                setDates((current) => ({
                  ...current,
                  [field.key]: event.target.value,
                }))
              }
              onBlur={() => onEdit(item.index, { [field.key]: dates[field.key] })}
            />
          </label>
        ))}
      </div>

      <div style={{ display: "flex", gap: "var(--gap-small)" }}>
        <InkButton
          fullWidth
          outline
          disabled={disabled}
          text="移入调料"
          onClick={() => onMove(item.index, "seasoning")}
        />
        <InkButton
          fullWidth
          outline
          disabled={disabled}
          text="移入已忽略"
          onClick={() => onIgnore(item.index)}
        />
      </div>
    </article>
  );
}

interface DraftItemRowProps {
  item: DraftItemDto;
  disabled: boolean;
  onMove: (index: number, group: DraftItemGroup) => void;
}

function DraftItemRow({ item, disabled, onMove }: DraftItemRowProps) {
  return (
    <li
      style={{
        display: "grid",
        gap: "var(--gap-small)",
        padding: "var(--gap-small) var(--gap)",
        borderRadius: "var(--radius-row)",
        background: "var(--selected-paper)",
        boxShadow: "var(--shadow-one)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "var(--gap-small)" }}>
        <CategoryDot category={item.category} />
        <strong style={{ flex: 1, minWidth: 0 }}>{item.name}</strong>
        {item.aiClassified && <span className="badge">AI 归类</span>}
        {item.quantity && (
          <span style={{ color: "var(--muted)", fontSize: "var(--text-meta)" }}>
            {item.quantity}
          </span>
        )}
      </div>
      {item.needsShelfLife && (
        <p style={{ margin: 0, color: "var(--overdue)", fontSize: "var(--text-meta)" }}>
          待录保质期
        </p>
      )}
      <div style={{ display: "flex", gap: "var(--gap-small)" }}>
        {item.group !== "food" && (
          <InkButton
            fullWidth
            outline
            disabled={disabled}
            text="移入食材"
            onClick={() => onMove(item.index, "food")}
          />
        )}
        {item.group !== "seasoning" && (
          <InkButton
            fullWidth
            outline
            disabled={disabled}
            text="移入调料"
            onClick={() => onMove(item.index, "seasoning")}
          />
        )}
        {item.group !== "ignored" && (
          <InkButton
            fullWidth
            outline
            disabled={disabled}
            text="移入已忽略"
            onClick={() => onMove(item.index, "ignored")}
          />
        )}
      </div>
    </li>
  );
}

export function ImportFlowPage({ open }: ImportFlowPageProps) {
  const {
    state,
    refresh,
    openImport,
    closeImport,
    notify,
  } = useAppShell();
  const [status, setStatus] = useState<ImportStatusDto>(() =>
    initialStatus(state),
  );
  const [stage, setStage] = useState<Stage>("choose");
  const [method, setMethod] = useState<ImportMethod>("gallery");
  const [pastedText, setPastedText] = useState("");
  const [manualName, setManualName] = useState("");
  const [manualQuantity, setManualQuantity] = useState("");
  const [manualLocation, setManualLocation] = useState("冷藏");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const galleryInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  const statusRef = useRef(status);
  const requestSequence = useRef(0);
  const suppressAutoOpen = useRef(false);
  const previousOpen = useRef(open);

  const commitStatus = useCallback((next: ImportStatusDto) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  const runStatusAction = useCallback(
    async (
      request: () => Promise<ImportStatusDto>,
      fallback: string,
    ): Promise<ImportStatusDto | null> => {
      if (busyRef.current) {
        return null;
      }
      const sequence = ++requestSequence.current;
      busyRef.current = true;
      setBusy(true);
      setError("");
      try {
        const next = await request();
        if (sequence === requestSequence.current) {
          commitStatus(next);
          return next;
        }
        return null;
      } catch (requestError) {
        if (sequence === requestSequence.current) {
          setError(errorMessage(requestError, fallback));
        }
        return null;
      } finally {
        if (sequence === requestSequence.current) {
          busyRef.current = false;
          setBusy(false);
        }
      }
    },
    [commitStatus],
  );

  const cancelInBackground = useCallback(() => {
    suppressAutoOpen.current = true;
    const sequence = ++requestSequence.current;
    busyRef.current = false;
    setBusy(false);
    setError("");
    void api
      .cancelImport()
      .then((next) => {
        if (sequence === requestSequence.current) {
          commitStatus(next);
          suppressAutoOpen.current = false;
        }
      })
      .catch((requestError: unknown) => {
        if (sequence === requestSequence.current) {
          notify(errorMessage(requestError, "取消导入失败，请重试"));
        }
      });
  }, [commitStatus, notify]);

  useEffect(() => {
    let active = true;
    const poll = async () => {
      if (busyRef.current) {
        return;
      }
      const sequence = ++requestSequence.current;
      try {
        const next = await api.importStatus();
        if (active && sequence === requestSequence.current) {
          commitStatus(next);
        }
      } catch {
        // The next poll retries without interrupting an active import.
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 1_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [commitStatus]);

  useEffect(() => {
    if (previousOpen.current && !open) {
      setStage("choose");
      cancelInBackground();
    }
    previousOpen.current = open;
  }, [open, cancelInBackground]);

  useEffect(() => {
    if (status.importState === ImportState.Idle) {
      suppressAutoOpen.current = false;
      return;
    }
    if (!suppressAutoOpen.current) {
      openImport();
    }
  }, [status.importState, openImport]);

  const closePanel = useCallback(() => {
    suppressAutoOpen.current = true;
    closeImport();
  }, [closeImport]);

  const startRecognition = async (allowDuplicate: boolean) => {
    commitStatus({
      ...statusRef.current,
      importState: ImportState.Recognizing,
      importError: "",
    });
    await runStatusAction(
      () =>
        api.startImport({
          privacyConfirmed: true,
          allowDuplicate,
        }),
      "无法开始识别，请稍后重试",
    );
  };

  const beginTextImport = async () => {
    const text = pastedText.trim();
    if (!text) {
      setError("请先粘贴订单文字");
      return;
    }
    await runStatusAction(
      () => api.beginTextImport(text),
      "无法读取订单文字，请稍后重试",
    );
  };

  const uploadImages = async (event: ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (selected.length === 0) {
      return;
    }
    await runStatusAction(async () => {
      const files = await Promise.all(
        selected.map(async (file) => ({
          filename: file.name,
          mimeType: file.type,
          data: await file.arrayBuffer(),
          lastModified: file.lastModified,
        })),
      );
      return api.uploadImportImages({
        origin: method === "camera" ? "camera" : "gallery",
        files,
      });
    }, "无法读取所选图片，请重试");
  };

  const discardToManual = async () => {
    setStage("manual");
    setError("");
    await runStatusAction(
      () => api.cancelImport(),
      "无法结束当前识别，请稍后重试",
    );
  };

  const editDraft = async (index: number, edits: ItemEdits) => {
    await runStatusAction(
      () => api.editDraftItem({ index, edits }),
      "无法保存草稿修改，请重试",
    );
  };

  const moveDraft = async (index: number, group: DraftItemGroup) => {
    if (group === "ignored") {
      await runStatusAction(
        () => api.dropDraftItem({ index }),
        "无法忽略该项，请重试",
      );
      return;
    }
    if (statusRef.current.draftItems[index]?.group === "ignored") {
      await runStatusAction(
        () => api.retrieveDraftItem({ index }),
        "无法找回该项，请重试",
      );
    }
    await runStatusAction(
      () => api.setDraftCategory({ index, category: group }),
      "无法移动该项，请重试",
    );
  };

  const confirmDraft = async () => {
    const next = await runStatusAction(
      () => api.confirmImport(statusRef.current.draftDuplicate),
      "无法确认入库，请重试",
    );
    if (next?.importState !== ImportState.Idle) {
      return;
    }
    await refresh();
    notify("已加入冰箱");
    closePanel();
  };

  const skipDuplicate = async () => {
    const next = await runStatusAction(
      () => api.skipDuplicateImport(),
      "无法跳过重复导入，请重试",
    );
    if (next?.importState !== ImportState.Idle) {
      return;
    }
    closePanel();
  };

  const addManualItem = async () => {
    const name = manualName.trim();
    if (!name) {
      setError("请先填写食材名称");
      return;
    }
    if (busyRef.current) {
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await api.addItem({
        name,
        quantity: manualQuantity.trim(),
        location: manualLocation,
      });
      if (!result.ok) {
        setError(result.error || "添加失败");
        return;
      }
      await refresh();
      notify("已加入冰箱");
      closePanel();
    } catch (requestError) {
      setError(errorMessage(requestError, "添加失败，请稍后重试"));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const view =
    status.importState === ImportState.Idle
      ? stage
      : status.importState;
  const foods = status.draftItems.filter((item) => item.group === "food");
  const seasonings = status.draftItems.filter(
    (item) => item.group === "seasoning",
  );
  const ignored = status.draftItems.filter((item) => item.group === "ignored");

  return (
    <>
      <input
        ref={galleryInput}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(event) => void uploadImages(event)}
      />
      <input
        ref={cameraInput}
        type="file"
        accept="image/*"
        multiple
        capture="environment"
        hidden
        onChange={(event) => void uploadImages(event)}
      />
      <BottomSheet
        open={open}
        heading={status.importState === ImportState.Draft ? "确认入库" : "入库"}
        tapeText="识别结果"
        sheetHeight={744}
        onClose={closePanel}
      >
        <div style={{ display: "grid", gap: "var(--gap)" }}>
          <h2
            style={{
              margin: 0,
              fontFamily: "var(--font-serif)",
              fontSize: "var(--text-panel)",
              fontWeight: "var(--weight-black)",
            }}
          >
            {statusTitle(view)}
          </h2>

          {state.demoMode && (
            <NoticeBanner
              warning={false}
              message="演示模式：使用预设识别结果，不会发送任何内容给 DeepSeek"
            />
          )}

          {error && <NoticeBanner message={error} />}

          {view === "choose" && (
            <div style={sectionStyle}>
              <InkButton
                fullWidth
                iconName="notes"
                text="相册截图 · 可多选"
                onClick={() => {
                  setError("");
                  setMethod("gallery");
                  setStage("privacy");
                }}
              />
              <InkButton
                fullWidth
                outline
                iconName="notes"
                text="拍购物小票"
                onClick={() => {
                  setError("");
                  setMethod("camera");
                  setStage("privacy");
                }}
              />
              <InkButton
                fullWidth
                outline
                iconName="notes"
                text="粘贴订单文字"
                onClick={() => {
                  setError("");
                  setMethod("text");
                  setStage("privacy");
                }}
              />
              <InkButton
                fullWidth
                outline
                iconName="plus"
                text="手动添加"
                onClick={() => {
                  setError("");
                  setStage("manual");
                }}
              />
            </div>
          )}

          {view === "privacy" && (
            <div style={sectionStyle}>
              <p style={{ margin: 0 }}>
                {state.demoMode
                  ? "演示模式不会上传任何内容，将返回预设的识别结果。"
                  : state.privacyNotice}
              </p>
              {!state.demoMode && !state.recognitionConfigured && (
                <NoticeBanner message="未配置识别服务密钥，无法真实识别。可在「我的」开启演示模式，或手动添加" />
              )}
              {method === "text" && (
                <label style={sectionStyle}>
                  <span
                    style={{
                      color: "var(--muted)",
                      fontSize: "var(--text-subtitle)",
                    }}
                  >
                    订单文字
                  </span>
                  <textarea
                    value={pastedText}
                    onChange={(event) => setPastedText(event.target.value)}
                    placeholder="在此粘贴订单文字"
                    rows={5}
                    style={{ ...fieldStyle, resize: "vertical" }}
                  />
                </label>
              )}
              <InkButton
                fullWidth
                disabled={busy}
                text={
                  method === "text" ? "同意并识别" : "同意并选择图片"
                }
                onClick={() => {
                  if (method === "text") {
                    void beginTextImport();
                  } else if (method === "camera") {
                    cameraInput.current?.click();
                  } else {
                    galleryInput.current?.click();
                  }
                }}
              />
              <InkButton
                fullWidth
                outline
                disabled={busy}
                text="返回"
                onClick={() => {
                  setError("");
                  setStage("choose");
                }}
              />
            </div>
          )}

          {view === "prepared" && (
            <div style={sectionStyle}>
              <p style={{ margin: 0 }}>
                {state.demoMode
                  ? "演示模式不会上传任何内容。"
                  : state.privacyNotice}
              </p>
              <InkButton
                fullWidth
                disabled={busy}
                text="同意并识别"
                onClick={() => void startRecognition(false)}
              />
              <InkButton
                fullWidth
                outline
                disabled={busy}
                text="放弃"
                onClick={closePanel}
              />
            </div>
          )}

          {view === ImportState.Recognizing && (
            <div
              style={{
                ...sectionStyle,
                justifyItems: "center",
                paddingBlock: "var(--gap-large)",
              }}
            >
              <span
                className="import-spinner"
                role="status"
                aria-label="正在识别"
              />
              <p style={{ margin: 0, color: "var(--muted)" }}>
                {state.demoMode
                  ? "正在读取预设识别结果"
                  : "正在识别，请稍候"}
              </p>
              <InkButton outline text="取消" onClick={closePanel} />
            </div>
          )}

          {view === ImportState.Duplicate && (
            <div style={sectionStyle}>
              <NoticeBanner message="这些图片或文字与之前的导入相同。仍要识别并入库吗？" />
              <InkButton
                fullWidth
                disabled={busy}
                text="仍然识别"
                onClick={() => void startRecognition(true)}
              />
              <InkButton
                fullWidth
                outline
                disabled={busy}
                text="跳过"
                onClick={() => void skipDuplicate()}
              />
            </div>
          )}

          {view === ImportState.Failed && (
            <div style={sectionStyle}>
              <NoticeBanner
                message={`${status.importError || "识别失败。"}可以重试，或改为手动添加`}
              />
              <InkButton
                fullWidth
                disabled={busy}
                text="重试"
                onClick={() => void startRecognition(false)}
              />
              <InkButton
                fullWidth
                outline
                disabled={busy}
                text="改为手动添加"
                onClick={() => void discardToManual()}
              />
            </div>
          )}

          {view === "manual" && (
            <div style={sectionStyle}>
              <label style={sectionStyle}>
                <span style={{ color: "var(--muted)", fontSize: "var(--text-subtitle)" }}>
                  食材名称
                </span>
                <input
                  value={manualName}
                  disabled={busy}
                  autoComplete="off"
                  placeholder="食材名称"
                  style={fieldStyle}
                  onChange={(event) => setManualName(event.target.value)}
                />
              </label>
              <label style={sectionStyle}>
                <span style={{ color: "var(--muted)", fontSize: "var(--text-subtitle)" }}>
                  数量
                </span>
                <input
                  value={manualQuantity}
                  disabled={busy}
                  autoComplete="off"
                  placeholder="数量原值，如 500g"
                  style={fieldStyle}
                  onChange={(event) => setManualQuantity(event.target.value)}
                />
              </label>
              <label style={sectionStyle}>
                <span style={{ color: "var(--muted)", fontSize: "var(--text-subtitle)" }}>
                  存放位置
                </span>
                <select
                  value={manualLocation}
                  disabled={busy}
                  style={fieldStyle}
                  onChange={(event) => setManualLocation(event.target.value)}
                >
                  {locationOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <InkButton
                fullWidth
                disabled={busy}
                text={busy ? "添加中…" : "添加食材"}
                onClick={() => void addManualItem()}
              />
            </div>
          )}

          {view === ImportState.Draft && (
            <div style={{ display: "grid", gap: "var(--gap-small)" }}>
              <p style={{ margin: 0, color: "var(--muted)" }}>
                识别出 {status.draftFoodCount} 项食材 · 核对后入库
              </p>
              <p
                style={{
                  margin: 0,
                  color: "var(--muted)",
                  fontSize: "var(--text-meta)",
                }}
              >
                确认入库会接受下列每项当前显示的保质期估计；可先修改天数和日期，不会逐项询问。
              </p>
              {status.draftWarning && (
                <NoticeBanner message={status.draftWarning} />
              )}
              {status.draftDuplicate && (
                <NoticeBanner message="疑似重复导入：确认入库将再次添加这些食材" />
              )}
              {status.importError && (
                <NoticeBanner message={status.importError} />
              )}

              <section style={sectionStyle}>
                <h3 style={groupHeadingStyle}>食材 · {foods.length} 项</h3>
                {foods.length === 0 ? (
                  <p style={{ margin: 0, color: "var(--muted)" }}>暂无食材</p>
                ) : (
                  foods.map((item) => (
                    <DraftItemCard
                      key={item.index}
                      item={item}
                      disabled={busy}
                      onEdit={(index, edits) =>
                        void editDraft(index, edits)
                      }
                      onMove={(index, group) =>
                        void moveDraft(index, group)
                      }
                      onIgnore={(index) =>
                        void moveDraft(index, "ignored")
                      }
                    />
                  ))
                )}
              </section>

              <section style={sectionStyle}>
                <h3 style={groupHeadingStyle}>
                  常备调料 · {seasonings.length} 项
                </h3>
                {seasonings.length === 0 ? (
                  <p style={{ margin: 0, color: "var(--muted)" }}>
                    没有识别出调料
                  </p>
                ) : (
                  <ul style={sectionStyle}>
                    {seasonings.map((item) => (
                      <DraftItemRow
                        key={item.index}
                        item={item}
                        disabled={busy}
                        onMove={(index, group) =>
                          void moveDraft(index, group)
                        }
                      />
                    ))}
                  </ul>
                )}
              </section>

              <section style={sectionStyle}>
                <h3 style={groupHeadingStyle}>
                  已忽略 · {ignored.length} 项
                </h3>
                {ignored.length === 0 ? (
                  <p style={{ margin: 0, color: "var(--muted)" }}>
                    没有忽略项
                  </p>
                ) : (
                  <ul style={sectionStyle}>
                    {ignored.map((item) => (
                      <DraftItemRow
                        key={item.index}
                        item={item}
                        disabled={busy}
                        onMove={(index, group) =>
                          void moveDraft(index, group)
                        }
                      />
                    ))}
                  </ul>
                )}
              </section>

              <div
                style={{
                  position: "sticky",
                  bottom: 0,
                  zIndex: 1,
                  paddingBlock: "var(--gap-small)",
                  background: "var(--card)",
                }}
              >
                {status.draftDuplicate && (
                  <InkButton
                    fullWidth
                    outline
                    disabled={busy}
                    text="跳过"
                    onClick={() => void skipDuplicate()}
                  />
                )}
                <InkButton
                  fullWidth
                  titleStyle
                  disabled={busy}
                  text={`${status.draftDuplicate ? "仍然入库" : "确认入库"} · ${status.draftFoodCount} 项食材`}
                  onClick={() => void confirmDraft()}
                />
              </div>
            </div>
          )}
        </div>
      </BottomSheet>
    </>
  );
}
