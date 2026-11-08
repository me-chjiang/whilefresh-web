import {
  DateOrigin,
  Freshness,
  ItemKind,
  ItemStatus,
  ShoppingOrigin,
  Storage,
  SuggestionKind,
} from "../../shared/enums.js";
import type { BuiltinData } from "../data/builtin.js";
import {
  Store,
  isSnoozed,
  type FridgeItem,
  type ImportRecord,
  type StoredSuggestion,
} from "../data/store.js";
import { addDays, type Clock } from "../domain/clock.js";
import {
  classifyItemKind,
  sortForFridge,
} from "../domain/fridge-groups.js";
import {
  evaluateFreshness,
  type FreshnessState,
} from "../domain/freshness.js";
import {
  PantryRules,
  statusAfterUse,
  suggestionsAfterAbsent,
  type PantryOverride,
} from "../domain/pantry.js";
import {
  proposalsForEdit,
  resolveShelfLife,
  type RuleProposal,
  type ShelfLifeResolution,
} from "../domain/shelf-life.js";
import {
  dedupeKey,
  makeShoppingEntry,
  toText as shoppingListText,
  type ShoppingEntry,
} from "../domain/shopping-list.js";
import { totalAmount } from "../domain/quantity.js";
import { sameStatusState } from "../domain/undo.js";

const UNDO_TTL_MS = 30_000;
const UNDO_CAPACITY = 20;

interface UndoEntry {
  expiresAt: number;
  before: FridgeItem[];
  after: FridgeItem[];
  overridesBefore: Map<string, PantryOverride | null>;
  createdSuggestionIds: number[];
}

export interface UndoableResult {
  ok: boolean;
  token: string;
  suggestions: string[];
}

export type UndoOutcome = "ok" | "expired" | "changed";

export interface KitchenServiceOptions {
  store: Store;
  builtin: BuiltinData;
  clock: Clock;
}

export interface SaveItemResult {
  ok: boolean;
  error: string;
  proposals: RuleProposal[];
}

function dateIsSet(value: string | null | undefined): boolean {
  if (!value) {
    return false;
  }
  try {
    addDays(value, 0);
    return true;
  } catch {
    return false;
  }
}

function sameOptionalNumber(
  left: number | null | undefined,
  right: number | null | undefined,
): boolean {
  return (left ?? null) === (right ?? null);
}

export class KitchenService {
  private readonly store: Store;
  private readonly builtin: BuiltinData;
  private readonly clock: Clock;
  private readonly undoJournal = new Map<string, UndoEntry>();
  private undoCounter = 0;

  constructor({ store, builtin, clock }: KitchenServiceOptions) {
    this.store = store;
    this.builtin = builtin;
    this.clock = clock;
  }

  fridge(): FridgeItem[] {
    return sortForFridge(
      this.store.items().map((item) => ({
        ...item,
        id: item.id ?? 0,
        canonicalName: item.canonicalName ?? "",
        displayName: item.displayName ?? "",
        kind: item.kind ?? ItemKind.Food,
        storage: item.storage ?? Storage.Fridge,
      })),
      this.clock.today(),
    );
  }

  attention(): FridgeItem[] {
    const today = this.clock.today();
    return this.fridge().filter((item) => {
      const freshness = this.freshness(item).freshness;
      return (
        (freshness === Freshness.NearExpiry ||
          freshness === Freshness.BeyondEstimate) &&
        !isSnoozed(item, today)
      );
    });
  }

  nearCount(): number {
    const today = this.clock.today();
    return this.fridge().filter(
      (item) =>
        this.freshness(item).freshness === Freshness.NearExpiry &&
        !isSnoozed(item, today),
    ).length;
  }

  freshness(item: FridgeItem): FreshnessState {
    return evaluateFreshness(
      item.expiryDate,
      item.shelfLifeDays,
      this.clock.today(),
    );
  }

  defaultSelection(): number[] {
    return this.fridge()
      .filter(
        (item) =>
          item.useFirst === true ||
          this.freshness(item).freshness === Freshness.NearExpiry,
      )
      .flatMap((item) => (item.id && item.id > 0 ? [item.id] : []));
  }

