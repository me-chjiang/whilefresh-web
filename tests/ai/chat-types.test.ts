import { describe, expect, it } from "vitest";

import {
  encodeChatRequest,
  ErrorKind,
  parseChatResponse,
  parseJsonContent,
  requestDigest,
  type ChatRequest,
  type ChatResult,
} from "../../server/ai/chat-types.js";

function textPart(text: string) {
  return { type: "text" as const, text };
}

function userRequest(text: string): ChatRequest {
  return {
    messages: [
      { role: "system", parts: [textPart("只输出 JSON。")] },
      { role: "user", parts: [textPart(text)] },
    ],
    jsonMode: true,
    maxTokens: 4000,
  };
}

function withContent(
  content: string,
  finishReason = "stop",
): Pick<ChatResult, "content" | "finishReason"> {
  return { content, finishReason };
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

describe("chat request encoding", () => {
  it("follows the wire format and recursively sorts keys", () => {
    const request: ChatRequest = {
      messages: [{ role: "user", parts: [textPart("hi")] }],
    };
    const encoded = encodeChatRequest(request);
    const body = JSON.parse(encoded.body) as Record<string, unknown>;

    expect(body.messages).toEqual([
      { content: "hi", role: "user" },
    ]);
    expect(body).not.toHaveProperty("response_format");
    expect(body).not.toHaveProperty("max_tokens");
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("thinking");

    const thinkingRequest: ChatRequest = {
      ...request,
      thinking: false,
      temperature: 0.3,
    };
    const thinkingBody = JSON.parse(
      encodeChatRequest(thinkingRequest).body,
    ) as Record<string, unknown>;
    expect(thinkingBody.thinking).toEqual({ type: "disabled" });
    expect(thinkingBody.temperature).toBe(0.3);

    const encodedUserRequest = encodeChatRequest(userRequest("12345"));
    expect(encodedUserRequest.body).toBe(
      '{"max_tokens":4000,"messages":[{"content":"只输出 JSON。","role":"system"},{"content":"12345","role":"user"}],"model":"deepseek-flash","response_format":{"type":"json_object"}}',
    );
    expect(encodedUserRequest.summary).toEqual({
      model: "deepseek-flash",
      messageCount: 2,
      imageCount: 0,
      textChars: 14,
      jsonMode: true,
      maxTokens: 4000,
    });
    expect(requestDigest(encodedUserRequest.body)).toHaveLength(64);
    expect(requestDigest(encodedUserRequest.body)).toBe(
      requestDigest(encodeChatRequest(userRequest("12345")).body),
    );
    expect(requestDigest(encodedUserRequest.body)).not.toBe(
      requestDigest(encodeChatRequest(userRequest("1234")).body),
    );
  });

  it("carries per-request limits without sending them", () => {
    const request = userRequest("x");
    request.idleTimeoutMs = 20000;
    request.deadlineMs = 60000;
    const encoded = encodeChatRequest(request);

    expect(encoded.idleTimeoutMs).toBe(20000);
    expect(encoded.deadlineMs).toBe(60000);
    expect(encoded.body).toBe(encodeChatRequest(userRequest("x")).body);
    expect(encodeChatRequest(userRequest("x")).deadlineMs).toBeUndefined();
    expect(encoded.body).not.toContain("idleTimeoutMs");
    expect(encoded.body).not.toContain("deadlineMs");
  });
});

describe("JSON chat content", () => {
  it.each([
    ["bare", '{"dish":"番茄炒蛋"}'],
    ["whitespace", '\n  {"dish":"番茄炒蛋"}  \n'],
    ["json fence", '```json\n{"dish":"番茄炒蛋"}\n```'],
    ["bare fence", '```\n{"dish":"番茄炒蛋"}\n```\n'],
  ])("parses %s", (_name, content) => {
    const parsed = parseJsonContent(withContent(content));
    expect(parsed.result).not.toBeNull();
    expect(parsed.result?.dish).toBe("番茄炒蛋");
  });

  it.each([
    ["empty", "", "stop"],
    ["prose", "抱歉，我无法回答", "stop"],
    ["array", "[1,2]", "stop"],
    ["cut off", '{"dishes":[{"name":"番', "length"],
    ["unclosed fence", '```json\n{"a":', "length"],
  ])("rejects unusable %s content", (_name, content, finishReason) => {
    const parsed = parseJsonContent(withContent(content, finishReason));
    expect(parsed.result).toBeNull();
    expect(parsed.error.kind).toBe(ErrorKind.BadResponse);
    expect(parsed.error.detail).toContain(finishReason);
    expect(parsed.error.detail).not.toContain("番");
    expect(parsed.error.detail).not.toContain("抱歉");
    expect(parseJsonContent(withContent(content, finishReason)).result).toBeNull();
  });
});

describe("chat response parsing", () => {
  it("reads a completion response and usage", () => {
    const parsed = parseChatResponse(
      chatCompletion("{}", "length", 10, 5),
    );

    expect(parsed.result).not.toBeNull();
    expect(parsed.result?.truncated).toBe(true);
    expect(parsed.result?.usage.totalTokens).toBe(15);
    expect(parsed.result?.content).toBe("{}");
    expect(parsed.result?.rawBody).toBe(chatCompletion("{}", "length", 10, 5));
  });

  it("rejects a non-JSON response body", () => {
    const parsed = parseChatResponse("<html>");
    expect(parsed.result).toBeNull();
    expect(parsed.error.kind).toBe(ErrorKind.BadResponse);
    expect(parsed.error.detail).toContain("HTTP body is not a JSON object");
  });

  it.each([
    ["null", "null"],
    ["array", "[]"],
    ["missing choices", "{}"],
    ["missing content", '{"choices":[{"finish_reason":"length","message":{}}]}'],
  ])("rejects %s response", (_name, body) => {
    const parsed = parseChatResponse(body);
    expect(parsed.result).toBeNull();
    expect(parsed.error.kind).toBe(ErrorKind.BadResponse);
  });
});
