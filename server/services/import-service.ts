import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { abortError, isAbortError } from "../ai/chat-client.js";
import { IngredientClassifier } from "../ai/ingredient-classifier.js";
import { CapturedAtSource } from "../import/captured-at.js";
import {
  CategoryCode,
  DateOrigin,
  ImportState,
  ImportStatus,
  ItemStatus,
  Storage,
  StorageSource,
} from "../../shared/enums.js";
import type {
  DraftItemDto,
  DraftItemGroup,
  ImportStatusDto,
  ItemEdits,
} from "../../shared/api.js";
import type { BuiltinData } from "../data/builtin.js";
import type {
  FridgeItem,
  ImportRecord,
  RecordedDate,
} from "../data/store.js";
import { needsShelfLife, Store } from "../data/store.js";
import type { Clock } from "../domain/clock.js";
import { classifyItemKind } from "../domain/fridge-groups.js";
import {
  DuplicateCheck,
  checkSameImage,
  checkSimilarItems,
  type ImportItem,
} from "../domain/import-duplicates.js";
import {
  suggestionsAfterPurchase,
  PantryRules,
} from "../domain/pantry.js";
import { totalAmount } from "../domain/quantity.js";
import {
  JobState,
  ResumableJob,
} from "../domain/resumable-job.js";
import {
  resolveShelfLife,
  suggestStorage,
  type StorageDays,
} from "../domain/shelf-life.js";
import {
  importEmptyInput,
  importMayBeIncomplete,
  importNeedsBaseDate,
  importNothingToConfirm,
  uploadPrivacyNotice,
} from "../domain/texts.js";
import {
  parseDateText,
  type DateParse,
} from "../domain/date-text.js";
import {
  nameKey,
  NameSource,
  resolveName,
  unresolvedNames,
  type NameMappingStore,
} from "../domain/vocabulary-resolver.js";
import {
  MAX_IMAGES_PER_IMPORT,
  MAX_IMAGE_BYTES,
  MAX_IMPORT_BYTES,
  type StoredImportFile,
} from "../import/import-files.js";
import {
  ErrorKind,
  InputKind,
  ItemCategory,
  makeRecognitionError,
  type RecognizedItem,
  type RecognitionError,
  type RecognitionRequest,
  type RecognitionResult,
  type Recognizer,
  type StorageKind,
} from "../recognition/types.js";
import {
  mergeResults,
  parseChatCompletion,
} from "../recognition/response-parser.js";

const UNCATEGORIZED_NAME = "未归类";

export interface ParsedDraftDate extends DateParse {
  text: string;
}

export interface DraftItem {
  recognized: RecognizedItem;
  item: FridgeItem;
  category: ItemCategory;
  selected: boolean;
  nameSource: NameSource;
  production: ParsedDraftDate;
  purchase: ParsedDraftDate;
  expiry: ParsedDraftDate;
  needsShelfLife: boolean;
}

export interface ImportDraft {
  record: ImportRecord;
  items: DraftItem[];
  duplicate: DuplicateCheck;
  ignoredSummary: string;
  warning: string;
  ready: boolean;
}

export interface ImportTextPayload {
  kind: "text";
  origin?: string;
  text: string;
}

export interface ImportImagesPayload {
  kind: "images";
  origin: "gallery" | "share" | "camera";
  images?: readonly StoredImportFile[];
  files?: readonly StoredImportFile[];
}

export type ImportPayload = ImportTextPayload | ImportImagesPayload;

export interface ImportServiceOptions {
  store: Store;
  builtin: BuiltinData;
  clock: Clock;
  recognizer: Recognizer;
  mappings?: NameMappingStore;
  classifier?: IngredientClassifier;
  classifierConfigured?: boolean;
  demo?: boolean;
  importsDirectory?: string;
}

interface ReceivedImage {
  path: string;
  sha256: string;
  mimeType: string;
  capturedAt: Date | null;
  capturedAtSource: string;
}

