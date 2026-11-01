import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  ServerResponse,
} from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";

import { Catalog } from "../../server/domain/catalog.js";
import {
  DeepSeekRecognizer,
  kindForHttpStatus,
  kindForNetworkError,
  type DeepSeekRecognizerOptions,
} from "../../server/recognition/deepseek.js";
import { DeepSeekChatClient } from "../../server/ai/deepseek-chat-client.js";
import { StaticCredentialProvider } from "../../server/ai/credentials.js";
import {
  ErrorKind,
  InputKind,
  type RecognitionError,
  type RecognitionRequest,
  userMessageFor,
} from "../../server/recognition/types.js";

const TEST_KEY = "test-key-9f3a7c";

const vocabulary = Catalog.fromJson(
  readFileSync(
    new URL(
      "../../test-data/vocabulary/synthetic-vocabulary.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

interface CapturedRequest {
  method: string | undefined;
  path: string | undefined;
  headers: IncomingHttpHeaders;
  body: string;
}

interface MockReply {
  status?: number;
  body?: string;
  delayMs?: number;
  stall?: boolean;
}

type Responder = (
  request: CapturedRequest,
  index: number,
) => MockReply | Promise<MockReply>;

class FakeHttpService {
  readonly requests: CapturedRequest[] = [];
  private readonly sockets = new Set<Socket>();
  private readonly server = createServer((request, response) => {
    void this.handle(request, response);
  });
  private baseUrl = "";
  private closed = false;

  constructor(private readonly responder: Responder) {
    this.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
  }

  async start(): Promise<this> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      this.server.once("error", onError);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.off("error", onError);
        resolve();
      });
    });

    const address = this.server.address() as AddressInfo | null;
    if (!address) {
      throw new Error("fake service has no address");
    }
    this.baseUrl = `http://127.0.0.1:${address.port}`;
    return this;
  }

  get url(): string {
    return this.baseUrl;
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const socket of this.sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    const captured: CapturedRequest = {
      method: request.method,
      path: request.url,
      headers: request.headers,
      body: Buffer.concat(chunks).toString("utf8"),
    };
    this.requests.push(captured);

    try {
      const reply = await this.responder(captured, this.requests.length - 1);
      if (reply.delayMs && reply.delayMs > 0) {
        await delay(reply.delayMs);
      }
      if (reply.stall) {
        return;
      }
      response.writeHead(reply.status ?? 200, {
        "content-type": "application/json",
      });
      response.end(reply.body ?? "");
    } catch (error) {
      response.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

const services: FakeHttpService[] = [];
let directory = "";
let tallImage = "";

async function startService(
  responder: Responder,
): Promise<FakeHttpService> {
  const service = await new FakeHttpService(responder).start();
  services.push(service);
  return service;
}

async function startReplies(
  ...replies: MockReply[]
): Promise<FakeHttpService> {
  return startService((_request, index) => {
    const reply = replies[Math.min(index, replies.length - 1)];
    if (!reply) {
      throw new Error("fake service has no scripted reply");
    }
    return reply;
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("condition was not met before the timeout");
    }
    await delay(5);
  }
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the recognition request to fail");
}

function item(
  rawName: string,
  canonicalName = rawName,
  quantityText = "",
): Record<string, unknown> {
  return {
    raw_name: rawName,
    canonical_name: canonicalName,
    quantity_text: quantityText,
  };
}

function modelContent(
  items: readonly Record<string, unknown>[],
): string {
  return JSON.stringify({
    source_type: "cart",
    items,
  });
}

function chatCompletion(
  content: string,
  finishReason = "stop",
  promptTokens = 100,
  completionTokens = 50,
): string {
  return JSON.stringify({
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  });
}

function textRequest(text = "x"): RecognitionRequest {
  return {
    kind: InputKind.OrderText,
    images: [],
    text,
    vocabulary,
  };
}

function imageRequest(): RecognitionRequest {
  return {
    kind: InputKind.Screenshot,
    images: [{ path: tallImage, captureDate: "2026-10-18" }],
    text: "",
    vocabulary,
  };
}

interface RecognizerTestOptions extends Partial<DeepSeekRecognizerOptions> {
  apiKey?: string;
  baseUrl?: string;
  idleTimeoutMs?: number;
  deadlineMs?: number;
  retryDelayMs?: number;
}

function recognizerFor(
  service: FakeHttpService,
  options: RecognizerTestOptions = {},
): DeepSeekRecognizer {
  const {
    apiKey = TEST_KEY,
    baseUrl = service.url,
    idleTimeoutMs = 2_000,
    deadlineMs = 4_000,
    retryDelayMs = 0,
    batchLimits,
    requestOptions,
  } = options;
  const client = new DeepSeekChatClient({
    credentials: new StaticCredentialProvider(apiKey),
    baseUrl,
    idleTimeoutMs,
    deadlineMs,
    retryDelayMs,
  });
  return new DeepSeekRecognizer(client, { batchLimits, requestOptions });
}

function imageCount(body: string): number {
  const parsed = JSON.parse(body) as {
    messages: Array<{
      content: Array<{ type: string }>;
    }>;
  };
  return parsed.messages[0].content.filter(
    (block) => block.type === "image_url",
  ).length;
}

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "whilefresh-deepseek-"));
  tallImage = join(directory, "cart.png");
  await sharp({
    create: {
      width: 1_100,
      height: 3_000,
      channels: 3,
      background: { r: 210, g: 210, b: 210 },
    },
  })
    .png()
    .toFile(tallImage);
});

