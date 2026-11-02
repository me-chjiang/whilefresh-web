import type { Catalog } from "../domain/catalog.js";

export {
  ErrorKind,
  RECOGNITION_ERROR_MESSAGES,
  makeRecognitionError,
  userMessageFor,
  type ChatError,
  type RecognitionError,
  type TokenUsage,
} from "../ai/chat-types.js";

import type { TokenUsage } from "../ai/chat-types.js";

export const InputKind = {
  Screenshot: "screenshot",
  Receipt: "receipt",
  OrderText: "order-text",
} as const;

export type InputKind = (typeof InputKind)[keyof typeof InputKind];

export const SourceType = {
  Cart: "cart",
  Order: "order",
  Receipt: "receipt",
  Text: "text",
  Other: "other",
} as const;

export type SourceType = (typeof SourceType)[keyof typeof SourceType];

export const ItemCategory = {
  Food: "food",
  Seasoning: "seasoning",
  Irrelevant: "irrelevant",
} as const;

export type ItemCategory =
  (typeof ItemCategory)[keyof typeof ItemCategory];

export const StorageKind = {
  Unknown: "unknown",
  Fridge: "fridge",
  Freezer: "freezer",
  Room: "room",
} as const;

export type StorageKind = (typeof StorageKind)[keyof typeof StorageKind];

export interface ShelfLifeDays {
  fridge: number | null;
  freezer: number | null;
  room: number | null;
}

export interface RecognizedItem {
  rawName: string;
  canonicalName: string;
  quantityText: string;
  count: number;
  category: ItemCategory;
  selected: boolean;
  isGift: boolean;
  productionDateText: string;
  expiryDateText: string;
  purchaseDateText: string;
  storage: StorageKind;
  shelfLifeDays: ShelfLifeDays;
  imageIndex: number;
}

export interface BatchSpan {
  firstImage: number;
  lastImage: number;
}

export interface RecognitionResult {
  sourceType: SourceType;
  items: RecognizedItem[];
  ignoredSummary: string;
  rawResponses: string[];
  batchSpans: BatchSpan[];
  usage: TokenUsage;
  elapsedMs: number;
  isDemo: boolean;
  truncated: boolean;
}

export interface ImageInput {
  path: string;
  captureDate: string | null;
}

export interface RecognitionRequest {
  kind: InputKind;
  images: ImageInput[];
  text: string;
  vocabulary: Catalog;
  firstBatch?: number;
  onBatch?: (
    index: number,
    count: number,
    part: RecognitionResult,
  ) => void;
}

export interface Recognizer {
  recognize(
    req: RecognitionRequest,
    signal: AbortSignal,
  ): Promise<RecognitionResult>;
}