interface ActivePayload {
  kind: "text" | "images";
  origin: string;
  text: string;
  images: ReceivedImage[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRecognitionError(value: unknown): value is RecognitionError {
  return (
    isObject(value) &&
    Object.values(ErrorKind).includes(value.kind as ErrorKind) &&
    typeof value.userMessage === "string"
  );
}

function storageOf(kind: StorageKind): Storage | null {
  switch (kind) {
    case Storage.Fridge:
    case Storage.Freezer:
    case Storage.Room:
      return kind;
    default:
      return null;
  }
}

function displayDate(date: Date | null): string {
  if (!date || !Number.isFinite(date.getTime())) {
    return "";
  }
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function utcTimestamp(value: ImportRecord["createdAt"]): string {
  const date =
    value instanceof Date
      ? value
      : typeof value === "string"
        ? new Date(value)
        : null;
  return date && Number.isFinite(date.getTime())
    ? date.toISOString()
    : "";
}

function capturedAtSourceName(source: string): string {
  switch (source) {
    case CapturedAtSource.None:
      return "none";
    case CapturedAtSource.Camera:
      return "camera";
    case CapturedAtSource.Exif:
      return "exif";
    case CapturedAtSource.FileModified:
      return "file-modified";
    default:
      return source;
  }
}

function calendarDate(value: string | Date): { date: Date; text: string } | null {
  let year: number;
  let month: number;
  let day: number;
  if (typeof value === "string") {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value.trim());
    if (!match) {
      return null;
    }
    year = Number(match[1]);
    month = Number(match[2]);
    day = Number(match[3]);
  } else if (Number.isFinite(value.getTime())) {
    year = value.getFullYear();
    month = value.getMonth() + 1;
    day = value.getDate();
  } else {
    return null;
  }

  const date = new Date(year, month - 1, day, 12);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return { date, text: displayDate(date) };
}

function parsedDate(text: string, baseDate: string | null): ParsedDraftDate {
  return { ...parseDateText(text, baseDate), text: text.trim() };
}

function recordedDate(parsed: ParsedDraftDate): RecordedDate {
  return {
    date: parsed.date ?? null,
    origin: parsed.text.length > 0 ? DateOrigin.Visible : DateOrigin.None,
    text: parsed.text,
  };
}

function emptyDate(): RecordedDate {
  return { date: null, origin: DateOrigin.None, text: "" };
}

function dateNeedsBase(parsed: ParsedDraftDate, recorded: RecordedDate): boolean {
  return parsed.status === "needs_base_date" && !recorded.date;
}

function needsDateConfirmation(draft: DraftItem): boolean {
  return (
    dateNeedsBase(draft.production, draft.item.productionDate ?? emptyDate()) ||
    dateNeedsBase(draft.purchase, draft.item.purchaseDate ?? emptyDate()) ||
    dateNeedsBase(draft.expiry, draft.item.packageExpiry ?? emptyDate())
  );
}

function ignoredCount(draft: ImportDraft): number {
  return draft.items.reduce(
    (count, item) =>
      count + (item.category === ItemCategory.Irrelevant ? 1 : 0),
    0,
  );
}

function products(draft: ImportDraft): ImportItem[] {
  return draft.items
    .filter(
      (item) =>
        item.selected && item.category !== ItemCategory.Irrelevant,
    )
    .map(({ item }) => [
      item.canonicalName ?? "",
      `${(item.quantityText ?? "").trim()}\u001f${item.count ?? 1}`,
    ]);
}

function categoryCode(value: string | undefined): CategoryCode {
  const values = Object.values(CategoryCode);
  const candidate = value ?? "";
  return values.includes(candidate as CategoryCode)
    ? (candidate as CategoryCode)
    : CategoryCode.Other;
}

function storageLocation(storage: Storage | undefined): string {
  switch (storage) {
    case Storage.Freezer:
      return "冷冻";
    case Storage.Room:
      return "常温";
    default:
      return "冷藏";
  }
}

function storageFromEdit(value: string | undefined): Storage | null {
  switch (value?.trim()) {
    case "冷藏":
    case Storage.Fridge:
      return Storage.Fridge;
    case "冷冻":
    case Storage.Freezer:
      return Storage.Freezer;
    case "常温":
    case Storage.Room:
      return Storage.Room;
    default:
      return null;
  }
}

function sourceName(item: FridgeItem): string {
  switch (item.shelfLifeSource) {
    case "package":
      return "package";
    case "manual":
    case "local_rule":
      return "user";
    case "reference":
      return "reference";
    case "ai_estimate":
      return "ai";
    default:
      return "none";
  }
}

function draftGroup(item: DraftItem): DraftItemGroup {
  if (!item.selected || item.category === ItemCategory.Irrelevant) {
    return "ignored";
  }
  return item.category === ItemCategory.Seasoning ? "seasoning" : "food";
}

function setDate(
  current: RecordedDate | undefined,
  value: string | undefined,
): RecordedDate {
  const before = current ?? emptyDate();
  const text = value?.trim() ?? "";
  if (text.length === 0) {
    return emptyDate();
  }
  const parsed = calendarDate(text);
  if (!parsed || parsed.text === before.date) {
    return before;
  }
  return {
    date: parsed.text,
    origin: DateOrigin.User,
    text: parsed.text,
  };
}

function activeValuesFor(item: FridgeItem): Parameters<typeof resolveShelfLife>[0] {
  return {
    name: item.canonicalName ?? "",
    storage: item.storage,
    productionDate: item.productionDate?.date,
    purchaseDate: item.purchaseDate?.date,
    entryDate: item.entryDate,
    packageExpiry: item.packageExpiry?.date,
    labelledDays: item.labelledDays,
    manualDays: item.manualDays,
    aiDays: item.aiDays,
    referenceConditionsConfirmed: item.referenceConditionsConfirmed,
  };
}

function applyShelfLife(
  item: FridgeItem,
  resolution: ReturnType<typeof resolveShelfLife>,
): void {
  item.shelfLifeSource = resolution.source;
  item.shelfLifeDays = resolution.days;
  item.expiryDate = resolution.expiryDate;
  item.startBasis = resolution.startBasis;
  item.shelfLifeNote = resolution.note;
}

function aiDays(item: FridgeItem): StorageDays {
  return {
    fridge: item.aiDays?.fridge ?? null,
    freezer: item.aiDays?.freezer ?? null,
    room: item.aiDays?.room ?? null,
  };
}

export class ImportService {
  private readonly store: Store;
  private readonly builtin: BuiltinData;
  private readonly clock: Clock;
  private readonly recognizer: Recognizer;
  private readonly mappings: NameMappingStore | undefined;
  private readonly classifier: IngredientClassifier | undefined;
  private readonly classifierConfigured: boolean;
  private readonly demo: boolean;
  private readonly importsDirectory: string | null;

  private payload: ActivePayload | null = null;
  private received = false;
  private draftValue: ImportDraft | null = null;
  private importState: ImportState = ImportState.Idle;
  private failure: RecognitionError | null = null;
  private controller: AbortController | null = null;
  private requestSequence = 0;
  private jobId = 0;
  private job = new ResumableJob();
  private batchesReported = false;

  constructor({
    store,
    builtin,
    clock,
    recognizer,
    mappings,
    classifier,
    classifierConfigured,
    demo = false,
    importsDirectory,
  }: ImportServiceOptions) {
    this.store = store;
    this.builtin = builtin;
    this.clock = clock;
    this.recognizer = recognizer;
    this.mappings = mappings;
    this.classifier = classifier;
    this.classifierConfigured =
      classifierConfigured ?? classifier !== undefined;
    this.demo = demo;
    this.importsDirectory = importsDirectory
      ? resolve(importsDirectory)
      : null;
  }

  static privacyNotice(): string {
    return uploadPrivacyNotice();
  }

  get state(): ImportState {
    return this.importState;
  }

  get busy(): boolean {
    return this.controller !== null;
  }

  get lastError(): RecognitionError | null {
    return this.failure ? { ...this.failure } : null;
  }

  draft(): ImportDraft | null {
    return this.draftValue;
  }

  status(): ImportStatusDto {
    const draft = this.draftValue;
    return {
      importState: this.importState,
      importError: this.failure?.userMessage ?? "",
      draftItems: draft ? draft.items.map((item, index) => this.itemDto(item, index)) : [],
      draftWarning: draft?.warning ?? "",
      draftDuplicate: draft?.duplicate.isDuplicate() ?? false,
      draftFoodCount: draft
        ? draft.items.filter(
            (item) =>
              item.selected && item.category === ItemCategory.Food,
          ).length
        : 0,
    };
  }

  async receive(payload: ImportPayload): Promise<boolean> {
    if (this.received || (this.payload?.images.length ?? 0) > 0) {
      const incoming = payload.kind === "images"
        ? this.imagesFrom(payload).map((image) => image.path)
        : [];
      const active = new Set(
        (this.payload?.images ?? []).map((image) => resolve(image.path)),
      );
      const rejected = incoming.filter((path) => !active.has(resolve(path)));
      if (rejected.length > 0) {
        this.store.discardImportFiles(rejected);
      }
      return this.reject(
        ErrorKind.InvalidInput,
        "请先确认或放弃当前入库草稿，再重新导入",
      );
    }

    this.dropStoredJobs();
    this.jobId = 0;
    this.job = new ResumableJob();
    this.batchesReported = false;
    this.failure = null;
    const createdAt = this.clock.now();
    if (payload.kind === "text") {
      const value = payload.text.trim();
      if (value.length === 0) {
        return this.reject(ErrorKind.InvalidInput, importEmptyInput());
      }
      this.payload = {
        kind: "text",
        origin: payload.origin ?? "paste",
        text: payload.text,
        images: [],
      };
      this.draftValue = this.emptyDraft({
        createdAt,
        inputKind: InputKind.OrderText,
        origin: this.payload.origin,
        textLength: payload.text.length,
      });
      this.received = true;
      this.importState = ImportState.Prepared;
      return true;
    }

    const sourceImages = this.imagesFrom(payload);
    if (
      sourceImages.length === 0 ||
      sourceImages.length > MAX_IMAGES_PER_IMPORT
    ) {
      return this.reject(ErrorKind.InvalidInput, importEmptyInput());
    }

    let totalBytes = 0;
    const images: ReceivedImage[] = [];
    for (const image of sourceImages) {
      let info;
      try {
        info = await lstat(image.path);
      } catch {
        return this.reject(
          ErrorKind.InvalidInput,
          "无法读取导入图片，请重新选择",
        );
      }
      if (
        info.isSymbolicLink() ||
        !info.isFile() ||
        info.size <= 0 ||
        info.size > MAX_IMAGE_BYTES ||
        !this.directImportFile(image.path)
      ) {
        return this.reject(
          ErrorKind.InvalidInput,
          info.size > MAX_IMAGE_BYTES
            ? "图片超过 50 MB"
            : "无法读取导入图片，请重新选择",
        );
      }
      totalBytes += info.size;
      if (totalBytes > MAX_IMPORT_BYTES) {
        return this.reject(
          ErrorKind.InvalidInput,
          "图片总大小超过导入限制",
        );
      }

      let bytes: Buffer;
      try {
        bytes = await readFile(image.path);
      } catch {
        return this.reject(
          ErrorKind.InvalidInput,
          "无法读取导入图片，请重新选择",
        );
      }
      images.push({
        path: image.path,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        mimeType: image.mimeType,
        capturedAt: image.capturedAt
          ? new Date(image.capturedAt)
          : null,
        capturedAtSource: capturedAtSourceName(
          image.capturedAtSource,
        ),
      });
    }

    const inputKind =
      payload.origin === "camera"
        ? InputKind.Receipt
        : InputKind.Screenshot;
    this.payload = {
      kind: "images",
      origin: payload.origin,
      text: "",
      images,
    };
    this.draftValue = this.emptyDraft({
      createdAt,
      inputKind,
      origin: payload.origin,
      textLength: 0,
      images: images.map((image) => ({
        path: image.path,
        sha256: image.sha256,
        mimeType: image.mimeType,
        capturedAt: image.capturedAt,
        capturedAtSource: image.capturedAtSource,
      })),
    });
    this.draftValue.duplicate = checkSameImage(
      images.map((image) => image.sha256),
      this.store.importFingerprints(),
    );
    this.received = true;
    this.importState = this.draftValue.duplicate.isDuplicate()
      ? ImportState.Duplicate
      : ImportState.Prepared;
    return true;
  }

  async start(
    privacyConfirmed: boolean,
    allowDuplicate = false,
  ): Promise<boolean> {
    if (
      !this.received ||
      this.busy ||
      !this.payload ||
      !this.draftValue ||
      this.draftValue.ready
    ) {
      return this.reject(
        ErrorKind.InvalidInput,
        "当前不能开始识别",
      );
    }
    if (!privacyConfirmed) {
      return this.reject(
        ErrorKind.InvalidInput,
        "上传前需要你确认隐私提示",
        ImportState.Failed,
      );
    }
    if (
      this.draftValue.duplicate.isDuplicate() &&
      !allowDuplicate
    ) {
      this.importState = ImportState.Duplicate;
      return false;
    }

    if (
      this.payload.kind === "images" &&
      (this.payload.images.length === 0 ||
        this.draftValue.record.images?.length !==
          this.payload.images.length)
    ) {
      return this.reject(
        ErrorKind.InvalidInput,
        importEmptyInput(),
        ImportState.Failed,
      );
    }

    if (!this.recognitionRequest()) {
      return this.reject(
        ErrorKind.InvalidInput,
        importEmptyInput(),
        ImportState.Failed,
      );
    }

    if (this.payload.kind === "images") {
      this.job.start();
      if (this.jobId > 0) {
        this.saveJob();
      } else {
        this.jobId = this.store.insertImportJob(
          this.jobPayload(),
          this.job,
        );
      }
    }
    this.batchesReported = false;
    return this.runRecognition();
  }

  updateDraft(index: number, edits: ItemEdits): boolean {
    if (
      !this.ready() ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= (this.draftValue?.items.length ?? 0)
    ) {
      return false;
    }

    const draft = this.draftValue!;
    const next: DraftItem = {
      ...draft.items[index],
      item: { ...draft.items[index].item },
      recognized: draft.items[index].recognized,
      production: draft.items[index].production,
      purchase: draft.items[index].purchase,
      expiry: draft.items[index].expiry,
    };
    const before = draft.items[index].item;
    const item = next.item;
    item.id = undefined;
    item.importId = undefined;
    item.status = ItemStatus.InStock;

    if (typeof edits.name === "string") {
      const name = edits.name.trim();
      if (name.length > 0 && name !== item.displayName) {
        const canonical =
          this.builtin.catalog.resolve(name) || UNCATEGORIZED_NAME;
        item.displayName = name;
        if (canonical !== item.canonicalName) {
          item.canonicalName = canonical;
          next.nameSource = NameSource.UserEdited;
          item.aiDays = {};
          item.referenceConditionsConfirmed = false;
        }
        item.category = this.builtin.catalog.categoryOf(canonical);
      }
    }
    if (typeof edits.quantity === "string") {
      item.quantityText = edits.quantity.trim();
    }
    if (typeof edits.location === "string") {
      const storage = storageFromEdit(edits.location);
      if (storage && storage !== before.storage) {
        item.storage = storage;
        item.manualDays = null;
        item.referenceConditionsConfirmed = false;
      }
    }
    if (typeof edits.shelfDays === "string") {
      const text = edits.shelfDays.trim();
      const days = Number(text);
      if (text.length === 0) {
        item.manualDays = null;
      } else if (
        Number.isInteger(days) &&
        days > 0 &&
        days !== item.shelfLifeDays &&
        days !== item.manualDays
      ) {
        item.manualDays = days;
      }
    }
    if (typeof edits.purchasedAt === "string") {
      item.purchaseDate = setDate(item.purchaseDate, edits.purchasedAt);
    }
    if (typeof edits.producedAt === "string") {
      item.productionDate = setDate(item.productionDate, edits.producedAt);
    }
    if (typeof edits.packageExpiresAt === "string") {
      const packageBefore = item.packageExpiry?.date;
      item.packageExpiry = setDate(
        item.packageExpiry,
        edits.packageExpiresAt,
      );
      if (item.packageExpiry.date !== packageBefore) {
        item.manualDays = null;
      }
    }
    if (typeof edits.storedAt === "string") {
      const stored = calendarDate(edits.storedAt);
      if (stored) {
        item.entryDate = stored.text;
      }
    }
    item.category = this.builtin.catalog.categoryOf(
      item.canonicalName ?? "",
    );

    draft.items[index] = next;
    this.recalculate();
    this.importState = ImportState.Draft;
    return true;
  }

  setCategory(
    index: number,
    category: Exclude<DraftItemGroup, "ignored">,
  ): boolean {
    if (
      !this.ready() ||
      (category !== "food" && category !== "seasoning")
    ) {
      return false;
    }
    const draft = this.draftValue!;
    if (!Number.isInteger(index) || index < 0 || index >= draft.items.length) {
      return false;
    }
    const item = draft.items[index];
    item.category =
      category === "food" ? ItemCategory.Food : ItemCategory.Seasoning;
    item.selected = true;
    this.recalculate();
    return true;
  }

  drop(index: number): boolean {
    return this.setSelected(index, false);
  }

  retrieve(index: number): boolean {
    if (!this.ready() || !this.validIndex(index)) {
      return false;
    }
    const item = this.draftValue!.items[index];
    if (item.category === ItemCategory.Irrelevant) {
      item.category = ItemCategory.Food;
    }
    item.selected = true;
    this.recalculate();
    return true;
  }

  setCaptureDate(imageIndex: number, date: string | Date): boolean {
    if (
      !this.ready() ||
      !this.payload ||
      this.payload.kind !== "images" ||
      !Number.isInteger(imageIndex) ||
      imageIndex < 0 ||
      imageIndex >= this.payload.images.length
    ) {
      return false;
    }
    const parsed = calendarDate(date);
    if (!parsed) {
      return false;
    }
    this.payload.images[imageIndex].capturedAt = parsed.date;
    const image = this.draftValue!.record.images?.[imageIndex];
    if (image) {
      image.capturedAt = parsed.date;
      image.capturedAtSource = "user";
    }
    for (const item of this.draftValue!.items) {
      this.parseDates(item);
    }
    this.recalculate();
    return true;
  }

  confirm(allowDuplicate = false): boolean {
    const draft = this.draftValue;
    if (!draft?.ready || this.busy) {
      return false;
    }
    this.recalculate();
    if (draft.duplicate.isDuplicate() && !allowDuplicate) {
      this.importState = ImportState.Duplicate;
      return false;
    }
    const selectedProducts = products(draft);
    if (selectedProducts.length === 0) {
      return this.rejectForDraft(
        ErrorKind.InvalidInput,
        importNothingToConfirm(),
      );
    }

    for (const item of draft.items) {
      if (
        !item.selected ||
        item.category === ItemCategory.Irrelevant
      ) {
        continue;
      }
      const value = item.item;
      const canonical = value.canonicalName ?? "";
      if (
        (value.count ?? 0) <= 0 ||
        (value.displayName ?? "").trim().length === 0 ||
        (canonical !== UNCATEGORIZED_NAME &&
          this.builtin.catalog.resolve(canonical) !== canonical) ||
        (value.manualDays != null && value.manualDays <= 0) ||
        (value.labelledDays != null && value.labelledDays <= 0)
      ) {
        return this.rejectForDraft(
          ErrorKind.InvalidInput,
          "请检查商品名称、数量和保质天数",
        );
      }
      if (needsDateConfirmation(item)) {
        return this.rejectForDraft(
          ErrorKind.InvalidInput,
          importNeedsBaseDate(),
        );
      }
    }

    try {
      const importId = this.store.transaction(() => {
        const record = draft.record;
        if (this.store.insertImport(record) <= 0) {
          throw new Error("insert import failed");
        }
        if (!this.store.saveImportProducts(record.id!, selectedProducts)) {
          throw new Error("save import products failed");
        }

        const cache = this.store.aiEstimateCache();
        const rules = this.store.ruleBook();
        const pantry = this.pantryRules();
        for (const draftItem of draft.items) {
          if (
            !draftItem.selected ||
            draftItem.category === ItemCategory.Irrelevant
          ) {
            continue;
          }
          const item = draftItem.item;
          item.entryDate ||= this.clock.today();
          const resolution = resolveShelfLife(
            activeValuesFor(item),
            {
              catalog: this.builtin.catalog,
              table: this.builtin.shelfLife,
              rules,
              aiCache: cache,
            },
          );
          applyShelfLife(item, resolution);
          for (const estimate of resolution.newAiEstimates) {
            if (!this.store.cacheAiEstimate(estimate)) {
              throw new Error("cache AI estimate failed");
            }
            cache.insert(
              estimate.name,
              estimate.storage,
              estimate.days,
            );
          }
          const amount = totalAmount(
            item.quantityText ?? "",
            item.count ?? 1,
          );
          item.amount = amount.value;
          item.unit = amount.unit;
          item.importId = record.id;
          if (this.store.insertItem(item) <= 0) {
            throw new Error("insert item failed");
          }
          if (
            this.builtin.catalog.resolve(item.canonicalName ?? "") !==
            item.canonicalName
          ) {
            continue;
          }
          if (
            draftItem.category === ItemCategory.Seasoning ||
            pantry.isPantry(item.canonicalName ?? "")
          ) {
            const suggestion = suggestionsAfterPurchase(
              item.canonicalName ?? "",
              pantry,
            );
            if (suggestion) {
              if (
                this.store.addSuggestion({
                  ...suggestion,
                  importId: record.id,
                }) <= 0
              ) {
                throw new Error("add suggestion failed");
              }
            }
          }
        }
        if (
          this.jobId > 0 &&
          !this.store.deleteImportJob(this.jobId)
        ) {
          throw new Error("delete import job failed");
        }
        return record.id!;
      });

      if (importId > 0) {
        this.rememberNames(draft.items);
      }
      this.payload = null;
      this.draftValue = null;
      this.received = false;
      this.failure = null;
      this.importState = ImportState.Idle;
      this.jobId = 0;
      this.job = new ResumableJob();
      return importId > 0;
    } catch {
      return this.rejectForDraft(
        ErrorKind.Internal,
        "无法保存，请重试",
      );
    }
  }

  skipDuplicate(): boolean {
    const draft = this.draftValue;
    if (
      !this.received ||
      this.busy ||
      !draft ||
      !draft.duplicate.isDuplicate()
    ) {
      return false;
    }
    const record = {
      ...draft.record,
      images: [],
      status: ImportStatus.SkippedDuplicate,
      duplicateOf: draft.duplicate.importId,
    };
    if (this.store.insertImport(record) <= 0) {
      return this.reject(ErrorKind.Internal, "无法保存，请重试");
    }
    this.discard();
    return true;
  }

  discard(): boolean {
    this.requestSequence += 1;
    this.controller?.abort();
    this.controller = null;

    const paths: string[] = [];
    if (this.payload?.images.length) {
      const referenced = new Set(
        this.store
          .imports()
          .flatMap((record) => record.images ?? [])
          .map((image) => resolve(image.path)),
      );
      for (const image of this.payload.images) {
        if (!referenced.has(resolve(image.path))) {
          paths.push(image.path);
        }
      }
    }
    const ok = this.dropJob(this.jobId, paths);

    this.draftValue = null;
    this.received = false;
    this.failure = null;
    this.payload = null;
    this.importState = ImportState.Idle;
    this.jobId = 0;
    this.job = new ResumableJob();
    return ok;
  }

  hasUnfinishedJob(): boolean {
    return !this.received && this.store.importJob() !== null;
  }

  async resume(): Promise<boolean> {
    if (this.received || this.busy) {
      return false;
    }
    const stored = this.store.importJob();
    if (!stored) {
      return false;
    }
    this.jobId = stored.id;
    this.job = stored.job;
    if (!(await this.restoreJobPayload(stored.payload))) {
      this.discard();
      return this.reject(
        ErrorKind.InvalidInput,
        "导入的图片已不在，请重新导入",
      );
    }
    this.received = true;
    if (this.job.state === JobState.Done) {
      const result = this.resultFromJob();
      if (result) {
        try {
          await this.acceptRecognition(result);
        } catch (error) {
          if (isAbortError(error)) {
            return false;
          }
          throw error;
        }
        return this.received;
      }
      this.job.reset();
    }
    this.job.start();
    this.saveJob();
    this.batchesReported = false;
    return this.runRecognition();
  }

  discardUnfinishedJob(): boolean {
    if (this.received || this.busy) {
      return false;
    }
    return this.dropStoredJobs();
  }

  private emptyDraft(values: {
    createdAt: Date;
    inputKind: InputKind;
    origin: string;
    textLength: number;
    images?: ImportRecord["images"];
  }): ImportDraft {
    return {
      record: {
        createdAt: new Date(values.createdAt),
        inputKind: values.inputKind,
        origin: values.origin,
        isDemo: this.demo,
        truncated: false,
        textLength: values.textLength,
        sourceType: "other",
        images: values.images ?? [],
      },
      items: [],
      duplicate: new DuplicateCheck(),
      ignoredSummary: "",
      warning: "",
      ready: false,
    };
  }

  private imagesFrom(payload: ImportImagesPayload): readonly StoredImportFile[] {
    return payload.images ?? payload.files ?? [];
  }

  private directImportFile(path: string): boolean {
    if (!this.importsDirectory) {
      return true;
    }
    return resolve(path).startsWith(`${this.importsDirectory}/`);
  }

  private validIndex(index: number): boolean {
    return (
      Number.isInteger(index) &&
      index >= 0 &&
      index < (this.draftValue?.items.length ?? 0)
    );
  }

  private ready(): boolean {
    return this.draftValue?.ready === true && !this.busy;
  }

  private setSelected(index: number, selected: boolean): boolean {
    if (!this.ready() || !this.validIndex(index)) {
      return false;
    }
    this.draftValue!.items[index].selected = selected;
    this.recalculate();
    return true;
  }

  private recognitionRequest(): RecognitionRequest | null {
    if (!this.payload) {
      return null;
    }
    if (this.payload.kind === "text") {
      if (this.payload.text.trim().length === 0) {
        return null;
      }
      return {
        kind: InputKind.OrderText,
        images: [],
        text: this.payload.text,
        vocabulary: this.builtin.catalog,
      };
    }
    if (this.payload.images.length === 0) {
      return null;
    }
    const inputKind =
      Object.values(InputKind).find(
        (kind) => kind === this.draftValue?.record.inputKind,
      ) ?? InputKind.Screenshot;
    return {
      kind: inputKind,
      images: this.payload.images.map((image) => ({
        path: image.path,
        captureDate: displayDate(image.capturedAt) || null,
      })),
      text: "",
      vocabulary: this.builtin.catalog,
    };
  }

  private async runRecognition(): Promise<boolean> {
    this.failure = null;
    this.importState = ImportState.Recognizing;
    let activeController: AbortController | null = null;

    try {
      for (;;) {
        if (!this.received) {
          return false;
        }
        const requestNumber = ++this.requestSequence;
        const controller = new AbortController();
        activeController = controller;
        this.controller = controller;
        const request = this.recognitionRequest();
        if (!request) {
          throw makeRecognitionError(
            ErrorKind.InvalidInput,
            "empty recognition request",
          );
        }

        let restart = false;
        if (this.payload?.kind === "images") {
          request.firstBatch = this.job.nextBatch();
          request.onBatch = (index, count, part) => {
            if (
              controller.signal.aborted ||
              requestNumber !== this.requestSequence ||
              this.controller !== controller ||
              !this.received
            ) {
              return;
            }
            this.batchesReported = true;
            if (!this.job.plan(count)) {
              restart = true;
              controller.abort(abortError("restart import batches"));
              this.job.reset();
              this.job.start();
              this.saveJob();
              return;
            }
            if (this.job.completeBatch(index, this.encodeBatch(part))) {
              this.saveJob();
            }
          };
        }

        let result: RecognitionResult;
        try {
          result = await this.recognizer.recognize(
            request,
            controller.signal,
          );
        } catch (error) {
          if (restart && controller.signal.aborted) {
            continue;
          }
          throw error;
        }
        if (restart) {
          continue;
        }
        if (
          controller.signal.aborted ||
          requestNumber !== this.requestSequence ||
          this.controller !== controller ||
          !this.received
        ) {
          return false;
        }

        let accepted = result;
        if (this.payload?.kind === "images") {
          if (!this.batchesReported) {
            this.job.reset();
            this.job.start();
            if (this.job.plan(result.rawResponses.length)) {
              for (const [index, response] of result.rawResponses.entries()) {
                const span = result.batchSpans[index] ?? {
                  firstImage: -1,
                  lastImage: -1,
                };
                this.job.completeBatch(
                  index,
                  this.encodeBatch({
                    ...result,
                    rawResponses: [response],
                    batchSpans: [span],
                  }),
                );
              }
            }
            this.saveJob();
          } else if (this.job.state === JobState.Done) {
            accepted = this.resultFromJob() ?? result;
          }
        }

        await this.acceptRecognition(accepted);
        if (
          controller.signal.aborted ||
          requestNumber !== this.requestSequence ||
          this.controller !== controller ||
          !this.received
        ) {
          return false;
        }
        return true;
      }
    } catch (error) {
      if (
        activeController?.signal.aborted ||
        isAbortError(error) ||
        !this.received
      ) {
        return false;
      }
      this.failure = isRecognitionError(error)
        ? { ...error }
        : makeRecognitionError(
            ErrorKind.BadResponse,
            error instanceof Error ? error.message : String(error),
          );
      this.importState = ImportState.Failed;
      if (
        this.payload?.kind === "images" &&
        this.job.fail()
      ) {
        this.saveJob();
      }
      return false;
    } finally {
      if (this.controller === activeController) {
        this.controller = null;
      }
    }
  }

  private saveJob(): void {
    if (
      this.jobId > 0 &&
      !this.store.saveImportJob(this.jobId, this.job)
    ) {
      console.warn(`import job ${this.jobId}: progress not saved`);
    }
  }

  private jobPayload(): string {
    const record = this.draftValue?.record;
    return JSON.stringify({
      inputKind: record?.inputKind ?? "",
      origin: record?.origin ?? "",
      createdAt: utcTimestamp(record?.createdAt),
      isDemo: record?.isDemo === true,
      images: (record?.images ?? []).map((image) => ({
        path: image.path,
        sha256: image.sha256,
        mimeType: image.mimeType ?? "",
        capturedAt: utcTimestamp(image.capturedAt),
        capturedAtSource: image.capturedAtSource ?? "",
      })),
    });
  }

  private async restoreJobPayload(payload: Buffer): Promise<boolean> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload.toString("utf8"));
    } catch {
      return false;
    }
    if (!isObject(parsed)) {
      return false;
    }

