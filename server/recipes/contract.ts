type JsonObject = Record<string, unknown>;

export type ContractOperation = "search" | "detail";

export interface ContractQuery {
  keyword?: string;
  id?: string;
  page?: number;
  pageSize?: number;
  provider?: string;
  elapsedMs?: number;
}

interface ContractRecipe {
  id: string;
  name: string;
  description: null;
  author: null;
  source_url: string;
  image_url: string | null;
  category: null;
  region: null;
  rating: number | null;
  rating_count: null;
  made_count: null;
  steps: ContractStep[];
  ingredients: ContractIngredient[];
  tips: string[];
  notes: null;
}

interface ContractStep {
  order: number;
  text: string;
  image_url: string | null;
}

interface ContractIngredient {
  raw: string;
  name: string;
  amount: string | null;
  category: "ingredient";
  required: "unknown";
  evidence: string;
  notes: null;
  substitutes: [];
}

export interface RecipeContract {
  schema_version: "1.0";
  query: {
    source: "xiachufang";
    operation: ContractOperation;
    keyword: string | null;
    id: string | null;
    page: number;
    page_size: number;
    provider: string;
    search_type: "browser";
  };
  operation: ContractOperation;
  source: {
    name: "xiachufang";
    capabilities: {
      search: true;
      detail: true;
      recommend: false;
    };
    provider: string;
  };
  status: {
    code: "complete" | "partial";
    message: "source data returned";
    incomplete: string[];
    warnings: string[];
  };
  results: ContractRecipe[];
  filter: {
    applied: { keyword: string }[];
    candidate_scope: "one upstream page";
  };
  sort: {
    requested: null;
    applied: null;
  };
  pagination: {
    page: number;
    page_size: number;
    returned: number;
    total_candidates_after_filter: number;
  };
  timing: {
    elapsed_ms: number;
  };
}

