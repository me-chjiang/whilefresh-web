import {
  abortError,
  ChatClientError,
  type ChatClient,
} from "./chat-client.js";
import {
  encodeChatRequest,
  ErrorKind,
  parseChatResponse,
  type ChatError,
  type ChatRequest,
  type ChatResult,
  type EncodedChatRequest,
} from "./chat-types.js";
import type { CredentialProvider } from "./credentials.js";

export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
export const DEFAULT_IDLE_TIMEOUT_MS = 150_000;
export const DEFAULT_DEADLINE_MS = 240_000;
export const DEFAULT_RETRY_DELAY_MS = 1_000;

const MAX_RETRIES = 1;
const DETAIL_SNIPPET_LENGTH = 200;

export interface DeepSeekChatClientOptions {
  credentials: CredentialProvider;
  baseUrl?: string;
  idleTimeoutMs?: number;
  deadlineMs?: number;
  retryDelayMs?: number;
  fetch?: typeof fetch;
}

function failure(
  kind: ErrorKind,
  detail: string,
  httpStatus = 0,
): ChatClientError {
  return new ChatClientError({ kind, detail, httpStatus });
}

function errorDetails(error: unknown): string {
  const details: string[] = [];
  const seen = new Set<object>();

  const visit = (value: unknown, depth: number): void => {
    if (depth > 4 || value === null || typeof value !== "object") {
      if (typeof value === "string") {
        details.push(value);
      }
      return;
    }
    if (seen.has(value)) {
      return;
    }
    seen.add(value);
    const record = value as Record<string, unknown>;
    for (const key of ["code", "name", "message"]) {
      if (typeof record[key] === "string") {
        details.push(record[key]);
      }
    }
    visit(record.cause, depth + 1);
  };

  visit(error, 0);
  return details.join(" ");
}

function isConnectionDrop(error: unknown): boolean {
  const details = errorDetails(error);
  return /ECONNRESET|EPIPE|ERR_STREAM_PREMATURE_CLOSE|UND_ERR_SOCKET|other side closed|socket hang up/i.test(
    details,
  );
}

export function kindForHttpStatus(status: number): ErrorKind {
  if (status === 401 || status === 403) {
    return ErrorKind.AuthFailed;
  }
  if (status === 402 || status === 429) {
    return ErrorKind.QuotaOrRateLimit;
  }
  if (status >= 500) {
    return ErrorKind.ServerError;
  }
  return ErrorKind.RequestRejected;
}

export function kindForNetworkError(error: unknown): ErrorKind {
  const details = errorDetails(error);
  if (
    /CERT_|SELF_SIGNED|UNABLE_TO_(?:GET|VERIFY)|HOSTNAME_MISMATCHED|ERR_TLS_|ERR_SSL_|EPROTO|TLS handshake|SSL routines/i.test(
      details,
    )
  ) {
    return ErrorKind.SecureConnectionFailed;
  }
  if (
    /ETIMEDOUT|ESOCKETTIMEDOUT|UND_ERR_(?:CONNECT|HEADERS|BODY)_TIMEOUT|timed out|timeout/i.test(
      details,
    )
  ) {
    return ErrorKind.Timeout;
  }
  if (isConnectionDrop(error)) {
    return ErrorKind.ServerError;
  }
  return ErrorKind.NoNetwork;
}

export function isRetryableFailure(error: unknown, status: number): boolean {
  return status >= 500 || (status < 400 && isConnectionDrop(error));
}

function httpFailure(status: number, body: string): ChatClientError {
  const snippet = body
    .slice(0, DETAIL_SNIPPET_LENGTH)
    .replace(/\s+/gu, " ")
    .trim();
  return failure(kindForHttpStatus(status), `HTTP ${status}: ${snippet}`, status);
}

function networkFailure(error: unknown): ChatClientError {
  return failure(
    kindForNetworkError(error),
    `network error: ${errorDetails(error)}`,
  );
}

function abortReason(signal: AbortSignal): Error {
  return abortError(signal.reason);
}