    const inputKindText =
      typeof parsed.inputKind === "string" ? parsed.inputKind : "";
    const inputKind =
      Object.values(InputKind).find((kind) => kind === inputKindText) ??
      null;
    const origin =
      typeof parsed.origin === "string" ? parsed.origin : "";
    const createdAt =
      typeof parsed.createdAt === "string" &&
      Number.isFinite(new Date(parsed.createdAt).getTime())
        ? new Date(parsed.createdAt)
        : new Date(Number.NaN);
    const isDemo = parsed.isDemo === true;
    const imageValues = Array.isArray(parsed.images) ? parsed.images : [];
    const images: ReceivedImage[] = [];
    const recordImages: NonNullable<ImportRecord["images"]> = [];
    let complete = inputKind !== null;

    for (const value of imageValues) {
      const image = isObject(value) ? value : {};
      const path = typeof image.path === "string" ? image.path : "";
      const sha256 =
        typeof image.sha256 === "string" ? image.sha256 : "";
      const mimeType =
        typeof image.mimeType === "string" ? image.mimeType : "";
      const capturedAtText =
        typeof image.capturedAt === "string" ? image.capturedAt : "";
      const capturedAt =
        capturedAtText.length > 0 &&
        Number.isFinite(new Date(capturedAtText).getTime())
          ? new Date(capturedAtText)
          : null;
      const capturedAtSource =
        typeof image.capturedAtSource === "string"
          ? image.capturedAtSource
          : "";
      const imageExists = await this.validImportedImage(path);
      complete = imageExists && complete;
      images.push({
        path,
        sha256,
        mimeType,
        capturedAt,
        capturedAtSource,
      });
      recordImages.push({
        path,
        sha256,
        mimeType,
        capturedAt,
        capturedAtSource,
      });
    }

