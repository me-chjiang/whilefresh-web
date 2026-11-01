import {
  ShelfLifeSource,
  StartBasis,
  Storage,
  StorageSource,
} from "../../shared/enums.js";
import { addDays, daysBetween } from "./clock.js";
import {
  freshnessUnknownHint,
  ruleQuestionShelfLife,
  ruleQuestionStorage,
  sourceReference,
} from "./texts.js";

type JsonObject = Record<string, unknown>;

export interface StorageDays {
  fridge?: number | null;
  freezer?: number | null;
  room?: number | null;
}

export interface ShelfLifeReference {
  days: StorageDays;
  source: string;
  foodkeeperId: string;
  basis: Record<string, string>;
}

export interface ShelfLifeHit {
  days: number;
  matchedName: string;
  reference: ShelfLifeReference;
}

export interface ShelfLifeRowHit {
  matchedName: string;
  reference: ShelfLifeReference;
}

interface CatalogAncestors {
  ancestors(name: string): readonly string[];
  resolve(name: string): string;
}

export interface ShelfLifeRule {
  name: string;
  storage: Storage;
  days: number;
}

export interface StorageRule {
  name: string;
  storage: Storage;
}

export interface AiCacheEntry {
  name: string;
  storage: Storage;
  days: number;
}

export interface ShelfLifeInput {
  name: string;
  storage?: Storage;
  productionDate?: string | null;
  purchaseDate?: string | null;
  entryDate?: string | null;
  packageExpiry?: string | null;
  labelledDays?: number | null;
  manualDays?: number | null;
  aiDays?: StorageDays | null;
  referenceConditionsConfirmed?: boolean;
}

export interface ShelfLifeContext {
  catalog?: CatalogAncestors | null;
  table?: ShelfLifeTable | null;
  rules?: RuleBook | null;
  aiCache?: AiEstimateCache | null;
}

export interface ShelfLifeResolution {
  source: ShelfLifeSource;
  days: number | null;
  expiryDate: string | null;
  startBasis: StartBasis;
  startDate: string | null;
  note: string;
  newAiEstimates: AiCacheEntry[];
  isEstimate: boolean;
}

export interface StorageSuggestion {
  storage: Storage;
  source: StorageSource;
}

export type RuleProposalKind = "shelf" | "storage";

export interface RuleProposal {
  kind: RuleProposalKind;
  name: string;
  storage: Storage;
  days: number;
  question: string;
}

type EditDate = string | { date?: string | null } | null | undefined;

export interface RuleEditState {
  name?: string;
  canonicalName?: string;
  storage: Storage;
  manualDays?: number | null;
  expiryDate?: EditDate;
  purchaseDate?: EditDate;
  productionDate?: EditDate;
  shelfLifeDays?: number | null;
}

export const allStorages = [
  Storage.Fridge,
  Storage.Freezer,
  Storage.Room,
] as const;

