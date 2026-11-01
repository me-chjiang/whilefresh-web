import { ShoppingOrigin } from "../../shared/enums.js";
import type { Catalog } from "./catalog.js";
import type { Recipe, RecipeMatch } from "./recipe.js";
import { orSeparator, shoppingListTitle } from "./texts.js";

export interface ShoppingEntry {
  id: number;
  names: string[];
  category: string;
  origin: ShoppingOrigin;
  note: string;
  createdAt: string;
}

export interface ShoppingSection {
  category: string;
  title: string;
  entries: ShoppingEntry[];
}

export function displayName(entry: ShoppingEntry): string {
  return entry.names.join(orSeparator());
}

export function dedupeKey(entry: ShoppingEntry): string {
  return [...entry.names].sort().join("\u001f");
}

export function makeShoppingEntry(
  names: readonly string[],
  origin: ShoppingOrigin,
  note: string,
  catalog: Catalog | null,
): ShoppingEntry {
  const uniqueNames: string[] = [];
  for (const name of names) {
    const trimmed = name.trim();
    if (trimmed.length > 0 && !uniqueNames.includes(trimmed)) {
      uniqueNames.push(trimmed);
    }
  }

  return {
    id: 0,
    names: uniqueNames,
    category:
      catalog && uniqueNames.length > 0
        ? catalog.categoryOf(uniqueNames[0] ?? "")
        : "other",
    origin,
    note,
    createdAt: "",
  };
}

export function entriesForMissing(
  recipe: Recipe,
  match: RecipeMatch,
  catalog: Catalog | null,
): ShoppingEntry[] {
  return match
    .missingGroups()
    .map((group) =>
      makeShoppingEntry(group, ShoppingOrigin.Recipe, recipe.name, catalog),
    );
}

function categoryRank(category: string, catalog: Catalog | null): number {
  if (!catalog) {
    return 0;
  }
  const index = catalog.categories.findIndex(
    (item) => item.code === category,
  );
  return index === -1 ? catalog.categories.length : index;
}

function categoryTitle(category: string, catalog: Catalog | null): string {
  if (!catalog) {
    return category;
  }
  return (
    catalog.categories.find((item) => item.code === category)?.name ??
    (category === "other" ? "其他" : category)
  );
}

export function sections(
  entries: readonly ShoppingEntry[],
  catalog: Catalog | null,
): ShoppingSection[] {
  const byCategory = new Map<string, ShoppingSection>();
  for (const entry of entries) {
    const section = byCategory.get(entry.category);
    if (section) {
      section.entries.push(entry);
    } else {
      byCategory.set(entry.category, {
        category: entry.category,
        title: categoryTitle(entry.category, catalog),
        entries: [entry],
      });
    }
  }

  return [...byCategory.values()].sort(
    (a, b) => categoryRank(a.category, catalog) - categoryRank(b.category, catalog),
  );
}

export function toText(
  entries: readonly ShoppingEntry[],
  catalog: Catalog | null,
): string {
  const lines = [shoppingListTitle()];
  for (const section of sections(entries, catalog)) {
    lines.push("", `【${section.title}】`);
    for (const entry of section.entries) {
      lines.push(`- ${displayName(entry)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
