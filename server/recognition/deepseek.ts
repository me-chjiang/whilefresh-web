import {
  DEFAULT_BATCH_LIMITS,
  planBatches,
  prepareImages,
  type BatchLimits,
  type PreparedImage,
} from "./image-preprocessor.js";
import {
  MAX_ORDER_TEXT_CHARS,
  buildChatRequest,
  type RequestOptions,
} from "./request-builder.js";
import {
  mergeResults,
  parseChatCompletion,
} from "./response-parser.js";
import {
  ErrorKind,
  InputKind,
  makeRecognitionError,
  type BatchSpan,
  type RecognitionError,
  type RecognitionRequest,
  type RecognitionResult,
  type Recognizer,
} from "./types.js";
import {
  DEEPSEEK_BASE_URL,
  DEFAULT_DEADLINE_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_RETRY_DELAY_MS,
  kindForHttpStatus,
  kindForNetworkError,
} from "../ai/deepseek-chat-client.js";

export {
  DEEPSEEK_BASE_URL,
  DEFAULT_DEADLINE_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_RETRY_DELAY_MS,
  kindForHttpStatus,
  kindForNetworkError,
} from "../ai/deepseek-chat-client.js";

const MAX_RETRIES = 1;
const DETAIL_SNIPPET_LENGTH = 200;

export interface DeepSeekRecognizerOptions {
  apiKey?: string;
  baseUrl?: string;
  idleTimeoutMs?: number;
  deadlineMs?: number;
  retryDelayMs?: number;
  batchLimits?: Partial<BatchLimits>;
  requestOptions?: RequestOptions;
}

interface PreparedBatch {
  body: string;
  span: BatchSpan;
}

interface HttpAnswer {
  status: number;
  body: string;
}

class RetryableFailure extends Error {
  constructor(readonly recognitionError: RecognitionError) {
    super(recognitionError.detail);
    this.name = "RetryableFailure";
  }
}

function failure(
  kind: ErrorKind,
  detail: string,
  httpStatus = 0,
  userMessage?: string,
): RecognitionError {
  const error = makeRecognitionError(kind, detail, httpStatus);
  return userMessage ? { ...error, userMessage } : error;
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

function httpFailure(status: number, body: string): RecognitionError {
  const snippet = body.replace(/\s+/gu, " ").trim().slice(0, DETAIL_SNIPPET_LENGTH);
  return failure(
    kindForHttpStatus(status),
    `HTTP ${status}: ${snippet}`,
    status,
  );
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Aborted", "AbortError");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw abortReason(signal);
  }
}

