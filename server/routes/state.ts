import type { FastifyInstance } from "fastify";

import type {
  ImportRecordDto,
  PantryDto,
  RuleDto,
  ShoppingDto,
  StateDto,
  SuggestionDto,
} from "../../shared/api.js";
import type { CategoryCode } from "../../shared/enums.js";
import { ImportStatus, Storage } from "../../shared/enums.js";
import type { BuiltinData } from "../data/builtin.js";
import type { Clock } from "../domain/clock.js";
import type { RecipeMatch } from "../domain/recipe.js";
import { displayName } from "../domain/shopping-list.js";
import type { AppState } from "../services/app-state.js";
import { ImportService } from "../services/import-service.js";

export interface RouteContext {
  state: AppState;
  builtin: BuiltinData;
  dataDir: string;
  clock: Clock;
}

function localDate(value: Date | string | null | undefined): string {
  if (!value) {
    return "";
  }
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return "";
  }
  return [
    String(date.getFullYear()).padStart(4, "0"),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function importName(inputKind: string, origin: string, images: number): string {
  let name =
    inputKind === "receipt"
      ? "小票"
      : inputKind === "order-text"
        ? "订单文字"
        : inputKind === "screenshot"
          ? "截图"
          : "导入";
  if (images > 0) {
    name += ` · ${images} 张`;
  }
  const originName =
    origin === "paste"
      ? "粘贴文字"
      : origin === "share"
        ? "系统分享"
        : origin === "camera"
          ? "拍照"
          : origin === "gallery"
            ? "相册"
            : "";
  if (originName) {
    name += ` · ${originName}`;
  }
  return name;
}

export function selectedFromQuery(value: unknown): number[] {
  const raw = Array.isArray(value) ? value : value == null ? [] : [value];
  const selected: number[] = [];
  for (const item of raw.flatMap((part) =>
    typeof part === "string" ? part.split(",") : [],
  )) {
    const id = Number(item);
    if (Number.isSafeInteger(id) && id > 0 && !selected.includes(id)) {
      selected.push(id);
    }
  }
  return selected;
}

function rules(state: AppState): RuleDto[] {
  const result: RuleDto[] = [];
  for (const rule of state.activeStore.shelfLifeRules()) {
    result.push({
      name: rule.name,
      location: storageDisplayName(rule.storage),
      days: String(rule.days),
      kind: "shelf",
      source: "你的设置",
    });
  }
  for (const rule of state.activeStore.storageRules()) {
    result.push({
      name: rule.name,
      location: storageDisplayName(rule.storage),
      days: "",
      kind: "storage",
      source: "你的设置",
    });
  }
  return result;
}

export function storageDisplayName(storage: string): string {
  switch (storage) {
    case "freezer":
      return "冷冻";
    case "room":
      return "常温";
    default:
      return "冷藏";
  }
}

export function storageFromName(value: string): Storage | null {
  switch (value.trim()) {
    case "冷藏":
    case Storage.Fridge:
      return Storage.Fridge;
    case "冷冻":
    case Storage.Freezer:
      return Storage.Freezer;
    case "常温":
    case Storage.Room:
      return Storage.Room;
    default:
      return null;
  }
}

export function categoryCode(value: string | undefined): CategoryCode {
  const categories = [
    "vegetable",
    "fruit",
    "meat",
    "seafood",
    "egg_dairy",
    "soy",
    "staple",
    "seasoning",
    "processed",
    "other",
  ];
  return categories.includes(value ?? "")
    ? (value as CategoryCode)
    : "other";
}

export function stateDto(state: AppState, builtin: BuiltinData): StateDto {
  const kitchen = state.activeKitchen;
  const selectedIds = kitchen.defaultSelection();
  const shopping: ShoppingDto[] = kitchen.shopping().map((entry) => ({
    id: entry.id,
    name: displayName(entry),
    category: categoryCode(entry.category),
  }));
  const pantry: PantryDto[] = kitchen.pantryRules().namesAtHome().map((name) => ({
    name,
    category: categoryCode(builtin.catalog.categoryOf(name)),
    bulk: kitchen.pantryRules().isBulk(name),
  }));
  const suggestions: SuggestionDto[] = kitchen.suggestions().map((item) => ({
    id: item.id ?? 0,
    name: item.name,
    note: item.message,
  }));
  const imports: ImportRecordDto[] = kitchen.imports().map((record) => ({
    id: record.id ?? 0,
    name: `${record.isDemo ? "演示 · " : ""}${importName(
      record.inputKind ?? "",
      record.origin ?? "",
      record.images?.length ?? 0,
    )}${record.status === ImportStatus.SkippedDuplicate ? " · 已跳过" : ""}`,
    date: localDate(record.createdAt),
  }));
  const importStatus = state.importStatus();
  const clearPreview = kitchen.clearFridgePreview(selectedIds);

  return {
    ...importStatus,
    items: state.items(),
    nearCount: state.nearCount(),
    attentionCount: state.attentionCount(),
    hasUnfinishedImport: state.hasUnfinishedImport(),
    selectedIds,
    recipes: kitchen.recipes().map((match) =>
      recipeSummaryDto(match, builtin.recipeSource.name),
    ),
    clearRecipes: [],
    clearPreview,
    clearResultsSummary: null,
    clearResultsReady: false,
    shopping,
    pantry,
    suggestions,
    rules: rules(state),
    imports,
    demoMode: state.demoMode,
    recognitionConfigured: state.recognitionConfigured,
    startupNotice: state.startupNotice,
    privacyNotice: ImportService.privacyNotice(),
  };
}

export function recipeSummaryDto(
  match: RecipeMatch,
  sourceName: string,
): StateDto["recipes"][number] {
  return {
    id: match.recipe.id,
    name: match.recipe.name,
    difficulty: match.recipe.difficulty ?? 1,
    haveCount: match.haveCount,
    missingCount: match.missingCount,
    sourceUrl: match.recipe.sourceUrl,
    sourceName,
    usedSelected: [...match.usedSelected],
    unusedSelected: [...match.unusedSelected],
  };
}

export function registerStateRoutes(
  app: FastifyInstance,
  context: RouteContext,
): void {
  app.get("/api/state", async () => stateDto(context.state, context.builtin));
}
