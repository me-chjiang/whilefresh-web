import type { Catalog } from "./catalog.js";

type JsonObject = Record<string, unknown>;

export type RequirementGroup = string[];

export interface RecipeIngredient {
  raw: string;
  name: string;
  optional: boolean;
  kind: string;
  groups: RequirementGroup[];
}

export interface RecipeQuantity {
  name: string;
  expr: string;
}

export interface Recipe {
  id: string;
  name: string;
  category: string;
  categoryZh: string;
  difficulty: number | null;
  caloriesKcal: number | null;
  timeMinutes: number | null;
  summary: string;
  ingredients: RecipeIngredient[];
  ingredientNotes: string[];
  quantities: RecipeQuantity[];
  quantityNotes: string[];
  steps: string[];
  notes: string;
  sourceUrl: string;
}

export interface RecipeSource {
  name: string;
  url: string;
  commit: string;
  license: string;
  licenseUrl: string;
}

export interface StockEntry {
  name: string;
  itemId: number;
  pantry?: boolean;
  selected?: boolean;
  nearExpiry?: boolean;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(text) : [];
}

function groupsFromJson(value: unknown): RequirementGroup[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const groups: RequirementGroup[] = [];
  for (const valueGroup of value) {
    const names = (
      Array.isArray(valueGroup) ? valueGroup.map(text) : [text(valueGroup)]
    ).filter((name) => name.length > 0);
    if (names.length > 0) {
      groups.push(names);
    }
  }
  return groups;
}

function recipeFromJson(value: unknown): Recipe {
  const object = isObject(value) ? value : {};
  const ingredients: RecipeIngredient[] = [];
  if (Array.isArray(object.ingredients)) {
    for (const valueIngredient of object.ingredients) {
      const ingredient = isObject(valueIngredient) ? valueIngredient : {};
      ingredients.push({
        raw: text(ingredient.raw),
        name: text(ingredient.name),
        optional: ingredient.optional === true,
        kind: text(ingredient.kind),
        groups: groupsFromJson(ingredient.canonical),
      });
    }
  }

  const quantities: RecipeQuantity[] = [];
  if (Array.isArray(object.quantities)) {
    for (const valueQuantity of object.quantities) {
      const quantity = isObject(valueQuantity) ? valueQuantity : {};
      quantities.push({
        name: text(quantity.name),
        expr: text(quantity.expr),
      });
    }
  }

  return {
    id: text(object.id),
    name: text(object.name),
    category: text(object.category),
    categoryZh: text(object.category_zh),
    difficulty: optionalInt(object.difficulty),
    caloriesKcal: optionalInt(object.calories_kcal),
    timeMinutes: optionalInt(object.time_minutes),
    summary: text(object.summary),
    ingredients,
    ingredientNotes: stringList(object.ingredient_notes),
    quantities,
    quantityNotes: stringList(object.quantity_notes),
    steps: stringList(object.steps),
    notes: text(object.notes),
    sourceUrl: text(object.source_url),
  };
}

export class RecipeBook {
  readonly recipes: readonly Recipe[];
  readonly source: RecipeSource;

  private readonly index: ReadonlyMap<string, number>;

  private constructor(
    recipes: Recipe[],
    source: RecipeSource,
    index: ReadonlyMap<string, number>,
  ) {
    this.recipes = recipes;
    this.source = source;
    this.index = index;
  }

  static fromJson(json: string): RecipeBook {
    let root: unknown;
    try {
      root = JSON.parse(json) as unknown;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`recipes: ${message}`);
    }

    const rootObject = isObject(root) ? root : {};
    const sourceObject = isObject(rootObject.source) ? rootObject.source : {};
    const source: RecipeSource = {
      name: text(sourceObject.name),
      url: text(sourceObject.url),
      commit: text(sourceObject.commit),
      license: text(sourceObject.license),
      licenseUrl: text(sourceObject.license_url),
    };
    const values = Array.isArray(root)
      ? root
      : Array.isArray(rootObject.recipes)
        ? rootObject.recipes
        : [];
    const recipes: Recipe[] = [];
    const index = new Map<string, number>();
    for (const value of values) {
      const recipe = recipeFromJson(value);
      if (recipe.id.length === 0 || index.has(recipe.id)) {
        continue;
      }
      index.set(recipe.id, recipes.length);
      recipes.push(recipe);
    }
    if (recipes.length === 0) {
      throw new Error("recipes: no recipes");
    }
    return new RecipeBook(recipes, source, index);
  }

  find(id: string): Recipe | null {
    const index = this.index.get(id);
    return index === undefined ? null : (this.recipes[index] ?? null);
  }

  size(): number {
    return this.recipes.length;
  }
}

export class GroupMatch {
  readonly group: RequirementGroup;
  optional: boolean;
  readonly satisfiedBy: StockEntry[];
  readonly ingredientRaw: string;

  constructor(
    group: RequirementGroup,
    optional: boolean,
    satisfiedBy: StockEntry[],
    ingredientRaw: string,
  ) {
    this.group = group;
    this.optional = optional;
    this.satisfiedBy = satisfiedBy;
    this.ingredientRaw = ingredientRaw;
  }

  satisfied(): boolean {
    return this.satisfiedBy.length > 0;
  }
}

export class RecipeMatch {
  readonly recipe: Recipe;
  readonly groups: GroupMatch[] = [];
  readonly selectedNames: string[];
  readonly usedSelected: string[] = [];
  readonly unusedSelected: string[] = [];
  haveCount = 0;
  missingCount = 0;
  selectedUsed = 0;
  nearExpiryUsed = 0;
  inventoryUsed = 0;

