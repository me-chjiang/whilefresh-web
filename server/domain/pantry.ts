import { ItemStatus, SuggestionKind } from "../../shared/enums.js";
import type { Catalog } from "./catalog.js";
import { isRuleEligibleName } from "./shelf-life.js";
import {
  suggestionAddToPantry,
  suggestionAddToShopping,
  suggestionMarkPantryHave,
} from "./texts.js";

export interface PantryOverride {
  name: string;
  pantry?: boolean;
  bulk?: boolean;
  out?: boolean;
}

export interface Suggestion {
  kind: SuggestionKind;
  name: string;
  message: string;
}

export class PantryRules {
  private readonly overrides = new Map<string, PantryOverride>();

  constructor(private readonly catalog: Catalog | null = null) {}

  setOverride(override: PantryOverride): void {
    this.overrides.set(override.name, { ...override });
  }

  overrideFor(name: string): PantryOverride {
    return { ...(this.overrides.get(name) ?? { name }) };
  }

  isPantry(name: string): boolean {
    const override = this.overrides.get(name);
    if (override && typeof override.pantry === "boolean") {
      return override.pantry;
    }
    return this.catalog?.pantryDefault(name) ?? false;
  }

  isBulk(name: string): boolean {
    const override = this.overrides.get(name);
    if (override && typeof override.bulk === "boolean") {
      return override.bulk;
    }
    return this.catalog?.bulkDefault(name) ?? false;
  }

  isOut(name: string): boolean {
    return this.overrides.get(name)?.out === true;
  }

  isAtHome(name: string): boolean {
    return this.isPantry(name) && !this.isOut(name);
  }

  pantryNames(): string[] {
    const names =
      this.catalog?.entries
        .filter((entry) => this.isPantry(entry.name))
        .map((entry) => entry.name) ?? [];
    const catalogNames = new Set(
      this.catalog?.entries.map((entry) => entry.name) ?? [],
    );
    const extra = [...this.overrides.values()]
      .filter(
        (override) =>
          override.pantry === true && !catalogNames.has(override.name),
      )
      .map((override) => override.name)
      .sort();
    return [...names, ...extra];
  }

  namesAtHome(): string[] {
    return this.pantryNames().filter((name) => !this.isOut(name));
  }
}

export function statusAfterUse(bulk: boolean): ItemStatus {
  return bulk ? ItemStatus.InStock : ItemStatus.Used;
}

export function suggestionsAfterPurchase(
  name: string,
  rules: PantryRules,
): Suggestion | null {
  if (!isRuleEligibleName(name)) {
    return null;
  }
  if (rules.isPantry(name)) {
    return rules.isOut(name)
      ? {
          kind: SuggestionKind.MarkPantryHave,
          name,
          message: suggestionMarkPantryHave(name),
        }
      : null;
  }
  return {
    kind: SuggestionKind.AddToPantry,
    name,
    message: suggestionAddToPantry(name),
  };
}

export function suggestionsAfterAbsent(
  name: string,
  rules: PantryRules,
): Suggestion | null {
  if (
    !isRuleEligibleName(name) ||
    !(rules.isPantry(name) || rules.isBulk(name))
  ) {
    return null;
  }
  return {
    kind: SuggestionKind.AddToShopping,
    name,
    message: suggestionAddToShopping(name),
  };
}
