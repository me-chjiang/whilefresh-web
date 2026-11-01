import type { Catalog } from "../domain/catalog.js";
import {
  ErrorKind,
  InputKind,
  ItemCategory,
  SourceType,
  StorageKind,
  makeRecognitionError,
  type RecognizedItem,
  type RecognitionError,
  type RecognitionResult,
} from "./types.js";

const MAX_COUNT = 999;
const MAX_SHELF_LIFE_DAYS = 3650;
const INT_MAX = 2_147_483_647;
const INT_MIN = -2_147_483_648;
const UNCATEGORIZED_NAME = "未归类";

type JsonObject = Record<string, unknown>;

export interface ParseOutcome {
  result: RecognitionResult | null;
  error: RecognitionError;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptyError(): RecognitionError {
  return {
    kind: ErrorKind.BadResponse,
    userMessage: "",
    detail: "",
    httpStatus: 0,
  };
}

function fail(detail: string): ParseOutcome {
  return {
    result: null,
    error: makeRecognitionError(ErrorKind.BadResponse, detail),
  };
}

function succeed(result: RecognitionResult): ParseOutcome {
  return { result, error: emptyError() };
}

function isNullLike(value: string): boolean {
  return new Set(["", "null", "none", "n/a", "无", "-", "—", "未知"]).has(
    value.toLowerCase(),
  );
}

function optionalText(value: unknown): string {
  let text = "";
  if (typeof value === "string") {
    text = value.trim();
  } else if (typeof value === "number") {
    text = String(value);
  }
  return isNullLike(text) ? "" : text;
}

function requiredText(value: unknown): string {
  return typeof value === "string" ? value.trim() : optionalText(value);
}

function integerOf(value: unknown): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return null;
    }
    const rounded = value < 0 ? -Math.round(-value) : Math.round(value);
    return Math.min(INT_MAX, Math.max(INT_MIN, rounded));
  }

  if (typeof value === "string") {
    const match = /\d+/.exec(value);
    if (!match) {
      return null;
    }
    return BigInt(match[0]) > BigInt(INT_MAX) ? INT_MAX : Number(match[0]);
  }

  return null;
}

function boolOf(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (["true", "yes", "是", "1"].includes(text)) {
      return true;
    }
    if (["false", "no", "否", "0"].includes(text)) {
      return false;
    }
  }
  return fallback;
}

function shelfLifeOf(value: unknown): number | null {
  const days = integerOf(value);
  return days !== null && days > 0 && days <= MAX_SHELF_LIFE_DAYS
    ? days
    : null;
}

function categoryOf(value: string): ItemCategory {
  switch (value.trim().toLowerCase()) {
    case ItemCategory.Food:
      return ItemCategory.Food;
    case ItemCategory.Seasoning:
      return ItemCategory.Seasoning;
    case ItemCategory.Irrelevant:
      return ItemCategory.Irrelevant;
    default:
      return ItemCategory.Food;
  }
}

function storageOf(value: string): StorageKind {
  switch (value.trim().toLowerCase()) {
    case StorageKind.Fridge:
      return StorageKind.Fridge;
    case StorageKind.Freezer:
      return StorageKind.Freezer;
    case StorageKind.Room:
      return StorageKind.Room;
    case StorageKind.Unknown:
      return StorageKind.Unknown;
    default:
      return StorageKind.Unknown;
  }
}

function sourceTypeOf(value: string): SourceType | null {
  switch (value.trim().toLowerCase()) {
    case SourceType.Cart:
      return SourceType.Cart;
    case SourceType.Order:
      return SourceType.Order;
    case SourceType.Receipt:
      return SourceType.Receipt;
    case SourceType.Text:
      return SourceType.Text;
    case SourceType.Other:
      return SourceType.Other;
    default:
      return null;
  }
}

function canonicalOf(
  modelName: string,
  catalog: Catalog | null,
): string {
  if (!catalog) {
    return modelName || UNCATEGORIZED_NAME;
  }
  return catalog.resolve(modelName) || UNCATEGORIZED_NAME;
}

