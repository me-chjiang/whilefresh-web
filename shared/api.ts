import type {
  CategoryCode,
  ImportState,
  StartBasis,
} from "./enums.js";

export type ItemFreshness = "unknown" | "fresh" | "nearing" | "overdue";

export interface ItemDto {
  id: number;
  name: string;
  quantity: string;
  category: CategoryCode;
  location: string;
  freshness: ItemFreshness;
  source: string;
  days: string;
  first: boolean;
  bulk: boolean;
  purchasedAt: string;
  storedAt: string;
  producedAt: string;
  packageExpiresAt: string;
  shelfDays: string;
  startBasis: StartBasis;
  startDate: string;
  expiryDate: string;
  shelfLifeNote: string;
}

export type DraftItemGroup = "food" | "seasoning" | "ignored";

export interface DraftItemDto {
  index: number;
  name: string;
  quantity: string;
  category: CategoryCode;
  location: string;
  source: string;
  shelfDays: string;
  startBasis: StartBasis;
  startDate: string;
  expiryDate: string;
  shelfLifeNote: string;
  purchasedAt: string;
  storedAt: string;
  producedAt: string;
  packageExpiresAt: string;
  group: DraftItemGroup;
  needsDate: boolean;
}

export interface RecipeSummaryDto {
  id: string;
  name: string;
  difficulty: number;
  haveCount: number;
  missingCount: number;
  sourceUrl: string;
  sourceName: string;
  usedSelected: string[];
  unusedSelected: string[];
}

export interface RecipeIngredientDto {
  raw: string;
  has: boolean;
  known: boolean;
  optional: boolean;
}

export interface RecipeQuantityDto {
  name: string;
  expr: string;
}

export interface RecipeDetailDto extends RecipeSummaryDto {
  summary: string;
  ingredients: RecipeIngredientDto[];
  ingredientNotes: string[];
  quantities: RecipeQuantityDto[];
  quantityNotes: string[];
  steps: string[];
  notes: string;
}

export interface ShoppingDto {
  id: number;
  name: string;
  category: CategoryCode;
}

export interface PantryDto {
  name: string;
  category: CategoryCode;
  bulk: boolean;
}

export interface SuggestionDto {
  id: number;
  name: string;
  note: string;
}

export type RuleKind = "shelf" | "storage";

export interface RuleDto {
  name: string;
  location: string;
  days: string;
  kind: RuleKind;
  source: string;
}

export interface ImportRecordDto {
  id: number;
  name: string;
  date: string;
}

export interface ClearPreviewDto {
  selectedCount: number;
  candidateCount: number;
  completeCount: number;
  uncovered: string[];
}

export interface ImportStatusDto {
  importState: ImportState;
  importError: string;
  draftItems: DraftItemDto[];
  draftWarning: string;
  draftDuplicate: boolean;
  draftFoodCount: number;
}

export interface StateDto extends ImportStatusDto {
  items: ItemDto[];
  nearCount: number;
  selectedIds: number[];
  recipes: RecipeSummaryDto[];
  clearRecipes: RecipeSummaryDto[];
  clearPreview: ClearPreviewDto;
  clearResultsSummary: ClearPreviewDto | null;
  clearResultsReady: boolean;
  shopping: ShoppingDto[];
  pantry: PantryDto[];
  suggestions: SuggestionDto[];
  rules: RuleDto[];
  imports: ImportRecordDto[];
  demoMode: boolean;
  recognitionConfigured: boolean;
  startupNotice: string;
  privacyNotice: string;
}

export interface SaveItemResult {
  ok: boolean;
  error: string;
  question: string;
}

export interface ActionResult {
  ok: boolean;
}

export interface DeleteAllDataResult extends ActionResult {
  error?: string;
  warning?: string;
}

export interface ClearRecipesResult {
  recipes: RecipeSummaryDto[];
  summary: ClearPreviewDto;
}

export interface AddMissingResult {
  added: number;
}

export interface ShoppingTextDto {
  text: string;
}

export interface ItemEdits {
  name?: string;
  quantity?: string;
  location?: string;
  shelfDays?: string;
  purchasedAt?: string;
  producedAt?: string;
  packageExpiresAt?: string;
  storedAt?: string;
}

export interface ItemRequest {
  id: number;
}

export interface UpdateItemRequest extends ItemRequest {
  edits: ItemEdits;
}

export interface AddManualItemRequest {
  name: string;
  quantity: string;
  location: string;
}

export interface UseFirstRequest extends ItemRequest {
  enabled: boolean;
}

export interface RemoveItemsRequest {
  ids: number[];
}

export interface RecipeRequest {
  id: string;
  selected?: number[];
}

export interface ShoppingItemRequest {
  id: number;
}

export interface ClearRequest {
  selected: number[];
}

export interface PantryItemRequest {
  name: string;
}

export interface SuggestionDecisionRequest {
  id: number;
  accept: boolean;
}

export interface SaveRuleRequest {
  name: string;
  oldLocation: string;
  location: string;
  days: string;
}

export interface DeleteRuleRequest {
  name: string;
  location: string;
  kind: RuleKind;
}

export interface ImportRequest {
  id: number;
}

export interface DemoModeRequest {
  enabled: boolean;
}

export interface TextImportRequest {
  text: string;
}

export interface ImportImageUpload {
  filename: string;
  mimeType: string;
  data: ArrayBuffer;
  lastModified: number;
}

export interface ImportImagesRequest {
  origin: "gallery" | "share" | "camera";
  files: ImportImageUpload[];
}

