import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
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
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Icon } from "../components/Icon";
import { InkButton } from "../components/InkButton";
import { NoticeBanner } from "../components/NoticeBanner";

type Stage = "choose" | "privacy" | "manual";
type ImportMethod = "gallery" | "camera" | "text";
type DiscardKind = "draft" | "recognizing";

interface ImportFlowPageProps {
  open: boolean;
}

const locationOptions = [
  { value: "冷藏", label: "冷藏" },
  { value: "冷冻", label: "冷冻" },
  { value: "常温", label: "常温" },
] as const;

const dateFields = [
  { key: "packageExpiresAt", label: "包装到期" },
  { key: "purchasedAt", label: "购买" },
  { key: "storedAt", label: "入库" },
  { key: "producedAt", label: "生产" },
] as const;

type DateField = (typeof dateFields)[number]["key"];

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

const methodLabels: Record<ImportMethod, string> = {
  gallery: "相册截图 · 可多选",
  camera: "拍购物小票",
  text: "粘贴订单文字",
};

function sheetCopy(
  view: ImportStatusDto["importState"] | Stage,
  method: ImportMethod,
  status: ImportStatusDto,
  demoMode: boolean,
): { heading: string; subtitle: string } {
  switch (view) {
    case "choose":
      return { heading: "入库", subtitle: "选择入库方式" };
    case "privacy":
      return { heading: "上传前请确认", subtitle: methodLabels[method] };
    case "prepared":
      return { heading: "上传前请确认", subtitle: "上次的导入还没开始识别" };
    case "recognizing":
      return {
        heading: "识别中",
        subtitle: demoMode ? "正在读取预设识别结果" : "正在识别，请稍候",
      };
    case "duplicate":
      return {
        heading: "疑似重复导入",
        subtitle: "这些图片或文字与之前的导入相同",
      };
    case "failed":
      return {
        heading: status.importError ? "识别失败" : "没有识别出食材",
        subtitle: "可以重试，或改为手动添加",
      };
    case "manual":
      return { heading: "手动添加", subtitle: "记下一件食材" };
    case "draft":
      return {
        heading: "确认入库",
        subtitle: `识别出 ${status.draftFoodCount} 项食材，核对后入库`,
      };
    default:
      return { heading: "入库", subtitle: "" };
  }
}

function discardKind(status: ImportStatusDto): DiscardKind | null {
  if (status.importState === ImportState.Draft) {
    return "draft";
  }
  if (status.importState === ImportState.Recognizing) {
    return "recognizing";
  }
  return null;
}

function srcLine(item: DraftItemDto): ReactNode {
  const prefix = item.aiClassified ? "AI 归类 · " : "";
  let tail: ReactNode;
  if (item.needsShelfLife) {
    tail = <b className="need">待录保质期</b>;
  } else if (item.needsDate) {
    tail = <b className="need">需填写日期</b>;
  } else if (item.source === "package" && item.expiryDate) {
    const day = /^\d{4}-(\d{2}-\d{2})$/.exec(item.expiryDate)?.[1];
    tail = <b className="pkg">{day ?? item.expiryDate} 到期 · 包装标注</b>;
  } else if (item.shelfDays) {
    const basis =
      item.source === "ai"
        ? "AI 估计"
        : item.source === "user"
          ? "你的设置"
          : `${sourceLabel(item.source)} · 估计`;
    tail = <b>保质 {item.shelfDays} 天 · {basis}</b>;
  } else {
    tail = sourceLabel(item.source);
  }
  return (
    <>
      {prefix}
      {tail}
    </>
  );
}

function useSyncedState<T>(value: T) {
  const [current, setCurrent] = useState(value);
  useEffect(() => setCurrent(value), [value]);
  return [current, setCurrent] as const;
}

function blurOnEnter(event: KeyboardEvent<HTMLInputElement>) {
  if (event.key === "Enter") {
    event.currentTarget.blur();
  }
}

