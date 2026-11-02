import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { Catalog } from "../../server/domain/catalog.js";
import {
  CLASSIFIER_DEADLINE_MS,
  CLASSIFIER_IDLE_TIMEOUT_MS,
  CLASSIFIER_MAX_NAMES,
  IngredientClassifier,
  buildClassifierRequest,
  namesToSend,
  parseClassifierAnswer,
} from "../../server/ai/ingredient-classifier.js";
import { ErrorKind, encodeChatRequest, requestDigest } from "../../server/ai/chat-types.js";
import {
  readChatRecording,
  type ChatExchange,
} from "../../server/ai/chat-recording.js";
import { RecordedChatClient } from "../../server/ai/recorded-chat-client.js";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const smallCatalog = Catalog.fromJson(
  JSON.stringify({
    categories: [
      { code: "meat", name: "肉类" },
      { code: "seafood", name: "水产海鲜" },
    ],
    items: [
      { name: "鸡肉", category: "meat" },
      { name: "鸡腿", category: "meat", parent: "鸡肉" },
      { name: "牛肉", category: "meat", aliases: ["黄牛肉"] },
      { name: "鱼", category: "seafood" },
    ],
  }),
);

function chatCompletion(content: string): string {
  return JSON.stringify({
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  });
}

function recordedAnswer(content: string): ChatExchange {
  return {
    request: {
      model: "deepseek-flash",
      messageCount: 2,
      imageCount: 0,
      textChars: 0,
      jsonMode: true,
      maxTokens: 0,
    },
    requestDigest: "",
    elapsedMs: 0,
    response: chatCompletion(content),
  };
}

