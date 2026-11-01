import {
  lstatSync,
  readdirSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  DateOrigin,
  ItemStatus,
  ShelfLifeSource,
  ShoppingOrigin,
  StartBasis,
  Storage,
  StorageSource,
  SuggestionKind,
} from "../../shared/enums.js";
import type { Clock } from "../domain/clock.js";
import type {
  ImportFingerprint,
  ImportItem,
} from "../domain/import-duplicates.js";
import type {
  PantryOverride,
  Suggestion,
} from "../domain/pantry.js";
import {
  AiEstimateCache,
  isRuleEligibleName,
  RuleBook,
  type AiCacheEntry,
  type ShelfLifeRule,
  type StorageDays,
  type StorageRule,
} from "../domain/shelf-life.js";
import {
  dedupeKey,
  type ShoppingEntry,
} from "../domain/shopping-list.js";

type Timestamp = Date | string | null;
type SqlRow = Record<string, unknown>;
type SqlValue = null | number | string;

export interface RecordedDate {
  date: string | null;
  origin?: DateOrigin;
  text?: string;
}

export interface FridgeItem {
  id?: number;
  importId?: number;
  canonicalName?: string;
  displayName?: string;
  rawName?: string;
  category?: string;
  quantityText?: string;
  count?: number;
  storage?: Storage;
  storageSource?: StorageSource;
  useFirst?: boolean;
  status?: ItemStatus;
  statusChangedAt?: Timestamp;
  purchaseDate?: RecordedDate;
  entryDate?: string | null;
  productionDate?: RecordedDate;
  packageExpiry?: RecordedDate;
  labelledDays?: number | null;
  manualDays?: number | null;
  aiDays?: StorageDays;
  shelfLifeSource?: ShelfLifeSource;
  shelfLifeDays?: number | null;
  expiryDate?: string | null;
  startBasis?: StartBasis;
  shelfLifeNote?: string;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
  referenceConditionsConfirmed?: boolean;
}

export interface ImportImageRecord {
  path: string;
  sha256: string;
  mimeType?: string;
  capturedAt?: Timestamp;
  capturedAtSource?: string;
}

export interface ImportRecord {
  id?: number;
  createdAt?: Timestamp;
  inputKind?: string;
  sourceType?: string;
  origin?: string;
  isDemo?: boolean;
  truncated?: boolean;
  textLength?: number;
  images?: ImportImageRecord[];
}

export type StoredSuggestion = Suggestion & {
  id?: number;
  importId?: number;
  createdAt?: Timestamp;
};

const itemColumns = [
  "import_id",
  "canonical_name",
  "display_name",
  "raw_name",
  "category",
  "quantity_text",
  "count",
  "storage",
  "storage_source",
  "use_first",
  "status",
  "status_changed_at",
  "purchase_date",
  "purchase_date_origin",
  "purchase_date_text",
  "entry_date",
  "production_date",
  "production_date_origin",
  "production_date_text",
  "package_expiry_date",
  "package_expiry_origin",
  "package_expiry_text",
  "labelled_days",
  "manual_days",
  "ai_fridge_days",
  "ai_freezer_days",
  "ai_room_days",
  "shelf_life_source",
  "shelf_life_days",
  "expiry_date",
  "start_basis",
  "shelf_life_note",
  "created_at",
  "updated_at",
  "reference_conditions_confirmed",
] as const;

const itemInsertSql =
  `INSERT INTO items (${itemColumns.join(", ")}) ` +
  `VALUES (${itemColumns.map(() => "?").join(", ")})`;
const itemUpdateSql =
  `UPDATE items SET ${itemColumns.map((column) => `${column} = ?`).join(", ")} ` +
  "WHERE id = ?";

const dateOrigins = Object.values(DateOrigin);
const itemStatuses = Object.values(ItemStatus);
const shelfLifeSources = Object.values(ShelfLifeSource);
const startBases = Object.values(StartBasis);
const storages = Object.values(Storage);
const storageSources = Object.values(StorageSource);

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function number(value: unknown, fallback = 0): number {
  const result =
    typeof value === "number"
      ? value
      : typeof value === "bigint"
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(result) ? result : fallback;
}

function optionalNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const result = number(value, Number.NaN);
  return Number.isFinite(result) ? result : null;
}