const compactButton: CSSProperties = {
  minHeight: 34,
  padding: "0 10px",
  fontSize: 13,
};

interface DraftFoodRowProps {
  item: DraftItemDto;
  expanded: boolean;
  moveDisabled: boolean;
  onToggle: () => void;
  onEdit: (index: number, edits: ItemEdits) => void;
  onMove: (index: number, group: DraftItemGroup) => void;
}

function DraftFoodRow({
  item,
  expanded,
  moveDisabled,
  onToggle,
  onEdit,
  onMove,
}: DraftFoodRowProps) {
  const editorId = useId();
  const [name, setName] = useSyncedState(item.name);
  const [quantity, setQuantity] = useSyncedState(item.quantity);
  const [location, setLocation] = useSyncedState(item.location);
  const [shelfDays, setShelfDays] = useSyncedState(item.shelfDays);
  const [packageExpiresAt, setPackageExpiresAt] = useSyncedState(
    item.packageExpiresAt,
  );
  const [purchasedAt, setPurchasedAt] = useSyncedState(item.purchasedAt);
  const [storedAt, setStoredAt] = useSyncedState(item.storedAt);
  const [producedAt, setProducedAt] = useSyncedState(item.producedAt);
  const dates: Record<
    DateField,
    readonly [string, (value: string) => void]
  > = {
    packageExpiresAt: [packageExpiresAt, setPackageExpiresAt],
    purchasedAt: [purchasedAt, setPurchasedAt],
    storedAt: [storedAt, setStoredAt],
    producedAt: [producedAt, setProducedAt],
  };

  const commitText = (
    key: "name" | "quantity" | "shelfDays",
    value: string,
    setValue: (value: string) => void,
  ) => {
    const next = value.trim();
    if (key === "name" && !next) {
      setValue(item.name);
      return;
    }
    setValue(next);
    if (next !== item[key]) {
      onEdit(item.index, { [key]: next });
    }
  };

  const expiryText =
    item.source === "package" && item.expiryDate
      ? `包装到期：${item.expiryDate}`
      : `${item.startDate ? `从${startBasisLabel(item.startBasis)} ${item.startDate} 起算 · ` : ""}预计到期：${item.expiryDate || "暂无法估计"}`;

  return (
    <li className="ing" data-expanded={expanded || undefined}>
      <div className="ing__row">
        <button
          type="button"
          className="ing__toggle"
          aria-expanded={expanded}
          aria-controls={expanded ? editorId : undefined}
          aria-label={`${item.name}，点按修改`}
          onClick={onToggle}
        >
          <CategoryDot category={item.category} />
          <span className="ing__main">
            <span className="ing__name">{item.name}</span>
            <span className="ing__src">{srcLine(item)}</span>
          </span>
        </button>
        <label className="field field--qty">
          <span className="field__sizer" data-value={quantity || "数量"}>
            <input
              aria-label={`${item.name}的数量`}
              size={1}
              value={quantity}
              placeholder="数量"
              enterKeyHint="done"
              autoComplete="off"
              onChange={(event) => setQuantity(event.target.value)}
              onBlur={() => commitText("quantity", quantity, setQuantity)}
              onKeyDown={blurOnEnter}
            />
          </span>
          <Icon name="pencil" size={14} color="var(--muted)" />
        </label>
        <label className="field field--loc">
          <span>{location}</span>
          <Icon name="chevron-down" size={14} color="currentColor" />
          <select
            className="field__select"
            aria-label={`${item.name}的存放位置`}
            value={location}
            onChange={(event) => {
              const next = event.target.value;
              setLocation(next);
              if (next !== item.location) {
                onEdit(item.index, { location: next });
              }
            }}
          >
            {locationOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {expanded && (
        <div className="ing__editor" id={editorId}>
          <label className="draft-field">
            <span>名称</span>
            <input
              className="field-input"
              aria-label={`${item.name}的名称`}
              value={name}
              enterKeyHint="done"
              autoComplete="off"
              onChange={(event) => setName(event.target.value)}
              onBlur={() => commitText("name", name, setName)}
              onKeyDown={blurOnEnter}
            />
          </label>
          {item.shelfLifeNote && (
            <p className="ing__note">{item.shelfLifeNote}</p>
          )}
          <p className="ing__note ing__note--ink">{expiryText}</p>
          {item.needsDate && (
            <p className="ing__note ing__note--warn">
              日期写法需要拍摄日期才能换算，请填写具体日期
            </p>
          )}
          <div className="ing__fields">
            <label className="draft-field">
              <span>保质天数</span>
              <input
                className="field-input"
                type="number"
                min="1"
                step="1"
                inputMode="numeric"
                enterKeyHint="done"
                aria-label={`${item.name}的保质天数`}
                value={shelfDays}
                placeholder="包装标注可留空"
                onChange={(event) => setShelfDays(event.target.value)}
                onBlur={() => commitText("shelfDays", shelfDays, setShelfDays)}
                onKeyDown={blurOnEnter}
              />
            </label>
            {dateFields.map((field) => {
              const [value, setValue] = dates[field.key];
              return (
                <label key={field.key} className="draft-field">
                  <span>{field.label}</span>
                  <input
                    className="field-input"
                    type="date"
                    aria-label={`${item.name}的${field.label}日期`}
                    value={value}
                    onChange={(event) => setValue(event.target.value)}
                    onBlur={() => {
                      if (value !== item[field.key]) {
                        onEdit(item.index, { [field.key]: value });
                      }
                    }}
                  />
                </label>
              );
            })}
          </div>
          <div className="ing__actions">
            <InkButton
              outline
              text="移入调料"
              disabled={moveDisabled}
              style={{ flex: 1, minHeight: 40, padding: "0 12px" }}
              onClick={() => onMove(item.index, "seasoning")}
            />
            <InkButton
              outline
              text="移入已忽略"
              disabled={moveDisabled}
              style={{ flex: 1, minHeight: 40, padding: "0 12px" }}
              onClick={() => onMove(item.index, "ignored")}
            />
          </div>
        </div>
      )}
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
    setDemoMode,
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
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const [ignoredOpen, setIgnoredOpen] = useState(false);
  const [discardAsk, setDiscardAsk] = useState<DiscardKind | null>(null);

  const galleryInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  const busyToken = useRef(0);
  const statusRef = useRef(status);
  const requestSequence = useRef(0);
  const suppressAutoOpen = useRef(false);
  const previousOpen = useRef(open);
  const openRef = useRef(open);
  openRef.current = open;
  const editQueue = useRef<Promise<void>>(Promise.resolve());
  const pendingEdits = useRef(0);
  const editFailed = useRef(false);
  const editEpoch = useRef(0);
  const editSequence = useRef(0);
  const [editRevision, setEditRevision] = useState(0);
  const allowClose = useRef(false);
  const discardAskRef = useRef(discardAsk);
  discardAskRef.current = discardAsk;

  const commitStatus = useCallback((next: ImportStatusDto) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  const runStatusAction = useCallback(
    async (
      request: (isCurrent: () => boolean) => Promise<ImportStatusDto>,
      fallback: string,
    ): Promise<ImportStatusDto | null> => {
      if (busyRef.current) {
        return null;
      }
      const sequence = ++requestSequence.current;
      const token = ++busyToken.current;
      busyRef.current = true;
      setBusy(true);
      setError("");
      try {
        const next = await request(() => token === busyToken.current);
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
        if (token === busyToken.current) {
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
    ++busyToken.current;
    ++editEpoch.current;
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
      if (busyRef.current || pendingEdits.current > 0) {
        return;
      }
      const sequence = ++requestSequence.current;
      const editMark = editSequence.current;
      try {
        const next = await api.importStatus();
        if (
          active &&
          sequence === requestSequence.current &&
          editMark === editSequence.current &&
          pendingEdits.current === 0
        ) {
          commitStatus(next);
        }
      } catch {
        // The next poll retries without interrupting an active import.
      }
    };
    void poll();
    const timer = window.setInterval(() => {
      if (openRef.current || statusRef.current.importState !== ImportState.Idle) {
        void poll();
      }
    }, 1_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        void poll();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [commitStatus]);

  const closePanel = useCallback(() => {
    allowClose.current = true;
    suppressAutoOpen.current = true;
    closeImport();
  }, [closeImport]);

  const requestClose = useCallback(() => {
    if (discardAskRef.current) {
      return;
    }
    const kind = discardKind(statusRef.current);
    if (kind) {
      setDiscardAsk(kind);
    } else {
      closePanel();
    }
  }, [closePanel]);

  useEffect(() => {
    if (!previousOpen.current && open) {
      allowClose.current = false;
    }
    if (previousOpen.current && !open) {
      const deliberate = allowClose.current;
      allowClose.current = false;
      const kind = discardKind(statusRef.current);
      if (!deliberate && kind) {
        // Browser Back on unsaved work: reopen and ask instead of discarding.
        openImport();
        setDiscardAsk(kind);
      } else {
        setStage("choose");
        setExpandedIndex(null);
        setIgnoredOpen(false);
        setDiscardAsk(null);
        setPastedText("");
        setManualName("");
        setManualQuantity("");
        setManualLocation("冷藏");
        cancelInBackground();
      }
    }
    previousOpen.current = open;
  }, [open, openImport, cancelInBackground]);

  useEffect(() => {
    if (status.importState === ImportState.Idle) {
      suppressAutoOpen.current = false;
      setStage((current) => (current === "manual" ? current : "choose"));
      return;
    }
    if (!suppressAutoOpen.current) {
      openImport();
    }
  }, [status.importState, openImport]);

  useEffect(() => {
    if (discardAsk && discardKind(status) !== discardAsk) {
      setDiscardAsk(discardKind(status));
    }
  }, [discardAsk, status]);

  useEffect(() => {
    if (
      expandedIndex !== null &&
      status.draftItems[expandedIndex]?.group !== "food"
    ) {
      setExpandedIndex(null);
    }
  }, [expandedIndex, status.draftItems]);

  const editDraft = useCallback(
    (index: number, edits: ItemEdits) => {
      const epoch = editEpoch.current;
      pendingEdits.current += 1;
      editQueue.current = editQueue.current.then(async () => {
        try {
          if (epoch !== editEpoch.current) {
            return;
          }
          const sequence = ++editSequence.current;
          try {
            const next = await api.editDraftItem({ index, edits });
            if (
              epoch === editEpoch.current &&
              sequence === editSequence.current &&
              !busyRef.current
            ) {
              commitStatus(next);
            }
          } catch (requestError) {
            editFailed.current = true;
            if (epoch === editEpoch.current) {
              setEditRevision((revision) => revision + 1);
              notify(errorMessage(requestError, "无法保存草稿修改，请重试"));
            }
          }
        } finally {
          pendingEdits.current -= 1;
        }
      });
    },
    [commitStatus, notify],
  );

  const flushEdits = async (): Promise<boolean> => {
    // A tap on a button may not blur the focused field on every mobile browser.
    const active = document.activeElement;
    if (active instanceof HTMLInputElement) {
      active.blur();
    }
    await editQueue.current;
    const ok = !editFailed.current;
    editFailed.current = false;
    return ok;
  };

  const startRecognition = async (allowDuplicate: boolean) => {
    const before = statusRef.current;
    const optimistic = {
      ...before,
      importState: ImportState.Recognizing,
      importError: "",
    };
    commitStatus(optimistic);
    const result = await runStatusAction(
      () =>
        api.startImport({
          privacyConfirmed: true,
          allowDuplicate,
        }),
      "无法开始识别，请稍后重试",
    );
    if (result === null && statusRef.current === optimistic) {
      commitStatus(before);
    }
  };

  // The privacy step already asked for consent, so a fresh upload goes
  // straight to recognition (app-model.cpp:202-213).
  const receiveAndStart = async (
    receive: () => Promise<ImportStatusDto>,
    fallback: string,
  ) => {
    const before = statusRef.current;
    const optimistic = {
      ...before,
      importState: ImportState.Recognizing,
      importError: "",
    };
    commitStatus(optimistic);
    const epoch = editEpoch.current;
    const result = await runStatusAction(async (isCurrent) => {
      const received = await receive();
      if (!isCurrent() || epoch !== editEpoch.current) {
        suppressAutoOpen.current = true;
        await api.cancelImport().catch(() => undefined);
        return received;
      }
      return received.importState === ImportState.Prepared
        ? api.startImport({ privacyConfirmed: true, allowDuplicate: false })
        : received;
    }, fallback);
    if (result === null && statusRef.current === optimistic) {
      commitStatus(before);
    }
  };

  const beginTextImport = async () => {
    const text = pastedText.trim();
    if (!text) {
      setError("请先粘贴订单文字");
      return;
    }
    await receiveAndStart(
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
    await receiveAndStart(async () => {
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

  const moveDraft = async (index: number, group: DraftItemGroup) => {
    if (busyRef.current || !(await flushEdits())) {
      return;
    }
    if (group === "ignored") {
      await runStatusAction(
        () => api.dropDraftItem({ index }),
        "无法忽略该项，请重试",
      );
      return;
    }
    if (statusRef.current.draftItems[index]?.group === "ignored") {
      const retrieved = await runStatusAction(
        () => api.retrieveDraftItem({ index }),
        "无法找回该项，请重试",
      );
      if (!retrieved) {
        return;
      }
    }
    await runStatusAction(
      () => api.setDraftCategory({ index, category: group }),
      "无法移动该项，请重试",
    );
  };

  const confirmDraft = async () => {
    if (busyRef.current || !(await flushEdits())) {
      return;
    }
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
    if (busyRef.current || !(await flushEdits())) {
      return;
    }
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
    const token = ++busyToken.current;
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
      setManualName("");
      setManualQuantity("");
      setManualLocation("冷藏");
      await refresh();
      notify("已加入冰箱");
      closePanel();
    } catch (requestError) {
      setError(errorMessage(requestError, "添加失败，请稍后重试"));
    } finally {
      if (token === busyToken.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };

  const view =
    status.importState === ImportState.Idle
      ? stage
      : status.importState;
  const isDraft = view === ImportState.Draft;
  const copy = sheetCopy(view, method, status, state.demoMode);
  const foods = status.draftItems.filter((item) => item.group === "food");
  const seasonings = status.draftItems.filter(
    (item) => item.group === "seasoning",
  );
  const ignored = status.draftItems.filter((item) => item.group === "ignored");

  const onMaskClick = () => {
    const typing =
      (view === "privacy" && method === "text" && pastedText.trim() !== "") ||
      (view === "manual" &&
        (manualName !== "" || manualQuantity !== "" || manualLocation !== "冷藏"));
    if (!typing) {
      requestClose();
    }
  };

  const draftFooter = isDraft ? (
    <>
      {status.draftDuplicate && (
        <InkButton
          fullWidth
          outline
          text="跳过"
          disabled={busy}
          style={{ minHeight: 44 }}
          onClick={() => void skipDuplicate()}
        />
      )}
      <InkButton
        fullWidth
        titleStyle
        iconName="check"
        iconSize={22}
        className="ink-button--stitched"
        disabled={busy}
        text={`${status.draftDuplicate ? "仍然入库" : "确认入库"} · ${status.draftFoodCount} 项食材`}
        style={{
          height: 52,
          minHeight: 52,
          padding: "0 16px",
          gap: 6,
          letterSpacing: 3,
          boxShadow: "var(--shadow-one)",
        }}
        onClick={() => void confirmDraft()}
      />
    </>
  ) : undefined;

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
        heading={copy.heading}
        subtitle={copy.subtitle}
        tapeText={isDraft ? "识别结果" : "入库"}
        sheetHeight={744}
        footer={draftFooter}
        onClose={requestClose}
        onMaskClick={onMaskClick}
      >
        <div
          className="sheet-stack"
          style={isDraft ? undefined : { paddingInline: 2 }}
        >
          {error && <NoticeBanner message={error} />}

          {view === "choose" && (
            <div className="sheet-stack" style={{ gap: "var(--gap-small)" }}>
              <InkButton
                fullWidth
                iconName="photo"
                text={methodLabels.gallery}
                onClick={() => {
                  setError("");
                  setMethod("gallery");
                  setStage("privacy");
                }}
              />
              <InkButton
                fullWidth
                outline
                iconName="receipt"
                text={methodLabels.camera}
                onClick={() => {
                  setError("");
                  setMethod("camera");
                  setStage("privacy");
                }}
              />
              <InkButton
                fullWidth
                outline
                iconName="clipboard-text"
                text={methodLabels.text}
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
            <div className="sheet-stack" style={{ gap: "var(--gap-small)" }}>
              <p className="sheet-message">
                {state.demoMode
                  ? "演示模式不会上传任何内容，将返回预设的识别结果。"
                  : state.privacyNotice}
              </p>
              {!state.demoMode && !state.recognitionConfigured && (
                <NoticeBanner
                  message="未配置识别服务密钥，无法真实识别。可开启演示模式，或手动添加"
                  actionText="开启演示模式"
                  onAction={() => void setDemoMode(true)}
                />
              )}
              {method === "text" && (
                <label className="draft-field">
                  <span>订单文字</span>
                  <textarea
                    className="field-input"
                    value={pastedText}
                    onChange={(event) => setPastedText(event.target.value)}
                    placeholder="在此粘贴订单文字"
                    rows={5}
                  />
                </label>
              )}
              <InkButton
                fullWidth
                disabled={
                  busy || (!state.demoMode && !state.recognitionConfigured)
                }
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
            <div className="sheet-stack" style={{ gap: "var(--gap-small)" }}>
              <p className="sheet-message">
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
              className="sheet-stack"
              style={{ justifyItems: "center", paddingBlock: "var(--gap-large)" }}
            >
              <span
                className="import-spinner"
                role="status"
                aria-label="正在识别"
              />
              <InkButton outline text="取消" onClick={closePanel} />
            </div>
          )}

          {view === ImportState.Duplicate && (
            <div className="sheet-stack" style={{ gap: "var(--gap-small)" }}>
              <p className="sheet-message">仍要识别并入库吗？</p>
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
            <div className="sheet-stack" style={{ gap: "var(--gap-small)" }}>
              {status.importError && (
                <NoticeBanner message={status.importError} />
              )}
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
            <form
              className="sheet-stack"
              style={{ gap: "var(--gap-small)" }}
              onSubmit={(event) => {
                event.preventDefault();
                void addManualItem();
              }}
            >
              <label className="draft-field">
                <span>食材名称</span>
                <input
                  className="field-input"
                  value={manualName}
                  autoComplete="off"
                  enterKeyHint="next"
                  placeholder="食材名称"
                  onChange={(event) => setManualName(event.target.value)}
                />
              </label>
              <label className="draft-field">
                <span>数量</span>
                <input
                  className="field-input"
                  value={manualQuantity}
                  autoComplete="off"
                  enterKeyHint="done"
                  placeholder="数量原值，如 500g"
                  onChange={(event) => setManualQuantity(event.target.value)}
                />
              </label>
              <label className="draft-field">
                <span>存放位置</span>
                <select
                  className="field-input"
                  value={manualLocation}
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
                type="submit"
                fullWidth
                disabled={busy}
                text={busy ? "添加中…" : "添加食材"}
              />
            </form>
          )}

          {isDraft && (
            <div>
              {status.draftWarning && (
                <NoticeBanner message={status.draftWarning} />
              )}
              {status.draftDuplicate && (
                <NoticeBanner message="疑似重复导入：确认入库将再次添加这些食材" />
              )}
              {status.importError && (
                <NoticeBanner message={status.importError} />
              )}

              <section>
                <h3
                  className="group-title"
                  aria-label={`食材 · ${foods.length} 项`}
                >
                  食材<span className="n">{foods.length} 项 · 点击可修改</span>
                </h3>
                {foods.length === 0 ? (
                  <p className="group-empty">暂无食材</p>
                ) : (
                  <ul>
                    {foods.map((item) => (
                      <DraftFoodRow
                        key={`${item.index}:${editRevision}`}
                        item={item}
                        expanded={expandedIndex === item.index}
                        moveDisabled={busy}
                        onToggle={() =>
                          setExpandedIndex((current) =>
                            current === item.index ? null : item.index,
                          )
                        }
                        onEdit={editDraft}
                        onMove={(index, group) =>
                          void moveDraft(index, group)
                        }
                      />
                    ))}
                  </ul>
                )}
              </section>

              {seasonings.length > 0 && (
                <section>
                  <h3
                    className="group-title"
                    aria-label={`常备调料 · ${seasonings.length} 项`}
                  >
                    调料
                    <span className="n">
                      {seasonings.length} 项 · 更新常备调料
                    </span>
                  </h3>
                  <div className="seas">
                    {seasonings.map((item) => (
                      <button
                        key={item.index}
                        type="button"
                        className="chip chip--sel"
                        aria-label={`${item.name}，移入已忽略`}
                        disabled={busy}
                        onClick={() => void moveDraft(item.index, "ignored")}
                      >
                        <span className="box">
                          <Icon name="check" size={13} color="#fff" />
                        </span>
                        {item.name}
                        {item.needsShelfLife && <small>待录保质期</small>}
                      </button>
                    ))}
                  </div>
                </section>
              )}

              {ignored.length > 0 && (
                <section>
                  <button
                    type="button"
                    className="ignored"
                    aria-expanded={ignoredOpen}
                    aria-label={`已忽略 · ${ignored.length} 项`}
                    onClick={() => setIgnoredOpen((current) => !current)}
                  >
                    已忽略 {ignored.length} 项
                    <span className="ignored__hint">
                      {ignored.map((item) => item.name).join("、")}
                    </span>
                    <Icon name="chevron-down" size={20} />
                  </button>
                  {ignoredOpen && (
                    <ul className="ignored-list">
                      {ignored.map((item) => (
                        <li key={item.index}>
                          <CategoryDot category={item.category} />
                          <span className="name">{item.name}</span>
                          {item.quantity && (
                            <span className="qty">{item.quantity}</span>
                          )}
                          <InkButton
                            outline
                            className="ink-button--compact"
                            text="移入食材"
                            disabled={busy}
                            style={compactButton}
                            onClick={() => void moveDraft(item.index, "food")}
                          />
                          <InkButton
                            outline
                            className="ink-button--compact"
                            text="移入调料"
                            disabled={busy}
                            style={compactButton}
                            onClick={() =>
                              void moveDraft(item.index, "seasoning")
                            }
                          />
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              )}

              <p className="draft-note">
                确认入库会接受以上每项当前显示的保质期估计；可先修改天数和日期，不会逐项询问。
              </p>
            </div>
          )}
        </div>
      </BottomSheet>
      <ConfirmDialog
        open={discardAsk !== null}
        destructive
        message={
          discardAsk === "draft"
            ? "放弃这次识别结果？已识别的食材不会入库。"
            : "停止识别并关闭？"
        }
        confirmText={discardAsk === "draft" ? "放弃" : "停止识别"}
        cancelText={discardAsk === "draft" ? "继续核对" : "继续识别"}
        onConfirm={() => {
          setDiscardAsk(null);
          closePanel();
        }}
        onCancel={() => setDiscardAsk(null)}
      />
    </>
  );
}