  saveItem(item: FridgeItem): SaveItemResult {
    const canonicalName = item.canonicalName ?? "";
    if (
      canonicalName !== "未归类" &&
      this.builtin.catalog.resolve(canonicalName) !== canonicalName
    ) {
      return {
        ok: false,
        error: "请填写名称、有效数量和保质天数，并确认标准食材名",
        proposals: [],
      };
    }
    if (
      !item.displayName?.trim() ||
      (item.count ?? 1) <= 0 ||
      (item.manualDays != null && item.manualDays <= 0) ||
      (item.labelledDays != null && item.labelledDays <= 0)
    ) {
      return {
        ok: false,
        error: "请填写名称、有效数量和保质天数，并确认标准食材名",
        proposals: [],
      };
    }

    let before: FridgeItem | undefined;
    if (item.id && item.id > 0) {
      before = this.store.item(item.id);
      if (!before) {
        return { ok: false, error: "", proposals: [] };
      }

      item.importId = before.importId;
      item.createdAt = before.createdAt;
      if (before.canonicalName !== item.canonicalName) {
        item.aiDays = {};
        item.referenceConditionsConfirmed = false;
      }
      if (before.storage !== item.storage) {
        item.referenceConditionsConfirmed = false;
        if (sameOptionalNumber(before.manualDays, item.manualDays)) {
          item.manualDays = null;
        }
      }
      if (before.productionDate?.date !== item.productionDate?.date) {
        item.productionDate = {
          ...item.productionDate,
          date: item.productionDate?.date ?? null,
          origin: dateIsSet(item.productionDate?.date)
            ? DateOrigin.User
            : DateOrigin.None,
        };
      }
      if (before.purchaseDate?.date !== item.purchaseDate?.date) {
        item.purchaseDate = {
          ...item.purchaseDate,
          date: item.purchaseDate?.date ?? null,
          origin: dateIsSet(item.purchaseDate?.date)
            ? DateOrigin.User
            : DateOrigin.None,
        };
      }
      if (before.packageExpiry?.date !== item.packageExpiry?.date) {
        item.packageExpiry = {
          ...item.packageExpiry,
          date: item.packageExpiry?.date ?? null,
          origin: dateIsSet(item.packageExpiry?.date)
            ? DateOrigin.User
            : DateOrigin.None,
        };
        item.manualDays = null;
      }
      if (
        before.quantityText !== item.quantityText ||
        before.count !== item.count
      ) {
        const amount = totalAmount(item.quantityText ?? "", item.count ?? 1);
        item.amount = amount.value;
        item.unit = amount.unit;
      }
    } else {
      item.importId = 0;
      if (!dateIsSet(item.entryDate)) {
        item.entryDate = this.clock.today();
      }
      item.productionDate = {
        ...item.productionDate,
        date: item.productionDate?.date ?? null,
        origin: dateIsSet(item.productionDate?.date)
          ? DateOrigin.User
          : DateOrigin.None,
      };
      item.purchaseDate = {
        ...item.purchaseDate,
        date: item.purchaseDate?.date ?? null,
        origin: dateIsSet(item.purchaseDate?.date)
          ? DateOrigin.User
          : DateOrigin.None,
      };
      item.packageExpiry = {
        ...item.packageExpiry,
        date: item.packageExpiry?.date ?? null,
        origin: dateIsSet(item.packageExpiry?.date)
          ? DateOrigin.User
          : DateOrigin.None,
      };
      const amount = totalAmount(item.quantityText ?? "", item.count ?? 1);
      item.amount = amount.value;
      item.unit = amount.unit;
    }

    const name = item.canonicalName ?? "";
    item.category = this.builtin.catalog.categoryOf(name);
    this.classify(item);
    this.resolve(item);
    const ok = before
      ? this.store.updateItem(item)
      : this.store.insertItem(item) > 0;
    return {
      ok,
      error: "",
      proposals:
        ok && before ? this.proposalsForEdit(before, item) : [],
    };
  }

  useItem(id: number): boolean {
    const item = this.store.item(id);
    if (!item || item.status !== ItemStatus.InStock) {
      return false;
    }
    item.status = statusAfterUse(
      this.pantryRules().isBulk(item.canonicalName ?? ""),
    );
    item.statusChangedAt = this.clock.now();
    return this.store.updateItem(item);
  }

  markAbsent(id: number): boolean {
    return this.transaction(() => {
      const item = this.store.item(id);
      if (!item) {
        return false;
      }
      item.status = ItemStatus.Absent;
      item.statusChangedAt = this.clock.now();
      if (!this.store.updateItem(item)) {
        return false;
      }

      const rules = this.pantryRules();
      const another = this.fridge().some(
        (other) => other.canonicalName === item.canonicalName,
      );
      if (!another) {
        const override = rules.overrideFor(item.canonicalName ?? "");
        if (rules.isPantry(item.canonicalName ?? "")) {
          override.out = true;
          if (!this.store.savePantryOverride(override)) {
            return false;
          }
        }
        const suggestion = suggestionsAfterAbsent(
          item.canonicalName ?? "",
          rules,
        );
        if (suggestion && this.store.addSuggestion(suggestion) <= 0) {
          return false;
        }
      }
      return true;
    });
  }