function optionalBoolean(value: unknown): boolean | null {
  if (value === null || value === undefined) {
    return null;
  }
  return number(value) !== 0;
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : text(value);
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  const candidate = text(value);
  return allowed.includes(candidate as T) ? (candidate as T) : fallback;
}

function storageFrom(value: unknown): Storage | null {
  const candidate = text(value);
  return storages.includes(candidate as Storage)
    ? (candidate as Storage)
    : null;
}

function timestampFrom(value: unknown): Date | null {
  const date =
    value instanceof Date
      ? new Date(value.getTime())
      : typeof value === "string" && value.length > 0
        ? new Date(value)
        : null;
  return date && Number.isFinite(date.getTime()) ? date : null;
}

function timestampValue(value: unknown): string | null {
  return timestampFrom(value)?.toISOString() ?? null;
}

function recordedDate(
  date: unknown,
  origin: unknown,
  recordedText: unknown,
): RecordedDate {
  return {
    date: nullableText(date),
    origin: oneOf(origin, dateOrigins, DateOrigin.None),
    text: text(recordedText),
  };
}

function normalizeItem(item: FridgeItem): void {
  item.id = number(item.id);
  item.importId = number(item.importId);
  item.canonicalName = text(item.canonicalName);
  item.displayName = text(item.displayName);
  item.rawName = text(item.rawName);
  item.category = text(item.category);
  item.quantityText = text(item.quantityText);
  item.count = number(item.count, 1);
  item.storage = item.storage ?? Storage.Fridge;
  item.storageSource = item.storageSource ?? StorageSource.Default;
  item.useFirst = item.useFirst === true;
  item.status = item.status ?? ItemStatus.InStock;
  item.purchaseDate ??= { date: null, origin: DateOrigin.None, text: "" };
  item.productionDate ??= { date: null, origin: DateOrigin.None, text: "" };
  item.packageExpiry ??= { date: null, origin: DateOrigin.None, text: "" };
  item.labelledDays = optionalNumber(item.labelledDays);
  item.manualDays = optionalNumber(item.manualDays);
  item.aiDays ??= {};
  item.aiDays.fridge = optionalNumber(item.aiDays.fridge);
  item.aiDays.freezer = optionalNumber(item.aiDays.freezer);
  item.aiDays.room = optionalNumber(item.aiDays.room);
  item.shelfLifeSource ??= ShelfLifeSource.None;
  item.shelfLifeDays = optionalNumber(item.shelfLifeDays);
  item.expiryDate = nullableText(item.expiryDate);
  item.startBasis ??= StartBasis.None;
  item.shelfLifeNote = text(item.shelfLifeNote);
  item.referenceConditionsConfirmed =
    item.referenceConditionsConfirmed === true;
}

function itemBindings(item: FridgeItem): SqlValue[] {
  const purchase = item.purchaseDate ?? {
    date: null,
    origin: DateOrigin.None,
    text: "",
  };
  const production = item.productionDate ?? {
    date: null,
    origin: DateOrigin.None,
    text: "",
  };
  const packageExpiry = item.packageExpiry ?? {
    date: null,
    origin: DateOrigin.None,
    text: "",
  };

  return [
    (item.importId ?? 0) > 0 ? (item.importId ?? 0) : null,
    item.canonicalName ?? "",
    item.displayName ?? "",
    item.rawName ?? "",
    item.category ?? "",
    item.quantityText ?? "",
    item.count ?? 1,
    item.storage ?? Storage.Fridge,
    item.storageSource ?? StorageSource.Default,
    item.useFirst === true ? 1 : 0,
    item.status ?? ItemStatus.InStock,
    timestampValue(item.statusChangedAt),
    purchase.date,
    purchase.origin ?? DateOrigin.None,
    text(purchase.text),
    item.entryDate ?? null,
    production.date,
    production.origin ?? DateOrigin.None,
    text(production.text),
    packageExpiry.date,
    packageExpiry.origin ?? DateOrigin.None,
    text(packageExpiry.text),
    item.labelledDays ?? null,
    item.manualDays ?? null,
    item.aiDays?.fridge ?? null,
    item.aiDays?.freezer ?? null,
    item.aiDays?.room ?? null,
    item.shelfLifeSource ?? ShelfLifeSource.None,
    item.shelfLifeDays ?? null,
    item.expiryDate ?? null,
    item.startBasis ?? StartBasis.None,
    item.shelfLifeNote ?? "",
    timestampValue(item.createdAt),
    timestampValue(item.updatedAt),
    item.referenceConditionsConfirmed === true ? 1 : 0,
  ];
}

