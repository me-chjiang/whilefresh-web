import { open, readFile } from "node:fs/promises";

import { ErrorKind, type ChatError, type ChatRequestSummary } from "./chat-types.js";

export interface ChatExchange {
  request: ChatRequestSummary;
  requestDigest: string;
  elapsedMs: number;
  response?: string;
  error?: ChatError;
}

export interface ChatRecording {
  exchanges: ChatExchange[];
}

interface JsonObject {
  [key: string]: unknown;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function integer(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : 0;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function boolValue(value: unknown): boolean {
  return typeof value === "boolean" ? value : false;
}

function requestSummary(value: unknown): ChatRequestSummary {
  const request = isObject(value) ? value : {};
  return {
    model: stringValue(request.model),
    messageCount: integer(request.messages),
    imageCount: integer(request.images),
    textChars: integer(request.textChars),
    jsonMode: boolValue(request.jsonMode),
    maxTokens: integer(request.maxTokens),
  };
}

function responseBody(value: unknown): string {
  return JSON.stringify(isObject(value) ? value : {});
}

function errorKind(value: unknown): ChatError["kind"] {
  return Object.values(ErrorKind).includes(value as ChatError["kind"])
    ? (value as ChatError["kind"])
    : ErrorKind.BadResponse;
}

function chatError(value: unknown): ChatError {
  const error = isObject(value) ? value : {};
  return {
    kind: errorKind(error.kind),
    detail: stringValue(error.detail),
    httpStatus: integer(error.httpStatus),
  };
}

function exchangeFromJson(value: unknown): ChatExchange {
  const json = isObject(value) ? value : {};
  const request = isObject(json.request) ? json.request : {};
  const exchange: ChatExchange = {
    request: requestSummary(request),
    requestDigest: stringValue(request.digest),
    elapsedMs: integer(json.elapsedMs),
  };
  if (Object.prototype.hasOwnProperty.call(json, "error")) {
    exchange.error = chatError(json.error);
  } else {
    exchange.response = responseBody(json.response);
  }
  return exchange;
}

function unsupported(path: string): Error {
  return new Error(`${path} is not a format-1 or format-2 recording`);
}

export async function readChatRecording(path: string): Promise<ChatRecording> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot open recording ${path}: ${detail}`);
  }

  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    throw unsupported(path);
  }
  if (!isObject(root)) {
    throw unsupported(path);
  }

  const format = integer(root.format);
  const exchanges: ChatExchange[] = [];
  if (format === 1) {
    const responses = Array.isArray(root.responses) ? root.responses : [];
    const digests = Array.isArray(root.requestDigests)
      ? root.requestDigests
      : [];
    for (let index = 0; index < responses.length; index += 1) {
      exchanges.push({
        request: requestSummary(undefined),
        requestDigest:
          digests.length === responses.length
            ? stringValue(digests[index])
            : "",
        elapsedMs: 0,
        response: responseBody(responses[index]),
      });
    }
  } else if (format === 2) {
    const values = Array.isArray(root.exchanges) ? root.exchanges : [];
    for (const value of values) {
      exchanges.push(exchangeFromJson(value));
    }
  } else {
    throw unsupported(path);
  }

  if (exchanges.length === 0) {
    throw new Error(`${path} has no recorded answers`);
  }
  return { exchanges };
}

function jsonResponse(rawBody: string | undefined): JsonObject {
  if (rawBody === undefined) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(rawBody);
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function exchangeToJson(exchange: ChatExchange): JsonObject {
  const request = exchange.request;
  const json: JsonObject = {
    request: {
      digest: exchange.requestDigest,
      model: request.model,
      messages: request.messageCount,
      images: request.imageCount,
      textChars: request.textChars,
      jsonMode: request.jsonMode,
      maxTokens: request.maxTokens,
    },
    elapsedMs: exchange.elapsedMs,
  };
  if (exchange.error !== undefined) {
    json.error = {
      kind: exchange.error.kind,
      httpStatus: exchange.error.httpStatus ?? 0,
      detail: exchange.error.detail,
    };
  } else {
    json.response = jsonResponse(exchange.response);
  }
  return json;
}

export async function writeChatRecording(
  path: string,
  recording: ChatRecording,
): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "w", 0o600);
    await handle.chmod(0o600);
    await handle.truncate(0);
    const root = {
      format: 2,
      exchanges: recording.exchanges.map(exchangeToJson),
    };
    await handle.writeFile(`${JSON.stringify(root, null, 2)}\n`, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot write recording ${path}: ${detail}`);
  } finally {
    if (handle !== undefined) {
      await handle.close();
    }
  }
}

