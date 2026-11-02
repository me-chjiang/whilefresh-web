import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import type {
  DraftItemDto,
  ImportStatusDto,
  ItemDto,
  ItemFreshness,
} from "../../shared/api.js";
import {
  CategoryCode,
  DateOrigin,
  Freshness,
  ItemKind,
  ShelfLifeSource,
  StartBasis,
  Storage,
} from "../../shared/enums.js";
import type { BuiltinData } from "../data/builtin.js";
import { openDatabase } from "../data/db.js";
import {
  isSnoozed,
  needsShelfLife as itemNeedsShelfLife,
  SqliteNameMappingStore,
  Store,
  type FridgeItem,
} from "../data/store.js";
import { addDays, type Clock } from "../domain/clock.js";
import {
  FridgeGroup,
  groupOf,
} from "../domain/fridge-groups.js";
import {
  evaluateFreshness,
  type FreshnessState,
} from "../domain/freshness.js";
import { needsShelfLife as needsShelfLifeText } from "../domain/texts.js";
import type { RuleProposal } from "../domain/shelf-life.js";
import {
  DeepSeekChatClient,
} from "../ai/deepseek-chat-client.js";
import {
  EnvCredentialProvider,
  LayeredCredentialProvider,
  type CredentialProvider,
} from "../ai/credentials.js";
import type { ChatClient } from "../ai/chat-client.js";
import { IngredientClassifier } from "../ai/ingredient-classifier.js";
import {
  UserKeyStore,
  type KeySource,
  type UserKeyField,
} from "../ai/user-keys.js";
import { DeepSeekRecognizer } from "../recognition/deepseek.js";
import { DemoRecognizer } from "../recognition/replay.js";
import type { Recognizer } from "../recognition/types.js";
import { ImportService } from "./import-service.js";
import { KitchenService } from "./kitchen-service.js";

export interface AppStateOptions {
  dataDir: string;
  builtin: BuiltinData;
  clock: Clock;
  apiKey?: string;
  chatClient?: ChatClient;
  realRecognizer?: Recognizer;
  demoRecognizer?: Recognizer;
}

type CredentialChatClient = ChatClient & {
  setCredentials?: (provider: CredentialProvider) => void;
};

interface AppSession {
  readonly demo: boolean;
  readonly database: DatabaseSync;
  readonly store: Store;
  readonly kitchen: KitchenService;
  readonly importService: ImportService;
  readonly names?: SqliteNameMappingStore;
  readonly classifier?: IngredientClassifier;
}

const DATABASE_NOTICE = "无法打开本机数据库，数据无法保存";
const CLEANUP_NOTICE = "部分导入图片尚未清理，稍后会自动重试";
const NO_API_KEY_NOTICE = "未配置识别服务密钥，可在「我的」开启演示模式";
const DEMO_CREATE_NOTICE = "无法创建演示数据";

const categories = Object.values(CategoryCode);

function categoryCode(value: string | undefined): CategoryCode {
  const candidate = value ?? "";
  return categories.includes(candidate as CategoryCode)
    ? (candidate as CategoryCode)
    : CategoryCode.Other;
}

function storageLocation(storage: Storage | undefined): string {
  switch (storage) {
    case Storage.Freezer:
      return "冷冻";
    case Storage.Room:
      return "常温";
    default:
      return "冷藏";
  }
}

function freshnessName(freshness: Freshness): ItemFreshness {
  switch (freshness) {
    case Freshness.Fresh:
      return "fresh";
    case Freshness.NearExpiry:
      return "nearing";
    case Freshness.BeyondEstimate:
      return "overdue";
    default:
      return "unknown";
  }
}

function sourceName(source: ShelfLifeSource | undefined): string {
  switch (source) {
    case ShelfLifeSource.Package:
      return "package";
    case ShelfLifeSource.Manual:
    case ShelfLifeSource.LocalRule:
      return "user";
    case ShelfLifeSource.Reference:
      return "reference";
    case ShelfLifeSource.AiEstimate:
      return "ai";
    default:
      return "none";
  }
}

