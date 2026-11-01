import { createHash } from "node:crypto";

export const DEFAULT_CHAT_MODEL = "deepseek-flash";

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

export interface ChatError {
  kind: ErrorKind;
  detail: string;
  httpStatus?: number;
}

export interface RecognitionError extends ChatError {
  userMessage: string;
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

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export type ChatRole = "system" | "user" | "assistant";

export interface ChatTextPart {
  type: "text";
  text: string;
}

export interface ChatImageUrlPart {
  type: "image_url";
  image_url: {
    url: string;
  };
}

export type ChatPart = ChatTextPart | ChatImageUrlPart;

export interface ChatMessage {
  role: ChatRole;
  parts: ChatPart[];
}

export interface ChatRequest {
  model?: string;
  messages: ChatMessage[];
  jsonMode?: boolean;
  maxTokens?: number;
  temperature?: number;
  thinking?: boolean;
  idleTimeoutMs?: number;
  deadlineMs?: number;
}

export interface ChatResult {
  content: string;
  finishReason: string;
  truncated: boolean;
  usage: TokenUsage;
  elapsedMs: number;
  rawBody: string;
}

export interface ChatRequestSummary {
  model: string;
  messageCount: number;
  imageCount: number;
  textChars: number;
  jsonMode: boolean;
  maxTokens: number;
}

export interface EncodedChatRequest {
  body: string;
  summary: ChatRequestSummary;
}

export interface ChatParseOutcome<T> {
  result: T | null;
  error: ChatError;
}

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

function sortJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortJson(value[key])]),
    );
  }
  return value;
}

function wirePart(part: ChatPart): JsonValue {
  if (part.type === "image_url") {
    return {
      type: "image_url",
      image_url: { url: part.image_url.url },
    };
  }
  return { type: "text", text: part.text };
}

function wireContent(parts: readonly ChatPart[]): JsonValue {
  if (parts.length === 1 && parts[0]?.type === "text") {
    return parts[0].text;
  }
  return parts.map(wirePart);
}

export function encodeChatRequest(request: ChatRequest): EncodedChatRequest {
  const model = request.model ?? DEFAULT_CHAT_MODEL;
  const jsonMode = request.jsonMode ?? false;
  const thinking = request.thinking ?? true;
  const messages = request.messages.map((message) => ({
    role: message.role,
    content: wireContent(message.parts),
  }));
  const body: Record<string, JsonValue> = {
    model,
    messages,
  };
  if (jsonMode) {
    body.response_format = { type: "json_object" };
  }
  if (request.maxTokens !== undefined) {
    body.max_tokens = request.maxTokens;
  }
  if (request.temperature !== undefined) {
    body.temperature = request.temperature;
  }
  if (!thinking) {
    body.thinking = { type: "disabled" };
  }

  const summary: ChatRequestSummary = {
    model,
    messageCount: request.messages.length,
    imageCount: request.messages.reduce(
      (count, message) =>
        count + message.parts.filter((part) => part.type === "image_url").length,
      0,
    ),
    textChars: request.messages.reduce(
      (count, message) =>
        count +
        message.parts.reduce(
          (chars, part) => (part.type === "text" ? chars + part.text.length : chars),
          0,
        ),
      0,
    ),
    jsonMode,
    maxTokens: request.maxTokens ?? 0,
  };

  return {
    body: JSON.stringify(sortJson(body)),
    summary,
  };
}

export function requestDigest(body: string | Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

function badResponse(detail: string): ChatParseOutcome<never> {
  return {
    result: null,
    error: { kind: ErrorKind.BadResponse, detail, httpStatus: 0 },
  };
}

function bodyText(body: string | Uint8Array): string {
  return typeof body === "string" ? body : new TextDecoder().decode(body);
}

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : 0;
}

export function parseChatResponse(
  rawBody: string | Uint8Array,
): ChatParseOutcome<ChatResult> {
  const text = bodyText(rawBody);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return badResponse("HTTP body is not a JSON object: invalid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return badResponse("HTTP body is not a JSON object: no error occurred");
  }
  const root = parsed as Record<string, unknown>;
  const choices = Array.isArray(root.choices) ? root.choices : [];
  const choice =
    typeof choices[0] === "object" && choices[0] !== null
      ? (choices[0] as Record<string, unknown>)
      : {};
  const message =
    typeof choice.message === "object" && choice.message !== null
      ? (choice.message as Record<string, unknown>)
      : {};
  const finishReason =
    typeof choice.finish_reason === "string" ? choice.finish_reason : "";
  if (typeof message.content !== "string") {
    return badResponse(
      `response has no message content (finish_reason=${finishReason})`,
    );
  }
  const usage =
    typeof root.usage === "object" && root.usage !== null
      ? (root.usage as Record<string, unknown>)
      : {};
  return {
    result: {
      content: message.content,
      finishReason,
      truncated: finishReason === "length",
      usage: {
        promptTokens: tokenCount(usage.prompt_tokens),
        completionTokens: tokenCount(usage.completion_tokens),
        totalTokens: tokenCount(usage.total_tokens),
      },
      elapsedMs: 0,
      rawBody: text,
    },
    error: { kind: ErrorKind.BadResponse, detail: "", httpStatus: 0 },
  };
}

export function parseJsonContent(
  textOrResult: string | Pick<ChatResult, "content" | "finishReason">,
): ChatParseOutcome<Record<string, unknown>> {
  const content =
    typeof textOrResult === "string" ? textOrResult : textOrResult.content;
  const finishReason =
    typeof textOrResult === "string" ? "" : textOrResult.finishReason;
  let text = content.trim();
  if (text.startsWith("```")) {
    const firstLine = text.indexOf("\n");
    text = firstLine < 0 ? "" : text.slice(firstLine + 1);
    if (text.trim().endsWith("```")) {
      text = text.trim().slice(0, -3);
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return badResponse(
      `model text is not a JSON object (invalid JSON, finish_reason=${finishReason}, ${content.length} chars)`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return badResponse(
      `model text is not a JSON object (not an object, finish_reason=${finishReason}, ${content.length} chars)`,
    );
  }
  return {
    result: parsed as Record<string, unknown>,
    error: { kind: ErrorKind.BadResponse, detail: "", httpStatus: 0 },
  };
}