const uncategorized = "未归类";

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveDays(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const days = Math.trunc(value);
  return days > 0 ? days : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function referenceFromObject(object: JsonObject): ShelfLifeReference {
  let foodkeeperId = "";
  if (typeof object.foodkeeper_id === "number") {
    foodkeeperId = String(Math.trunc(object.foodkeeper_id));
  } else {
    foodkeeperId = text(object.foodkeeper_id);
  }

  const basis: Record<string, string> = {};
  if (isObject(object.basis)) {
    for (const [storage, value] of Object.entries(object.basis)) {
      basis[storage] = text(value);
    }
  } else if (typeof object.basis === "string") {
    for (const storage of allStorages) {
      basis[storage] = object.basis;
    }
  }

  return {
    days: {
      fridge: positiveDays(object.fridge_days),
      freezer: positiveDays(object.freezer_days),
      room: positiveDays(object.room_days),
    },
    source: text(object.source),
    foodkeeperId,
    basis,
  };
}

function daysForStorage(
  days: StorageDays | null | undefined,
  storage: Storage,
): number | null {
  return days?.[storage] ?? null;
}

function validDate(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  try {
    addDays(value, 0);
    return value;
  } catch {
    return null;
  }
}

function startBasisNote(basis: StartBasis): string {
  switch (basis) {
    case StartBasis.ProductionDate:
      return "从生产日期起算";
    case StartBasis.PurchaseDate:
      return "从购买日期起算";
    case StartBasis.EntryDate:
      return "购买时间未知，按入库日期估算";
    case StartBasis.None:
      return "";
  }
}

function storageDisplayName(storage: Storage): string {
  switch (storage) {
    case Storage.Fridge:
      return "冷藏";
    case Storage.Freezer:
      return "冷冻";
    case Storage.Room:
      return "常温";
  }
}

export function isRuleEligibleName(name: string): boolean {
  return name.trim().length > 0 && name !== uncategorized;
}

export class ShelfLifeTable {
  private readonly rows = new Map<string, ShelfLifeReference>();
  private source = "";

  static fromJson(json: string): ShelfLifeTable {
    let root: unknown;
    try {
      root = JSON.parse(json) as unknown;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`shelf-life: ${message}`);
    }
    if (!isObject(root)) {
      throw new Error("shelf-life: not an object");
    }

    const table = new ShelfLifeTable();
    if (typeof root.source === "string") {
      table.setSourceName(root.source);
    }

    if (Array.isArray(root.items)) {
      for (const value of root.items) {
        if (!isObject(value)) {
          continue;
        }
        const name = text(value.name).trim();
        if (name.length > 0) {
          table.insert(name, referenceFromObject(value));
        }
      }
      return table;
    }

    const rows = isObject(root.items) ? root.items : root;
    for (const [name, value] of Object.entries(rows)) {
      if (isObject(value)) {
        table.insert(name.trim(), referenceFromObject(value));
      }
    }
    return table;
  }

  insert(name: string, reference: ShelfLifeReference): void {
    this.rows.set(name, reference);
  }

  setSourceName(name: string): void {
    this.source = name;
  }

  sourceName(): string {
    return this.source;
  }

  isEmpty(): boolean {
    return this.rows.size === 0;
  }

  size(): number {
    return this.rows.size;
  }

  row(
    name: string,
    catalog?: CatalogAncestors | null,
  ): ShelfLifeRowHit | null {
    const chain = [name, ...(catalog?.ancestors(name) ?? [])];
    for (const candidate of chain) {
      const reference = this.rows.get(candidate);
      if (reference) {
        return { matchedName: candidate, reference };
      }
    }
    return null;
  }

  lookup(
    name: string,
    storage: Storage,
    catalog?: CatalogAncestors | null,
  ): ShelfLifeHit | null {
    const row = this.row(name, catalog);
    if (!row) {
      return null;
    }
    const days = daysForStorage(row.reference.days, storage);
    if (days === null) {
      return null;
    }
    return {
      days,
      matchedName: row.matchedName,
      reference: row.reference,
    };
  }
}

export class RuleBook {
  private readonly shelfDays = new Map<string, number>();
  private readonly storages = new Map<string, Storage>();

  static key(name: string, storage: Storage): string {
    return `${name}\u001f${storage}`;
  }

  setShelfLife(rule: ShelfLifeRule): void {
    this.shelfDays.set(RuleBook.key(rule.name, rule.storage), rule.days);
  }

  setStorage(rule: StorageRule): void {
    this.storages.set(rule.name, rule.storage);
  }

  shelfLifeDays(name: string, storage: Storage): number | null {
    return this.shelfDays.get(RuleBook.key(name, storage)) ?? null;
  }

  storage(name: string): Storage | null {
    return this.storages.get(name) ?? null;
  }
}

export class AiEstimateCache {
  private readonly estimates = new Map<string, number>();

  insert(name: string, storage: Storage, days: number): void {
    this.estimates.set(RuleBook.key(name, storage), days);
  }

  days(name: string, storage: Storage): number | null {
    return this.estimates.get(RuleBook.key(name, storage)) ?? null;
  }
}

