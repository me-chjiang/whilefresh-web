import {
  abortError,
  ChatClientError,
  isAbortError,
  type ChatClient,
} from "./chat-client.js";
import {
  encodeChatRequest,
  ErrorKind,
  parseChatResponse,
  requestDigest,
  type ChatError,
  type ChatRequest,
  type ChatResult,
  type EncodedChatRequest,
} from "./chat-types.js";
import type { ChatExchange, ChatRecording } from "./chat-recording.js";

function failure(detail: string): ChatClientError {
  return new ChatClientError({
    kind: ErrorKind.BadResponse,
    detail,
    httpStatus: 0,
  });
}

interface Pending {
  resolve: (result: ChatResult) => void;
  reject: (error: unknown) => void;
  request: EncodedChatRequest;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class RecordedChatClient implements ChatClient {
  private readonly recorded: ChatRecording;
  private readonly requestList: EncodedChatRequest[] = [];
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private answered = 0;

  constructor(recording: ChatRecording) {
    this.recorded = recording;
  }

  isConfigured(): boolean {
    return true;
  }

  send(request: ChatRequest, signal?: AbortSignal): Promise<ChatResult> {
    const encoded = encodeChatRequest(request);
    this.requestList.push(encoded);
    const id = this.nextId;
    this.nextId += 1;

    const promise = new Promise<ChatResult>((resolve, reject) => {
      const pending: Pending = { resolve, reject, request: encoded, signal };
      const onAbort = (): void => {
        if (!this.pending.delete(id)) {
          return;
        }
        pending.signal?.removeEventListener("abort", onAbort);
        reject(abortError(signal?.reason));
      };
      pending.onAbort = onAbort;
      this.pending.set(id, pending);
      if (signal?.aborted) {
        onAbort();
      } else {
        signal?.addEventListener("abort", onAbort, { once: true });
      }
    });
    setImmediate(() => this.answer(id));
    return promise;
  }

  requests(): readonly EncodedChatRequest[] {
    return this.requestList;
  }

  remaining(): number {
    return this.recorded.exchanges.length - this.answered;
  }

  private answer(id: number): void {
    const pending = this.pending.get(id);
    if (pending === undefined) {
      return;
    }
    this.pending.delete(id);
    if (pending.onAbort !== undefined) {
      pending.signal?.removeEventListener("abort", pending.onAbort);
    }

    const index = this.answered;
    this.answered += 1;
    const exchange = this.recorded.exchanges[index];
    if (exchange === undefined) {
      pending.reject(failure(`the recording has no answer for request ${index + 1}`));
      return;
    }
    if (
      exchange.requestDigest.length > 0 &&
      exchange.requestDigest !== requestDigest(pending.request.body)
    ) {
      pending.reject(
        failure(`request ${index + 1} differs from the recorded one; re-record`),
      );
      return;
    }
    if (exchange.error !== undefined) {
      pending.reject(new ChatClientError(exchange.error));
      return;
    }
    const parsed = parseChatResponse(exchange.response ?? "");
    if (parsed.result === null) {
      pending.reject(new ChatClientError(parsed.error));
      return;
    }
    parsed.result.elapsedMs = exchange.elapsedMs;
    pending.resolve(parsed.result);
  }
}

interface RecordedEntry {
  request: ChatExchange["request"];
  requestDigest: string;
  startedAt: number;
  done: boolean;
  response?: string;
  error?: ChatError;
}

function errorFromUnknown(value: unknown): ChatError {
  if (value instanceof ChatClientError) {
    return value.chatError;
  }
  if (typeof value === "object" && value !== null) {
    const candidate = value as Partial<ChatError>;
    if (typeof candidate.kind === "string" && typeof candidate.detail === "string") {
      return {
        kind: candidate.kind as ChatError["kind"],
        detail: candidate.detail,
        httpStatus: candidate.httpStatus,
      };
    }
  }
  return {
    kind: ErrorKind.Internal,
    detail: value instanceof Error ? value.message : String(value),
    httpStatus: 0,
  };
}

export class RecordingChatClient implements ChatClient {
  private readonly inner: ChatClient;
  private readonly entries: RecordedEntry[] = [];

  constructor(inner: ChatClient) {
    this.inner = inner;
  }

  isConfigured(): boolean {
    return this.inner.isConfigured();
  }

  send(request: ChatRequest, signal?: AbortSignal): Promise<ChatResult> {
    const encoded = encodeChatRequest(request);
    const entry: RecordedEntry = {
      request: encoded.summary,
      requestDigest: requestDigest(encoded.body),
      startedAt: performance.now(),
      done: false,
    };
    this.entries.push(entry);
    let cancelled = false;
    const onAbort = (): void => {
      cancelled = true;
      this.remove(entry);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
    }

    let result: Promise<ChatResult>;
    try {
      result = this.inner.send(request, signal);
    } catch (error) {
      result = Promise.reject(error);
    }
    return result.then(
      (value) => {
        signal?.removeEventListener("abort", onAbort);
        if (cancelled || signal?.aborted) {
          throw abortError(signal?.reason);
        }
        entry.response = value.rawBody;
        entry.done = true;
        entry.startedAt = value.elapsedMs;
        return value;
      },
      (error: unknown) => {
        signal?.removeEventListener("abort", onAbort);
        if (cancelled || signal?.aborted || isAbortError(error)) {
          throw error;
        }
        entry.error = errorFromUnknown(error);
        entry.done = true;
        entry.startedAt = performance.now() - entry.startedAt;
        throw error;
      },
    );
  }

  toRecording(): ChatRecording {
    return {
      exchanges: this.entries
        .filter((entry) => entry.done)
        .map((entry) => ({
          request: entry.request,
          requestDigest: entry.requestDigest,
          elapsedMs: entry.startedAt,
          ...(entry.error === undefined
            ? { response: entry.response ?? "" }
            : { error: entry.error }),
        })),
    };
  }

  recording(): ChatRecording {
    return this.toRecording();
  }

  private remove(entry: RecordedEntry): void {
    const index = this.entries.indexOf(entry);
    if (index >= 0) {
      this.entries.splice(index, 1);
    }
  }
}

