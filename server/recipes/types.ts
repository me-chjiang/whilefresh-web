export const RecipeErrorKind = {
  NotConfigured: "not_configured",
  InvalidQuery: "invalid_query",
  NotFound: "not_found",
  Unavailable: "unavailable",
  Blocked: "blocked",
  AuthFailed: "auth_failed",
  NetworkError: "network_error",
  Timeout: "timeout",
  BadResponse: "bad_response",
  Internal: "internal",
} as const;

export type RecipeErrorKind =
  (typeof RecipeErrorKind)[keyof typeof RecipeErrorKind];

export interface RecipeError {
  kind: RecipeErrorKind;
  detail: string;
}

export interface RecipeIngredient {
  raw: string;
  name: string;
  amount: string;
  category: string;
  required: string;
  evidence: string;
  notes: string;
  substitutes: string[];
}

export interface RecipeStep {
  order: number;
  text: string;
  imageUrl: string;
}

export interface RecipeAttribution {
  sourceName: string;
  provider: string;
  sourceUrl: string;
  author: string;
}

export interface RecipeSummary {
  id: string;
  name: string;
  description: string;
  imageUrl: string;
  attribution: RecipeAttribution;
}

export interface WebRecipe {
  id: string;
  name: string;
  description: string;
  imageUrl: string;
  category: string;
  region: string;
  rating: number | null;
  ratingCount: number | null;
  madeCount: number | null;
  ingredients: RecipeIngredient[];
  steps: RecipeStep[];
  tips: string[];
  notes: string;
  attribution: RecipeAttribution;
  partial: boolean;
  incomplete: string[];
}

export interface RecipeSearchResult {
  keyword: string;
  page: number;
  pageSize: number;
  totalCandidates: number;
  items: RecipeSummary[];
  partial: boolean;
  incomplete: string[];
  warnings: string[];
}

export interface RecipeSource {
  search(
    keyword: string,
    page: number,
    signal: AbortSignal,
  ): Promise<RecipeSearchResult>;
  detail(id: string, signal: AbortSignal): Promise<WebRecipe>;
  isConfigured(): boolean;
}