function parseItem(
  value: unknown,
  catalog: Catalog | null,
): RecognizedItem | null {
  if (!isObject(value)) {
    return null;
  }

  let rawName = requiredText(value.raw_name);
  const modelName = requiredText(value.canonical_name);
  if (!rawName && !modelName) {
    return null;
  }
  if (!rawName) {
    rawName = modelName;
  }

  const shelf = isObject(value.shelf_life_days) ? value.shelf_life_days : {};
  const imageNumber = integerOf(value.image_index);

  return {
    rawName,
    canonicalName: canonicalOf(modelName, catalog),
    quantityText: optionalText(value.quantity_text),
    count: Math.min(
      MAX_COUNT,
      Math.max(1, integerOf(value.count) ?? 1),
    ),
    category: categoryOf(requiredText(value.category)),
    selected: boolOf(value.selected, true),
    isGift: boolOf(value.is_gift, false),
    productionDateText: optionalText(value.production_date_text),
    expiryDateText: optionalText(value.expiry_date_text),
    purchaseDateText: optionalText(value.purchase_date_text),
    storage: storageOf(requiredText(value.storage)),
    shelfLifeDays: {
      fridge: shelfLifeOf(shelf.fridge),
      freezer: shelfLifeOf(shelf.freezer),
      room: shelfLifeOf(shelf.room),
    },
    imageIndex: imageNumber !== null && imageNumber >= 1 ? imageNumber - 1 : -1,
  };
}

function sourceTypeForKind(kind: InputKind): SourceType {
  switch (kind) {
    case InputKind.Receipt:
      return SourceType.Receipt;
    case InputKind.OrderText:
      return SourceType.Text;
    case InputKind.Screenshot:
      return SourceType.Other;
  }
}

function buildResult(
  root: JsonObject,
  items: unknown[],
  catalog: Catalog | null,
  kind: InputKind,
): RecognitionResult {
  const parsedItems: RecognizedItem[] = [];
  for (const value of items) {
    const item = parseItem(value, catalog);
    if (item) {
      parsedItems.push(item);
    }
  }

  return {
    sourceType:
      sourceTypeOf(requiredText(root.source_type)) ?? sourceTypeForKind(kind),
    items: parsedItems,
    ignoredSummary: optionalText(root.ignored_summary),
    rawResponses: [],
    batchSpans: [],
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    elapsedMs: 0,
    isDemo: false,
    truncated: false,
  };
}

function stripCodeFence(value: string): string {
  let text = value.trim();
  if (text.startsWith("```")) {
    const firstNewline = text.indexOf("\n");
    text = firstNewline < 0 ? "" : text.slice(firstNewline + 1);
    const lastFence = text.lastIndexOf("```");
    if (lastFence >= 0) {
      text = text.slice(0, lastFence);
    }
  }
  return text.trim();
}

function parseJsonLoosely(content: string): unknown {
  const text = stripCodeFence(content);
  try {
    const parsed: unknown = JSON.parse(text);
    if (isObject(parsed) || Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // Fall through to the object extracted from surrounding prose.
  }

  const open = text.indexOf("{");
  const close = text.lastIndexOf("}");
  if (open >= 0 && close > open) {
    try {
      const parsed: unknown = JSON.parse(text.slice(open, close + 1));
      if (isObject(parsed) || Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      return null;
    }
  }
  return null;
}

export function parseModelContent(
  content: string,
  catalog: Catalog | null,
  kind: InputKind,
): ParseOutcome {
  const parsed = parseJsonLoosely(content);
  if (parsed === null) {
    return fail(`model text is not JSON (${content.length} chars)`);
  }

  if (Array.isArray(parsed)) {
    return succeed(buildResult({}, parsed, catalog, kind));
  }
  if (!isObject(parsed) || !Array.isArray(parsed.items)) {
    return fail('JSON has no "items" array');
  }
  return succeed(buildResult(parsed, parsed.items, catalog, kind));
}

function isWhitespace(character: string): boolean {
  return /\s/u.test(character);
}

function objectEnd(text: string, open: number): number {
  let depth = 0;
  let inString = false;
  for (let index = open; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (character === "\\") {
        index += 1;
      } else if (character === '"') {
        inString = false;
      }
    } else if (character === '"') {
      inString = true;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}" && --depth === 0) {
      return index + 1;
    }
  }
  return -1;
}

function completeItemsOfCutOffText(text: string): JsonObject[] {
  const items: JsonObject[] = [];
  const key = text.indexOf('"items"');
  if (key < 0) {
    return items;
  }
  let index = text.indexOf("[", key);
  if (index < 0) {
    return items;
  }

  index += 1;
  while (index < text.length) {
    const character = text[index];
    if (isWhitespace(character) || character === ",") {
      index += 1;
    } else if (character === "{") {
      const end = objectEnd(text, index);
      if (end < 0) {
        break;
      }
      try {
        const parsed: unknown = JSON.parse(text.slice(index, end));
        if (!isObject(parsed)) {
          break;
        }
        items.push(parsed);
      } catch {
        break;
      }
      index = end;
    } else {
      break;
    }
  }
  return items;
}

