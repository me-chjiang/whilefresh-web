import {
  RecipeErrorKind,
  type RecipeSearchResult,
  type RecipeSource,
  type WebRecipe,
} from "../recipes/types.js";

export type WebRecipeRequestState = "idle" | "busy" | "done" | "error";

export interface WebRecipeSummaryDto {
  id: string;
  name: string;
  imageUrl: string;
  sourceUrl: string;
}

export interface WebRecipeIngredientDto {
  raw: string;
  name: string;
  amount: string;
}

export interface WebRecipeStepDto {
  order: number;
  text: string;
  imageUrl: string;
}

export interface WebRecipeAttributionDto {
  source: string;
  url: string;
  author: string;
}

export interface WebRecipeDetailDto {
  id: string;
  name: string;
  imageUrl: string;
  rating: number;
  ingredients: WebRecipeIngredientDto[];
  steps: WebRecipeStepDto[];
  tips: string[];
  partial: boolean;
  attribution: WebRecipeAttributionDto;
}

interface PendingRequest {
  readonly controller: AbortController;
  readonly detach: () => void;
}

function linkedRequest(signal: AbortSignal): PendingRequest {
  const controller = new AbortController();
  const abort = (): void => {
    controller.abort(signal.reason);
  };
  if (signal.aborted) {
    abort();
  } else {
    signal.addEventListener("abort", abort, { once: true });
  }
  return {
    controller,
    detach: () => signal.removeEventListener("abort", abort),
  };
}

function errorKind(error: unknown): string {
  if (typeof error !== "object" || error === null || !("kind" in error)) {
    return "";
  }
  const kind = (error as { kind?: unknown }).kind;
  return typeof kind === "string" ? kind : "";
}

function detailDto(recipe: WebRecipe): WebRecipeDetailDto {
  return {
    id: recipe.id,
    name: recipe.name,
    imageUrl: recipe.imageUrl,
    rating: recipe.rating ?? 0,
    ingredients: recipe.ingredients.map(({ raw, name, amount }) => ({
      raw,
      name,
      amount,
    })),
    steps: recipe.steps.map(({ order, text, imageUrl }) => ({
      order,
      text,
      imageUrl,
    })),
    tips: [...recipe.tips],
    partial: recipe.partial,
    attribution: {
      source:
        recipe.attribution.sourceName === "xiachufang"
          ? "下厨房"
          : recipe.attribution.sourceName,
      url: recipe.attribution.sourceUrl,
      author: recipe.attribution.author,
    },
  };
}

function searchDto(result: RecipeSearchResult): WebRecipeSummaryDto[] {
  return result.items.map((item) => ({
    id: item.id,
    name: item.name,
    imageUrl: item.imageUrl,
    sourceUrl: item.attribution.sourceUrl,
  }));
}

export class WebRecipeService {
  private readonly source: RecipeSource;
  private searchRequest: PendingRequest | null = null;
  private detailRequest: PendingRequest | null = null;
  private resultsValue: WebRecipeSummaryDto[] = [];
  private searchStateValue: WebRecipeRequestState = "idle";
  private searchErrorValue = "";
  private detailValue: WebRecipeDetailDto | null = null;
  private detailStateValue: WebRecipeRequestState = "idle";
  private detailErrorValue = "";
  private readonly cache = new Map<string, WebRecipeDetailDto>();

  constructor(source: RecipeSource) {
    this.source = source;
  }

  static errorLabel(kind: string): string {
    switch (kind) {
      case RecipeErrorKind.NotConfigured:
        return "未配置 Lexmount";
      case RecipeErrorKind.AuthFailed:
        return "Lexmount 密钥无效";
      case RecipeErrorKind.Blocked:
        return "下厨房拦截";
      case RecipeErrorKind.NetworkError:
        return "网络错误";
      case RecipeErrorKind.Timeout:
        return "超时";
      case RecipeErrorKind.NotFound:
        return "没有找到";
      case RecipeErrorKind.InvalidQuery:
        return "输入有误";
      default:
        return "菜谱源不可用";
    }
  }

  results(): WebRecipeSummaryDto[] {
    return this.resultsValue;
  }

  searchState(): WebRecipeRequestState {
    return this.searchStateValue;
  }

  searchError(): string {
    return this.searchErrorValue;
  }

  isConfigured(): boolean {
    return this.source.isConfigured();
  }

  detailState(): WebRecipeRequestState {
    return this.detailStateValue;
  }

  detailError(): string {
    return this.detailErrorValue;
  }

  async search(
    keyword: string,
    page: number,
    signal: AbortSignal,
  ): Promise<WebRecipeSummaryDto[]> {
    const trimmed = keyword.trim();
    if (trimmed.length === 0) {
      return this.resultsValue;
    }

    this.searchRequest?.controller.abort();
    const request = linkedRequest(signal);
    this.searchRequest = request;
    this.resultsValue = [];
    this.searchErrorValue = "";
    this.searchStateValue = "busy";

    try {
      const result = await this.source.search(
        trimmed,
        page,
        request.controller.signal,
      );
      if (this.searchRequest !== request) {
        return [];
      }
      this.resultsValue = searchDto(result);
      this.searchStateValue = "done";
      return this.resultsValue;
    } catch (error) {
      if (this.searchRequest !== request) {
        return [];
      }
      this.searchStateValue = "error";
      this.searchErrorValue = WebRecipeService.errorLabel(errorKind(error));
      return [];
    } finally {
      request.detach();
      if (this.searchRequest === request) {
        this.searchRequest = null;
      }
    }
  }

  async detail(
    id: string,
    signal: AbortSignal,
  ): Promise<WebRecipeDetailDto | null> {
    this.detailRequest?.controller.abort();
    this.detailRequest = null;
    this.detailErrorValue = "";

    const cached = this.cache.get(id);
    if (cached) {
      this.detailValue = cached;
      this.detailStateValue = "done";
      return cached;
    }

    const request = linkedRequest(signal);
    this.detailRequest = request;
    this.detailValue = null;
    this.detailStateValue = "busy";

    try {
      const recipe = await this.source.detail(
        id,
        request.controller.signal,
      );
      if (this.detailRequest !== request) {
        return null;
      }
      const result = detailDto(recipe);
      this.detailValue = result;
      this.cache.set(recipe.id, result);
      this.detailStateValue = "done";
      return result;
    } catch (error) {
      if (this.detailRequest !== request) {
        return null;
      }
      this.detailStateValue = "error";
      this.detailErrorValue = WebRecipeService.errorLabel(errorKind(error));
      return null;
    } finally {
      request.detach();
      if (this.detailRequest === request) {
        this.detailRequest = null;
      }
    }
  }

  reset(): void {
    this.searchRequest?.controller.abort();
    this.detailRequest?.controller.abort();
    this.searchRequest = null;
    this.detailRequest = null;
    this.resultsValue = [];
    this.searchStateValue = "idle";
    this.searchErrorValue = "";
    this.detailValue = null;
    this.detailStateValue = "idle";
    this.detailErrorValue = "";
    this.cache.clear();
  }
}
