const DEFAULT_STEP_TIMEOUT_MS = 20_000;
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

type JsonObject = Record<string, unknown>;

export type CdpEventHandler = (
  params: JsonObject,
  sessionId: string,
) => void;

export interface CdpConnectionOptions {
  stepTimeoutMs?: number;
}

export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkError";
  }
}

interface PendingCall {
  resolve: (result: JsonObject) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class CdpConnection {
  private readonly stepTimeoutMs: number;
  private socket: WebSocket | null = null;
  private state: "idle" | "connecting" | "open" | "closed" = "idle";
  private openPromise: Promise<void> | null = null;
  private openReject: ((error: Error) => void) | null = null;
  private openAbort: (() => void) | null = null;
  private openSignal: AbortSignal | null = null;
  private lastId = 0;
  private readonly pending = new Map<number, PendingCall>();
  private readonly handlers = new Map<string, Set<CdpEventHandler>>();

  constructor(
    private readonly url: string,
    options: CdpConnectionOptions = {},
  ) {
    this.stepTimeoutMs =
      options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  }

  open(signal: AbortSignal): Promise<void> {
    if (this.state === "open") {
      return Promise.resolve();
    }
    if (this.state === "connecting" && this.openPromise) {
      return this.openPromise;
    }
    if (this.state !== "idle") {
      return Promise.reject(new NetworkError("websocket connection closed"));
    }
    if (signal.aborted) {
      return Promise.reject(abortError(signal.reason));
    }

    let parsed: URL;
    try {
      parsed = new URL(this.url);
    } catch {
      this.state = "closed";
      return Promise.reject(
        new NetworkError("websocket URL must be ws or wss"),
      );
    }
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
      this.state = "closed";
      return Promise.reject(
        new NetworkError("websocket URL must be ws or wss"),
      );
    }

    this.state = "connecting";
    try {
      this.socket = new WebSocket(parsed);
    } catch {
      this.state = "closed";
      return Promise.reject(
        new NetworkError("websocket connection error"),
      );
    }

    const socket = this.socket;
    this.openPromise = new Promise<void>((resolve, reject) => {
      this.openReject = reject;
      const onAbort = (): void => {
        this.fail(abortError(signal.reason));
      };
      this.openAbort = onAbort;
      this.openSignal = signal;
      signal.addEventListener("abort", onAbort, { once: true });

      socket.onopen = () => {
        this.removeOpenAbort();
        this.openReject = null;
        this.state = "open";
        resolve();
      };
      socket.onerror = () => {
        this.fail(new NetworkError("websocket connection error"));
      };
      socket.onclose = (event) => {
        this.fail(
          new NetworkError(
            event.reason || "websocket closed by peer",
          ),
        );
      };
      socket.onmessage = (event) => {
        void this.receive(event.data);
      };
    });
    return this.openPromise;
  }

  send(
    method: string,
    params: JsonObject = {},
    sessionId = "",
  ): Promise<JsonObject> {
    if (this.state !== "open" || !this.socket) {
      return Promise.reject(
        new NetworkError("websocket connection is not open"),
      );
    }

    const id = ++this.lastId;
    const message: JsonObject = { id, method };
    if (Object.keys(params).length > 0) {
      message.params = params;
    }
    if (sessionId) {
      message.sessionId = sessionId;
    }

    return new Promise<JsonObject>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(
          `CDP ${method} timed out after ${this.stepTimeoutMs}ms`,
        );
        error.name = "TimeoutError";
        reject(error);
      }, this.stepTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });

      try {
        this.socket?.send(JSON.stringify(message));
      } catch {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new NetworkError("websocket connection error"));
      }
    });
  }

  on(event: string, handler: CdpEventHandler): () => void {
    let handlers = this.handlers.get(event);
    if (!handlers) {
      handlers = new Set();
      this.handlers.set(event, handlers);
    }
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) {
        this.handlers.delete(event);
      }
    };
  }

  close(): void {
    if (this.state === "closed") {
      return;
    }
    if (this.state === "idle") {
      this.state = "closed";
      return;
    }
    this.fail(new NetworkError("websocket connection closed"));
  }

  private async receive(data: unknown): Promise<void> {
    const decoded = await decodeMessage(data);
    if (decoded === null) {
      return;
    }
    if (decoded.byteLength > MAX_MESSAGE_BYTES) {
      this.fail(new NetworkError("CDP message exceeds 4 MiB"));
      return;
    }

    let message: unknown;
    try {
      message = JSON.parse(decoded.text);
    } catch {
      return;
    }
    if (!isObject(message)) {
      return;
    }

    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (isObject(message.error) && Object.keys(message.error).length > 0) {
        pending.reject(
          new Error(
            typeof message.error.message === "string"
              ? message.error.message
              : "CDP request failed",
          ),
        );
      } else {
        pending.resolve(
          isObject(message.result) ? message.result : {},
        );
      }
      return;
    }

    if (typeof message.method !== "string") {
      return;
    }
    const params = isObject(message.params) ? message.params : {};
    const sessionId =
      typeof message.sessionId === "string"
        ? message.sessionId
        : "";
    for (const handler of this.handlers.get(message.method) ?? []) {
      handler(params, sessionId);
    }
  }

  private fail(error: Error): void {
    if (this.state === "closed") {
      return;
    }
    this.state = "closed";
    this.removeOpenAbort();
    this.openReject?.(error);
    this.openReject = null;

    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();

    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = null;
      socket.onerror = null;
      socket.onclose = null;
      socket.onmessage = null;
      try {
        socket.close(1000);
      } catch {
        // The socket is already unusable; pending calls have been rejected.
      }
    }
  }

  private removeOpenAbort(): void {
    if (this.openAbort) {
      this.openSignal?.removeEventListener("abort", this.openAbort);
      this.openAbort = null;
      this.openSignal = null;
    }
  }

}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function abortError(reason?: unknown): Error {
  const error = new Error(
    reason instanceof Error
      ? reason.message
      : "The operation was aborted",
  );
  error.name = "AbortError";
  return error;
}

async function decodeMessage(
  data: unknown,
): Promise<{ text: string; byteLength: number } | null> {
  if (typeof data === "string") {
    return {
      text: data,
      byteLength: new TextEncoder().encode(data).byteLength,
    };
  }
  if (data instanceof ArrayBuffer) {
    const bytes = new Uint8Array(data);
    return {
      text: new TextDecoder().decode(bytes),
      byteLength: bytes.byteLength,
    };
  }
  if (ArrayBuffer.isView(data)) {
    const bytes = new Uint8Array(
      data.buffer,
      data.byteOffset,
      data.byteLength,
    );
    return {
      text: new TextDecoder().decode(bytes),
      byteLength: bytes.byteLength,
    };
  }
  if (data instanceof Blob) {
    if (data.size > MAX_MESSAGE_BYTES) {
      return { text: "", byteLength: data.size };
    }
    return {
      text: await data.text(),
      byteLength: data.size,
    };
  }
  return null;
}