function waitForRetry(milliseconds: number, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
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

export class DeepSeekRecognizer implements Recognizer {
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly idleTimeoutMs: number;
  private readonly deadlineMs: number;
  private readonly retryDelayMs: number;
  private readonly batchLimits: BatchLimits;
  private readonly requestOptions: RequestOptions;

  constructor(options: DeepSeekRecognizerOptions = {}) {
    this.apiKey =
      options.apiKey ?? process.env.WHILEFRESH_DEEPSEEK_API_KEY ?? "";
    this.endpoint = `${(options.baseUrl ?? DEEPSEEK_BASE_URL).replace(/\/+$/u, "")}/chat/completions`;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.batchLimits = {
      ...DEFAULT_BATCH_LIMITS,
      ...options.batchLimits,
    };
    this.requestOptions = options.requestOptions ?? {};
  }

  async recognize(
    request: RecognitionRequest,
    signal: AbortSignal,
  ): Promise<RecognitionResult> {
    throwIfAborted(signal);
    if (this.apiKey.length === 0) {
      throw failure(ErrorKind.NotConfigured, "no API key configured");
    }
    if (!request.vocabulary || request.vocabulary.entries.length === 0) {
      throw failure(ErrorKind.InvalidInput, "request has no vocabulary");
    }
    if (request.kind === InputKind.OrderText) {
      const length = request.text.trim().length;
      if (length === 0) {
        throw failure(ErrorKind.InvalidInput, "empty order text");
      }
      if (length > MAX_ORDER_TEXT_CHARS) {
        throw failure(
          ErrorKind.InvalidInput,
          `order text has ${length} chars`,
          0,
          "文字太长，请分几次粘贴。",
        );
      }
    } else if (request.images.length === 0) {
      throw failure(ErrorKind.InvalidInput, "no images");
    }

    const startedAt = performance.now();
    const batches = await this.prepareBatches(request, signal);
    if (batches.length === 0) {
      throw failure(ErrorKind.InvalidInput, "no prepared batches");
    }

    const parts: RecognitionResult[] = [];
    for (const batch of batches) {
      throwIfAborted(signal);
      const answer = await this.requestWithRetry(batch.body, signal);
      const outcome = parseChatCompletion(
        answer.body,
        request.vocabulary,
        request.kind,
      );
      if (!outcome.result) {
        throw outcome.error;
      }
      outcome.result.batchSpans = [batch.span];
      parts.push(outcome.result);
    }

    const result = mergeResults(parts);
    result.elapsedMs = performance.now() - startedAt;
    return result;
  }

  private async prepareBatches(
    request: RecognitionRequest,
    signal: AbortSignal,
  ): Promise<PreparedBatch[]> {
    if (request.kind === InputKind.OrderText) {
      return [
        {
          body: JSON.stringify(
            buildChatRequest(
              request.kind,
              request.vocabulary,
              [],
              request.text,
              this.requestOptions,
            ),
          ),
          span: { firstImage: -1, lastImage: -1 },
        },
      ];
    }

    const images: PreparedImage[] = [];
    try {
      for await (const image of prepareImages(request.images, signal)) {
        images.push(image);
      }
    } catch (error) {
      if (signal.aborted) {
        throw abortReason(signal);
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw failure(
        ErrorKind.InvalidInput,
        detail,
        0,
        "有图片无法读取，请重新选择图片。",
      );
    }

    return planBatches(images, this.batchLimits).map((batch) => {
      const firstImage = batch[0]?.imageIndex ?? -1;
      const lastImage = batch[batch.length - 1]?.imageIndex ?? -1;
      return {
        body: JSON.stringify(
          buildChatRequest(
            request.kind,
            request.vocabulary,
            batch,
            "",
            this.requestOptions,
          ),
        ),
        span: { firstImage, lastImage },
      };
    });
  }

  private async requestWithRetry(
    body: string,
    signal: AbortSignal,
  ): Promise<HttpAnswer> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.requestOnce(body, signal);
      } catch (error) {
        if (
          error instanceof RetryableFailure &&
          attempt < MAX_RETRIES
        ) {
          await waitForRetry(this.retryDelayMs, signal);
          continue;
        }
        if (error instanceof RetryableFailure) {
          throw error.recognitionError;
        }
        throw error;
      }
    }
  }

  private async requestOnce(
    body: string,
    callerSignal: AbortSignal,
  ): Promise<HttpAnswer> {
    throwIfAborted(callerSignal);

    const controller = new AbortController();
    let timeoutKind: "idle" | "deadline" | null = null;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;

    const abortForTimeout = (kind: "idle" | "deadline"): void => {
      if (!timeoutKind) {
        timeoutKind = kind;
        controller.abort(new DOMException("Timeout", "TimeoutError"));
      }
    };
    const resetIdleTimer = (): void => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () => abortForTimeout("idle"),
        this.idleTimeoutMs,
      );
    };
    const onCallerAbort = (): void => {
      controller.abort(abortReason(callerSignal));
    };

    callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    const deadlineTimer = setTimeout(
      () => abortForTimeout("deadline"),
      this.deadlineMs,
    );
    resetIdleTimer();

    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body,
        signal: controller.signal,
      });
      resetIdleTimer();
      const responseBody = await this.readResponseBody(
        response,
        resetIdleTimer,
      );

      if (response.status >= 500) {
        throw new RetryableFailure(
          httpFailure(response.status, responseBody),
        );
      }
      if (response.status < 200 || response.status >= 300) {
        throw httpFailure(response.status, responseBody);
      }
      return { status: response.status, body: responseBody };
    } catch (error) {
      if (callerSignal.aborted) {
        throw abortReason(callerSignal);
      }
      if (timeoutKind === "idle") {
        throw failure(
          ErrorKind.Timeout,
          `no complete answer within the ${this.idleTimeoutMs} ms idle timeout`,
        );
      }
      if (timeoutKind === "deadline") {
        throw failure(
          ErrorKind.Timeout,
          `no complete answer within the ${this.deadlineMs} ms deadline`,
        );
      }
      if (error instanceof RetryableFailure) {
        throw error;
      }
      if (
        typeof error === "object" &&
        error !== null &&
        "kind" in error
      ) {
        throw error;
      }

      const kind = kindForNetworkError(error);
      const recognitionError = failure(
        kind,
        `network error: ${errorDetails(error)}`,
      );
      if (isConnectionDrop(error)) {
        throw new RetryableFailure(recognitionError);
      }
      throw recognitionError;
    } finally {
      clearTimeout(idleTimer);
      clearTimeout(deadlineTimer);
      callerSignal.removeEventListener("abort", onCallerAbort);
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
