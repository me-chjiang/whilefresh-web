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
  ChatClientError,
  type ChatClient,
} from "../ai/chat-client.js";
import type { ChatRequest } from "../ai/chat-types.js";

export {
  DEEPSEEK_BASE_URL,
  DEFAULT_DEADLINE_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_RETRY_DELAY_MS,
  kindForHttpStatus,
  kindForNetworkError,
} from "../ai/deepseek-chat-client.js";

export interface DeepSeekRecognizerOptions {
  batchLimits?: Partial<BatchLimits>;
  requestOptions?: RequestOptions;
}

interface PreparedBatch {
  request: ChatRequest;
  span: BatchSpan;
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

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason ?? new DOMException("Aborted", "AbortError");
  }
}

function toChatRequest(request: ReturnType<typeof buildChatRequest>): ChatRequest {
  return {
    model: request.model,
    messages: [
      {
        role: "user",
        parts: request.messages[0].content.map((part) =>
          part.type === "text"
            ? { type: "text", text: part.text }
            : { type: "image_url", image_url: { url: part.image_url.url } },
        ),
      },
    ],
    jsonMode: request.response_format.type === "json_object",
    maxTokens: request.max_tokens,
    temperature: request.temperature,
    ...(request.thinking === undefined
      ? {}
      : { thinking: request.thinking.type !== "disabled" }),
  };
}

function recognitionError(error: ChatClientError): RecognitionError {
  return failure(
    error.chatError.kind,
    error.chatError.detail,
    error.chatError.httpStatus,
  );
}

export class DeepSeekRecognizer implements Recognizer {
  private readonly client: ChatClient;
  private readonly batchLimits: BatchLimits;
  private readonly requestOptions: RequestOptions;

  constructor(client: ChatClient, options: DeepSeekRecognizerOptions = {}) {
    this.client = client;
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
    if (!this.client.isConfigured()) {
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
    const firstBatch = request.firstBatch ?? 0;
    if (firstBatch < 0 || firstBatch >= batches.length) {
      throw failure(
        ErrorKind.InvalidInput,
        `first batch ${firstBatch} of ${batches.length}`,
      );
    }

    const parts: RecognitionResult[] = [];
    for (let index = firstBatch; index < batches.length; index += 1) {
      throwIfAborted(signal);
      const batch = batches[index]!;
      let answer;
      try {
        answer = await this.client.send(batch.request, signal);
      } catch (error) {
        if (error instanceof ChatClientError) {
          throw recognitionError(error);
        }
        throw error;
      }
      const outcome = parseChatCompletion(answer.rawBody, request.vocabulary, request.kind);
      if (!outcome.result) {
        throw outcome.error;
      }
      outcome.result.batchSpans = [batch.span];
      parts.push(outcome.result);
      request.onBatch?.(index, batches.length, outcome.result);
      throwIfAborted(signal);
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
          request: toChatRequest(
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
        throw signal.reason ?? new DOMException("Aborted", "AbortError");
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
        request: toChatRequest(
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
}
