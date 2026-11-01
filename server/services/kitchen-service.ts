import {
  DateOrigin,
  Freshness,
  ItemStatus,
  ShoppingOrigin,
  Storage,
  SuggestionKind,
} from "../../shared/enums.js";
import type { BuiltinData } from "../data/builtin.js";
import {
  Store,
  type FridgeItem,
  type ImportRecord,
  type StoredSuggestion,
} from "../data/store.js";
import { addDays, type Clock } from "../domain/clock.js";
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
  RecipeMatcher,
  rankForBrowsing,
  rankForClearFridge,
  type Recipe,
  type RecipeMatch,
  type StockEntry,
} from "../domain/recipe.js";
import {
  proposalsForEdit,
  resolveShelfLife,
  type RuleProposal,
  type ShelfLifeResolution,
} from "../domain/shelf-life.js";
import {
  dedupeKey,
  entriesForMissing,
  makeShoppingEntry,
  toText as shoppingListText,
  type ShoppingEntry,
} from "../domain/shopping-list.js";

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

export interface ClearFridgePreview {
  selectedCount: number;
  candidateCount: number;
  completeCount: number;
  uncovered: string[];
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

  constructor({ store, builtin, clock }: KitchenServiceOptions) {
    this.store = store;
    this.builtin = builtin;
    this.clock = clock;
  }

  fridge(): FridgeItem[] {
    return this.store.items();
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
    }

    const name = item.canonicalName ?? "";
    item.category = this.builtin.catalog.categoryOf(name);
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

  setUseFirst(id: number, enabled: boolean): boolean {
    const item = this.store.item(id);
    if (!item) {
      return false;
    }
    item.useFirst = enabled;
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

  recipes(search = ""): RecipeMatch[] {
    const term = search.trim().toLocaleLowerCase();
    const matches = new RecipeMatcher(
      this.builtin.catalog,
      this.stock(),
    ).matchAll(this.builtin.recipes);
    return rankForBrowsing(
      term
        ? matches.filter((match) =>
            match.recipe.name.toLocaleLowerCase().includes(term),
          )
        : matches,
    );
  }

  clearFridge(selected: readonly number[]): RecipeMatch[] {
    return rankForClearFridge(
      new RecipeMatcher(
        this.builtin.catalog,
        this.stock(selected),
      ).matchAll(this.builtin.recipes),
    );
  }

  clearFridgePreview(selected: readonly number[]): ClearFridgePreview {
    const matcher = new RecipeMatcher(
      this.builtin.catalog,
      this.stock(selected),
    );
    const names = new Set(matcher.selectedNames);
    const preview: ClearFridgePreview = {
      selectedCount: names.size,
      candidateCount: 0,
      completeCount: 0,
      uncovered: [],
    };
    if (names.size === 0) {
      return preview;
    }

    const covered = new Set<string>();
    for (const recipe of this.builtin.recipes) {
      const match = matcher.match(recipe);
      if (match.usedSelected.length === 0) {
        continue;
      }
      preview.candidateCount += 1;
      if (match.unusedSelected.length === 0) {
        preview.completeCount += 1;
      }
      for (const name of match.usedSelected) {
        covered.add(name);
      }
    }
    preview.uncovered = [...names].filter((name) => !covered.has(name)).sort();
    return preview;
  }

  recipe(id: string, selected: readonly number[] = []): RecipeMatch | null {
    const recipe = this.builtin.recipes.find(
      (candidate): candidate is Recipe => candidate.id === id,
    );
    if (!recipe) {
      return null;
    }
    return new RecipeMatcher(
      this.builtin.catalog,
      this.stock(selected),
    ).match(recipe);
  }

  addMissing(recipeId: string, selected: readonly number[] = []): number {
    const match = this.recipe(recipeId, selected);
    if (!match) {
      return 0;
    }
    let added = 0;
    for (const entry of entriesForMissing(
      match.recipe,
      match,
      this.builtin.catalog,
    )) {
      if (this.store.addShoppingEntry(entry) > 0) {
        added += 1;
      }
    }
    return added;
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

  deleteAllData(): boolean {
    return this.store.deleteAllData();
  }

  private stock(selected: readonly number[] = []): StockEntry[] {
    const selectedIds = new Set(selected);
    const result: StockEntry[] = this.fridge().map((item) => ({
      name: item.canonicalName ?? "",
      itemId: item.id ?? 0,
      pantry: false,
      selected: item.id != null && selectedIds.has(item.id),
      nearExpiry:
        this.freshness(item).freshness === Freshness.NearExpiry,
    }));
    for (const name of this.pantryRules().namesAtHome()) {
      result.push({
        name,
        itemId: 0,
        pantry: true,
        selected: false,
        nearExpiry: false,
      });
    }
    return result;
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
