import {
  apiRoutes,
  type ApiRoute,
  type RequestOf,
  type ResponseOf,
} from "../shared/api.js";
import type * as Api from "../shared/api.js";

type PathParameters = Readonly<Record<string, string | number>>;
type QueryValue =
  | string
  | number
  | boolean
  | readonly (string | number)[]
  | null
  | undefined;

export interface ApiRequestOptions {
  path?: PathParameters;
  query?: Readonly<Record<string, QueryValue>>;
}

export interface ApiClientOptions {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

function expandPath(path: string, parameters: PathParameters): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, (_match, name: string) => {
    const value = parameters[name];
    if (value === undefined) {
      throw new Error(`缺少接口路径参数：${name}`);
    }
    return encodeURIComponent(String(value));
  });
}

function addQuery(
  path: string,
  query: Readonly<Record<string, QueryValue>> | undefined,
): string {
  if (!query) {
    return path;
  }
  const parameters = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (value == null) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        parameters.append(name, String(item));
      }
    } else {
      parameters.append(name, String(value));
    }
  }
  const encoded = parameters.toString();
  return encoded ? `${path}?${encoded}` : path;
}

function responseError(text: string, status: number): ApiError {
  try {
    const body: unknown = JSON.parse(text);
    if (
      typeof body === "object" &&
      body !== null &&
      "error" in body &&
      typeof body.error === "string"
    ) {
      return new ApiError(body.error, status);
    }
  } catch {
    // A non-JSON error is replaced by a stable, user-facing message.
  }
  return new ApiError(`请求失败（${status}）`, status);
}

async function readResponse<TResponse>(response: Response): Promise<TResponse> {
  const text = await response.text();
  if (!response.ok) {
    throw responseError(text, response.status);
  }
  if (!text) {
    return undefined as TResponse;
  }
  try {
    return JSON.parse(text) as TResponse;
  } catch {
    throw new ApiError("服务返回了无法解析的数据", response.status);
  }
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "").replace(/\/+$/, "");
    this.fetchImpl =
      options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async request<TRoute extends ApiRoute<unknown, unknown>>(
    route: TRoute,
    payload?: RequestOf<TRoute>,
    options: ApiRequestOptions = {},
  ): Promise<ResponseOf<TRoute>> {
    const path = addQuery(
      expandPath(route.path, options.path ?? {}),
      options.query,
    );
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: route.method,
      headers:
        body === undefined ? undefined : { "Content-Type": "application/json" },
      body,
    });
    return readResponse<ResponseOf<TRoute>>(response);
  }

  async multipart<TRoute extends ApiRoute<unknown, unknown>>(
    route: TRoute,
    body: FormData,
    options: ApiRequestOptions = {},
  ): Promise<ResponseOf<TRoute>> {
    const path = addQuery(
      expandPath(route.path, options.path ?? {}),
      options.query,
    );
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: route.method,
      body,
    });
    return readResponse<ResponseOf<TRoute>>(response);
  }
}

const client = new ApiClient();

