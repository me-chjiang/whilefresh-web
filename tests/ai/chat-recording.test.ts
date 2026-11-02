import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  encodeChatRequest,
  ErrorKind,
  requestDigest,
  type ChatRequest,
} from "../../server/ai/chat-types.js";
import {
  readChatRecording,
  writeChatRecording,
  type ChatExchange,
  type ChatRecording,
} from "../../server/ai/chat-recording.js";
import { DeepSeekChatClient } from "../../server/ai/deepseek-chat-client.js";
import { StaticCredentialProvider } from "../../server/ai/credentials.js";
import {
  RecordedChatClient,
  RecordingChatClient,
} from "../../server/ai/recorded-chat-client.js";
import {
  FakeHttpServer,
  type MockReply,
} from "../helpers/fake-http-server.js";

const repository = fileURLToPath(new URL("../../", import.meta.url));

function textPart(text: string) {
  return { type: "text" as const, text };
}

function userRequest(text: string): ChatRequest {
  return {
    messages: [
      { role: "system", parts: [textPart("只输出 JSON。秘密提示词")] },
      { role: "user", parts: [textPart(text)] },
    ],
    jsonMode: true,
    maxTokens: 4_000,
  };
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

function answer(content: string, digest = ""): ChatExchange {
  return {
    request: {
      model: "deepseek-flash",
      messageCount: 2,
      imageCount: 0,
      textChars: 0,
      jsonMode: true,
      maxTokens: 4_000,
    },
    requestDigest: digest,
    elapsedMs: 0,
    response: chatCompletion(content),
  };
}

async function resultOf(
  promise: Promise<unknown>,
): Promise<{ content: string } | { error: Error & { chatError?: { kind: string } } }> {
  try {
    const result = (await promise) as { content: string };
    return result;
  } catch (error) {
    return { error: error as Error & { chatError?: { kind: string } } };
  }
}

async function runAll(
  client: RecordedChatClient | RecordingChatClient,
  requests: readonly ChatRequest[],
): Promise<string[]> {
  const outcomes: string[] = [];
  for (const request of requests) {
    const result = await resultOf(client.send(request));
    if ("content" in result) {
      outcomes.push(result.content);
    } else if (result.error.chatError !== undefined) {
      outcomes.push(`error:${result.error.chatError.kind}`);
    } else {
      outcomes.push(`error:${result.error.message}`);
    }
  }
  return outcomes;
}

function temporaryDirectory(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("chat recording", () => {
  it("replays answers in order, retains requests, and reports exhaustion", async () => {
    const failure: ChatExchange = {
      ...answer(""),
      response: undefined,
      error: {
        kind: ErrorKind.QuotaOrRateLimit,
        detail: "HTTP 429",
        httpStatus: 429,
      },
    };
    const client = new RecordedChatClient({
      exchanges: [answer("first"), answer("second"), failure],
    });

    const first = client.send(userRequest("a"));
    const second = client.send(userRequest("b"));
    const third = client.send(userRequest("c"));
    let firstSettled = false;
    void first.then(() => {
      firstSettled = true;
    });
    expect(firstSettled).toBe(false);
    expect(await first).toMatchObject({ content: "first" });
    expect(await second).toMatchObject({ content: "second" });
    await expect(third).rejects.toMatchObject({
      chatError: { kind: ErrorKind.QuotaOrRateLimit, httpStatus: 429 },
    });
    expect(client.requests()).toHaveLength(3);
    expect(client.requests()[1]?.body).toBe(encodeChatRequest(userRequest("b")).body);
    expect(client.remaining()).toBe(0);

    await expect(client.send(userRequest("d"))).rejects.toMatchObject({
      chatError: { kind: ErrorKind.BadResponse },
    });
  });

  it("uses a recorded digest only for the matching request", async () => {
    const same = userRequest("same");
    const digest = requestDigest(encodeChatRequest(same).body);
    const client = new RecordedChatClient({
      exchanges: [answer("ok", digest), answer("ok", digest)],
    });

    await expect(client.send(same)).resolves.toMatchObject({ content: "ok" });
    await expect(client.send(userRequest("changed prompt"))).rejects.toMatchObject({
      chatError: { kind: ErrorKind.BadResponse },
      message: expect.stringContaining("re-record"),
    });
  });

  it("keeps length-truncated answers as partial successes", async () => {
    const client = new RecordedChatClient({
      exchanges: [
        {
          ...answer(""),
          response: chatCompletion('{"a":[1,', "length"),
        },
      ],
    });

    await expect(client.send(userRequest("x"))).resolves.toMatchObject({
      content: '{"a":[1,',
      truncated: true,
    });
  });

  it("does not consume a replay when its request is cancelled", async () => {
    const client = new RecordedChatClient({
      exchanges: [answer("a"), answer("b")],
    });
    const controller = new AbortController();
    const cancelled = client.send(userRequest("cancelled"), controller.signal);
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    expect(client.remaining()).toBe(2);

    await expect(client.send(userRequest("next"))).resolves.toMatchObject({
      content: "a",
    });
    expect(client.remaining()).toBe(1);
    expect(client.requests()).toHaveLength(2);
  });

  it("replays a cancelled recorded request consistently", async () => {
    const inner = new RecordedChatClient({
      exchanges: [answer("a"), answer("b")],
    });
    const recorder = new RecordingChatClient(inner);
    const controller = new AbortController();
    const cancelled = recorder.send(userRequest("dropped"), controller.signal);
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    expect(await recorder.send(userRequest("kept 1"))).toMatchObject({ content: "a" });
    expect(await recorder.send(userRequest("kept 2"))).toMatchObject({ content: "b" });
    expect(recorder.recording().exchanges).toHaveLength(2);

    const replay = new RecordedChatClient(recorder.recording());
    const replayController = new AbortController();
    const replayCancelled = replay.send(userRequest("dropped"), replayController.signal);
    replayController.abort();
    await expect(replayCancelled).rejects.toMatchObject({ name: "AbortError" });
    expect(await replay.send(userRequest("kept 1"))).toMatchObject({ content: "a" });
    expect(await replay.send(userRequest("kept 2"))).toMatchObject({ content: "b" });
    expect(replay.remaining()).toBe(0);
  });

  it("leaves cancelled requests out of a recording", async () => {
    const inner = new RecordedChatClient({
      exchanges: [answer("a"), answer("b")],
    });
    const recorder = new RecordingChatClient(inner);
    const controller = new AbortController();
    const cancelled = recorder.send(userRequest("a"), controller.signal);
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });

    expect(await recorder.send(userRequest("b"))).toMatchObject({ content: "a" });
    expect(recorder.recording().exchanges).toHaveLength(1);
  });

  it("records network responses, errors, and truncated answers for offline replay", async () => {
    const replies: MockReply[] = [
      { status: 503, body: "busy" },
      { status: 200, body: chatCompletion('{"dish":"番茄炒蛋"}', "stop", 120, 30) },
      { status: 401, body: '{"error":{"message":"bad key"}}' },
      { status: 200, body: chatCompletion('{"dish":"清炒', "length") },
    ];
    const server = await FakeHttpServer.fromReplies(...replies).start();
    try {
      const network = new DeepSeekChatClient({
        credentials: new StaticCredentialProvider("test-key"),
        baseUrl: server.url,
        retryDelayMs: 0,
      });
      const recorder = new RecordingChatClient(network);
      const requests = [userRequest("一"), userRequest("二"), userRequest("三")];
      expect(await runAll(recorder, requests)).toEqual([
        '{"dish":"番茄炒蛋"}',
        `error:${ErrorKind.AuthFailed}`,
        '{"dish":"清炒',
      ]);
      const recording = recorder.recording();
      expect(recording.exchanges).toHaveLength(3);
      expect(recording.exchanges[0]?.request.messageCount).toBe(2);
      expect(recording.exchanges[0]?.requestDigest).toBe(
        requestDigest(encodeChatRequest(requests[0]!).body),
      );
      expect(recording.exchanges[1]?.error?.httpStatus).toBe(401);
      expect(recording.exchanges[2]?.response).toContain("清炒");

      const directory = temporaryDirectory("whilefresh-chat-recording-");
      try {
        const path = join(directory, "chat.json");
        await writeChatRecording(path, recording);
        expect(statSync(path).mode & 0o777).toBe(0o600);
        const text = readFileSync(path, "utf8");
        expect(text).not.toContain("test-key");
        expect(text).not.toContain("只输出");

        const loaded = await readChatRecording(path);
        expect(await runAll(new RecordedChatClient(loaded), requests)).toEqual([
          '{"dish":"番茄炒蛋"}',
          `error:${ErrorKind.AuthFailed}`,
          '{"dish":"清炒',
        ]);
        expect(server.requests).toHaveLength(4);
        await expect(
          runAll(new RecordedChatClient(loaded), [userRequest("改过的")]),
        ).resolves.toEqual([`error:${ErrorKind.BadResponse}`]);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    } finally {
      await server.close();
    }
  });

  it("checks request digests from format 1 recordings", async () => {
    const directory = temporaryDirectory("whilefresh-format1-");
    try {
      const request = userRequest("recorded");
      const digest = requestDigest(encodeChatRequest(request).body);
      const path = join(directory, "format-1.json");
      writeFileSync(
        path,
        JSON.stringify({
          format: 1,
          request: { inputKind: "order-text" },
          requestDigests: [digest],
          responses: [JSON.parse(chatCompletion("{}"))],
        }),
      );
      const recording = await readChatRecording(path);
      expect(recording.exchanges[0]?.requestDigest).toBe(digest);
      expect(await runAll(new RecordedChatClient(recording), [request])).toEqual(["{}"]);
      expect(
        await runAll(new RecordedChatClient(recording), [userRequest("other")]),
      ).toEqual([`error:${ErrorKind.BadResponse}`]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reads existing format 1 recordings", async () => {
    const fixtures = [
      {
        path: join(repository, "test-data/recordings/synthetic/cart-fresh-01.json"),
        exchanges: 1,
      },
      {
        path: join(repository, "test-data/recordings/synthetic-two-batches.json"),
        exchanges: 2,
      },
      {
        path: join(repository, "assets/demo/order-text.json"),
        exchanges: 1,
      },
    ];
    for (const fixture of fixtures) {
      const recording = await readChatRecording(fixture.path);
      expect(recording.exchanges).toHaveLength(fixture.exchanges);
      expect(recording.exchanges.every((exchange) => !exchange.error)).toBe(true);
      expect(recording.exchanges.every((exchange) => exchange.requestDigest === "")).toBe(
        true,
      );

      const replay = new RecordedChatClient(recording);
      const outcomes = await runAll(
        replay,
        recording.exchanges.map(() => userRequest("anything")),
      );
      expect(outcomes).toHaveLength(recording.exchanges.length);
      expect(outcomes[0]).toContain("items");
    }
  });

  it("rejects unusable recording files", async () => {
    const directory = temporaryDirectory("whilefresh-invalid-recording-");
    try {
      await expect(readChatRecording(join(directory, "missing.json"))).rejects.toThrow();
      writeFileSync(join(directory, "garbage.json"), "not json");
      await expect(readChatRecording(join(directory, "garbage.json"))).rejects.toThrow();
      writeFileSync(join(directory, "format-9.json"), '{"format":9,"exchanges":[{}]}');
      await expect(readChatRecording(join(directory, "format-9.json"))).rejects.toThrow();
      writeFileSync(join(directory, "empty.json"), '{"format":2,"exchanges":[]}');
      await expect(readChatRecording(join(directory, "empty.json"))).rejects.toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
