import type {
  ChatError,
  ChatRequest,
  ChatResult,
} from "./chat-types.js";

export interface ChatClient {
  send(request: ChatRequest, signal?: AbortSignal): Promise<ChatResult>;
  isConfigured(): boolean;
}

export class ChatClientError extends Error {
  readonly chatError: ChatError;
  readonly error: ChatError;

  constructor(chatError: ChatError) {
    super(chatError.detail);
    this.name = "ChatClientError";
    this.chatError = chatError;
    this.error = chatError;
  }
}

export function abortError(reason?: unknown): Error {
  if (reason instanceof Error && reason.name === "AbortError") {
    return reason;
  }
  const error = new Error(
    reason instanceof Error ? reason.message : "The operation was aborted",
  );
  error.name = "AbortError";
  return error;
}

export function isAbortError(value: unknown): value is Error {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    value.name === "AbortError"
  );
}