export const api = {
  client,
  health: () => client.request(apiRoutes.health),
  state: () => client.request(apiRoutes.state),
  services: () => client.request(apiRoutes.services),
  setService: (field: keyof Api.ServiceSourcesDto, value: string) =>
    client.request(apiRoutes.setService, { value }, {
      path: { field },
    }),
  clearService: (field: keyof Api.ServiceSourcesDto) =>
    client.request(apiRoutes.clearService, undefined, {
      path: { field },
    }),
  preferences: () => client.request(apiRoutes.preferences),
  addPreference: (text: string) =>
    client.request(apiRoutes.addPreference, { text }),
  deletePreference: (id: number) =>
    client.request(apiRoutes.deletePreference, undefined, {
      path: { id },
    }),
  summarizePreferences: () =>
    client.request(apiRoutes.summarizePreferences),
  nameMappings: () => client.request(apiRoutes.nameMappings),
  forgetNameMapping: (raw: string) =>
    client.request(apiRoutes.forgetNameMapping, undefined, {
      path: { raw },
    }),
  clearNameMappings: () =>
    client.request(apiRoutes.clearNameMappings),
  recipes: () => client.request(apiRoutes.recipes),
  recipeDetail: (request: Api.RecipeRequest) =>
    client.request(apiRoutes.recipeDetail, undefined, {
      path: { id: request.id },
      query: { selected: request.selected },
    }),
  clearPreview: (request: Api.ClearRequest) =>
    client.request(apiRoutes.clearPreview, request),
  searchClearRecipes: (request: Api.ClearRequest) =>
    client.request(apiRoutes.searchClearRecipes, request),
  addItem: (request: Api.AddManualItemRequest) =>
    client.request(apiRoutes.addItem, request),
  updateItem: (request: Api.UpdateItemRequest) =>
    client.request(apiRoutes.updateItem, request, {
      path: { id: request.id },
    }),
  useItem: (request: Api.ItemRequest) =>
    client.request(apiRoutes.useItem, request, {
      path: { id: request.id },
    }),
  markItemAbsent: (request: Api.ItemRequest) =>
    client.request(apiRoutes.markItemAbsent, request, {
      path: { id: request.id },
    }),
  discardItem: (request: Api.ItemRequest) =>
    client.request(apiRoutes.discardItem, request, {
      path: { id: request.id },
    }),
  snoozeItem: (request: Api.ItemRequest) =>
    client.request(apiRoutes.snoozeItem, request, {
      path: { id: request.id },
    }),
  setItemUseFirst: (request: Api.UseFirstRequest) =>
    client.request(apiRoutes.setItemUseFirst, request, {
      path: { id: request.id },
    }),
  removeItems: (request: Api.RemoveItemsRequest) =>
    client.request(apiRoutes.removeItems, request),
  confirmRememberedRules: () =>
    client.request(apiRoutes.confirmRememberedRules),
  dismissRememberedRules: () =>
    client.request(apiRoutes.dismissRememberedRules),
  saveRule: (request: Api.SaveRuleRequest) =>
    client.request(apiRoutes.saveRule, request),
  deleteRule: (request: Api.DeleteRuleRequest) =>
    client.request(apiRoutes.deleteRule, request),
  addPantryItem: (request: Api.PantryItemRequest) =>
    client.request(apiRoutes.addPantryItem, request),
  removePantryItem: (request: Api.PantryItemRequest) =>
    client.request(apiRoutes.removePantryItem, request, {
      path: { name: request.name },
    }),
  decideSuggestion: (request: Api.SuggestionDecisionRequest) =>
    client.request(apiRoutes.decideSuggestion, request, {
      path: { id: request.id },
    }),
  addMissingIngredients: (request: Api.RecipeRequest) =>
    client.request(apiRoutes.addMissingIngredients, request, {
      path: { id: request.id },
    }),
  shopping: () => client.request(apiRoutes.shopping),
  shoppingText: () => client.request(apiRoutes.shoppingText),
  removeShoppingItem: (request: Api.ShoppingItemRequest) =>
    client.request(apiRoutes.removeShoppingItem, request, {
      path: { id: request.id },
    }),
  deleteImport: (request: Api.ImportRequest) =>
    client.request(apiRoutes.deleteImport, request, {
      path: { id: request.id },
    }),
  clearImportHistory: () => client.request(apiRoutes.clearImportHistory),
  deleteAllData: () => client.request(apiRoutes.deleteAllData),
  setDemoMode: (enabled: boolean) =>
    client.request(apiRoutes.setDemoMode, { enabled }),
  importStatus: () => client.request(apiRoutes.importStatus),
  beginTextImport: (text: string) =>
    client.request(apiRoutes.beginTextImport, { text }),
  uploadImportImages: (request: Api.ImportImagesRequest) => {
    const body = new FormData();
    body.append("origin", request.origin);
    for (const file of request.files) {
      body.append(
        "images",
        new File([file.data], file.filename, {
          type: file.mimeType,
          lastModified: file.lastModified,
        }),
      );
      body.append("lastModified", String(file.lastModified));
    }
    return client.multipart(apiRoutes.uploadImportImages, body);
  },
  startImport: (request: Api.StartImportRequest) =>
    client.request(apiRoutes.startImport, request),
  cancelImport: () => client.request(apiRoutes.cancelImport),
  skipDuplicateImport: () =>
    client.request(apiRoutes.skipDuplicateImport),
  resumeImport: () => client.request(apiRoutes.resumeImport),
  discardUnfinishedImport: () =>
    client.request(apiRoutes.discardUnfinishedImport),
  editDraftItem: (request: Api.EditDraftItemRequest) =>
    client.request(apiRoutes.editDraftItem, request, {
      path: { i: request.index },
    }),
  setDraftCategory: (request: Api.SetDraftCategoryRequest) =>
    client.request(apiRoutes.setDraftCategory, request, {
      path: { i: request.index },
    }),
  dropDraftItem: (request: Api.DraftItemRequest) =>
    client.request(apiRoutes.dropDraftItem, request, {
      path: { i: request.index },
    }),
  retrieveDraftItem: (request: Api.DraftItemRequest) =>
    client.request(apiRoutes.retrieveDraftItem, request, {
      path: { i: request.index },
    }),
  confirmImport: (allowDuplicate: boolean) =>
    client.request(apiRoutes.confirmImport, { allowDuplicate }),
};
