import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ChatClientError,
  isAbortError,
} from "../../server/ai/chat-client.js";
import {
  DeepSeekChatClient,
  isRetryableFailure,
  kindForHttpStatus,
  kindForNetworkError,
} from "../../server/ai/deepseek-chat-client.js";
import { StaticCredentialProvider } from "../../server/ai/credentials.js";
import { RecordingChatClient } from "../../server/ai/recorded-chat-client.js";
import {
  encodeChatRequest,
  ErrorKind,
  type ChatRequest,
  type ChatResult,
} from "../../server/ai/chat-types.js";
import {
  FakeHttpServer,
  type MockReply,
} from "../helpers/fake-http-server.js";

const TEST_KEY = "test-key-9f3a7c";
const servers: FakeHttpServer[] = [];

function textPart(text: string) {
  return { type: "text" as const, text };
}

function userRequest(text = "x"): ChatRequest {
  return {
    messages: [
      { role: "system", parts: [textPart("只输出 JSON。")] },
      { role: "user", parts: [textPart(text)] },
    ],
    jsonMode: true,
    maxTokens: 4_000,
  };
}

function imageRequest(): ChatRequest {
  const request = userRequest("看图");
  request.messages[1]?.parts.push({
    type: "image_url",
    image_url: { url: "data:image/jpeg;base64,/9j/ZmFrZQ==" },
  });
  return request;
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function startReplies(...replies: MockReply[]): Promise<FakeHttpServer> {
  const server = await FakeHttpServer.fromReplies(...replies).start();
  servers.push(server);
  return server;
}

function clientFor(
  server: FakeHttpServer,
  options: {
    apiKey?: string;
    idleTimeoutMs?: number;
    deadlineMs?: number;
    retryDelayMs?: number;
    fetch?: typeof fetch;
  } = {},
): DeepSeekChatClient {
  return new DeepSeekChatClient({
    credentials: new StaticCredentialProvider(options.apiKey ?? TEST_KEY),
    baseUrl: server.url,
    idleTimeoutMs: options.idleTimeoutMs ?? 200,
    deadlineMs: options.deadlineMs ?? 1_000,
    retryDelayMs: options.retryDelayMs ?? 0,
    fetch: options.fetch,
  });
}

async function errorOf(promise: Promise<unknown>): Promise<ChatClientError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ChatClientError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected the request to fail");
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

afterEach(async () => {
  const active = servers.splice(0);
  await Promise.all(active.map((server) => server.close()));
});

describe("DeepSeek ChatClient", () => {
  it("posts the encoded body with the key in a header", async () => {
    const server = await startReplies({
      body: chatCompletion('{"秘方":"红烧"}', "stop", 300, 40),
    });
    const client = clientFor(server, { deadlineMs: 2_000 });
    const request = userRequest("冰箱里有五花肉");
    const result = await client.send(request);

    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]?.method).toBe("POST");
    expect(server.requests[0]?.path).toBe("/chat/completions");
    expect(server.requests[0]?.headers.authorization).toBe(`Bearer ${TEST_KEY}`);
    expect(server.requests[0]?.headers["content-type"]).toContain("application/json");
    expect(server.requests[0]?.body).toBe(encodeChatRequest(request).body);
    expect(server.requests[0]?.body).not.toContain(TEST_KEY);
    expect(result).toMatchObject({
      content: '{"秘方":"红烧"}',
      finishReason: "stop",
      truncated: false,
      usage: { promptTokens: 300, totalTokens: 340 },
    });
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(result.rawBody).toContain("秘方");
  });

  it("sends images as data URLs without exposing them in the request metadata", async () => {
    const server = await startReplies({ body: chatCompletion("{}") });
    const client = clientFor(server);
    const request = imageRequest();
    await client.send(request);
    const body = JSON.parse(server.requests[0]?.body ?? "{}") as {
      messages?: Array<{ content?: Array<{ type: string; image_url?: { url: string } }> }>;
    };
    const content = body.messages?.[1]?.content ?? [];
    expect(content).toHaveLength(2);
    expect(content[1]?.type).toBe("image_url");
    expect(content[1]?.image_url?.url).toMatch(/^data:image\/jpeg;base64,/u);
    expect(encodeChatRequest(request).summary.imageCount).toBe(1);
  });

  it("keeps concurrent callers' answers associated with their own requests", async () => {
    const server = await new FakeHttpServer((request) => ({
      body: request.body.includes('"content":"a"')
        ? chatCompletion("for a")
        : chatCompletion("for b"),
    })).start();
    servers.push(server);
    const client = clientFor(server);
    const [a, b] = await Promise.all([
      client.send(userRequest("a")),
      client.send(userRequest("b")),
    ]);
    expect([a.content, b.content]).toEqual(["for a", "for b"]);
    expect(server.requests).toHaveLength(2);
  });

  it("does not put the key or image data URL in console output", async () => {
    const server = await startReplies({ body: chatCompletion("{}") });
    const methods = ["debug", "info", "log", "warn", "error"] as const;
    const spies = methods.map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    try {
      await clientFor(server).send(imageRequest());
      const output = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
      expect(output).not.toContain(TEST_KEY);
      expect(output).not.toContain("data:image");
      expect(output).not.toContain("base64");
    } finally {
      for (const spy of spies) {
        spy.mockRestore();
      }
    }
  });

  it.each([
    [401, ErrorKind.AuthFailed, 1],
    [403, ErrorKind.AuthFailed, 1],
    [402, ErrorKind.QuotaOrRateLimit, 1],
    [429, ErrorKind.QuotaOrRateLimit, 1],
    [400, ErrorKind.RequestRejected, 1],
    [422, ErrorKind.RequestRejected, 1],
    [500, ErrorKind.ServerError, 2],
    [503, ErrorKind.ServerError, 2],
  ] as const)("maps status %i to %s and makes %i request(s)", async (status, kind, requests) => {
    const server = await startReplies(
      { status, body: JSON.stringify({ error: { message: "scripted" } }) },
      { status, body: JSON.stringify({ error: { message: "scripted" } }) },
    );
    const error = await errorOf(clientFor(server).send(userRequest()));
    expect(error.chatError.kind).toBe(kind);
    expect(error.chatError.httpStatus).toBe(status);
    expect(error.chatError.detail).toContain(String(status));
    expect(server.requests).toHaveLength(requests);
  });

  it("does not retry client errors", async () => {
    for (const status of [400, 401, 402, 403, 404, 409, 413, 422, 429]) {
      const server = await startReplies(
        { status, body: JSON.stringify({ error: { message: "scripted" } }) },
        { body: chatCompletion("must not be fetched") },
      );
      const error = await errorOf(clientFor(server).send(userRequest()));
      expect(error.chatError.httpStatus).toBe(status);
      expect(server.requests).toHaveLength(1);
      await server.close();
      servers.splice(servers.indexOf(server), 1);
    }
  });

  it("retries a server error once and then succeeds", async () => {
    const server = await startReplies(
      { status: 500, body: "boom" },
      { body: chatCompletion("{}") },
    );
    const result = await clientFor(server).send(userRequest());
    expect(result.content).toBe("{}");
    expect(server.requests).toHaveLength(2);
  });

  it("retries a dropped connection once", async () => {
    const server = await startReplies(
      { drop: true },
      { drop: true },
    );
    const error = await errorOf(clientFor(server).send(userRequest()));
    expect(error.chatError.kind).toBe(ErrorKind.ServerError);
    expect(server.requests).toHaveLength(2);
  });

  it("does not retry a silent response beyond the idle timeout", async () => {
    const server = await startReplies(
      { stall: true },
      { body: chatCompletion("must not be fetched") },
    );
    const error = await errorOf(
      clientFor(server, { idleTimeoutMs: 40, deadlineMs: 500 }).send(userRequest()),
    );
    expect(error.chatError.kind).toBe(ErrorKind.Timeout);
    await delay(80);
    expect(server.requests).toHaveLength(1);
  });

  it("allows a slow answer within both limits", async () => {
    const server = await startReplies({ delayMs: 60, body: chatCompletion("{}") });
    const started = performance.now();
    await clientFor(server, { idleTimeoutMs: 150, deadlineMs: 300 }).send(userRequest());
    expect(performance.now() - started).toBeGreaterThanOrEqual(50);
  });

  it("applies the overall deadline to a slow answer without retrying", async () => {
    const server = await startReplies(
      { delayMs: 180, body: chatCompletion("{}") },
      { body: chatCompletion("must not be fetched") },
    );
    const started = performance.now();
    const error = await errorOf(
      clientFor(server, { idleTimeoutMs: 500, deadlineMs: 40 }).send(userRequest()),
    );
    expect(error.chatError.kind).toBe(ErrorKind.Timeout);
    expect(performance.now() - started).toBeLessThan(150);
    await delay(200);
    expect(server.requests).toHaveLength(1);
  });

  it("gives each call its own deadline", async () => {
    const server = await startReplies(
      { delayMs: 60, body: chatCompletion("first") },
      { delayMs: 60, body: chatCompletion("second") },
    );
    const client = clientFor(server, { deadlineMs: 100 });
    await expect(client.send(userRequest("a"))).resolves.toMatchObject({ content: "first" });
    await expect(client.send(userRequest("b"))).resolves.toMatchObject({ content: "second" });
  });

  it("covers retry time and retry waiting with the deadline", async () => {
    const server = await startReplies(
      { status: 503, body: "busy", delayMs: 10 },
      { delayMs: 100, body: chatCompletion("late") },
    );
    const started = performance.now();
    const error = await errorOf(
      clientFor(server, { deadlineMs: 60, retryDelayMs: 10, idleTimeoutMs: 200 }).send(userRequest()),
    );
    expect(error.chatError.kind).toBe(ErrorKind.Timeout);
    expect(performance.now() - started).toBeLessThan(180);
    expect(server.requests).toHaveLength(2);

    const waiting = await startReplies(
      { status: 503, body: "busy" },
      { body: chatCompletion("must not be fetched") },
    );
    const waitingError = await errorOf(
      clientFor(waiting, { deadlineMs: 30, retryDelayMs: 200 }).send(userRequest()),
    );
    expect(waitingError.chatError.kind).toBe(ErrorKind.Timeout);
    await delay(60);
    expect(waiting.requests).toHaveLength(1);
  });

  it("allows a request to override idle and deadline limits", async () => {
    const server = await startReplies(
      { delayMs: 100, body: chatCompletion("late") },
      { stall: true },
    );
    const shortDeadline = userRequest("x");
    shortDeadline.deadlineMs = 30;
    const deadlineError = await errorOf(clientFor(server).send(shortDeadline));
    expect(deadlineError.chatError.kind).toBe(ErrorKind.Timeout);
    const shortIdle = userRequest("y");
    shortIdle.idleTimeoutMs = 30;
    const idleError = await errorOf(clientFor(server).send(shortIdle));
    expect(idleError.chatError.kind).toBe(ErrorKind.Timeout);
    expect(encodeChatRequest(shortDeadline).body).toBe(encodeChatRequest(userRequest("x")).body);
  });

  it("returns a truncated answer as a partial success", async () => {
    const content = '{"dishes":[{"name":"番茄炒蛋"},{"na';
    const server = await startReplies({
      body: chatCompletion(content, "length", 900, 4000),
    });
    const result = await clientFor(server).send(userRequest());
    expect(result.truncated).toBe(true);
    expect(result.finishReason).toBe("length");
    expect(result.content).toBe(content);
    expect(server.requests).toHaveLength(1);
  });

  it.each(["<html>gateway</html>", '{"choices":[{"message":{},"finish_reason":"stop"}]}'])(
    "returns BadResponse for an unparsable answer without retrying (%s)",
    async (body) => {
      const server = await startReplies(
        { body },
        { body: chatCompletion("must not be fetched") },
      );
      const error = await errorOf(clientFor(server).send(userRequest()));
      expect(error.chatError.kind).toBe(ErrorKind.BadResponse);
      expect(server.requests).toHaveLength(1);
    },
  );

  it("stops a retry when cancellation arrives during the wait", async () => {
    const server = await startReplies(
      { status: 500, body: "boom" },
      { body: chatCompletion("must not be fetched") },
    );
    const controller = new AbortController();
    const pending = clientFor(server, { retryDelayMs: 120 }).send(userRequest(), controller.signal);
    await waitUntil(() => server.requests.length === 1);
    controller.abort();
    await expect(pending).rejects.toSatisfy((error: unknown) => isAbortError(error));
    await delay(160);
    expect(server.requests).toHaveLength(1);
  });

  it("stays silent after cancellation and remains usable", async () => {
    const server = await startReplies(
      { stall: true },
      { body: chatCompletion("next") },
    );
    const controller = new AbortController();
    const pending = clientFor(server, { idleTimeoutMs: 80 }).send(userRequest(), controller.signal);
    await waitUntil(() => server.requests.length === 1);
    controller.abort();
    await expect(pending).rejects.toSatisfy((error: unknown) => isAbortError(error));
    await expect(clientFor(server).send(userRequest())).resolves.toMatchObject({ content: "next" });
    expect(server.requests).toHaveLength(2);
  });

  it("reports an unreachable server as NoNetwork", async () => {
    const server = await startReplies({ body: chatCompletion("never") });
    const endpoint = server.url;
    await server.close();
    servers.splice(servers.indexOf(server), 1);
    const error = await errorOf(
      new DeepSeekChatClient({
        credentials: new StaticCredentialProvider(TEST_KEY),
        baseUrl: endpoint,
        deadlineMs: 200,
        idleTimeoutMs: 100,
      }).send(userRequest()),
    );
    expect(error.chatError.kind).toBe(ErrorKind.NoNetwork);
  });

  it("does not classify a TLS error as NoNetwork", async () => {
    const fakeFetch: typeof fetch = async () => {
      throw new Error("ERR_TLS_CERT_ALTNAME_INVALID");
    };
    const server = await startReplies({ body: "never" });
    const error = await errorOf(clientFor(server, { fetch: fakeFetch }).send(userRequest()));
    expect(error.chatError.kind).toBe(ErrorKind.SecureConnectionFailed);
  });

  it("maps a failed TLS handshake from the local service", async () => {
    const server = await startReplies({ body: "never" });
    server.setGarbageResponse("HTTP/1.1 400 Bad Request\r\n\r\n");
    const error = await errorOf(
      new DeepSeekChatClient({
        credentials: new StaticCredentialProvider(TEST_KEY),
        baseUrl: `https://127.0.0.1:${server.port}`,
        deadlineMs: 300,
        idleTimeoutMs: 100,
      }).send(userRequest()),
    );
    expect(error.chatError.kind).toBe(ErrorKind.SecureConnectionFailed);
    expect(server.requests).toHaveLength(0);
  });

  it("does not send without a key and reads the key at send time", async () => {
    const server = await startReplies(
      { body: chatCompletion("first") },
      { body: chatCompletion("second") },
    );
    const credentials = new StaticCredentialProvider("");
    const client = new DeepSeekChatClient({ credentials, baseUrl: server.url });
    expect(client.isConfigured()).toBe(false);
    const missing = await errorOf(client.send(userRequest()));
    expect(missing.chatError.kind).toBe(ErrorKind.NotConfigured);
    expect(server.requests).toHaveLength(0);
    credentials.setKey("deepseek", TEST_KEY);
    await expect(client.send(userRequest("a"))).resolves.toMatchObject({ content: "first" });
    credentials.setKey("deepseek", "user-key-2");
    await expect(client.send(userRequest("b"))).resolves.toMatchObject({ content: "second" });
    expect(server.requests[0]?.headers.authorization).toBe(`Bearer ${TEST_KEY}`);
    expect(server.requests[1]?.headers.authorization).toBe("Bearer user-key-2");
  });

  it("keeps a missing-key request silent when it is cancelled", async () => {
    const server = await startReplies({ body: chatCompletion("must not be fetched") });
    const client = new DeepSeekChatClient({
      credentials: new StaticCredentialProvider(""),
      baseUrl: server.url,
    });
    const controller = new AbortController();
    const pending = client.send(userRequest(), controller.signal);
    controller.abort();
    await expect(pending).rejects.toSatisfy((error: unknown) => isAbortError(error));
    await delay(30);
    expect(server.requests).toHaveLength(0);
  });

  it("keeps shared recording clients' answers and recordings separate", async () => {
    const server = await startReplies(
      { body: chatCompletion("for a") },
      { body: chatCompletion("for b") },
    );
    const client = clientFor(server);
    const a = new RecordingChatClient(client);
    const b = new RecordingChatClient(client);

    const resultA = await a.send(userRequest("a"));
    const resultB = await b.send(userRequest("b"));

    expect(resultA.content).toBe("for a");
    expect(resultB.content).toBe("for b");
    expect(a.recording().exchanges).toHaveLength(1);
    expect(b.recording().exchanges).toHaveLength(1);
    expect(a.recording().exchanges[0]?.response).toContain("for a");
    expect(b.recording().exchanges[0]?.response).toContain("for b");
    expect(server.requests).toHaveLength(2);
  });

  it("recognizes only server failures and dropped connections as retryable", () => {
    expect(isRetryableFailure(new Error("server error"), 500)).toBe(true);
    expect(isRetryableFailure(new Error("service unavailable"), 503)).toBe(true);
    expect(isRetryableFailure(new Error("socket hang up"), 0)).toBe(true);
    expect(isRetryableFailure(new Error("socket hang up"), 200)).toBe(true);
    expect(isRetryableFailure(new Error("protocol failure"), 0)).toBe(false);
    expect(isRetryableFailure(new Error("protocol invalid operation"), 0)).toBe(false);
    expect(isRetryableFailure(new Error("protocol unknown"), 0)).toBe(false);
    expect(isRetryableFailure(new Error("request timed out"), 0)).toBe(false);
    expect(isRetryableFailure(new Error("The operation was aborted"), 0)).toBe(false);
    expect(isRetryableFailure(new Error("not found"), 404)).toBe(false);
    expect(isRetryableFailure(new Error("connect ECONNREFUSED"), 0)).toBe(false);
    expect(kindForNetworkError(new Error("socket hang up"))).toBe(ErrorKind.ServerError);
  });

  it("keeps the default credential provider scoped to DeepSeek", () => {
    const credentials = new StaticCredentialProvider("a");
    expect(credentials.isConfigured()).toBe(true);
    expect(credentials.key("deepseek")).toBe("a");
    expect(credentials.key("lexmount")).toBe("");
    credentials.setKey("lexmount", "b");
    expect(credentials.key("lexmount")).toBe("b");
  });

  it("maps network and status errors to the expected kinds", () => {
    expect(kindForNetworkError(new Error("SELF_SIGNED_CERT_IN_CHAIN"))).toBe(ErrorKind.SecureConnectionFailed);
    expect(kindForNetworkError(new Error("connect ECONNREFUSED"))).toBe(ErrorKind.NoNetwork);
    expect(kindForNetworkError(new Error("getaddrinfo ENOTFOUND"))).toBe(ErrorKind.NoNetwork);
    expect(kindForNetworkError(new Error("temporary network failure"))).toBe(ErrorKind.NoNetwork);
    expect(kindForNetworkError(new Error("socket hang up"))).toBe(ErrorKind.ServerError);
    expect(kindForNetworkError(new Error("other side closed"))).toBe(ErrorKind.ServerError);
    expect(kindForNetworkError(new Error("request timed out"))).toBe(ErrorKind.Timeout);
    expect(kindForHttpStatus(401)).toBe(ErrorKind.AuthFailed);
    expect(kindForHttpStatus(402)).toBe(ErrorKind.QuotaOrRateLimit);
    expect(kindForHttpStatus(404)).toBe(ErrorKind.RequestRejected);
    expect(kindForHttpStatus(503)).toBe(ErrorKind.ServerError);
    expect(isRetryableFailure(new Error("socket hang up"), 0)).toBe(true);
    expect(isRetryableFailure(new Error("connect refused"), 0)).toBe(false);
  });

});
