import {
  mkdtempSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChatClient } from "../../server/ai/chat-client.js";
import type {
  ChatRequest,
  ChatResult,
} from "../../server/ai/chat-types.js";
import {
  type CredentialProvider,
  type Service,
  StaticCredentialProvider,
} from "../../server/ai/credentials.js";
import {
  type UserKeyField,
  UserKeyStore,
} from "../../server/ai/user-keys.js";
import { loadBuiltin } from "../../server/data/builtin.js";
import { fixedClock } from "../../server/domain/clock.js";
import { AppState } from "../../server/services/app-state.js";
import { SettingsService } from "../../server/services/settings-service.js";

class TrackingChatClient implements ChatClient {
  private credentials: CredentialProvider =
    new StaticCredentialProvider();

  setCredentials(credentials: CredentialProvider): void {
    this.credentials = credentials;
  }

  isConfigured(): boolean {
    return this.credentials.isConfigured();
  }

  key(service: Service): string {
    return this.credentials.key(service);
  }

  async send(
    _request: ChatRequest,
    _signal?: AbortSignal,
  ): Promise<ChatResult> {
    throw new Error("not used");
  }
}

const directories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "whilefresh-user-keys-"));
  directories.push(directory);
  return directory;
}

function stubEmptyCredentials(): void {
  vi.stubEnv("WHILEFRESH_DEEPSEEK_API_KEY", "");
  vi.stubEnv("WHILEFRESH_LEXMOUNT_API_KEY", "");
  vi.stubEnv("WHILEFRESH_LEXMOUNT_PROJECT_ID", "");
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("user key storage", () => {
  it("round-trips keys through new instances and removes unknown keys", () => {
    const dataDir = join(temporaryDirectory(), "data");
    const first = new UserKeyStore(dataDir, {});

    expect(first.key("deepseek")).toBe("");
    expect(first.save("deepseek", " sk-test-1 ")).toBe(true);
    expect(first.save("lexmountProject", "proj-中")).toBe(true);

    const again = new UserKeyStore(dataDir, {});
    expect(again.key("deepseek")).toBe("sk-test-1");
    expect(again.key("lexmountProjectId")).toBe("proj-中");
    expect(again.key("lexmount")).toBe("");
  });

  it("overwrites and deletes stored keys", () => {
    const store = new UserKeyStore(temporaryDirectory(), {});

    expect(store.save("lexmount", "test-a")).toBe(true);
    expect(store.save("lexmount", "test-b")).toBe(true);
    expect(store.key("lexmount")).toBe("test-b");

    expect(store.clear("lexmount")).toBe(true);
    expect(store.key("lexmount")).toBe("");
    expect(store.clear("lexmount")).toBe(true);

    expect(store.save("lexmount", "test-c")).toBe(true);
    expect(store.save("lexmount", "")).toBe(true);
    expect(store.key("lexmount")).toBe("");
  });

  it("stores the file with 0600 permissions inside a 0700 directory", () => {
    const dataDir = join(temporaryDirectory(), "data");
    const store = new UserKeyStore(dataDir, {});

    expect(store.save("deepseek", "test-owner-only")).toBe(true);
    expect(statSync(dataDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dataDir, "secrets.json")).mode & 0o777).toBe(0o600);
  });

  it("rejects invalid fields and values", () => {
    const store = new UserKeyStore(temporaryDirectory(), {});
    const settings = new SettingsService({
      credentials: store,
      chatClient: new TrackingChatClient(),
    });
    const invalidField = "nonsense" as UserKeyField;

    expect(store.save("../x" as UserKeyField, "test-value")).toBe(false);
    expect(settings.saveSecret(invalidField, "test-value")).toBe(false);
    expect(settings.saveSecret("deepseek", "   ")).toBe(false);
    expect(settings.saveSecret("deepseek", "test key")).toBe(false);
    expect(settings.saveSecret("deepseek", "test\nkey")).toBe(false);
    expect(settings.saveSecret("deepseek", "\uFDD0")).toBe(false);
    expect(store.key("deepseek")).toBe("");
  });

  it("reports user, builtin, then none as the source", () => {
    const dataDir = temporaryDirectory();
    const store = new UserKeyStore(dataDir, {
      WHILEFRESH_DEEPSEEK_API_KEY: "test-builtin",
    });
    const settings = new SettingsService({
      credentials: store,
      chatClient: new TrackingChatClient(),
    });

    expect(settings.saveSecret("deepseek", "test-user")).toBe(true);
    expect(settings.services().deepseek).toBe("user");
    expect(settings.clearSecret("deepseek")).toBe(true);
    expect(settings.services().deepseek).toBe("builtin");

    const noEnvironment = new UserKeyStore(temporaryDirectory(), {});
    expect(noEnvironment.keySource("deepseek")).toBe("none");
  });
});

describe("credential selection", () => {
  it("prefers the user key in real mode and ignores it in demo mode", () => {
    vi.stubEnv("WHILEFRESH_DEEPSEEK_API_KEY", "test-builtin");
    const chatClient = new TrackingChatClient();
    const state = new AppState({
      dataDir: temporaryDirectory(),
      builtin: loadBuiltin(),
      clock: fixedClock(new Date(2026, 9, 21, 12, 0)),
      chatClient,
    });

    try {
      expect(chatClient.key("deepseek")).toBe("test-builtin");
      expect(state.saveSecret("deepseek", "test-user")).toBe(true);
      expect(state.keySource("deepseek")).toBe("user");
      expect(chatClient.key("deepseek")).toBe("test-user");

      expect(state.setDemoMode(true)).toBe(true);
      expect(chatClient.key("deepseek")).toBe("test-builtin");
      expect(state.keySource("deepseek")).toBe("user");

      expect(state.setDemoMode(false)).toBe(true);
      expect(chatClient.key("deepseek")).toBe("test-user");
    } finally {
      state.close();
    }
  });

  it("requires a user key when no environment key is present", () => {
    stubEmptyCredentials();
    const state = new AppState({
      dataDir: temporaryDirectory(),
      builtin: loadBuiltin(),
      clock: fixedClock(new Date(2026, 9, 21, 12, 0)),
      chatClient: new TrackingChatClient(),
    });

    try {
      expect(state.recognitionConfigured).toBe(false);
      expect(state.saveSecret("deepseek", "test-user")).toBe(true);
      expect(state.recognitionConfigured).toBe(true);
      expect(state.setDemoMode(true)).toBe(true);
      expect(state.recognitionConfigured).toBe(false);
      expect(state.setDemoMode(false)).toBe(true);
      expect(state.recognitionConfigured).toBe(true);
    } finally {
      state.close();
    }
  });
});