function waitForRetry(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(abortReason(signal));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class DeepSeekChatClient implements ChatClient {
  private readonly endpoint: string;
  private readonly idleTimeoutMs: number;
  private readonly deadlineMs: number;
  private readonly retryDelayMs: number;
  private readonly requestFetch: typeof fetch;
  private credentials: CredentialProvider;

  constructor(options: DeepSeekChatClientOptions) {
    this.credentials = options.credentials;
    this.endpoint = `${(options.baseUrl ?? DEEPSEEK_BASE_URL).replace(/\/+$/u, "")}/chat/completions`;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.requestFetch = options.fetch ?? fetch;
  }

  setCredentials(provider: CredentialProvider): void {
    this.credentials = provider;
  }

  isConfigured(): boolean {
    return this.credentials.key("deepseek").length > 0;
  }

  async send(request: ChatRequest, signal?: AbortSignal): Promise<ChatResult> {
    if (signal?.aborted) {
      throw abortReason(signal);
    }
    const key = this.credentials.key("deepseek");
    if (key.length === 0) {
      await Promise.resolve();
      if (signal?.aborted) {
        throw abortReason(signal);
      }
      throw failure(ErrorKind.NotConfigured, "no DeepSeek API key configured");
    }
    return this.sendEncoded(encodeChatRequest(request), key, signal);
  }

  private async sendEncoded(
    request: EncodedChatRequest,
    key: string,
    callerSignal?: AbortSignal,
  ): Promise<ChatResult> {
    const deadlineMs = request.deadlineMs ?? this.deadlineMs;
    const idleTimeoutMs = request.idleTimeoutMs ?? this.idleTimeoutMs;
    const startedAt = performance.now();
    const callController = new AbortController();
    let deadlineHit = false;
    let callerAborted = false;
    const onCallerAbort = (): void => {
      callerAborted = true;
      callController.abort(abortReason(callerSignal as AbortSignal));
    };
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    const deadlineTimer = setTimeout(() => {
      deadlineHit = true;
      callController.abort(new Error("deadline"));
    }, deadlineMs);

    try {
      for (let attempt = 0; ; attempt += 1) {
        try {
          const response = await this.requestOnce(
            request,
            key,
            idleTimeoutMs,
            callController.signal,
          );
          if (callerAborted || callerSignal?.aborted) {
            throw abortReason(callerSignal as AbortSignal);
          }
          if (deadlineHit) {
            throw failure(
              ErrorKind.Timeout,
              `no complete answer within the ${deadlineMs} ms deadline`,
            );
          }
          if (response.status >= 500) {
            const error = httpFailure(response.status, response.body);
            if (attempt < MAX_RETRIES) {
              await waitForRetry(this.retryDelayMs, callController.signal);
              continue;
            }
            throw error;
          }
          if (response.status < 200 || response.status >= 300) {
            throw httpFailure(response.status, response.body);
          }
          const parsed = parseChatResponse(response.body);
          if (!parsed.result) {
            throw new ChatClientError(parsed.error);
          }
          parsed.result.elapsedMs = performance.now() - startedAt;
          return parsed.result;
        } catch (error) {
          if (callerAborted || callerSignal?.aborted) {
            throw abortReason(callerSignal as AbortSignal);
          }
          if (deadlineHit) {
            throw failure(
              ErrorKind.Timeout,
              `no complete answer within the ${deadlineMs} ms deadline`,
            );
          }
          if (error instanceof ChatClientError) {
            if (
              error.chatError.httpStatus !== undefined &&
              error.chatError.httpStatus >= 500 &&
              attempt < MAX_RETRIES
            ) {
              await waitForRetry(this.retryDelayMs, callController.signal);
              continue;
            }
            throw error;
          }
          const networkError = networkFailure(error);
          if (isRetryableFailure(error, 0) && attempt < MAX_RETRIES) {
            await waitForRetry(this.retryDelayMs, callController.signal);
            continue;
          }
          throw networkError;
        }
      }
    } finally {
      clearTimeout(deadlineTimer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    }
  }

  private async requestOnce(
    request: EncodedChatRequest,
    key: string,
    idleTimeoutMs: number,
    callSignal: AbortSignal,
  ): Promise<{ status: number; body: string }> {
    if (callSignal.aborted) {
      throw abortReason(callSignal);
    }
    const controller = new AbortController();
    let idleHit = false;
    const onCallAbort = (): void => {
      controller.abort(callSignal.reason);
    };
    callSignal.addEventListener("abort", onCallAbort, { once: true });
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const resetIdleTimer = (): void => {
      if (idleTimer !== undefined) {
        clearTimeout(idleTimer);
      }
      idleTimer = setTimeout(() => {
        idleHit = true;
        controller.abort(new Error("idle timeout"));
      }, idleTimeoutMs);
    };
    resetIdleTimer();
    try {
      const response = await this.requestFetch(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: request.body,
        signal: controller.signal,
      });
      resetIdleTimer();
      let body: string;
      try {
        body = await this.readResponseBody(response, resetIdleTimer);
      } catch (error) {
        // Keep an HTTP status when the peer closes while the body is read so a
        // 4xx response is not mistaken for a retryable connection drop.
        if (response.status >= 400) {
          throw httpFailure(response.status, "");
        }
        throw error;
      }
      return { status: response.status, body };
    } catch (error) {
      if (callSignal.aborted) {
        throw error;
      }
      if (idleHit) {
        throw failure(
          ErrorKind.Timeout,
          `no complete answer within the ${idleTimeoutMs} ms idle timeout`,
        );
      }
      throw error;
    } finally {
      if (idleTimer !== undefined) {
        clearTimeout(idleTimer);
      }
      callSignal.removeEventListener("abort", onCallAbort);
    }
  }

  private async readResponseBody(
    response: Response,
    bytesReceived: () => void,
  ): Promise<string> {
    if (!response.body) {
      return "";
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      bytesReceived();
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  }
}

export type { ChatError };