function parseCutOffContent(
  content: string,
  catalog: Catalog | null,
  kind: InputKind,
): ParseOutcome {
  const text = stripCodeFence(content);
  if (!text) {
    return fail(
      "model reply was cut off before any output (finish_reason=length)",
    );
  }

  const whole = parseModelContent(content, catalog, kind);
  if (whole.result) {
    whole.result.truncated = true;
    return whole;
  }

  const items = completeItemsOfCutOffText(text);
  if (items.length === 0) {
    return fail(
      "model reply was cut off and holds no complete item (finish_reason=length)",
    );
  }

  const root: JsonObject = {};
  const sourceType = /"source_type"\s*:\s*"([^"]*)"/.exec(text);
  if (sourceType) {
    root.source_type = sourceType[1];
  }
  const result = buildResult(root, items, catalog, kind);
  result.truncated = true;
  return succeed(result);
}

function bodyText(body: string | Uint8Array): string {
  return typeof body === "string" ? body : new TextDecoder().decode(body);
}

function tokenCount(value: unknown): number {
  return integerOf(value) ?? 0;
}

export function parseChatCompletion(
  body: string | Uint8Array,
  catalog: Catalog | null,
  kind: InputKind,
): ParseOutcome {
  const text = bodyText(body);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return fail(`HTTP body is not a JSON object: ${detail}`);
  }
  if (!isObject(parsed)) {
    return fail("HTTP body is not a JSON object");
  }

  const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
  const choice = isObject(choices[0]) ? choices[0] : {};
  const message = isObject(choice.message) ? choice.message : {};
  const finishReason =
    typeof choice.finish_reason === "string" ? choice.finish_reason : "";
  if (typeof message.content !== "string") {
    return fail(
      `response has no message content (finish_reason=${finishReason})`,
    );
  }

  const outcome =
    finishReason === "length"
      ? parseCutOffContent(message.content, catalog, kind)
      : parseModelContent(message.content, catalog, kind);
  if (!outcome.result) {
    return outcome;
  }

  const usage = isObject(parsed.usage) ? parsed.usage : {};
  outcome.result.usage = {
    promptTokens: tokenCount(usage.prompt_tokens),
    completionTokens: tokenCount(usage.completion_tokens),
    totalTokens: tokenCount(usage.total_tokens),
  };
  outcome.result.rawResponses.push(text);
  return outcome;
}

function itemKey(item: RecognizedItem): string {
  return [
    item.rawName,
    item.quantityText,
    item.isGift ? "1" : "0",
  ].join("\x1f");
}

export function mergeResults(
  results: readonly RecognitionResult[],
): RecognitionResult {
  const merged: RecognitionResult = {
    sourceType: SourceType.Other,
    items: [],
    ignoredSummary: "",
    rawResponses: [],
    batchSpans: [],
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    elapsedMs: 0,
    isDemo: false,
    truncated: false,
  };
  let sourceTypeSet = false;
  const summaries: string[] = [];

  results.forEach((part, index) => {
    let sharedImage = -1;
    if (
      index > 0 &&
      part.batchSpans.length > 0 &&
      results[index - 1].batchSpans.length > 0
    ) {
      const previousSpans = results[index - 1].batchSpans;
      const previousLast = previousSpans[previousSpans.length - 1].lastImage;
      if (
        previousLast >= 0 &&
        part.batchSpans[0].firstImage === previousLast
      ) {
        sharedImage = previousLast;
      }
    }

    const fromSharedImage = (item: RecognizedItem): boolean =>
      item.imageIndex === -1 || item.imageIndex === sharedImage;
    const previousKeys = new Set<string>();
    if (sharedImage >= 0) {
      for (const item of results[index - 1].items) {
        if (fromSharedImage(item)) {
          previousKeys.add(itemKey(item));
        }
      }
    }

    for (const item of part.items) {
      if (
        sharedImage >= 0 &&
        fromSharedImage(item) &&
        previousKeys.has(itemKey(item))
      ) {
        continue;
      }
      merged.items.push(item);
    }

    if (
      !sourceTypeSet ||
      (merged.sourceType === SourceType.Other &&
        part.sourceType !== SourceType.Other)
    ) {
      merged.sourceType = part.sourceType;
      sourceTypeSet = true;
    }
    if (
      part.ignoredSummary &&
      !summaries.includes(part.ignoredSummary)
    ) {
      summaries.push(part.ignoredSummary);
    }

    merged.rawResponses.push(...part.rawResponses);
    merged.batchSpans.push(...part.batchSpans);
    merged.usage.promptTokens += part.usage.promptTokens;
    merged.usage.completionTokens += part.usage.completionTokens;
    merged.usage.totalTokens += part.usage.totalTokens;
    merged.isDemo ||= part.isDemo;
    merged.truncated ||= part.truncated;
  });

  merged.ignoredSummary = summaries.join("；");
  return merged;
}