  runUndoable(
    ids: readonly number[],
    action: () => boolean,
  ): UndoableResult {
    const before = ids.flatMap((id) => {
      const item = this.store.item(id);
      return item ? [structuredClone(item)] : [];
    });
    const names = new Set(
      before.map((item) => item.canonicalName ?? ""),
    );
    const overridesFor = (): Map<string, PantryOverride | null> => {
      const overrides = this.store.pantryOverrides();
      return new Map(
        [...names].map((name) => [
          name,
          overrides.find((override) => override.name === name) ?? null,
        ]),
      );
    };
    const overridesBefore = overridesFor();
    const pendingBefore = new Set(
      this.store.pendingSuggestions().map((suggestion) => suggestion.id),
    );

    if (!action()) {
      return { ok: false, token: "", suggestions: [] };
    }

    const overridesAfter = overridesFor();
    const changedOverrides = new Map(
      [...overridesBefore].filter(
        ([name, prior]) =>
          JSON.stringify(prior) !== JSON.stringify(overridesAfter.get(name)),
      ),
    );
    const pending = this.store.pendingSuggestions();
    const suggestions = [
      ...new Set(
        pending
          .filter(
            (suggestion) =>
              suggestion.kind === SuggestionKind.AddToShopping &&
              names.has(suggestion.name),
          )
          .map((suggestion) => suggestion.name),
      ),
    ];
    const now = this.clock.now().getTime();
    for (const [token, entry] of this.undoJournal) {
      if (entry.expiresAt <= now) {
        this.undoJournal.delete(token);
      }
    }
    while (this.undoJournal.size >= UNDO_CAPACITY) {
      const oldest = this.undoJournal.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.undoJournal.delete(oldest);
    }
    this.undoCounter += 1;
    const token = `u${this.undoCounter}`;
    this.undoJournal.set(token, {
      expiresAt: now + UNDO_TTL_MS,
      before,
      after: before.flatMap((item) => {
        const current = this.store.item(item.id ?? 0);
        return current ? [current] : [];
      }),
      overridesBefore: changedOverrides,
      createdSuggestionIds: pending
        .filter((suggestion) => !pendingBefore.has(suggestion.id))
        .flatMap((suggestion) =>
          suggestion.id === undefined ? [] : [suggestion.id],
        ),
    });
    return { ok: true, token, suggestions };
  }

  undo(token: string): UndoOutcome {
    const entry = this.undoJournal.get(token);
    this.undoJournal.delete(token);
    if (!entry || entry.expiresAt <= this.clock.now().getTime()) {
      return "expired";
    }
    for (const expected of entry.after) {
      const current = this.store.item(expected.id ?? 0);
      if (!current || !sameStatusState(current, expected)) {
        return "changed";
      }
    }
    const restored = this.transaction(() => {
      for (const item of entry.before) {
        if (!this.store.updateItem(structuredClone(item))) {
          return false;
        }
      }
      for (const [name, prior] of entry.overridesBefore) {
        const done = prior
          ? this.store.savePantryOverride(prior)
          : this.store.deletePantryOverride(name);
        if (!done) {
          return false;
        }
      }
      for (const id of entry.createdSuggestionIds) {
        this.store.deleteSuggestion(id);
      }
      return true;
    });
    return restored ? "ok" : "changed";
  }

  setUseFirst(id: number, enabled: boolean): boolean {
    const item = this.store.item(id);
    if (!item) {
      return false;
    }
    item.useFirst = enabled;
    return this.store.updateItem(item);
  }

  changeStorage(id: number, storage: Storage): boolean {
    const item = this.store.item(id);
    if (!item) {
      return false;
    }
    item.storage = storage;
    item.manualDays = null;
    item.referenceConditionsConfirmed = false;
    this.classify(item);
    this.resolve(item);
    return this.store.updateItem(item);
  }

  discardItem(id: number): boolean {
    const item = this.store.item(id);
    if (!item || item.status !== ItemStatus.InStock) {
      return false;
    }
    item.status = ItemStatus.Discarded;
    item.statusChangedAt = this.clock.now();
    return this.store.updateItem(item);
  }

  snoozeItem(id: number): boolean {
    const item = this.store.item(id);
    if (
      !item ||
      item.status !== ItemStatus.InStock ||
      this.freshness(item).freshness !== Freshness.NearExpiry
    ) {
      return false;
    }
    item.snoozedUntil = addDays(this.clock.today(), 1);
    return this.store.updateItem(item);
  }

  resolve(item: FridgeItem): ShelfLifeResolution {
    const result = resolveShelfLife(
      {
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
      },
      {
        catalog: this.builtin.catalog,
        table: this.builtin.shelfLife,
        rules: this.store.ruleBook(),
        aiCache: this.store.aiEstimateCache(),
      },
    );
    item.shelfLifeSource = result.source;
    item.shelfLifeDays = result.days;
    item.expiryDate = result.expiryDate;
    item.startBasis = result.startBasis;
    item.shelfLifeNote = result.note;
    return result;
  }