describe("ingredient classifier", () => {
  it("builds a short text-only JSON request", () => {
    const request = buildClassifierRequest(
      [" 冰鲜  鸡全腿 ", "花胶", "冰鲜 鸡全腿"],
      smallCatalog,
    );
    expect(request.jsonMode).toBe(true);
    expect(request.thinking).toBe(false);
    expect(request.idleTimeoutMs).toBe(CLASSIFIER_IDLE_TIMEOUT_MS);
    expect(request.deadlineMs).toBe(CLASSIFIER_DEADLINE_MS);
    expect(request.messages).toHaveLength(2);
    expect(request.messages[0]?.parts[0]).toMatchObject({
      type: "text",
    });
    expect(request.messages[0]?.parts[0]).toMatchObject({
      text: expect.stringContaining("鸡肉 > 鸡腿"),
    });
    expect(request.messages[0]?.parts[0]).toMatchObject({
      text: expect.stringContaining("none"),
    });
    expect(request.messages[0]?.parts[0]).not.toMatchObject({
      text: expect.stringContaining("黄牛肉"),
    });
    expect(request.messages[1]?.parts[0]).toMatchObject({
      text: "<商品名>\n1. 冰鲜 鸡全腿\n2. 花胶\n</商品名>",
    });
    expect(encodeChatRequest(request).summary.imageCount).toBe(0);
  });

  it("caps names at 80 after trimming, truncating, and deduplicating", () => {
    const names = Array.from(
      { length: CLASSIFIER_MAX_NAMES + 5 },
      (_, index) => `商品${index}`,
    );
    expect(namesToSend(names)).toHaveLength(CLASSIFIER_MAX_NAMES);
    expect(namesToSend(["  重复  ", "重复", "", "   "])).toEqual(["重复"]);
    expect(namesToSend(["x".repeat(100)])[0]).toHaveLength(60);
  });

  it("validates answers against the catalog and applies index/raw-name rules", () => {
    const sent = ["冰鲜鸡全腿", "牛霖", "花胶", "洗衣液", "罗汉果"];
    const result = parseClassifierAnswer(
      JSON.stringify({
        items: [
          { index: 1, raw_name: "冰鲜鸡全腿", canonical_name: "鸡腿" },
          { index: 2, raw_name: "牛霖", canonical_name: "黄牛肉" },
          { index: 3, raw_name: "花胶", canonical_name: "鱼胶" },
          { index: 4, raw_name: "洗衣液", canonical_name: "none" },
          { index: 4, raw_name: "罗汉果", canonical_name: "鱼" },
          { index: 9, canonical_name: "鸡肉" },
          { index: 1, raw_name: "冰鲜鸡全腿", canonical_name: "鸡肉" },
        ],
      }),
      sent,
      smallCatalog,
    );
    expect(result.canonical.get("冰鲜鸡全腿")).toBe("鸡腿");
    expect(result.canonical.get("牛霖")).toBe("牛肉");
    expect(result.canonical.has("花胶")).toBe(false);
    expect(result.canonical.has("洗衣液")).toBe(false);
    expect(result.canonical.get("罗汉果")).toBe("鱼");
    expect(result.rejected).toBe(1);
    expect(result.canonical.size).toBe(3);
  });

  it("classifies through the chat client", async () => {
    const client = new RecordedChatClient({
      exchanges: [
        recordedAnswer(
          '{"items":[{"index":1,"raw_name":"冰鲜鸡全腿","canonical_name":"鸡腿"}]}',
        ),
      ],
    });
    const classifier = new IngredientClassifier(client);
    const result = await classifier.classify(["冰鲜鸡全腿"], smallCatalog);
    expect(result.canonical.get("冰鲜鸡全腿")).toBe("鸡腿");
    expect(result.usage).toEqual({
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
    });
    expect(client.requests()).toHaveLength(1);
    expect(client.requests()[0]?.deadlineMs).toBe(CLASSIFIER_DEADLINE_MS);
  });

  it("fails when the answer is unreadable", async () => {
    const bad = new IngredientClassifier(
      new RecordedChatClient({
        exchanges: [recordedAnswer("不是 JSON")],
      }),
    );
    await expect(bad.classify(["花胶"], smallCatalog)).rejects.toMatchObject({
      chatError: { kind: ErrorKind.BadResponse },
    });
  });

  it("stays silent when a request is cancelled", async () => {
    const cancelledClient = new RecordedChatClient({
      exchanges: [recordedAnswer('{"items":[]}')],
    });
    const cancelled = new IngredientClassifier(cancelledClient);
    const controller = new AbortController();
    const pending = cancelled.classify(["花胶"], smallCatalog, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelledClient.remaining()).toBe(1);
  });

  it("replays the synthetic classifier recording with its digest", async () => {
    const path = join(
      repository,
      "test-data/recordings/classifier/synthetic-names.json",
    );
    const recording = await readChatRecording(path);
    const catalog = Catalog.fromJson(
      readFileSync(join(repository, "assets/data/vocabulary.json"), "utf8"),
    );
    const names = [
      "冰鲜鸡全腿",
      "牛霖 500g",
      "鲜毛肚 200g",
      "花胶 100g",
      "罗汉果 1个",
      "黑松露酱 80g",
      "藕粉 500g",
      "洗衣液 2kg",
      "电热水壶 1.5L",
    ];
    const localDigest = requestDigest(
      encodeChatRequest(buildClassifierRequest(names, catalog)).body,
    );
    const recordedDigest = recording.exchanges[0]?.requestDigest ?? "";
    expect(recordedDigest).not.toBe("");
    expect(
      localDigest,
      `request digest mismatch: local ${localDigest}; recording ${recordedDigest}`,
    ).toBe(recordedDigest);

    const classifier = new IngredientClassifier(
      new RecordedChatClient(recording),
    );
    const result = await classifier.classify(names, catalog);
    expect([...result.canonical.entries()].sort()).toEqual([
      ["冰鲜鸡全腿", "鸡腿"],
      ["鲜毛肚 200g", "牛肚"],
    ]);
    expect(result.canonical.size).toBe(2);
    expect(names.filter((name) => !result.canonical.has(name))).toHaveLength(7);
  });
});
