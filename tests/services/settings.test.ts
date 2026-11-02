import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ChatClient } from "../../server/ai/chat-client.js";
import type { ChatExchange } from "../../server/ai/chat-recording.js";
import {
  ErrorKind,
  type ChatRequest,
  type ChatResult,
} from "../../server/ai/chat-types.js";
import {
  RecordedChatClient,
} from "../../server/ai/recorded-chat-client.js";
import { UserKeyStore } from "../../server/ai/user-keys.js";
import { openDatabase } from "../../server/data/db.js";
import { Store } from "../../server/data/store.js";
import { fixedClock } from "../../server/domain/clock.js";
import { MemoryNameMappingStore } from "../../server/domain/vocabulary-resolver.js";
import {
  PREFERENCE_SUMMARY_SETTING,
  PREFERENCE_SUMMARY_SOURCE_SETTING,
  SettingsService,
} from "../../server/services/settings-service.js";

interface SettingsHarness {
  directory: string;
  database: DatabaseSync;
  store: Store;
  credentials: UserKeyStore;
  names: MemoryNameMappingStore;
}

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

function summaryAnswer(content: string): ChatExchange {
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
    response: chatCompletion(JSON.stringify({ summary: content })),
  };
}

class UnconfiguredChatClient implements ChatClient {
  sent = 0;

  isConfigured(): boolean {
    return false;
  }

  async send(
    _request: ChatRequest,
    _signal?: AbortSignal,
  ): Promise<ChatResult> {
    this.sent += 1;
    throw new Error("an unconfigured client must not send");
  }
}

describe("settings service", () => {
  let harness: SettingsHarness;

  beforeEach(() => {
    const directory = mkdtempSync(join(tmpdir(), "whilefresh-settings-"));
    const database = openDatabase(join(directory, "whilefresh.db"));
    harness = {
      directory,
      database,
      store: new Store(
        database,
        fixedClock(new Date(2026, 9, 30, 10, 0)),
        join(directory, "imports"),
      ),
      credentials: new UserKeyStore(join(directory, "data"), {}),
      names: new MemoryNameMappingStore(),
    };
  });

  afterEach(() => {
    harness.database.close();
    rmSync(harness.directory, { recursive: true, force: true });
  });

  function service(chatClient: ChatClient): SettingsService {
    const settings = new SettingsService({
      credentials: harness.credentials,
      chatClient,
    });
    settings.attach(harness.store, harness.names);
    return settings;
  }

  it("moves a preference summary through its full lifecycle", async () => {
    const chat = new RecordedChatClient({
      exchanges: [summaryAnswer("不吃香菜；少油。")],
    });
    const settings = service(chat);
    expect(settings.addPreference("不吃香菜")).toBe(true);
    expect(settings.addPreference("少油")).toBe(true);
    expect(settings.addPreference("少油")).toBe(false);
    expect(settings.preferences()).toHaveLength(2);
    expect(settings.preferenceSummary()).toBe("");

    const pending = settings.summarize();
    expect(settings.summarizing()).toBe(true);
    const state = await pending;
    expect(state).toMatchObject({
      summary: "不吃香菜；少油。",
      stale: false,
      summarizing: false,
      error: "",
    });
    expect(harness.store.setting(PREFERENCE_SUMMARY_SETTING)).toBe(
      "不吃香菜；少油。",
    );
    expect(harness.store.setting(PREFERENCE_SUMMARY_SOURCE_SETTING)).toBe(
      "不吃香菜\n少油",
    );

    const first = settings.preferences()[0]!;
    expect(settings.editPreference(first.id, "不吃香菜和折耳根")).toBe(true);
    expect(settings.summaryStale()).toBe(true);
    for (const preference of settings.preferences()) {
      expect(settings.deletePreference(preference.id)).toBe(true);
    }
    expect(settings.preferenceSummary()).toBe("");
    expect(settings.summaryStale()).toBe(false);
  });

  it("drops a summary when preferences are edited while it is running", async () => {
    const settings = service(
      new RecordedChatClient({
        exchanges: [summaryAnswer("不吃香菜。")],
      }),
    );
    expect(settings.addPreference("不吃香菜")).toBe(true);
    const pending = settings.summarize();
    const first = settings.preferences()[0]!;
    expect(settings.editPreference(first.id, "不吃葱")).toBe(true);
    await pending;

    expect(settings.preferenceSummary()).toBe("");
    expect(settings.summarizing()).toBe(false);
  });

  it("does not request a summary without a key or preferences", async () => {
    const chat = new UnconfiguredChatClient();
    const settings = service(chat);

    await settings.summarize();
    expect(settings.summarizing()).toBe(false);
    expect(settings.addPreference("少油")).toBe(true);
    expect(settings.summarizeAvailable()).toBe(false);
    await settings.summarize();

    expect(settings.summaryError()).toBe("未配置密钥");
    expect(chat.sent).toBe(0);
  });

  it("keeps the old summary when summarizing fails", async () => {
    const failure: ChatExchange = {
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
      error: {
        kind: ErrorKind.NoNetwork,
        detail: "down",
        httpStatus: 0,
      },
    };
    const settings = service(
      new RecordedChatClient({ exchanges: [failure] }),
    );
    expect(
      harness.store.setSetting(PREFERENCE_SUMMARY_SETTING, "旧摘要"),
    ).toBe(true);
    expect(settings.addPreference("少油")).toBe(true);

    await settings.summarize();
    expect(settings.summaryError()).toBe("网络不可用");
    expect(settings.preferenceSummary()).toBe("旧摘要");
  });

  it("puts the stored summary last in the cooking prompt", () => {
    const settings = service(new RecordedChatClient({ exchanges: [] }));
    expect(
      harness.store.setSetting(
        PREFERENCE_SUMMARY_SETTING,
        "不吃香菜；少油。",
      ),
    ).toBe(true);
    const prompt = settings.cookingSystemPrompt("你是厨房助手。");
    expect(prompt).toBe(
      "你是厨房助手。\n\n【用户偏好】\n不吃香菜；少油。",
    );

    expect(
      harness.store.setSetting(PREFERENCE_SUMMARY_SETTING, ""),
    ).toBe(true);
    expect(settings.cookingSystemPrompt("你是厨房助手。")).not.toContain(
      "用户偏好",
    );
  });

  it("lists, forgets, and clears name mappings", () => {
    const settings = service(new RecordedChatClient({ exchanges: [] }));
    expect(settings.nameMappings()).toEqual([]);
    expect(harness.names.remember("土猪肉", "猪肉")).toBe(true);
    expect(harness.names.remember("冰鲜 鸡全腿", "鸡腿")).toBe(true);
    expect(settings.nameMappings()).toEqual([
      { raw: "冰鲜 鸡全腿", canonical: "鸡腿" },
      { raw: "土猪肉", canonical: "猪肉" },
    ]);

    expect(settings.forgetNameMapping("土猪肉")).toBe(true);
    expect(settings.nameMappings()).toEqual([
      { raw: "冰鲜 鸡全腿", canonical: "鸡腿" },
    ]);
    expect(settings.clearNameMappings()).toBe(true);
    expect(settings.nameMappings()).toEqual([]);
  });
});