function displayDays(item: FridgeItem, state: FreshnessState): string {
  if (state.remainingDays != null) {
    return state.remainingDays < 0
      ? `过期${-state.remainingDays}天`
      : `剩余${state.remainingDays}天`;
  }
  return itemNeedsShelfLife(item) ? needsShelfLifeText() : "";
}

function fridgeGroupName(item: FridgeItem): string {
  const group = groupOf({
    kind: item.kind ?? ItemKind.Food,
    storage: item.storage ?? Storage.Fridge,
  });
  switch (group) {
    case FridgeGroup.StapleSeasoning:
      return "常备调料";
    case FridgeGroup.StapleFood:
      return "常备食材";
    case FridgeGroup.Freezer:
      return "冷冻";
    case FridgeGroup.Room:
      return "常温";
    default:
      return "冷藏";
  }
}

function startDate(item: FridgeItem): string {
  switch (item.startBasis) {
    case StartBasis.ProductionDate:
      return item.productionDate?.date ?? "";
    case StartBasis.PurchaseDate:
      return item.purchaseDate?.date ?? "";
    case StartBasis.EntryDate:
      return item.entryDate ?? "";
    default:
      return "";
  }
}

export class AppState {
  private readonly dataDir: string;
  private readonly importsDir: string;
  private readonly builtin: BuiltinData;
  private readonly clock: Clock;
  private readonly chatClient: CredentialChatClient;
  private readonly userKeys: UserKeyStore;
  private readonly envCredentials: CredentialProvider;
  private readonly realCredentials: CredentialProvider;
  private readonly realRecognizer: Recognizer | undefined;
  private readonly demoRecognizer: Recognizer | undefined;
  private recognitionConfiguredValue = false;

  private real: AppSession | null = null;
  private demo: AppSession | null = null;
  private active: AppSession | null = null;
  private pendingRules: RuleProposal[] = [];
  private startupNoticeValue = "";

  constructor(options: AppStateOptions) {
    this.dataDir = options.dataDir;
    this.importsDir = join(options.dataDir, "imports");
    this.builtin = options.builtin;
    this.clock = options.clock;
    this.userKeys = new UserKeyStore(options.dataDir);
    this.envCredentials = new EnvCredentialProvider();
    this.realCredentials = new LayeredCredentialProvider(
      this.userKeys,
      this.envCredentials,
    );
    this.chatClient =
      options.chatClient ??
      new DeepSeekChatClient({ credentials: this.envCredentials });
    this.realRecognizer = options.realRecognizer;
    this.demoRecognizer = options.demoRecognizer;
    this.applyCredentials();

    try {
      mkdirSync(this.dataDir, { recursive: true });
      mkdirSync(this.importsDir, { recursive: true });
      this.real = this.openSession("whilefresh.db", false);
    } catch {
      this.startupNoticeValue = DATABASE_NOTICE;
      return;
    }

    this.active = this.real;
    if (!this.real.store.retryFileCleanup()) {
      this.startupNoticeValue = CLEANUP_NOTICE;
    }

    if (this.real.store.setting("demo_mode") === "1") {
      try {
        const demo = this.openDemoSession();
        if (this.seedDemo(demo)) {
          this.demo = demo;
          this.active = demo;
        } else {
          this.destroySession(demo);
          this.startupNoticeValue ||= DEMO_CREATE_NOTICE;
        }
      } catch {
        this.startupNoticeValue ||= DEMO_CREATE_NOTICE;
      }
    }
    this.applyCredentials();

    if (
      !this.demoMode &&
      !this.recognitionConfiguredValue &&
      this.startupNoticeValue.length === 0
    ) {
      this.startupNoticeValue = NO_API_KEY_NOTICE;
    }
  }

  get demoMode(): boolean {
    return this.active?.demo === true;
  }

  get recognitionConfigured(): boolean {
    return this.recognitionConfiguredValue;
  }