export interface StartImportRequest {
  privacyConfirmed: true;
  allowDuplicate: boolean;
}

export interface ConfirmImportRequest {
  allowDuplicate: boolean;
}

export interface DraftItemRequest {
  index: number;
}

export interface EditDraftItemRequest extends DraftItemRequest {
  edits: ItemEdits;
}

export interface SetDraftCategoryRequest extends DraftItemRequest {
  category: Exclude<DraftItemGroup, "ignored">;
}

export type ApiMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

declare const requestType: unique symbol;
declare const responseType: unique symbol;

export interface ApiRoute<TRequest, TResponse> {
  readonly method: ApiMethod;
  readonly path: string;
  readonly [requestType]: TRequest;
  readonly [responseType]: TResponse;
}

const route = <TRequest, TResponse>(
  method: ApiMethod,
  path: string,
): ApiRoute<TRequest, TResponse> =>
  ({ method, path }) as unknown as ApiRoute<TRequest, TResponse>;

export const apiRoutes = {
  health: route<void, { status: "ok" }>("GET", "/api/health"),
  state: route<void, StateDto>("GET", "/api/state"),
  recipes: route<void, RecipeSummaryDto[]>("GET", "/api/recipes"),
  recipeDetail: route<RecipeRequest, RecipeDetailDto>(
    "GET",
    "/api/recipes/:id",
  ),
  clearPreview: route<ClearRequest, ClearPreviewDto>(
    "POST",
    "/api/clear/preview",
  ),
  searchClearRecipes: route<ClearRequest, ClearRecipesResult>(
    "POST",
    "/api/clear/search",
  ),
  addItem: route<AddManualItemRequest, SaveItemResult>("POST", "/api/items"),
  updateItem: route<UpdateItemRequest, SaveItemResult>(
    "PATCH",
    "/api/items/:id",
  ),
  useItem: route<ItemRequest, ActionResult>(
    "POST",
    "/api/items/:id/use",
  ),
  markItemAbsent: route<ItemRequest, ActionResult>(
    "POST",
    "/api/items/:id/absent",
  ),
  setItemUseFirst: route<UseFirstRequest, ActionResult>(
    "POST",
    "/api/items/:id/first",
  ),
  removeItems: route<RemoveItemsRequest, ActionResult>(
    "POST",
    "/api/items/remove",
  ),
  confirmRememberedRules: route<void, ActionResult>(
    "POST",
    "/api/rules/remembered/confirm",
  ),
  dismissRememberedRules: route<void, ActionResult>(
    "POST",
    "/api/rules/remembered/dismiss",
  ),
  saveRule: route<SaveRuleRequest, ActionResult>("PUT", "/api/rules"),
  deleteRule: route<DeleteRuleRequest, ActionResult>("DELETE", "/api/rules"),
  addPantryItem: route<PantryItemRequest, ActionResult>(
    "POST",
    "/api/pantry",
  ),
  removePantryItem: route<PantryItemRequest, ActionResult>(
    "DELETE",
    "/api/pantry/:name",
  ),
  decideSuggestion: route<SuggestionDecisionRequest, ActionResult>(
    "POST",
    "/api/suggestions/:id",
  ),
  addMissingIngredients: route<RecipeRequest, AddMissingResult>(
    "POST",
    "/api/recipes/:id/add-missing",
  ),
  shopping: route<void, ShoppingDto[]>("GET", "/api/shopping"),
  shoppingText: route<void, ShoppingTextDto>(
    "GET",
    "/api/shopping/text",
  ),
  removeShoppingItem: route<ShoppingItemRequest, ActionResult>(
    "DELETE",
    "/api/shopping/:id",
  ),
  deleteImport: route<ImportRequest, ActionResult>(
    "DELETE",
    "/api/imports/:id",
  ),
  deleteAllData: route<void, DeleteAllDataResult>("DELETE", "/api/data"),
  setDemoMode: route<DemoModeRequest, StateDto>("PUT", "/api/demo"),
  importStatus: route<void, ImportStatusDto>("GET", "/api/import"),
  beginTextImport: route<TextImportRequest, ImportStatusDto>(
    "POST",
    "/api/import/text",
  ),
  uploadImportImages: route<ImportImagesRequest, ImportStatusDto>(
    "POST",
    "/api/import/images",
  ),
  startImport: route<StartImportRequest, ImportStatusDto>(
    "POST",
    "/api/import/start",
  ),
  cancelImport: route<void, ImportStatusDto>(
    "POST",
    "/api/import/cancel",
  ),
  editDraftItem: route<EditDraftItemRequest, ImportStatusDto>(
    "PATCH",
    "/api/import/draft/:i",
  ),
  setDraftCategory: route<SetDraftCategoryRequest, ImportStatusDto>(
    "POST",
    "/api/import/draft/:i/category",
  ),
  dropDraftItem: route<DraftItemRequest, ImportStatusDto>(
    "POST",
    "/api/import/draft/:i/drop",
  ),
  retrieveDraftItem: route<DraftItemRequest, ImportStatusDto>(
    "POST",
    "/api/import/draft/:i/retrieve",
  ),
  confirmImport: route<ConfirmImportRequest, ImportStatusDto>(
    "POST",
    "/api/import/confirm",
  ),
} as const;

export type ApiRouteName = keyof typeof apiRoutes;

export type RequestOf<TRoute extends ApiRoute<unknown, unknown>> =
  TRoute[typeof requestType];

export type ResponseOf<TRoute extends ApiRoute<unknown, unknown>> =
  TRoute[typeof responseType];