function itemFrom(row: SqlRow): FridgeItem {
  return {
    id: number(row.id),
    importId: number(row.import_id),
    canonicalName: text(row.canonical_name),
    displayName: text(row.display_name),
    rawName: text(row.raw_name),
    category: text(row.category),
    quantityText: text(row.quantity_text),
    count: number(row.count, 1),
    storage: oneOf(row.storage, storages, Storage.Fridge),
    storageSource: oneOf(
      row.storage_source,
      storageSources,
      StorageSource.Default,
    ),
    useFirst: number(row.use_first) !== 0,
    status: oneOf(row.status, itemStatuses, ItemStatus.InStock),
    statusChangedAt: timestampFrom(row.status_changed_at),
    purchaseDate: recordedDate(
      row.purchase_date,
      row.purchase_date_origin,
      row.purchase_date_text,
    ),
    entryDate: nullableText(row.entry_date),
    productionDate: recordedDate(
      row.production_date,
      row.production_date_origin,
      row.production_date_text,
    ),
    packageExpiry: recordedDate(
      row.package_expiry_date,
      row.package_expiry_origin,
      row.package_expiry_text,
    ),
    labelledDays: optionalNumber(row.labelled_days),
    manualDays: optionalNumber(row.manual_days),
    aiDays: {
      fridge: optionalNumber(row.ai_fridge_days),
      freezer: optionalNumber(row.ai_freezer_days),
      room: optionalNumber(row.ai_room_days),
    },
    shelfLifeSource: oneOf(
      row.shelf_life_source,
      shelfLifeSources,
      ShelfLifeSource.None,
    ),
    shelfLifeDays: optionalNumber(row.shelf_life_days),
    expiryDate: nullableText(row.expiry_date),
    startBasis: oneOf(row.start_basis, startBases, StartBasis.None),
    shelfLifeNote: text(row.shelf_life_note),
    createdAt: timestampFrom(row.created_at),
    updatedAt: timestampFrom(row.updated_at),
    referenceConditionsConfirmed:
      number(row.reference_conditions_confirmed) !== 0,
  };
}

function importFrom(row: SqlRow): ImportRecord {
  return {
    id: number(row.id),
    createdAt: timestampFrom(row.created_at),
    inputKind: text(row.input_kind),
    sourceType: text(row.source_type),
    origin: text(row.origin),
    isDemo: number(row.is_demo) !== 0,
    truncated: number(row.truncated) !== 0,
    textLength: number(row.text_length),
    images: [],
  };
}

function importImageFrom(row: SqlRow): ImportImageRecord {
  return {
    path: text(row.path),
    sha256: text(row.sha256),
    mimeType: text(row.mime_type),
    capturedAt: timestampFrom(row.captured_at),
    capturedAtSource: text(row.captured_at_source),
  };
}

function suggestionFrom(row: SqlRow): StoredSuggestion {
  const kinds = Object.values(SuggestionKind);
  return {
    id: number(row.id),
    kind: oneOf(row.kind, kinds, SuggestionKind.MarkPantryHave),
    name: text(row.canonical_name),
    message: text(row.message),
    importId: number(row.import_id),
    createdAt: timestampFrom(row.created_at),
  };
}