  get startupNotice(): string {
    return this.startupNoticeValue;
  }

  keySource(field: UserKeyField): KeySource {
    return this.userKeys.keySource(field);
  }

  saveSecret(field: UserKeyField, value: string): boolean {
    if (!this.userKeys.save(field, value)) {
      return false;
    }
    this.applyCredentials();
    return true;
  }

  clearSecret(field: UserKeyField): boolean {
    if (!this.userKeys.clear(field)) {
      return false;
    }
    this.applyCredentials();
    return true;
  }

  get activeKitchen(): KitchenService {
    return this.requireActive().kitchen;
  }

  get activeImportService(): ImportService {
    return this.requireActive().importService;
  }

  get activeStore(): Store {
    return this.requireActive().store;
  }

  itemMap(item: FridgeItem): ItemDto {
    const state = this.activeKitchen.freshness(item);
    const canonicalName = item.canonicalName ?? "";
    return {
      id: item.id ?? 0,
      name:
        (item.displayName ?? "").length > 0
          ? item.displayName!
          : canonicalName,
      quantity: item.quantityText ?? "",
      category: categoryCode(item.category),
      location: storageLocation(item.storage),
      freshness: freshnessName(state.freshness),
      source: sourceName(item.shelfLifeSource),
      days: displayDays(item, state),
      first: item.useFirst === true,
      kind: item.kind ?? ItemKind.Food,
      group: fridgeGroupName(item),
      needsShelfLife: itemNeedsShelfLife(item),
      snoozed: isSnoozed(item, this.clock.today()),
      bulk: this.activeKitchen.pantryRules().isBulk(canonicalName),
      purchasedAt: item.purchaseDate?.date ?? "",
      storedAt: item.entryDate ?? "",
      producedAt: item.productionDate?.date ?? "",
      packageExpiresAt: item.packageExpiry?.date ?? "",
      shelfDays:
        item.shelfLifeDays != null ? String(item.shelfLifeDays) : "",
      startBasis: item.startBasis ?? StartBasis.None,
      startDate: startDate(item),
      expiryDate: item.expiryDate ?? "",
      shelfLifeNote: item.shelfLifeNote ?? "",
    };
  }

  items(): ItemDto[] {
    return this.activeKitchen.fridge().map((item) => this.itemMap(item));
  }

  draftItems(): DraftItemDto[] {
    return this.activeImportService.status().draftItems;
  }

  importStatus(): ImportStatusDto {
    return this.activeImportService.status();
  }

  nearCount(): number {
    return this.activeKitchen.nearCount();
  }

  attentionCount(): number {
    return this.activeKitchen.attention().length;
  }

  hasUnfinishedImport(): boolean {
    return this.activeImportService.hasUnfinishedJob();
  }

  rememberRules(proposals: readonly RuleProposal[]): void {
    this.pendingRules = proposals.map((proposal) => ({ ...proposal }));
  }

  pendingRuleQuestion(): string {
    return this.pendingRules[0]?.question ?? "";
  }

  confirmRememberedRules(): boolean {
    const proposals = this.pendingRules;
    this.pendingRules = [];
    let ok = true;
    for (const proposal of proposals) {
      ok = this.activeKitchen.confirmRule(proposal) && ok;
    }
    return ok;
  }

  dismissRememberedRules(): void {
    this.pendingRules = [];
  }

  setDemoMode(enabled: boolean): boolean {
    if (!this.real || enabled === this.demoMode) {
      return this.real != null;
    }

    this.active?.importService.discard();

    if (enabled) {
      this.closeDemo();
      let next: AppSession;
      try {
        next = this.openDemoSession();
        if (!this.seedDemo(next)) {
          this.destroySession(next);
          return false;
        }
      } catch {
        return false;
      }
      if (!this.real.store.setSetting("demo_mode", "1")) {
        this.destroySession(next);
        return false;
      }
      this.demo = next;
      this.activate(next);
      this.applyCredentials();
      return true;
    }

    if (!this.real.store.setSetting("demo_mode", "0")) {
      return false;
    }
    this.activate(this.real);
    this.closeDemo();
    this.applyCredentials();
    return true;
  }

