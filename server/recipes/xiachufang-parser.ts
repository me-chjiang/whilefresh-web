import {
  RecipeErrorKind,
  type RecipeAttribution,
  type RecipeError,
  type RecipeIngredient,
  type RecipeSearchResult,
  type RecipeStep,
  type RecipeSummary,
  type WebRecipe,
} from "./types.js";

type JsonObject = Record<string, unknown>;

export interface RecipeParseOutcome {
  result: RecipeSearchResult | WebRecipe | null;
  error: RecipeError;
}

interface SearchParseOutcome {
  result: RecipeSearchResult | null;
  error: RecipeError;
}

class ContractError extends Error {}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptyError(): RecipeError {
  return { kind: RecipeErrorKind.BadResponse, detail: "" };
}

function fail(detail: string): RecipeParseOutcome {
  return {
    result: null,
    error: { kind: RecipeErrorKind.BadResponse, detail },
  };
}

function succeed(
  result: RecipeSearchResult | WebRecipe,
): RecipeParseOutcome {
  return { result, error: emptyError() };
}

function reject(detail: string): never {
  throw new ContractError(detail);
}

function child(map: JsonObject, key: string): unknown {
  return map[key];
}

function present(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function scalarText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "boolean") {
    return String(value);
  }
  return reject("value must be a scalar");
}

function text(map: JsonObject, key: string): string {
  const value = child(map, key);
  return present(value) ? scalarText(value) : "";
}

function textList(map: JsonObject, key: string): string[] {
  const value = child(map, key);
  if (!present(value)) {
    return [];
  }
  if (!Array.isArray(value)) {
    reject(`${key} must be a list`);
  }
  return value.map(scalarText);
}

function optionalDouble(map: JsonObject, key: string): number | null {
  const value = child(map, key);
  if (!present(value)) {
    return null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const number = Number(value);
    if (Number.isFinite(number)) {
      return number;
    }
  }
  return reject(`${key} must be a number`);
}

function optionalInt(map: JsonObject, key: string): number | null {
  const value = optionalDouble(map, key);
  return value === null ? null : Math.trunc(value);
}

function intOr(map: JsonObject, key: string, fallback: number): number {
  return optionalInt(map, key) ?? fallback;
}

function eachMap(
  map: JsonObject,
  key: string,
  visit: (item: JsonObject) => void,
): void {
  const value = child(map, key);
  if (!present(value)) {
    return;
  }
  if (!Array.isArray(value)) {
    reject(`${key} must be a list`);
  }
  for (const item of value) {
    if (!isObject(item)) {
      reject(`${key} must hold mappings`);
    }
    visit(item);
  }
}

function attributionOf(item: JsonObject, provider: string): RecipeAttribution {
  return {
    sourceName: "xiachufang",
    provider,
    sourceUrl: text(item, "source_url"),
    author: text(item, "author"),
  };
}

function summaryOf(item: JsonObject, provider: string): RecipeSummary {
  const summary = {
    id: text(item, "id"),
    name: text(item, "name"),
    description: text(item, "description"),
    imageUrl: text(item, "image_url"),
    attribution: attributionOf(item, provider),
  };
  if (!summary.id || !summary.name) {
    reject("recipe needs id and name");
  }
  return summary;
}

function ingredientOf(item: JsonObject): RecipeIngredient {
  const ingredient = {
    raw: text(item, "raw"),
    name: text(item, "name"),
    amount: text(item, "amount"),
    category: text(item, "category"),
    required: text(item, "required"),
    evidence: text(item, "evidence"),
    notes: text(item, "notes"),
    substitutes: textList(item, "substitutes"),
  };
  if (!ingredient.name) {
    reject("ingredient needs a name");
  }
  return ingredient;
}

function stepOf(item: JsonObject, fallbackOrder: number): RecipeStep {
  return {
    order: intOr(item, "order", fallbackOrder),
    text: text(item, "text"),
    imageUrl: text(item, "image_url"),
  };
}