    this.payload = {
      kind: "images",
      origin,
      text: "",
      images,
    };
    this.draftValue = this.emptyDraft({
      createdAt,
      inputKind: inputKind ?? InputKind.Screenshot,
      origin,
      textLength: 0,
      images: recordImages,
    });
    this.draftValue.record.isDemo = isDemo || this.demo;
    return complete && images.length > 0;
  }

  private async validImportedImage(path: string): Promise<boolean> {
    if (!this.importsDirectory) {
      return false;
    }
    try {
      const root = await realpath(this.importsDirectory);
      const absolute = resolve(path);
      const info = await lstat(absolute);
      return (
        info.isFile() &&
        !info.isSymbolicLink() &&
        (await realpath(dirname(absolute))) === root
      );
    } catch {
      return false;
    }
  }

  private encodeBatch(part: RecognitionResult): string {
    const span = part.batchSpans[0];
    return JSON.stringify({
      firstImage: span?.firstImage ?? -1,
      lastImage: span?.lastImage ?? -1,
      response: part.rawResponses[0] ?? "",
    });
  }

  private resultFromJob(): RecognitionResult | null {
    const inputKind =
      Object.values(InputKind).find(
        (kind) => kind === this.draftValue?.record.inputKind,
      ) ?? InputKind.Screenshot;
    const parts: RecognitionResult[] = [];
    for (const encoded of this.job.results()) {
      let value: unknown;
      try {
        value = JSON.parse(encoded);
      } catch {
        return null;
      }
      if (!isObject(value)) {
        return null;
      }
      const response =
        typeof value.response === "string" ? value.response : "";
      const firstImage =
        typeof value.firstImage === "number"
          ? Math.trunc(value.firstImage)
          : -1;
      const lastImage =
        typeof value.lastImage === "number"
          ? Math.trunc(value.lastImage)
          : -1;
      const outcome = parseChatCompletion(
        response,
        this.builtin.catalog,
        inputKind,
      );
      if (!outcome.result) {
        return null;
      }
      outcome.result.batchSpans = [{ firstImage, lastImage }];
      parts.push(outcome.result);
    }
    return parts.length > 0 ? mergeResults(parts) : null;
  }

  private dropJob(id: number, candidates: readonly string[]): boolean {
    if (id > 0) {
      this.store.deleteImportJob(id);
    }
    const referenced = new Set(
      this.store
        .imports(true)
        .flatMap((record) => record.images ?? [])
        .map((image) => resolve(image.path)),
    );
    const paths = candidates.filter(
      (path) =>
        existsSync(path) && !referenced.has(resolve(path)),
    );
    return (
      paths.length === 0 ||
      this.store.discardImportFiles(paths)
    );
  }

  private dropStoredJobs(): boolean {
    let ok = true;
    for (const stored of this.store.importJobRows()) {
      let value: unknown;
      try {
        value = JSON.parse(stored.payload.toString("utf8"));
      } catch {
        value = {};
      }
      const imageValues =
        isObject(value) && Array.isArray(value.images)
          ? value.images
          : [];
      const paths = imageValues.flatMap((image): string[] =>
        isObject(image) && typeof image.path === "string"
          ? [image.path]
          : [],
      );
      const dropped = this.dropJob(stored.id, paths);
      ok = dropped && ok;
    }
    return ok;
  }

  private async acceptRecognition(result: RecognitionResult): Promise<void> {
    const draft = this.draftValue;
    if (!draft) {
      return;
    }
    draft.record.isDemo =
      draft.record.isDemo === true || this.demo || result.isDemo;
    draft.record.truncated = result.truncated;
    draft.record.sourceType = result.sourceType;
    draft.warning = result.truncated ? importMayBeIncomplete() : "";
    draft.ignoredSummary = result.ignoredSummary;

    const rules = this.store.ruleBook();
    const cache = this.store.aiEstimateCache();
    const rawNames: string[] = [];
    const resolutions: ReturnType<typeof resolveName>[] = [];
    for (const recognized of result.items) {
      const resolution = resolveName(
        recognized.rawName,
        recognized.canonicalName,
        this.builtin.catalog,
        this.mappings,
      );
      const canonical = resolution.canonical || UNCATEGORIZED_NAME;
      const item: FridgeItem = {
        canonicalName: canonical,
        displayName:
          canonical === UNCATEGORIZED_NAME
            ? recognized.rawName
            : canonical,
        rawName: recognized.rawName,
        category: this.builtin.catalog.categoryOf(canonical),
        quantityText: recognized.quantityText,
        count: recognized.count,
        aiDays: aiDays({
          aiDays: recognized.shelfLifeDays,
        }),
        storage: Storage.Fridge,
        storageSource: StorageSource.Default,
        useFirst: false,
        status: ItemStatus.InStock,
        purchaseDate: emptyDate(),
        productionDate: emptyDate(),
        packageExpiry: emptyDate(),
        labelledDays: null,
        manualDays: null,
        shelfLifeSource: "none",
        shelfLifeDays: null,
        expiryDate: null,
        startBasis: "none",
        shelfLifeNote: "",
        referenceConditionsConfirmed: false,
      };
      const draftItem: DraftItem = {
        recognized,
        item,
        category: recognized.category,
        selected:
          recognized.selected &&
          recognized.category !== ItemCategory.Irrelevant,
        nameSource: resolution.source,
        production: { status: "empty", text: "" },
        purchase: { status: "empty", text: "" },
        expiry: { status: "empty", text: "" },
        needsShelfLife: false,
      };
      draft.items.push(draftItem);
      if (recognized.category !== ItemCategory.Irrelevant) {
        rawNames.push(recognized.rawName);
        resolutions.push(resolution);
      }
    }

    const unresolved = unresolvedNames(rawNames, resolutions);
    if (
      unresolved.length > 0 &&
      this.classifier &&
      this.classifierConfigured
    ) {
      try {
        const signal = this.controller?.signal;
        const classification = await this.classifier.classify(
          unresolved,
          this.builtin.catalog,
          signal,
        );
        if (signal?.aborted) {
          throw abortError(signal.reason);
        }
        for (const item of draft.items) {
          if (item.nameSource !== NameSource.Unresolved) {
            continue;
          }
          const canonical = classification.canonical.get(
            nameKey(item.recognized.rawName),
          );
          if (
            canonical &&
            this.builtin.catalog.resolve(canonical) === canonical
          ) {
            item.item.canonicalName = canonical;
            item.nameSource = NameSource.AiClassified;
          }
        }
      } catch (error) {
        if (this.controller?.signal.aborted || isAbortError(error)) {
          throw error;
        }
        console.warn("import: classification failed");
      }
    }

    this.finishDraft(draft, rules, cache);
  }

  private finishDraft(
    draft: ImportDraft,
    rules: ReturnType<Store["ruleBook"]>,
    cache: ReturnType<Store["aiEstimateCache"]>,
  ): void {
    for (const draftItem of draft.items) {
      const recognized = draftItem.recognized;
      const item = draftItem.item;
      const canonical = item.canonicalName ?? UNCATEGORIZED_NAME;
      item.canonicalName = canonical;
      item.displayName =
        canonical === UNCATEGORIZED_NAME ? recognized.rawName : canonical;
      item.rawName = recognized.rawName;
      item.category = this.builtin.catalog.categoryOf(canonical);
      item.quantityText = recognized.quantityText;
      item.count = recognized.count;
      item.entryDate = this.clock.today();
      const storage = suggestStorage(
        canonical,
        storageOf(recognized.storage),
        recognized.category === ItemCategory.Seasoning,
        {
          catalog: this.builtin.catalog,
          table: this.builtin.shelfLife,
          rules,
          aiCache: cache,
        },
      );
      item.storage = storage.storage;
      item.storageSource = storage.source;
      this.parseDates(draftItem);
    }

    draft.ready = true;
    this.recalculate();
    this.importState = ImportState.Draft;
  }

  private parseDates(draft: DraftItem): void {
    let index = draft.recognized.imageIndex;
    const images = this.payload?.images ?? [];
    if (index < 0 && images.length === 1) {
      index = 0;
    }
    const base =
      index >= 0 && index < images.length
        ? displayDate(images[index].capturedAt) || null
        : null;
    draft.production = parsedDate(
      draft.recognized.productionDateText,
      base,
    );
    draft.purchase = parsedDate(
      draft.recognized.purchaseDateText,
      base,
    );
    draft.expiry = parsedDate(
      draft.recognized.expiryDateText,
      base,
    );
    const item = draft.item;
    if (item.productionDate?.origin !== DateOrigin.User) {
      item.productionDate = recordedDate(draft.production);
    }
    if (item.purchaseDate?.origin !== DateOrigin.User) {
      item.purchaseDate = recordedDate(draft.purchase);
    }
    if (item.packageExpiry?.origin !== DateOrigin.User) {
      item.packageExpiry = recordedDate(draft.expiry);
    }
  }

  private recalculate(): void {
    const draft = this.draftValue;
    if (!draft) {
      return;
    }
    const cache = this.store.aiEstimateCache();
    const rules = this.store.ruleBook();
    for (const item of draft.items) {
      item.item.kind = classifyItemKind(
        item.item.canonicalName ?? "",
        item.category === ItemCategory.Seasoning,
        item.item.storage ?? Storage.Fridge,
        this.builtin.catalog,
        this.builtin.shelfLife,
      );
      const resolution = resolveShelfLife(activeValuesFor(item.item), {
        catalog: this.builtin.catalog,
        table: this.builtin.shelfLife,
        rules,
        aiCache: cache,
      });
      applyShelfLife(item.item, resolution);
      item.needsShelfLife = needsShelfLife(item.item);
      if (
        item.selected &&
        item.category !== ItemCategory.Irrelevant
      ) {
        for (const estimate of resolution.newAiEstimates) {
          cache.insert(estimate.name, estimate.storage, estimate.days);
        }
      }
    }
    if (draft.duplicate.kind !== DuplicateCheck.Kind.SameImage) {
      draft.duplicate = checkSimilarItems(
        products(draft),
        this.clock.now(),
        this.store.importFingerprints(),
      );
    }
  }

  private pantryRules(): PantryRules {
    const rules = new PantryRules(this.builtin.catalog);
    for (const override of this.store.pantryOverrides()) {
      rules.setOverride(override);
    }
    return rules;
  }

  private rememberNames(items: readonly DraftItem[]): void {
    if (!this.mappings) {
      return;
    }
    for (const draft of items) {
      const canonical = draft.item.canonicalName ?? "";
      if (
        !draft.selected ||
        draft.category === ItemCategory.Irrelevant ||
        canonical.length === 0 ||
        this.builtin.catalog.resolve(canonical) !== canonical ||
        (draft.nameSource !== NameSource.AiClassified &&
          draft.nameSource !== NameSource.UserEdited)
      ) {
        continue;
      }
      this.mappings.remember(
        draft.recognized.rawName,
        canonical,
      );
    }
  }

  private itemDto(item: DraftItem, index: number): DraftItemDto {
    const value = item.item;
    return {
      index,
      name:
        (value.displayName ?? "").length > 0
          ? value.displayName!
          : value.canonicalName ?? "",
      quantity: value.quantityText ?? "",
      category: categoryCode(value.category),
      location: storageLocation(value.storage),
      source: sourceName(value),
      shelfDays:
        value.shelfLifeDays != null
          ? String(value.shelfLifeDays)
          : "",
      startBasis: value.startBasis ?? "none",
      startDate:
        value.startBasis === "production"
          ? value.productionDate?.date ?? ""
          : value.startBasis === "purchase"
            ? value.purchaseDate?.date ?? ""
            : value.startBasis === "entry"
              ? value.entryDate ?? ""
              : "",
      expiryDate: value.expiryDate ?? "",
      shelfLifeNote: value.shelfLifeNote ?? "",
      purchasedAt: value.purchaseDate?.date ?? "",
      storedAt: value.entryDate ?? "",
      producedAt: value.productionDate?.date ?? "",
      packageExpiresAt: value.packageExpiry?.date ?? "",
      group: draftGroup(item),
      needsDate: needsDateConfirmation(item),
      aiClassified: item.nameSource === NameSource.AiClassified,
    };
  }

  private reject(
    kind: ErrorKind,
    message: string,
    state?: ImportState,
  ): false {
    this.failure = makeRecognitionError(kind, message);
    this.failure.userMessage = message;
    if (state) {
      this.importState = state;
    }
    return false;
  }

  private rejectForDraft(
    kind: ErrorKind,
    message: string,
  ): false {
    this.failure = makeRecognitionError(kind, message);
    this.failure.userMessage = message;
    this.importState = ImportState.Draft;
    return false;
  }
}
