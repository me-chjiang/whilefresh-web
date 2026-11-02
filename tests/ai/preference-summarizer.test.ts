import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  PREFERENCE_SUMMARIZER_DEADLINE_MS,
  PREFERENCE_SUMMARIZER_IDLE_TIMEOUT_MS,
  PREFERENCE_SUMMARY_MAX_CHARS,
  PreferenceSummarizer,
  buildPreferenceSummaryRequest,
  parsePreferenceSummary,
} from "../../server/ai/preference-summarizer.js";
import { readChatRecording, type ChatExchange } from "../../server/ai/chat-recording.js";
import { RecordedChatClient } from "../../server/ai/recorded-chat-client.js";
import {
  encodeChatRequest,
  ErrorKind,
} from "../../server/ai/chat-types.js";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const recordedPreferences = ["不吃香菜", "少油", "周末才做复杂菜", "不吃香菜"];

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

function answer(content: string): ChatExchange {
  return {
    request: {
      model: "deepseek-flash",
      messageCount: 2,
      imageCount: 0,
      textChars: 0,
      jsonMode: true,
      maxTokens: 600,
    },
    requestDigest: "",
    elapsedMs: 0,
    response: chatCompletion(content),
  };
}

describe("preference summarizer", () => {
  it("builds a short text-only JSON request", () => {
    const request = buildPreferenceSummaryRequest([
      " 不吃  香菜 ",
      "",
      "少油",
    ]);
    expect(request.jsonMode).toBe(true);
    expect(request.thinking).toBe(false);
    expect(request.idleTimeoutMs).toBe(PREFERENCE_SUMMARIZER_IDLE_TIMEOUT_MS);
    expect(request.deadlineMs).toBe(PREFERENCE_SUMMARIZER_DEADLINE_MS);
    expect(request.messages).toHaveLength(2);
    expect(request.messages[0]?.role).toBe("system");
    expect(request.messages[0]?.parts[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("summary"),
    });
    expect(request.messages[1]?.parts[0]).toEqual({
      type: "text",
      text: "<偏好记录>\n1. 不吃 香菜\n2. 少油\n</偏好记录>",
    });
    expect(encodeChatRequest(request).summary.imageCount).toBe(0);
  });

  it("caps preferences at 50 items and 100 characters each", () => {
    const many = Array.from({ length: 80 }, (_, index) => `偏好${index}`);
    many.push("a".repeat(300));
    const capped = buildPreferenceSummaryRequest(many).messages[1]?.parts[0];
    expect(capped).toMatchObject({
      type: "text",
      text: expect.stringContaining("50. 偏好49"),
    });
    expect(capped).toMatchObject({
      text: expect.not.stringContaining("51."),
    });

    const longOne = buildPreferenceSummaryRequest(["a".repeat(300)])
      .messages[1]?.parts[0];
    expect(longOne).toMatchObject({
      text: expect.stringContaining("a".repeat(100)),
    });
    expect(longOne).toMatchObject({
      text: expect.not.stringContaining("a".repeat(101)),
    });
  });

  it("combines answers into one line and truncates them", () => {
    expect(parsePreferenceSummary({ summary: " 不吃香菜；\n少油。 " })).toBe(
      "不吃香菜； 少油。",
    );
    expect(
      parsePreferenceSummary({ summary: "油".repeat(500) }),
    ).toHaveLength(PREFERENCE_SUMMARY_MAX_CHARS);
    expect(parsePreferenceSummary({ summary: 3 })).toBe("");
    expect(parsePreferenceSummary({ other: "x" })).toBe("");
    expect(parsePreferenceSummary({ summary: "  " })).toBe("");
  });

  it.each(["不是 JSON", '{"summary":""}', '{"text":"x"}'])(
    "fails on an unusable answer: %s",
    async (content) => {
      const summarizer = new PreferenceSummarizer(
        new RecordedChatClient({ exchanges: [answer(content)] }),
      );
      await expect(summarizer.summarize(["少油"])).rejects.toMatchObject({
        chatError: { kind: ErrorKind.BadResponse },
      });
    },
  );

  it("stays silent when a request is cancelled", async () => {
    const client = new RecordedChatClient({
      exchanges: [answer('{"summary":"x"}')],
    });
    const summarizer = new PreferenceSummarizer(client);
    const controller = new AbortController();
    const pending = summarizer.summarize(["少油"], controller.signal);
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(client.remaining()).toBe(1);
  });

  it("replays the synthetic preference recording with its digest", async () => {
    const recording = await readChatRecording(
      join(
        repository,
        "test-data/recordings/preferences/synthetic-preferences.json",
      ),
    );
    expect(recording.exchanges[0]?.requestDigest).not.toBe("");

    const summary = await new PreferenceSummarizer(
      new RecordedChatClient(recording),
    ).summarize(recordedPreferences);
    expect(summary.text).toBe("不吃香菜；少油；复杂菜只在周末做。");
  });
});