const SITE = "https://www.xiachufang.com";
const RECIPE_ID = /\/recipe\/(\d{1,20})\/?/;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function absoluteHttpUrl(value: unknown): string | null {
  const raw = text(value);
  if (!raw) {
    return null;
  }
  try {
    const url = new URL(raw, SITE);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function recipeUrl(id: string): string {
  return new URL(`/recipe/${id}/`, SITE).toString();
}

function stepOf(value: unknown, order: number): ContractStep | null {
  const step = isObject(value) ? value : {};
  const stepText = typeof step.desc === "string" ? step.desc : "";
  const imageUrl = absoluteHttpUrl(step.img);
  if (!stepText.trim() && imageUrl === null) {
    return null;
  }
  return { order, text: stepText, image_url: imageUrl };
}

function ratingOf(value: unknown): number | null {
  const rating =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(rating) && rating >= 0 && rating <= 10
    ? rating
    : null;
}

function recipeHead(
  id: string,
  name: string,
  imageUrl: string | null,
): Pick<
  ContractRecipe,
  | "id"
  | "name"
  | "description"
  | "author"
  | "source_url"
  | "image_url"
  | "category"
  | "region"
  | "rating"
  | "rating_count"
  | "made_count"
  | "steps"
  | "ingredients"
  | "tips"
  | "notes"
> {
  return {
    id,
    name,
    description: null,
    author: null,
    source_url: recipeUrl(id),
    image_url: imageUrl,
    category: null,
    region: null,
    rating: null,
    rating_count: null,
    made_count: null,
    steps: [],
    ingredients: [],
    tips: [],
    notes: null,
  };
}

function searchResults(
  query: Required<Pick<ContractQuery, "pageSize">> & ContractQuery,
  scraped: JsonObject,
): { recipes: ContractRecipe[]; candidates: number; incomplete: string[]; warnings: string[] } {
  const found = Array.isArray(scraped.Recipe) ? scraped.Recipe : [];
  const recipes: ContractRecipe[] = [];
  const seen = new Set<string>();
  let skipped = 0;

  for (const value of found) {
    const item = isObject(value) ? value : {};
    const match = RECIPE_ID.exec(text(item.url));
    const name = text(item.name);
    if (!match || !name) {
      skipped += 1;
      continue;
    }
    const id = match[1];
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    recipes.push(recipeHead(id, name, absoluteHttpUrl(item.cover)));
  }

  const warnings = skipped > 0 ? ["skipped_unusable_rows"] : [];
  const incomplete = ["full_details"];
  if (recipes.length > query.pageSize) {
    recipes.splice(query.pageSize);
    incomplete.push("upstream_page_truncated");
  }
  return { recipes, candidates: found.length, incomplete, warnings };
}

function detailResult(
  query: Required<Pick<ContractQuery, "id">> & ContractQuery,
  scraped: JsonObject,
): ContractRecipe | null {
  const found = Array.isArray(scraped.Content) ? scraped.Content : [];
  if (found.length !== 1) {
    return null;
  }
  const content = isObject(found[0]) ? found[0] : {};
  const name = text(content.name);
  if (!name) {
    return null;
  }

  const recipe: ContractRecipe = {
    ...recipeHead(query.id, name, absoluteHttpUrl(content.cover)),
    rating: ratingOf(content.grade),
  };

  const materials = Array.isArray(content.materials) ? content.materials : [];
  for (const value of materials) {
    const material = isObject(value) ? value : {};
    const ingredientName = text(material.name);
    if (!ingredientName) {
      continue;
    }
    const amount = text(material.unit);
    recipe.ingredients.push({
      raw: amount ? `${ingredientName} ${amount}` : ingredientName,
      name: ingredientName,
      amount: amount || null,
      category: "ingredient",
      required: "unknown",
      evidence: "source does not specify necessity",
      notes: null,
      substitutes: [],
    });
  }

  const steps = Array.isArray(content.steps) ? content.steps : [];
  for (const value of steps) {
    const step = stepOf(value, recipe.steps.length + 1);
    if (step) {
      recipe.steps.push(step);
    }
  }

  const tip = text(content.tip);
  if (tip) {
    recipe.tips.push(tip);
  }
  return recipe;
}

export function buildContract(
  operation: ContractOperation,
  query: ContractQuery,
  scraped: unknown,
): RecipeContract {
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? 20;
  const provider = query.provider ?? "lexmount";
  const scrape = isObject(scraped) ? scraped : {};
  const search = operation === "search";
  const searchData = search
    ? searchResults({ ...query, pageSize }, scrape)
    : null;
  const recipe = search
    ? null
    : detailResult({ ...query, id: query.id ?? "" }, scrape);

  if (!search && recipe === null) {
    const found = Array.isArray(scrape.Content) ? scrape.Content : [];
    throw new Error(
      found.length === 1
        ? "source recipe must have a name"
        : "response requires one Content recipe",
    );
  }

  const recipes = searchData?.recipes ?? (recipe ? [recipe] : []);
  const incomplete = searchData?.incomplete ?? [];
  if (!search && recipes[0]) {
    if (recipes[0].ingredients.length === 0) {
      incomplete.push("ingredients");
    }
    if (recipes[0].steps.length === 0) {
      incomplete.push("steps");
    }
  }
  const warnings = searchData?.warnings ?? [];
  const elapsedMs = query.elapsedMs ?? 0;

  return {
    schema_version: "1.0",
    query: {
      source: "xiachufang",
      operation,
      keyword: search ? (query.keyword ?? "") : null,
      id: search ? null : (query.id ?? ""),
      page,
      page_size: pageSize,
      provider,
      search_type: "browser",
    },
    operation,
    source: {
      name: "xiachufang",
      capabilities: { search: true, detail: true, recommend: false },
      provider,
    },
    status: {
      code: incomplete.length === 0 ? "complete" : "partial",
      message: "source data returned",
      incomplete,
      warnings,
    },
    results: recipes,
    filter: {
      applied: search ? [{ keyword: query.keyword ?? "" }] : [],
      candidate_scope: "one upstream page",
    },
    sort: { requested: null, applied: null },
    pagination: {
      page,
      page_size: pageSize,
      returned: recipes.length,
      total_candidates_after_filter:
        searchData?.candidates ?? (recipes.length > 0 ? 1 : 0),
    },
    timing: { elapsed_ms: Math.round(elapsedMs * 100) / 100 },
  };
}