export function resolveShelfLife(
  input: ShelfLifeInput,
  context: ShelfLifeContext = {},
): ShelfLifeResolution {
  const storage = input.storage ?? Storage.Fridge;
  const purchaseDate = validDate(input.purchaseDate);
  const entryDate = validDate(input.entryDate);
  const productionDate = validDate(input.productionDate);
  const packageExpiry = validDate(input.packageExpiry);

  let startBasis: StartBasis = StartBasis.None;
  let startDate: string | null = null;
  if (purchaseDate !== null) {
    startBasis = StartBasis.PurchaseDate;
    startDate = purchaseDate;
  } else if (entryDate !== null) {
    startBasis = StartBasis.EntryDate;
    startDate = entryDate;
  }

  const eligible = isRuleEligibleName(input.name);
  const newAiEstimates: AiCacheEntry[] = [];
  if (eligible) {
    for (const candidate of allStorages) {
      const estimated = daysForStorage(input.aiDays, candidate);
      if (
        estimated !== null &&
        estimated > 0 &&
        context.aiCache?.days(input.name, candidate) == null
      ) {
        newAiEstimates.push({
          name: input.name,
          storage: candidate,
          days: estimated,
        });
      }
    }
  }

  let source: ShelfLifeSource = ShelfLifeSource.None;
  let days: number | null = null;
  let expiryDate: string | null = null;
  let note = "";

  if (input.manualDays == null && packageExpiry !== null) {
    if (productionDate !== null) {
      startBasis = StartBasis.ProductionDate;
      startDate = productionDate;
    }
    source = ShelfLifeSource.Package;
    expiryDate = packageExpiry;
    if (startDate !== null) {
      days = Math.max(1, daysBetween(startDate, packageExpiry));
    }
    note = `包装到期日 ${packageExpiry}`;
    return {
      source,
      days,
      expiryDate,
      startBasis,
      startDate,
      note,
      newAiEstimates,
      isEstimate: false,
    };
  }

  const storageName = storageDisplayName(storage);
  if (input.manualDays != null && input.manualDays > 0) {
    days = input.manualDays;
    source = ShelfLifeSource.Manual;
    note = `你为这件食材设置的 ${days} 天`;
  } else if (input.labelledDays != null && input.labelledDays > 0) {
    days = input.labelledDays;
    if (productionDate !== null) {
      startBasis = StartBasis.ProductionDate;
      startDate = productionDate;
    }
    source = ShelfLifeSource.Package;
    note = `包装标注保质期 ${days} 天`;
  } else {
    const ruleDays =
      eligible && context.rules
        ? context.rules.shelfLifeDays(input.name, storage)
        : null;
    if (ruleDays !== null) {
      days = ruleDays;
      source = ShelfLifeSource.LocalRule;
      note = `你确认过：${input.name}${storageName} ${days} 天`;
    } else {
      const hit =
        eligible && context.table
          ? context.table.lookup(input.name, storage, context.catalog)
          : null;
      if (hit) {
        days = hit.days;
        source = ShelfLifeSource.Reference;
        const basis =
          hit.matchedName === input.name ? "" : `（按「${hit.matchedName}」）`;
        const sourceName = context.table?.sourceName() ?? "";
        const attribution =
          sourceName === "" ? sourceReference() : `参考：${sourceName}`;
        note = `${attribution}${basis}，${storageName} ${days} 天`;
      }
    }
  }

  if (days === null) {
    const cached =
      eligible && context.aiCache
        ? context.aiCache.days(input.name, storage)
        : null;
    if (cached !== null) {
      days = cached;
    } else {
      const fresh = daysForStorage(input.aiDays, storage);
      if (fresh !== null && fresh > 0) {
        days = fresh;
      }
    }
    if (days !== null) {
      source = ShelfLifeSource.AiEstimate;
      note = `AI 估计${storageName} ${days} 天`;
    }
  }

  if (days === null) {
    return {
      source: ShelfLifeSource.None,
      days: null,
      expiryDate: null,
      startBasis,
      startDate,
      note: freshnessUnknownHint(),
      newAiEstimates,
      isEstimate: true,
    };
  }

  if (startDate !== null) {
    expiryDate = addDays(startDate, days);
    note += `，${startBasisNote(startBasis)}`;
  }
  return {
    source,
    days,
    expiryDate,
    startBasis,
    startDate,
    note,
    newAiEstimates,
    isEstimate: source !== ShelfLifeSource.Package,
  };
}

