import type { Catalog } from "../domain/catalog.js";

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

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
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

export const ErrorKind = {
  NotConfigured: "not-configured",
  NoNetwork: "no-network",
  Timeout: "timeout",
  AuthFailed: "auth-failed",
  QuotaOrRateLimit: "quota-or-rate-limit",
  ServerError: "server-error",
  RequestRejected: "request-rejected",
  BadResponse: "bad-response",
  InvalidInput: "invalid-input",
  SecureConnectionFailed: "secure-connection-failed",
  Internal: "internal",
} as const;

export type ErrorKind = (typeof ErrorKind)[keyof typeof ErrorKind];

export const RECOGNITION_ERROR_MESSAGES = {
  [ErrorKind.NotConfigured]:
    "识别服务尚未配置，暂时无法识别。你仍可以手动添加食材。",
  [ErrorKind.NoNetwork]: "网络不可用，请检查网络连接后重试。",
  [ErrorKind.Timeout]: "识别超时了，请稍后重试。",
  [ErrorKind.AuthFailed]:
    "识别服务拒绝了请求，可能是服务凭据失效。请稍后再试或联系开发者。",
  [ErrorKind.QuotaOrRateLimit]:
    "识别服务额度已用完或请求太频繁，请稍后再试。",
  [ErrorKind.ServerError]: "识别服务暂时不可用，请稍后重试。",
  [ErrorKind.RequestRejected]:
    "识别服务无法处理这次请求，请换一张图片或稍后重试。",
  [ErrorKind.BadResponse]: "没能看懂识别结果，请重试一次。",
  [ErrorKind.InvalidInput]: "没有可识别的内容，请重新选择图片或文字。",
  [ErrorKind.SecureConnectionFailed]:
    "安全连接失败，请检查系统时间或网络环境。",
  [ErrorKind.Internal]: "图片处理组件缺失，请更新应用。",
} as const satisfies Record<ErrorKind, string>;

export interface RecognitionError {
  kind: ErrorKind;
  userMessage: string;
  detail: string;
  httpStatus: number;
}

export function userMessageFor(kind: ErrorKind): string {
  return RECOGNITION_ERROR_MESSAGES[kind];
}

export function makeRecognitionError(
  kind: ErrorKind,
  detail = "",
  httpStatus = 0,
): RecognitionError {
  return {
    kind,
    userMessage: userMessageFor(kind),
    detail,
    httpStatus,
  };
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
}

export interface Recognizer {
  recognize(
    req: RecognitionRequest,
    signal: AbortSignal,
  ): Promise<RecognitionResult>;
}