  constructor(recipe: Recipe, selectedNames: string[]) {
    this.recipe = recipe;
    this.selectedNames = selectedNames;
  }

  missingGroups(): RequirementGroup[] {
    return this.groups
      .filter((group) => !group.optional && !group.satisfied())
      .map((group) => [...group.group]);
  }
}

function groupKey(group: RequirementGroup): string {
  return [...group].sort().join("\u001f");
}

export class RecipeMatcher {
  readonly selectedNames: string[];

  private readonly stock: StockEntry[];
  private readonly byRequirement = new Map<string, number[]>();

  constructor(
    private readonly catalog: Catalog | null,
    stock: readonly StockEntry[],
  ) {
    this.stock = stock.map((entry) => {
      const resolved = catalog?.resolve(entry.name) ?? "";
      return {
        ...entry,
        name: resolved.length > 0 ? resolved : entry.name,
        pantry: entry.pantry === true,
        selected: entry.selected === true,
        nearExpiry: entry.nearExpiry === true,
      };
    });

    const selected = new Set<string>();
    for (let index = 0; index < this.stock.length; index += 1) {
      const entry = this.stock[index];
      if (
        entry.selected &&
        !entry.pantry &&
        (!catalog || catalog.categoryOf(entry.name) !== "seasoning")
      ) {
        selected.add(entry.name);
      }

      const requirements = [
        entry.name,
        ...(catalog?.ancestors(entry.name) ?? []),
      ];
      for (const requirement of requirements) {
        const indices = this.byRequirement.get(requirement);
        if (indices) {
          indices.push(index);
        } else {
          this.byRequirement.set(requirement, [index]);
        }
      }
    }
    this.selectedNames = [...selected].sort();
  }

  match(recipe: Recipe): RecipeMatch {
    const result = new RecipeMatch(recipe, [...this.selectedNames]);
    const seen = new Map<string, number>();

    for (const ingredient of recipe.ingredients) {
      if (ingredient.kind === "tool") {
        continue;
      }
      for (const group of ingredient.groups) {
        const key = groupKey(group);
        const seenIndex = seen.get(key);
        if (seenIndex !== undefined) {
          const existing = result.groups[seenIndex];
          if (existing) {
            existing.optional = existing.optional && ingredient.optional;
          }
          continue;
        }

        const used = new Set<number>();
        const satisfiedBy: StockEntry[] = [];
        for (const requirement of group) {
          for (const index of this.byRequirement.get(requirement) ?? []) {
            if (!used.has(index)) {
              used.add(index);
              const entry = this.stock[index];
              if (entry) {
                satisfiedBy.push(entry);
              }
            }
          }
        }
        seen.set(key, result.groups.length);
        result.groups.push(
          new GroupMatch([...group], ingredient.optional, satisfiedBy, ingredient.raw),
        );
      }
    }

    const usedSelected = new Set<string>();
    const nearExpiry = new Set<number>();
    const inventory = new Set<number>();
    for (const group of result.groups) {
      if (group.satisfied()) {
        result.haveCount += 1;
      } else if (!group.optional) {
        result.missingCount += 1;
      }

      for (const entry of group.satisfiedBy) {
        if (entry.pantry) {
          continue;
        }
        inventory.add(entry.itemId);
        if (
          entry.selected &&
          !group.optional &&
          (!this.catalog ||
            this.catalog.categoryOf(entry.name) !== "seasoning")
        ) {
          usedSelected.add(entry.name);
        }
        if (entry.nearExpiry) {
          nearExpiry.add(entry.itemId);
        }
      }
    }

    result.usedSelected.push(...[...usedSelected].sort());
    result.selectedUsed = result.usedSelected.length;
    for (const name of result.selectedNames) {
      if (!usedSelected.has(name)) {
        result.unusedSelected.push(name);
      }
    }
    result.nearExpiryUsed = nearExpiry.size;
    result.inventoryUsed = inventory.size;
    return result;
  }

  matchAll(recipes: readonly Recipe[]): RecipeMatch[] {
    return recipes.map((recipe) => this.match(recipe));
  }
}

export function matchRecipe(
  recipe: Recipe,
  stock: readonly StockEntry[],
  catalog: Catalog | null = null,
): RecipeMatch {
  return new RecipeMatcher(catalog, stock).match(recipe);
}

function compareName(a: Recipe, b: Recipe): number {
  if (a.name === b.name) {
    return 0;
  }
  return a.name < b.name ? -1 : 1;
}

export function rankForClearFridge(
  matches: readonly RecipeMatch[],
): RecipeMatch[] {
  return matches
    .filter((match) => match.selectedUsed > 0)
    .sort((a, b) => {
      if (a.selectedUsed !== b.selectedUsed) {
        return b.selectedUsed - a.selectedUsed;
      }
      if (a.missingCount !== b.missingCount) {
        return a.missingCount - b.missingCount;
      }
      if (a.nearExpiryUsed !== b.nearExpiryUsed) {
        return b.nearExpiryUsed - a.nearExpiryUsed;
      }
      return compareName(a.recipe, b.recipe);
    });
}

export function rankForBrowsing(
  matches: readonly RecipeMatch[],
): RecipeMatch[] {
  return [...matches].sort((a, b) => {
    if (a.missingCount !== b.missingCount) {
      return a.missingCount - b.missingCount;
    }
    if (a.inventoryUsed !== b.inventoryUsed) {
      return b.inventoryUsed - a.inventoryUsed;
    }
    return compareName(a.recipe, b.recipe);
  });
}