afterEach(async () => {
  const active = services.splice(0);
  await Promise.all(active.map((service) => service.close()));
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("DeepSeek recognizer", () => {
  it("sends a well-formed image request and parses the answer", async () => {
    const service = await startReplies({
      body: chatCompletion(
        modelContent([item("鲜鸡蛋", "鸡蛋")]),
        "stop",
        1_000,
        200,
      ),
    });
    const recognizer = recognizerFor(service);

    const result = await recognizer.recognize(
      imageRequest(),
      new AbortController().signal,
    );

    expect(service.requests).toHaveLength(1);
    const request = service.requests[0];
    expect(request.method).toBe("POST");
    expect(request.path).toBe("/chat/completions");
    expect(request.headers.authorization).toBe(`Bearer ${TEST_KEY}`);
    expect(request.headers["content-type"]).toContain("application/json");
    expect(request.body).not.toContain(TEST_KEY);

    const body = JSON.parse(request.body) as {
      model: string;
      response_format: { type: string };
      temperature: number;
      messages: Array<{
        role: string;
        content: Array<{
          type: string;
          image_url?: { url: string };
        }>;
      }>;
    };
    expect(body.model).toBe("deepseek-flash");
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.temperature).toBe(0);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe("user");
    expect(body.messages[0].content).toHaveLength(7);
    const images = body.messages[0].content.filter(
      (block) => block.type === "image_url",
    );
    expect(images).toHaveLength(3);
    for (const image of images) {
      expect(image.image_url?.url).toMatch(
        /^data:image\/jpeg;base64,/u,
      );
    }

    expect(result.items).toHaveLength(1);
    expect(result.items[0].canonicalName).toBe("鸡蛋");
    expect(result.usage.totalTokens).toBe(1_200);
    expect(result.rawResponses).toHaveLength(1);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it.each([
    { status: 401, kind: ErrorKind.AuthFailed, requests: 1 },
    { status: 403, kind: ErrorKind.AuthFailed, requests: 1 },
    { status: 402, kind: ErrorKind.QuotaOrRateLimit, requests: 1 },
    { status: 429, kind: ErrorKind.QuotaOrRateLimit, requests: 1 },
    { status: 400, kind: ErrorKind.RequestRejected, requests: 1 },
    { status: 422, kind: ErrorKind.RequestRejected, requests: 1 },
    { status: 500, kind: ErrorKind.ServerError, requests: 2 },
    { status: 503, kind: ErrorKind.ServerError, requests: 2 },
  ])(
    "maps HTTP $status to $kind with the expected retry count",
    async ({ status, kind, requests }) => {
      const service = await startReplies({
        status,
        body: JSON.stringify({ error: { message: "scripted" } }),
      });
      const recognizer = recognizerFor(service);

      const error = (await rejectionOf(
        recognizer.recognize(
          textRequest(),
          new AbortController().signal,
        ),
      )) as RecognitionError;

      expect(error.kind).toBe(kind);
      expect(error.httpStatus).toBe(status);
      expect(error.detail).toContain(String(status));
      expect(error.userMessage).toBe(userMessageFor(kind));
      expect(error.userMessage).not.toContain(String(status));
      expect(service.requests).toHaveLength(requests);
    },
  );

  it("retries a 5xx answer once and then succeeds", async () => {
    const service = await startReplies(
      { status: 500, body: "boom" },
      {
        body: chatCompletion(modelContent([item("鸡蛋")])),
      },
    );
    const recognizer = recognizerFor(service);

    const result = await recognizer.recognize(
      textRequest(),
      new AbortController().signal,
    );

    expect(service.requests).toHaveLength(2);
    expect(result.items).toHaveLength(1);
  });

  it("times out a silent response without retrying it", async () => {
    const service = await startReplies(
      { status: 200, body: "", stall: true },
      { body: chatCompletion(modelContent([item("鸡蛋")])) },
    );
    const recognizer = recognizerFor(service, {
      idleTimeoutMs: 80,
      deadlineMs: 1_000,
    });

    const error = (await rejectionOf(
      recognizer.recognize(textRequest(), new AbortController().signal),
    )) as RecognitionError;

    expect(error.kind).toBe(ErrorKind.Timeout);
    await delay(120);
    expect(service.requests).toHaveLength(1);
  });

  it("stays quiet after cancellation and does not retry", async () => {
    const service = await startReplies(
      { status: 500, body: "boom" },
      { body: chatCompletion(modelContent([item("鸡蛋")])) },
    );
    const recognizer = recognizerFor(service, { retryDelayMs: 500 });
    const controller = new AbortController();
    const outcome = recognizer
      .recognize(textRequest(), controller.signal)
      .then(
        () => null,
        (error: unknown) => error,
      );

    await waitUntil(() => service.requests.length === 1);
    await delay(30);
    controller.abort();
    const error = await outcome;

    expect(error).toMatchObject({ name: "AbortError" });
    await delay(120);
    expect(service.requests).toHaveLength(1);
  });

  it("does not contact the service when the API key is missing", async () => {
    const service = await startReplies({
      body: chatCompletion(modelContent([item("鸡蛋")])),
    });
    const recognizer = recognizerFor(service, { apiKey: "" });

    const error = (await rejectionOf(
      recognizer.recognize(textRequest(), new AbortController().signal),
    )) as RecognitionError;

    expect(error.kind).toBe(ErrorKind.NotConfigured);
    expect(service.requests).toHaveLength(0);
  });

  it("splits a large image into batches and merges duplicate items", async () => {
    const egg = item("鲜鸡蛋", "鸡蛋", "10枚");
    const service = await startReplies(
      {
        body: chatCompletion(
          modelContent([egg, item("洋葱")]),
          "stop",
          1_000,
          100,
        ),
      },
      {
        body: chatCompletion(
          modelContent([egg, item("牛奶")]),
          "stop",
          800,
          80,
        ),
      },
    );
    const recognizer = recognizerFor(service, {
      batchLimits: { maxImages: 2 },
    });

    const result = await recognizer.recognize(
      imageRequest(),
      new AbortController().signal,
    );

    expect(service.requests).toHaveLength(2);
    expect(service.requests.map(({ body }) => imageCount(body))).toEqual([
      2, 1,
    ]);
    expect(result.items).toHaveLength(3);
    expect(result.rawResponses).toHaveLength(2);
    expect(result.usage).toEqual({
      promptTokens: 1_800,
      completionTokens: 180,
      totalTokens: 1_980,
    });
  });

  it("returns complete items from a truncated answer", async () => {
    const completeItem = JSON.stringify(item("鲜鸡蛋", "鸡蛋"));
    const cutOff = `{"source_type":"cart","items":[${completeItem},{"raw_name":"牛奶","cano`;
    const service = await startReplies({
      body: chatCompletion(cutOff, "length", 900, 131_072),
    });
    const recognizer = recognizerFor(service);

    const result = await recognizer.recognize(
      textRequest(),
      new AbortController().signal,
    );

    expect(result.truncated).toBe(true);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].canonicalName).toBe("鸡蛋");
    expect(service.requests).toHaveLength(1);
  });

  it("fails the whole import when a later batch fails", async () => {
    const service = await startReplies(
      {
        body: chatCompletion(modelContent([item("鸡蛋")])),
      },
      { status: 401, body: "nope" },
    );
    const recognizer = recognizerFor(service, {
      batchLimits: { maxImages: 2 },
    });

    const error = (await rejectionOf(
      recognizer.recognize(imageRequest(), new AbortController().signal),
    )) as RecognitionError;

    expect(error.kind).toBe(ErrorKind.AuthFailed);
    expect(error.httpStatus).toBe(401);
    expect(service.requests).toHaveLength(2);
  });

  it("maps network and HTTP error classes", () => {
    expect(
      kindForNetworkError(new Error("SELF_SIGNED_CERT_IN_CHAIN")),
    ).toBe(ErrorKind.SecureConnectionFailed);
    expect(kindForNetworkError(new Error("connect ECONNREFUSED"))).toBe(
      ErrorKind.NoNetwork,
    );
    expect(kindForNetworkError(new Error("socket hang up"))).toBe(
      ErrorKind.ServerError,
    );
    expect(kindForNetworkError(new Error("request timed out"))).toBe(
      ErrorKind.Timeout,
    );
    expect(kindForHttpStatus(401)).toBe(ErrorKind.AuthFailed);
    expect(kindForHttpStatus(402)).toBe(ErrorKind.QuotaOrRateLimit);
    expect(kindForHttpStatus(404)).toBe(ErrorKind.RequestRejected);
    expect(kindForHttpStatus(503)).toBe(ErrorKind.ServerError);
  });

  it("maps an unparsable successful response to a bad response", async () => {
    const service = await startReplies({
      status: 200,
      body: "<html>gateway</html>",
    });
    const recognizer = recognizerFor(service);

    const error = (await rejectionOf(
      recognizer.recognize(textRequest(), new AbortController().signal),
    )) as RecognitionError;

    expect(error.kind).toBe(ErrorKind.BadResponse);
    expect(service.requests).toHaveLength(1);
  });
});