function recipeOf(item: JsonObject, provider: string): WebRecipe {
  const summary = summaryOf(item, provider);
  const recipe: WebRecipe = {
    ...summary,
    category: text(item, "category"),
    region: text(item, "region"),
    rating: optionalDouble(item, "rating"),
    ratingCount: optionalInt(item, "rating_count"),
    madeCount: optionalInt(item, "made_count"),
    ingredients: [],
    steps: [],
    tips: textList(item, "tips"),
    notes: text(item, "notes"),
    partial: false,
    incomplete: [],
  };
  eachMap(item, "ingredients", (ingredient) => {
    recipe.ingredients.push(ingredientOf(ingredient));
  });
  eachMap(item, "steps", (step) => {
    recipe.steps.push(stepOf(step, recipe.steps.length + 1));
  });
  return recipe;
}

function errorKindOf(message: string, incomplete: readonly string[]) {
  const lower = message.toLowerCase();
  if (lower.includes("timed out") || lower.includes("timeout")) {
    return RecipeErrorKind.Timeout;
  }
  if (lower.includes("not found") || lower.includes("404")) {
    return RecipeErrorKind.NotFound;
  }
  if (incomplete.includes("query")) {
    return RecipeErrorKind.InvalidQuery;
  }
  return RecipeErrorKind.Unavailable;
}

function parseContractUnsafe(value: unknown): RecipeParseOutcome {
  if (!isObject(value)) {
    reject("document is not a mapping");
  }
  const root = value;
  const schemaVersion = text(root, "schema_version");
  const majorText = schemaVersion.split(".")[0] ?? "";
  if (!/^-?\d+$/.test(majorText)) {
    reject("missing or malformed schema_version");
  }
  const major = Number(majorText);
  if (major !== 1) {
    return fail(`unsupported schema_version ${schemaVersion}`);
  }

  const operation = text(root, "operation");
  if (operation !== "search" && operation !== "detail") {
    reject("unknown operation");
  }

  const queryValue = child(root, "query");
  const query = isObject(queryValue) ? queryValue : {};
  const queryKeyword = text(query, "keyword");
  text(query, "id");
  const queryPage = intOr(query, "page", 1);

  const statusValue = child(root, "status");
  const status = isObject(statusValue) ? statusValue : {};
  const code = text(status, "code");
  const message = text(status, "message");
  const incomplete = textList(status, "incomplete");
  const warnings = textList(status, "warnings");
  if (code === "error") {
    return {
      result: null,
      error: { kind: errorKindOf(message, incomplete), detail: message },
    };
  }
  if (code !== "complete" && code !== "partial") {
    reject("unknown status code");
  }
  const partial = code === "partial";

  const sourceValue = child(root, "source");
  const source = isObject(sourceValue) ? sourceValue : {};
  text(source, "name");
  const provider = text(source, "provider");

  const paginationValue = child(root, "pagination");
  const pagination = isObject(paginationValue) ? paginationValue : {};
  const timingValue = child(root, "timing");
  const timing = isObject(timingValue) ? timingValue : {};
  optionalDouble(timing, "elapsed_ms");

  const results = child(root, "results");
  if (present(results) && !Array.isArray(results)) {
    reject("results must be a list");
  }

  if (operation === "search") {
    const items: RecipeSummary[] = [];
    eachMap(root, "results", (item) => {
      items.push(summaryOf(item, provider));
    });
    return succeed({
      keyword: queryKeyword,
      page: intOr(pagination, "page", queryPage),
      pageSize: intOr(pagination, "page_size", 0),
      totalCandidates: intOr(
        pagination,
        "total_candidates_after_filter",
        0,
      ),
      items,
      partial,
      incomplete,
      warnings,
    });
  }

  const recipes: WebRecipe[] = [];
  eachMap(root, "results", (item) => {
    recipes.push(recipeOf(item, provider));
  });
  if (recipes.length !== 1) {
    reject("detail needs exactly one result");
  }
  const recipe = recipes[0];
  if (!recipe) {
    reject("detail needs exactly one result");
  }
  recipe.partial = partial;
  recipe.incomplete = incomplete;
  return succeed(recipe);
}

export function parseContract(value: unknown): RecipeParseOutcome {
  try {
    return parseContractUnsafe(value);
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : "malformed contract";
    return fail(detail);
  }
}