export function suggestStorage(
  name: string,
  aiStorage: Storage | null,
  isSeasoning: boolean,
  context: ShelfLifeContext = {},
): StorageSuggestion {
  const eligible = isRuleEligibleName(name);
  if (eligible && context.rules) {
    const ruled = context.rules.storage(name);
    if (ruled !== null) {
      return { storage: ruled, source: StorageSource.LocalRule };
    }
  }

  if (eligible && context.table) {
    const row = context.table.row(name, context.catalog);
    if (row) {
      if (aiStorage && daysForStorage(row.reference.days, aiStorage) !== null) {
        return { storage: aiStorage, source: StorageSource.Reference };
      }

      const available = allStorages.filter(
        (storage) => daysForStorage(row.reference.days, storage) !== null,
      );
      if (available.length === 1) {
        return { storage: available[0], source: StorageSource.Reference };
      }
      for (const storage of [Storage.Fridge, Storage.Room, Storage.Freezer]) {
        if (daysForStorage(row.reference.days, storage) !== null) {
          return { storage, source: StorageSource.Reference };
        }
      }
    }
  }

  if (aiStorage) {
    return { storage: aiStorage, source: StorageSource.AiEstimate };
  }
  return {
    storage: isSeasoning ? Storage.Room : Storage.Fridge,
    source: StorageSource.Default,
  };
}

export function proposeShelfLifeRule(
  name: string,
  storage: Storage,
  days: number,
): RuleProposal | null {
  if (!isRuleEligibleName(name) || days <= 0) {
    return null;
  }
  return {
    kind: "shelf",
    name,
    storage,
    days,
    question: ruleQuestionShelfLife(name, storageDisplayName(storage), days),
  };
}

export function proposeStorageRule(
  name: string,
  storage: Storage,
): RuleProposal | null {
  if (!isRuleEligibleName(name)) {
    return null;
  }
  return {
    kind: "storage",
    name,
    storage,
    days: 0,
    question: ruleQuestionStorage(name, storageDisplayName(storage)),
  };
}

function editDate(value: EditDate): string | null {
  if (typeof value === "string") {
    return value.length > 0 ? value : null;
  }
  if (isObject(value) && typeof value.date === "string") {
    return value.date.length > 0 ? value.date : null;
  }
  return null;
}

function editName(state: RuleEditState): string {
  return state.name ?? state.canonicalName ?? "";
}

export function proposalsForEdit(
  before: RuleEditState,
  after: RuleEditState,
  catalog?: CatalogAncestors | null,
): RuleProposal[] {
  const name = editName(after);
  if (catalog && catalog.resolve(name) !== name) {
    return [];
  }

  const proposals: RuleProposal[] = [];
  if (before.storage !== after.storage) {
    const storageProposal = proposeStorageRule(name, after.storage);
    if (storageProposal) {
      proposals.push(storageProposal);
    }
  }

  if (
    (before.manualDays ?? null) !== (after.manualDays ?? null) ||
    editDate(before.expiryDate) !== editDate(after.expiryDate) ||
    editDate(before.purchaseDate) !== editDate(after.purchaseDate) ||
    editDate(before.productionDate) !== editDate(after.productionDate)
  ) {
    if (after.shelfLifeDays != null) {
      const shelfProposal = proposeShelfLifeRule(
        name,
        after.storage,
        after.shelfLifeDays,
      );
      if (shelfProposal) {
        proposals.push(shelfProposal);
      }
    }
  }
  return proposals;
}