function shoppingEntryFrom(row: SqlRow): ShoppingEntry {
  let names: string[] = [];
  try {
    const parsed: unknown = JSON.parse(text(row.names));
    if (Array.isArray(parsed)) {
      names = parsed.filter((name): name is string => typeof name === "string");
    }
  } catch {
    names = [];
  }

  return {
    id: number(row.id),
    names,
    category: text(row.category),
    origin: oneOf(
      row.origin,
      Object.values(ShoppingOrigin),
      ShoppingOrigin.Manual,
    ),
    note: text(row.note),
    createdAt:
      timestampFrom(row.created_at)?.toISOString() ?? new Date(0).toISOString(),
  };
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

export class Store {
  constructor(
    private readonly database: DatabaseSync,
    private readonly clock: Clock,
    private readonly importsDirectory: string,
    private readonly cleanUntrackedFiles = true,
  ) {}

  transaction(): boolean;
  transaction<T>(fn: () => T): T;
  transaction<T>(fn?: () => T): boolean | T {
    try {
      this.database.exec("BEGIN IMMEDIATE");
    } catch (error) {
      if (!fn) {
        return false;
      }
      throw error;
    }
    if (!fn) {
      return true;
    }

    try {
      const result = fn();
      if (!this.commit()) {
        throw new Error("database transaction commit failed");
      }
      return result;
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  commit(): boolean {
    try {
      this.database.exec("COMMIT");
      return true;
    } catch {
      return false;
    }
  }

  rollback(): void {
    try {
      this.database.exec("ROLLBACK");
    } catch {
      // Preserve the Store's non-throwing transaction contract.
    }
  }

  insertItem(item: FridgeItem): number {
    normalizeItem(item);
    const now = this.clock.now();
    item.createdAt = timestampFrom(item.createdAt) ?? new Date(now.getTime());
    item.updatedAt = new Date(now.getTime());
    item.entryDate ??= this.clock.today();

    try {
      const result = this.database
        .prepare(itemInsertSql)
        .run(...itemBindings(item));
      const id = Number(result.lastInsertRowid);
      if (!Number.isSafeInteger(id) || id <= 0) {
        return 0;
      }
      item.id = id;
      return id;
    } catch {
      return 0;
    }
  }

  updateItem(item: FridgeItem): boolean {
    const id = number(item.id);
    if (id <= 0) {
      return false;
    }
    normalizeItem(item);
    item.id = id;
    item.updatedAt = new Date(this.clock.now().getTime());

    try {
      const result = this.database
        .prepare(itemUpdateSql)
        .run(...itemBindings(item), id);
      return Number(result.changes) === 1;
    } catch {
      return false;
    }
  }

  item(id: number): FridgeItem | undefined {
    try {
      const row = this.database
        .prepare("SELECT * FROM items WHERE id = ?")
        .get(id);
      return row ? itemFrom(row) : undefined;
    } catch {
      return undefined;
    }
  }

  items(
    status: ItemStatus | null | undefined = ItemStatus.InStock,
  ): FridgeItem[] {
    try {
      const rows =
        status === null || status === undefined
          ? this.database.prepare("SELECT * FROM items ORDER BY id").all()
          : this.database
              .prepare("SELECT * FROM items WHERE status = ? ORDER BY id")
              .all(status);
      return rows.map(itemFrom);
    } catch {
      return [];
    }
  }

  itemsForImport(importId: number): FridgeItem[] {
    try {
      const rows = this.database
        .prepare("SELECT * FROM items WHERE import_id = ? ORDER BY id")
        .all(importId);
      return rows.map(itemFrom);
    } catch {
      return [];
    }
  }

  insertImport(record: ImportRecord): number {
    const now = this.clock.now();
    record.createdAt = timestampFrom(record.createdAt) ?? new Date(now.getTime());

    try {
      const result = this.database
        .prepare(
          `INSERT INTO imports (
            created_at, input_kind, origin, is_demo, truncated, text_length,
            source_type
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          timestampValue(record.createdAt),
          text(record.inputKind),
          text(record.origin),
          record.isDemo === true ? 1 : 0,
          record.truncated === true ? 1 : 0,
          number(record.textLength),
          record.sourceType === undefined ? "other" : text(record.sourceType),
        );
      const id = Number(result.lastInsertRowid);
      if (!Number.isSafeInteger(id) || id <= 0) {
        return 0;
      }
      record.id = id;

      const insertImage = this.database.prepare(
        `INSERT INTO import_images (
          import_id, position, path, sha256, mime_type, captured_at,
          captured_at_source
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const [position, image] of (record.images ?? []).entries()) {
        insertImage.run(
          id,
          position,
          text(image.path),
          text(image.sha256),
          text(image.mimeType),
          timestampValue(image.capturedAt),
          text(image.capturedAtSource),
        );
      }
      return id;
    } catch {
      return 0;
    }
  }

  imports(): ImportRecord[] {
    try {
      const rows = this.database
        .prepare("SELECT * FROM imports ORDER BY created_at DESC, id DESC")
        .all();
      const records = rows.map(importFrom);
      const byId = new Map<number, ImportRecord>();
      for (const record of records) {
        byId.set(record.id ?? 0, record);
      }

      const images = this.database
        .prepare(
          "SELECT * FROM import_images ORDER BY import_id, position",
        )
        .all();
      for (const row of images) {
        byId
          .get(number(row.import_id))
          ?.images?.push(importImageFrom(row));
      }
      return records;
    } catch {
      return [];
    }
  }

  importRecord(id: number): ImportRecord | undefined {
    return this.imports().find((record) => record.id === id);
  }

  importFingerprints(): ImportFingerprint[] {
    const fingerprints = this.imports().map((record) => ({
      importId: record.id ?? 0,
      createdAt: timestampFrom(record.createdAt) ?? new Date(0),
      imageSha256: (record.images ?? []).map((image) => image.sha256),
      items: [] as ImportItem[],
    }));
    const byId = new Map(
      fingerprints.map((fingerprint) => [fingerprint.importId, fingerprint]),
    );

    try {
      const rows = this.database
        .prepare(
          `SELECT import_id, canonical_name, quantity FROM import_products
           UNION ALL
           SELECT import_id, canonical_name, quantity_text || char(31) || count
           FROM items
           WHERE import_id IS NOT NULL
             AND import_id NOT IN (SELECT import_id FROM import_products)`,
        )
        .all();
      for (const row of rows) {
        const fingerprint = byId.get(number(row.import_id));
        if (fingerprint) {
          fingerprint.items.push([
            text(row.canonical_name),
            text(row.quantity),
          ]);
        }
      }
    } catch {
      return [];
    }
    return fingerprints;
  }

  saveImportProducts(
    id: number,
    products: readonly ImportItem[],
  ): boolean {
    try {
      const insert = this.database.prepare(
        `INSERT INTO import_products (import_id, canonical_name, quantity)
         VALUES (?, ?, ?)`,
      );
      for (const [name, quantity] of products) {
        insert.run(id, text(name), text(quantity));
      }
      return true;
    } catch {
      return false;
    }
  }

  discardImportFiles(paths: readonly string[]): boolean {
    const root = this.canonicalImportsDirectory();
    if (!root) {
      return false;
    }

    const absolutePaths: string[] = [];
    for (const path of paths) {
      const absolutePath = this.directImportPath(path, root);
      if (!absolutePath || !this.safeFileOrMissing(absolutePath)) {
        return false;
      }
      absolutePaths.push(absolutePath);
    }

    if (!this.transaction()) {
      return false;
    }
    try {
      const enqueue = this.database.prepare(
        "INSERT OR IGNORE INTO file_cleanup (path) VALUES (?)",
      );
      for (const path of absolutePaths) {
        enqueue.run(path);
      }
      if (!this.commit()) {
        this.rollback();
        return false;
      }
    } catch {
      this.rollback();
      return false;
    }
    return this.retryFileCleanup();
  }

  retryFileCleanup(): boolean {
    let paths: string[];
    try {
      paths = this.database
        .prepare(
          `SELECT path FROM file_cleanup
           WHERE path NOT IN (SELECT path FROM import_images)`,
        )
        .all()
        .map((row) => text(row.path));
    } catch {
      return false;
    }

    let ok = true;
    for (const path of paths) {
      let exists = true;
      try {
        lstatSync(path);
      } catch (error) {
        if (!isMissing(error)) {
          ok = false;
          continue;
        }
        exists = false;
      }
      if (exists && !this.removeImportFile(path)) {
        ok = false;
        continue;
      }
      try {
        this.database
          .prepare("DELETE FROM file_cleanup WHERE path = ?")
          .run(path);
      } catch {
        ok = false;
      }
    }
    return ok;
  }

  removeImportFile(path: string): boolean {
    const root = this.canonicalImportsDirectory();
    const absolutePath = root ? this.directImportPath(path, root) : null;
    if (!absolutePath) {
      return false;
    }

    try {
      const info = lstatSync(absolutePath);
      if (!info.isFile() || info.isSymbolicLink()) {
        return false;
      }
      unlinkSync(absolutePath);
      return true;
    } catch {
      return false;
    }
  }

  deleteImport(id: number): boolean {
    if (!this.importRecord(id)) {
      return false;
    }
    if (!this.transaction()) {
      return false;
    }

    try {
      const statements = [
        `INSERT OR IGNORE INTO file_cleanup
         SELECT path FROM import_images WHERE import_id = ?`,
        "DELETE FROM import_products WHERE import_id = ?",
        "DELETE FROM suggestions WHERE import_id = ? AND status = 'pending'",
        "DELETE FROM items WHERE import_id = ?",
        "UPDATE suggestions SET import_id = NULL WHERE import_id = ?",
        "DELETE FROM import_images WHERE import_id = ?",
        "DELETE FROM imports WHERE id = ?",
      ];
      for (const sql of statements) {
        this.database.prepare(sql).run(id);
      }
      if (!this.commit()) {
        this.rollback();
        return false;
      }
    } catch {
      this.rollback();
      return false;
    }
    return this.retryFileCleanup();
  }

  deleteAllData(): boolean {
    if (!this.transaction()) {
      return false;
    }

    try {
      const enqueue = this.database.prepare(
        "INSERT OR IGNORE INTO file_cleanup (path) VALUES (?)",
      );
      this.database
        .prepare(
          "INSERT OR IGNORE INTO file_cleanup (path) SELECT path FROM import_images",
        )
        .run();

      const root = this.canonicalImportsDirectory();
      if (this.cleanUntrackedFiles && root) {
        for (const entry of readdirSync(root, { withFileTypes: true })) {
          if (entry.isFile()) {
            enqueue.run(resolve(root, entry.name));
          }
        }
      }

      const tables = [
        "import_products",
        "suggestions",
        "items",
        "import_images",
        "imports",
        "shelf_life_rules",
        "storage_rules",
        "ai_shelf_life_cache",
        "pantry_overrides",
        "shopping_items",
        "settings",
      ];
      for (const table of tables) {
        this.database.exec(`DELETE FROM ${table}`);
      }
      if (!this.commit()) {
        this.rollback();
        return false;
      }
    } catch {
      this.rollback();
      return false;
    }
    return this.retryFileCleanup();
  }

  shelfLifeRules(): ShelfLifeRule[] {
    try {
      return this.database
        .prepare(
          `SELECT canonical_name, storage, days
           FROM shelf_life_rules
           ORDER BY canonical_name, storage`,
        )
        .all()
        .flatMap((row) => {
          const name = text(row.canonical_name);
          const storage = storageFrom(row.storage);
          const days = optionalNumber(row.days);
          return storage !== null && days !== null
            ? [{ name, storage, days }]
            : [];
        });
    } catch {
      return [];
    }
  }

  saveShelfLifeRule(rule: ShelfLifeRule): boolean {
    if (
      !isRuleEligibleName(rule.name) ||
      !Number.isSafeInteger(rule.days) ||
      rule.days <= 0 ||
      storageFrom(rule.storage) === null
    ) {
      return false;
    }
    try {
      this.database
        .prepare(
          `INSERT INTO shelf_life_rules
            (canonical_name, storage, days, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (canonical_name, storage) DO UPDATE SET
             days = excluded.days,
             updated_at = excluded.updated_at`,
        )
        .run(
          rule.name,
          rule.storage,
          rule.days,
          this.clock.now().toISOString(),
        );
      return true;
    } catch {
      return false;
    }
  }

  deleteShelfLifeRule(name: string, storage: Storage): boolean {
    try {
      const result = this.database
        .prepare(
          `DELETE FROM shelf_life_rules
           WHERE canonical_name = ? AND storage = ?`,
        )
        .run(name, storage);
      return number(result.changes) > 0;
    } catch {
      return false;
    }
  }

  storageRules(): StorageRule[] {
    try {
      return this.database
        .prepare(
          `SELECT canonical_name, storage
           FROM storage_rules
           ORDER BY canonical_name`,
        )
        .all()
        .flatMap((row) => {
          const storage = storageFrom(row.storage);
          return storage === null
            ? []
            : [{ name: text(row.canonical_name), storage }];
        });
    } catch {
      return [];
    }
  }

  saveStorageRule(rule: StorageRule): boolean {
    if (
      !isRuleEligibleName(rule.name) ||
      storageFrom(rule.storage) === null
    ) {
      return false;
    }
    try {
      this.database
        .prepare(
          `INSERT INTO storage_rules
            (canonical_name, storage, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT (canonical_name) DO UPDATE SET
             storage = excluded.storage,
             updated_at = excluded.updated_at`,
        )
        .run(
          rule.name,
          rule.storage,
          this.clock.now().toISOString(),
        );
      return true;
    } catch {
      return false;
    }
  }

  deleteStorageRule(name: string): boolean {
    try {
      const result = this.database
        .prepare("DELETE FROM storage_rules WHERE canonical_name = ?")
        .run(name);
      return number(result.changes) > 0;
    } catch {
      return false;
    }
  }

  ruleBook(): RuleBook {
    const book = new RuleBook();
    for (const rule of this.shelfLifeRules()) {
      book.setShelfLife(rule);
    }
    for (const rule of this.storageRules()) {
      book.setStorage(rule);
    }
    return book;
  }

  aiEstimateCache(): AiEstimateCache {
    const cache = new AiEstimateCache();
    try {
      const rows = this.database
        .prepare(
          `SELECT canonical_name, storage, days
           FROM ai_shelf_life_cache`,
        )
        .all();
      for (const row of rows) {
        const name = text(row.canonical_name);
        const storage = storageFrom(row.storage);
        const days = optionalNumber(row.days);
        if (storage !== null && days !== null) {
          cache.insert(name, storage, days);
        }
      }
    } catch {
      return cache;
    }
    return cache;
  }

  cacheAiEstimate(entry: AiCacheEntry): boolean {
    if (
      !isRuleEligibleName(entry.name) ||
      !Number.isSafeInteger(entry.days) ||
      entry.days <= 0 ||
      storageFrom(entry.storage) === null
    ) {
      return false;
    }
    try {
      this.database
        .prepare(
          `INSERT OR IGNORE INTO ai_shelf_life_cache
            (canonical_name, storage, days, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(
          entry.name,
          entry.storage,
          entry.days,
          this.clock.now().toISOString(),
        );
      return true;
    } catch {
      return false;
    }
  }

  pantryOverrides(): PantryOverride[] {
    try {
      return this.database
        .prepare(
          `SELECT canonical_name, is_pantry, is_bulk, is_out
           FROM pantry_overrides
           ORDER BY canonical_name`,
        )
        .all()
        .map((row) => ({
          name: text(row.canonical_name),
          pantry: optionalBoolean(row.is_pantry) ?? undefined,
          bulk: optionalBoolean(row.is_bulk) ?? undefined,
          out: number(row.is_out) !== 0,
        }));
    } catch {
      return [];
    }
  }

  savePantryOverride(override: PantryOverride): boolean {
    if (override.name.trim().length === 0) {
      return false;
    }
    const optionalBooleanValue = (
      value: boolean | undefined,
    ): number | null => (typeof value === "boolean" ? (value ? 1 : 0) : null);
    try {
      this.database
        .prepare(
          `INSERT INTO pantry_overrides
            (canonical_name, is_pantry, is_bulk, is_out, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (canonical_name) DO UPDATE SET
             is_pantry = excluded.is_pantry,
             is_bulk = excluded.is_bulk,
             is_out = excluded.is_out,
             updated_at = excluded.updated_at`,
        )
        .run(
          override.name,
          optionalBooleanValue(override.pantry),
          optionalBooleanValue(override.bulk),
          override.out === true ? 1 : 0,
          this.clock.now().toISOString(),
        );
      return true;
    } catch {
      return false;
    }
  }

  deletePantryOverride(name: string): boolean {
    try {
      this.database
        .prepare("DELETE FROM pantry_overrides WHERE canonical_name = ?")
        .run(name);
      return true;
    } catch {
      return false;
    }
  }

  addSuggestion(suggestion: StoredSuggestion): number {
    try {
      const existing = this.database
        .prepare(
          `SELECT id FROM suggestions
           WHERE status = 'pending' AND kind = ? AND canonical_name = ?`,
        )
        .get(suggestion.kind, suggestion.name);
      if (existing) {
        suggestion.id = number(existing.id);
        return suggestion.id;
      }

      suggestion.createdAt =
        timestampFrom(suggestion.createdAt) ?? this.clock.now();
      suggestion.importId =
        (suggestion.importId ?? 0) > 0 ? suggestion.importId : undefined;
      const result = this.database
        .prepare(
          `INSERT INTO suggestions
            (kind, canonical_name, message, import_id, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          suggestion.kind,
          suggestion.name,
          suggestion.message,
          suggestion.importId ?? null,
          timestampValue(suggestion.createdAt),
        );
      const id = number(result.lastInsertRowid);
      if (!Number.isSafeInteger(id) || id <= 0) {
        return 0;
      }
      suggestion.id = id;
      return id;
    } catch {
      return 0;
    }
  }

  pendingSuggestions(): StoredSuggestion[] {
    try {
      return this.database
        .prepare(
          `SELECT * FROM suggestions
           WHERE status = 'pending'
           ORDER BY id`,
        )
        .all()
        .map(suggestionFrom);
    } catch {
      return [];
    }
  }

  suggestion(id: number): StoredSuggestion | undefined {
    try {
      const row = this.database
        .prepare(
          `SELECT * FROM suggestions
           WHERE id = ? AND status = 'pending'`,
        )
        .get(id);
      return row ? suggestionFrom(row) : undefined;
    } catch {
      return undefined;
    }
  }

  resolveSuggestion(id: number, accepted: boolean): boolean {
    try {
      const result = this.database
        .prepare(
          `UPDATE suggestions
           SET status = ?, resolved_at = ?
           WHERE id = ? AND status = 'pending'`,
        )
        .run(
          accepted ? "accepted" : "dismissed",
          this.clock.now().toISOString(),
          id,
        );
      return number(result.changes) === 1;
    } catch {
      return false;
    }
  }

  addShoppingEntry(entry: ShoppingEntry): number {
    if (entry.names.length === 0) {
      return 0;
    }
    const createdAt =
      timestampFrom(entry.createdAt) ?? this.clock.now();
    try {
      const result = this.database
        .prepare(
          `INSERT OR IGNORE INTO shopping_items
            (names, dedupe_key, category, origin, note, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          JSON.stringify(entry.names),
          dedupeKey(entry),
          text(entry.category),
          entry.origin,
          text(entry.note),
          createdAt.toISOString(),
        );
      if (number(result.changes) === 0) {
        return 0;
      }
      const id = number(result.lastInsertRowid);
      if (!Number.isSafeInteger(id) || id <= 0) {
        return 0;
      }
      entry.id = id;
      entry.createdAt = createdAt.toISOString();
      return id;
    } catch {
      return 0;
    }
  }

  shoppingEntries(): ShoppingEntry[] {
    try {
      return this.database
        .prepare(
          `SELECT id, names, category, origin, note, created_at
           FROM shopping_items
           ORDER BY id`,
        )
        .all()
        .map(shoppingEntryFrom);
    } catch {
      return [];
    }
  }

  removeShoppingEntry(id: number): boolean {
    try {
      const result = this.database
        .prepare("DELETE FROM shopping_items WHERE id = ?")
        .run(id);
      return number(result.changes) === 1;
    } catch {
      return false;
    }
  }

  clearShoppingList(): boolean {
    try {
      this.database.exec("DELETE FROM shopping_items");
      return true;
    } catch {
      return false;
    }
  }

  setting(key: string, fallback = ""): string {
    try {
      const row = this.database
        .prepare("SELECT value FROM settings WHERE key = ?")
        .get(key);
      return row ? text(row.value) : fallback;
    } catch {
      return fallback;
    }
  }

  setSetting(key: string, value: string): boolean {
    try {
      this.database
        .prepare(
          `INSERT INTO settings (key, value)
           VALUES (?, ?)
           ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
        )
        .run(key, value);
      return true;
    } catch {
      return false;
    }
  }

  private canonicalImportsDirectory(): string | null {
    if (!this.importsDirectory) {
      return null;
    }
    try {
      return realpathSync(this.importsDirectory);
    } catch {
      return null;
    }
  }

  private directImportPath(path: string, root: string): string | null {
    if (!path) {
      return null;
    }
    const absolutePath = isAbsolute(path)
      ? resolve(path)
      : resolve(root, path);
    try {
      return realpathSync(dirname(absolutePath)) === root ? absolutePath : null;
    } catch {
      return null;
    }
  }

  private safeFileOrMissing(path: string): boolean {
    try {
      const info = lstatSync(path);
      return info.isFile() && !info.isSymbolicLink();
    } catch (error) {
      return isMissing(error);
    }
  }
}