  close(): void {
    this.active?.importService.discard();
    this.active = null;
    this.closeDemo();
    if (this.real) {
      try {
        this.real.database.close();
      } catch {
        // Closing is best-effort during shutdown.
      }
      this.real = null;
    }
  }

  private openDemoSession(): AppSession {
    this.removeDemoDatabase();
    return this.openSession("demo.db", true);
  }

  private openSession(fileName: string, demo: boolean): AppSession {
    const database = openDatabase(join(this.dataDir, fileName));
    try {
      const store = new Store(
        database,
        this.clock,
        this.importsDir,
        !demo,
      );
      const kitchen = new KitchenService({
        store,
        builtin: this.builtin,
        clock: this.clock,
      });
      const recognizer =
        (demo ? this.demoRecognizer : this.realRecognizer) ??
        (demo ? new DemoRecognizer() : new DeepSeekRecognizer(this.chatClient));
      const names = demo
        ? undefined
        : new SqliteNameMappingStore(database, this.clock);
      const classifier = demo
        ? undefined
        : new IngredientClassifier(this.chatClient);
      const importService = new ImportService({
        store,
        builtin: this.builtin,
        clock: this.clock,
        recognizer,
        mappings: names,
        classifier,
        classifierConfigured: !demo && this.chatClient.isConfigured(),
        demo,
        importsDirectory: this.importsDir,
      });
      return {
        demo,
        database,
        store,
        kitchen,
        importService,
        names,
        classifier,
      };
    } catch (error) {
      database.close();
      throw error;
    }
  }

  private seedDemo(session: AppSession): boolean {
    const seeds = [
      { name: "五花肉", quantity: "500g", storage: Storage.Fridge },
      { name: "鸡蛋", quantity: "10枚", storage: Storage.Fridge },
      { name: "茭白", quantity: "2根", storage: Storage.Fridge },
      { name: "白蘑菇", quantity: "200g", storage: Storage.Fridge },
      { name: "长尖椒", quantity: "150g", storage: Storage.Fridge },
      { name: "蓝莓", quantity: "125g", storage: Storage.Fridge },
      { name: "冻虾仁", quantity: "300g", storage: Storage.Freezer },
      { name: "山药", quantity: "1根", storage: Storage.Room },
    ] as const;

    for (const seed of seeds) {
      const canonicalName =
        this.builtin.catalog.resolve(seed.name) || "未归类";
      const result = session.kitchen.saveItem({
        canonicalName,
        displayName: seed.name,
        rawName: seed.name,
        quantityText: seed.quantity,
        storage: seed.storage,
        purchaseDate: {
          date: addDays(this.clock.today(), -3),
          origin: DateOrigin.User,
          text: "",
        },
      });
      if (!result.ok) {
        return false;
      }
    }
    return true;
  }

  private activate(session: AppSession): void {
    this.active = session;
    this.pendingRules = [];
  }

  private applyCredentials(): void {
    this.chatClient.setCredentials?.(
      this.demoMode ? this.envCredentials : this.realCredentials,
    );
    this.recognitionConfiguredValue =
      this.realRecognizer != null || this.chatClient.isConfigured();
  }

  private removeDemoDatabase(): void {
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(join(this.dataDir, `demo.db${suffix}`), { force: true });
    }
  }

  private destroySession(session: AppSession): void {
    try {
      session.database.close();
    } catch {
      // The database file can still be removed after a failed close.
    }
  }

  private closeDemo(): void {
    if (!this.demo) {
      this.removeDemoDatabase();
      return;
    }
    this.destroySession(this.demo);
    this.demo = null;
    this.removeDemoDatabase();
  }

  private requireActive(): AppSession {
    if (!this.active) {
      throw new Error("application database is not available");
    }
    return this.active;
  }
}
