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
  ShelfLifeSource,
  StartBasis,
  Storage,
} from "../../shared/enums.js";
import type { BuiltinData } from "../data/builtin.js";
import { openDatabase } from "../data/db.js";
import { Store, type FridgeItem } from "../data/store.js";
import { addDays, type Clock } from "../domain/clock.js";
import {
  evaluateFreshness,
  type FreshnessState,
} from "../domain/freshness.js";
import type { RuleProposal } from "../domain/shelf-life.js";
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
  realRecognizer?: Recognizer;
  demoRecognizer?: Recognizer;
}

interface AppSession {
  readonly demo: boolean;
  readonly database: DatabaseSync;
  readonly store: Store;
  readonly kitchen: KitchenService;
  readonly importService: ImportService;
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
  if (
    item.shelfLifeSource === ShelfLifeSource.Package &&
    item.expiryDate
  ) {
    return `${item.expiryDate.slice(5)} 到期`;
  }
  if (state.freshness === Freshness.BeyondEstimate) {
    return "请查看后决定";
  }
  if (state.remainingDays != null) {
    return `约剩 ${state.remainingDays} 天`;
  }
  return "保质期未知";
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
  private readonly apiKey: string;
  private readonly realRecognizer: Recognizer | undefined;
  private readonly demoRecognizer: Recognizer | undefined;
  private readonly recognitionConfiguredValue: boolean;

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
    this.apiKey =
      options.apiKey ?? process.env.WHILEFRESH_DEEPSEEK_API_KEY ?? "";
    this.realRecognizer = options.realRecognizer;
    this.demoRecognizer = options.demoRecognizer;
    this.recognitionConfiguredValue =
      this.realRecognizer != null || this.apiKey.length > 0;

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
    return this.items().filter((item) => item.freshness === "nearing").length;
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
      return true;
    }

    if (!this.real.store.setSetting("demo_mode", "0")) {
      return false;
    }
    this.activate(this.real);
    this.closeDemo();
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
        (demo ? new DemoRecognizer() : new DeepSeekRecognizer({
          apiKey: this.apiKey,
        }));
      const importService = new ImportService({
        store,
        builtin: this.builtin,
        clock: this.clock,
        recognizer,
        demo,
        importsDirectory: this.importsDir,
      });
      return { demo, database, store, kitchen, importService };
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