  confirmRule(proposal: RuleProposal): boolean {
    if (
      this.builtin.catalog.resolve(proposal.name) !== proposal.name
    ) {
      return false;
    }
    if (proposal.kind === "shelf") {
      return this.store.saveShelfLifeRule({
        name: proposal.name,
        storage: proposal.storage,
        days: proposal.days,
      });
    }
    return this.store.saveStorageRule({
      name: proposal.name,
      storage: proposal.storage,
    });
  }

  replaceRule(
    proposal: RuleProposal,
    oldStorage?: Storage | null,
  ): boolean {
    if (
      this.builtin.catalog.resolve(proposal.name) !== proposal.name
    ) {
      return false;
    }
    return this.transaction(() => {
      if (proposal.kind === "shelf") {
        if (
          !this.store.saveShelfLifeRule({
            name: proposal.name,
            storage: proposal.storage,
            days: proposal.days,
          })
        ) {
          return false;
        }
        if (
          oldStorage != null &&
          oldStorage !== proposal.storage &&
          !this.store.deleteShelfLifeRule(proposal.name, oldStorage)
        ) {
          return false;
        }
        return true;
      }
      return this.store.saveStorageRule({
        name: proposal.name,
        storage: proposal.storage,
      });
    });
  }

  deleteShelfRule(
    name: string,
    storage: Storage,
  ): boolean {
    return this.store.deleteShelfLifeRule(name, storage);
  }

  deleteStorageRule(name: string): boolean {
    return this.store.deleteStorageRule(name);
  }

  pantryRules(): PantryRules {
    const rules = new PantryRules(this.builtin.catalog);
    for (const override of this.store.pantryOverrides()) {
      rules.setOverride(override);
    }
    return rules;
  }

  setPantryOverride(override: PantryOverride): boolean {
    if (this.builtin.catalog.resolve(override.name) !== override.name) {
      return false;
    }
    return this.store.savePantryOverride(override);
  }

  suggestions(): StoredSuggestion[] {
    return this.store.pendingSuggestions();
  }

  decideSuggestion(id: number, accept: boolean): boolean {
    return this.transaction(() => {
      const suggestion = this.store.suggestion(id);
      if (!suggestion) {
        return false;
      }

      if (accept) {
        if (suggestion.kind === SuggestionKind.AddToShopping) {
          const entry = makeShoppingEntry(
            [suggestion.name],
            ShoppingOrigin.Pantry,
            "",
            this.builtin.catalog,
          );
          if (
            this.store.addShoppingEntry(entry) <= 0 &&
            !this.shopping().some(
              (existing) => dedupeKey(existing) === dedupeKey(entry),
            )
          ) {
            return false;
          }
        } else {
          const override = this.pantryRules().overrideFor(suggestion.name);
          override.pantry = true;
          override.out = false;
          if (!this.store.savePantryOverride(override)) {
            return false;
          }
        }
      }
      return this.store.resolveSuggestion(id, accept);
    });
  }

  shopping(): ShoppingEntry[] {
    return this.store.shoppingEntries();
  }

  shoppingText(): string {
    return shoppingListText(this.shopping(), this.builtin.catalog);
  }

  removeShopping(id: number): boolean {
    return this.store.removeShoppingEntry(id);
  }

  imports(): ImportRecord[] {
    return this.store.imports();
  }

  deleteImport(id: number): boolean {
    return this.store.deleteImport(id);
  }

  clearImportHistory(): boolean {
    return this.store.clearImportHistory();
  }

  deleteAllData(): boolean {
    return this.store.deleteAllData();
  }

  private proposalsForEdit(
    before: FridgeItem,
    after: FridgeItem,
  ): RuleProposal[] {
    return proposalsForEdit(
      {
        canonicalName: before.canonicalName,
        storage: before.storage ?? Storage.Fridge,
        manualDays: before.manualDays,
        expiryDate: before.expiryDate,
        purchaseDate: before.purchaseDate,
        productionDate: before.productionDate,
        shelfLifeDays: before.shelfLifeDays,
      },
      {
        canonicalName: after.canonicalName,
        storage: after.storage ?? Storage.Fridge,
        manualDays: after.manualDays,
        expiryDate: after.expiryDate,
        purchaseDate: after.purchaseDate,
        productionDate: after.productionDate,
        shelfLifeDays: after.shelfLifeDays,
      },
      this.builtin.catalog,
    );
  }

  private classify(item: FridgeItem): void {
    item.kind = classifyItemKind(
      item.canonicalName ?? "",
      item.kind === ItemKind.StapleSeasoning,
      item.storage ?? Storage.Fridge,
      this.builtin.catalog,
      this.builtin.shelfLife,
    );
  }

  private transaction(write: () => boolean): boolean {
    try {
      return this.store.transaction(() => {
        if (!write()) {
          throw new Error("kitchen transaction failed");
        }
        return true;
      });
    } catch {
      return false;
    }
  }
}
