import type { ChatClient } from "../ai/chat-client.js";
import { ChatClientError } from "../ai/chat-client.js";
import { ErrorKind } from "../ai/chat-types.js";
import {
  PreferenceSummarizer,
} from "../ai/preference-summarizer.js";
import { buildSystemPrompt } from "../ai/system-prompt-builder.js";
import {
  type KeySource,
  type UserKeyField,
  UserKeyStore,
} from "../ai/user-keys.js";
import type { Store } from "../data/store.js";
import type { NameMappingStore } from "../domain/vocabulary-resolver.js";

export const PREFERENCE_SUMMARY_SETTING = "preference_summary";
export const PREFERENCE_SUMMARY_SOURCE_SETTING =
  "preference_summary_source";

const USER_KEY_FIELDS = [
  "deepseek",
  "lexmount",
  "lexmountProject",
] as const satisfies readonly UserKeyField[];

const INVALID_SECRET = /[\s\p{Cc}\p{Noncharacter_Code_Point}]/u;

export interface SettingsServiceOptions {
  credentials: UserKeyStore;
  chatClient: ChatClient;
  credentialsChanged?: () => void;
}

export type ServiceSources = Record<UserKeyField, KeySource>;

export interface PreferenceItem {
  id: number;
  text: string;
  source: string;
}

export interface PreferencesState {
  items: PreferenceItem[];
  summary: string;
  stale: boolean;
  summarizing: boolean;
  error: string;
}

export interface NameMappingItem {
  raw: string;
  canonical: string;
}

interface SummaryRequest {
  readonly controller: AbortController;
  readonly source: string;
  promise: Promise<PreferencesState>;
}

function failureText(kind: ErrorKind): string {
  switch (kind) {
    case ErrorKind.NotConfigured:
      return "未配置密钥";
    case ErrorKind.NoNetwork:
      return "网络不可用";
    case ErrorKind.Timeout:
      return "请求超时";
    case ErrorKind.AuthFailed:
      return "密钥无效";
    case ErrorKind.QuotaOrRateLimit:
      return "额度不足或请求过多";
    default:
      return "整理失败";
  }
}

function isUserKeyField(field: string): field is UserKeyField {
  return USER_KEY_FIELDS.some((candidate) => candidate === field);
}

export class SettingsService {
  private readonly credentials: UserKeyStore;
  private readonly summarizer: PreferenceSummarizer;
  private readonly credentialsChanged: (() => void) | undefined;
  private store: Store | null = null;
  private names: NameMappingStore | null = null;
  private activeSummary: SummaryRequest | null = null;
  private error = "";

  constructor({
    credentials,
    chatClient,
    credentialsChanged,
  }: SettingsServiceOptions) {
    this.credentials = credentials;
    this.summarizer = new PreferenceSummarizer(chatClient);
    this.credentialsChanged = credentialsChanged;
  }

  attach(store: Store | null, names?: NameMappingStore | null): void {
    this.cancelSummary();
    this.store = store;
    this.names = names ?? null;
  }

  services(): ServiceSources {
    return {
      deepseek: this.credentials.keySource("deepseek"),
      lexmount: this.credentials.keySource("lexmount"),
      lexmountProject: this.credentials.keySource("lexmountProject"),
    };
  }

  saveSecret(field: UserKeyField, value: string): boolean {
    if (!isUserKeyField(field)) {
      return false;
    }
    const trimmed = value.trim();
    if (trimmed.length === 0 || INVALID_SECRET.test(trimmed)) {
      return false;
    }
    if (!this.credentials.save(field, trimmed)) {
      return false;
    }
    this.credentialsChanged?.();
    return true;
  }

  clearSecret(field: UserKeyField): boolean {
    if (!isUserKeyField(field) || !this.credentials.clear(field)) {
      return false;
    }
    this.credentialsChanged?.();
    return true;
  }

  preferences(): PreferenceItem[] {
    return this.store?.preferences().map(({ id, text, source }) => ({
      id,
      text,
      source,
    })) ?? [];
  }

  addPreference(text: string): boolean {
    this.cancelSummary();
    return this.store != null && this.store.addPreference(text) > 0;
  }

  editPreference(id: number, text: string): boolean {
    this.cancelSummary();
    return this.store != null && this.store.updatePreference(id, text);
  }

  deletePreference(id: number): boolean {
    this.cancelSummary();
    if (!this.store || !this.store.deletePreference(id)) {
      return false;
    }
    if (
      this.store.preferences().length === 0
      && this.store.setSetting(PREFERENCE_SUMMARY_SETTING, "")
    ) {
      this.store.setSetting(PREFERENCE_SUMMARY_SOURCE_SETTING, "");
    }
    return true;
  }

  preferenceSummary(): string {
    return this.store?.setting(PREFERENCE_SUMMARY_SETTING) ?? "";
  }

  summaryStale(): boolean {
    if (!this.store || this.preferenceSummary().length === 0) {
      return false;
    }
    return (
      this.store.setting(PREFERENCE_SUMMARY_SOURCE_SETTING)
      !== this.preferenceTexts().join("\n")
    );
  }

  summarizing(): boolean {
    return this.activeSummary !== null;
  }

  summaryError(): string {
    return this.error;
  }

  summarizeAvailable(): boolean {
    return this.summarizer.isConfigured();
  }

  preferencesState(): PreferencesState {
    return {
      items: this.preferences(),
      summary: this.preferenceSummary(),
      stale: this.summaryStale(),
      summarizing: this.summarizing(),
      error: this.error,
    };
  }

  summarize(): Promise<PreferencesState> {
    if (!this.store) {
      return Promise.resolve(this.preferencesState());
    }
    const texts = this.preferenceTexts();
    if (texts.length === 0) {
      return Promise.resolve(this.preferencesState());
    }
    if (this.activeSummary) {
      return this.activeSummary.promise;
    }
    if (!this.summarizeAvailable()) {
      this.error = failureText(ErrorKind.NotConfigured);
      return Promise.resolve(this.preferencesState());
    }

    this.error = "";
    const request: SummaryRequest = {
      controller: new AbortController(),
      source: texts.join("\n"),
      promise: Promise.resolve(this.preferencesState()),
    };
    this.activeSummary = request;
    request.promise = this.runSummary(request, texts);
    return request.promise;
  }

  cookingSystemPrompt(base: string): string {
    return buildSystemPrompt(base, [], this.preferenceSummary());
  }

  nameMappings(): NameMappingItem[] {
    return this.names?.entries().map(([raw, canonical]) => ({
      raw,
      canonical,
    })) ?? [];
  }

  forgetNameMapping(raw: string): boolean {
    return this.names?.forget(raw) ?? false;
  }

  clearNameMappings(): boolean {
    return this.names?.clear() ?? false;
  }

  private preferenceTexts(): string[] {
    return this.store?.preferences().map(({ text }) => text) ?? [];
  }

  private cancelSummary(): void {
    const active = this.activeSummary;
    if (!active) {
      return;
    }
    this.activeSummary = null;
    active.controller.abort();
    this.error = "";
  }

  private async runSummary(
    request: SummaryRequest,
    texts: readonly string[],
  ): Promise<PreferencesState> {
    try {
      const summary = await this.summarizer.summarize(
        texts,
        request.controller.signal,
      );
      if (this.activeSummary !== request || !this.store) {
        return this.preferencesState();
      }
      const saved =
        this.store.setSetting(
          PREFERENCE_SUMMARY_SOURCE_SETTING,
          request.source,
        )
        && this.store.setSetting(PREFERENCE_SUMMARY_SETTING, summary.text);
      this.error = saved ? "" : "保存失败";
    } catch (error) {
      if (this.activeSummary !== request) {
        return this.preferencesState();
      }
      this.error =
        error instanceof ChatClientError
          ? failureText(error.chatError.kind)
          : "整理失败";
    } finally {
      if (this.activeSummary === request) {
        this.activeSummary = null;
      }
    }
    return this.preferencesState();
  }
}
