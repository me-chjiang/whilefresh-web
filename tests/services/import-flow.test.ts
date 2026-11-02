import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IngredientClassifier } from "../../server/ai/ingredient-classifier.js";
import type { ChatExchange } from "../../server/ai/chat-recording.js";
import { StaticCredentialProvider } from "../../server/ai/credentials.js";
import { DeepSeekChatClient } from "../../server/ai/deepseek-chat-client.js";
import { RecordedChatClient } from "../../server/ai/recorded-chat-client.js";
import {
  DateOrigin,
  ImportStatus,
  ImportState,
  ItemKind,
  Storage,
} from "../../shared/enums.js";
import { loadBuiltin, type BuiltinData } from "../../server/data/builtin.js";
import { openDatabase } from "../../server/data/db.js";
import {
  needsShelfLife,
  SqliteNameMappingStore,
  Store,
} from "../../server/data/store.js";
import { fixedClock, type Clock } from "../../server/domain/clock.js";
import {
  FridgeGroup,
  groupOf,
} from "../../server/domain/fridge-groups.js";
import { ResumableJob } from "../../server/domain/resumable-job.js";
import {
  NameSource,
  type NameMappingStore,
} from "../../server/domain/vocabulary-resolver.js";
import { CapturedAtSource } from "../../server/import/captured-at.js";
import type { StoredImportFile } from "../../server/import/import-files.js";
import {
  writeRecording,
  type Recording,
} from "../../server/recognition/recording.js";
import {
  DeepSeekRecognizer,
} from "../../server/recognition/deepseek.js";
import {
  DemoRecognizer,
  ReplayRecognizer,
} from "../../server/recognition/replay.js";
import {
  ErrorKind,
  InputKind,
  ItemCategory,
  type RecognitionRequest,
  type RecognitionResult,
  type Recognizer,
} from "../../server/recognition/types.js";
import {
  ImportService,
  type ImportImagesPayload,
} from "../../server/services/import-service.js";
import { KitchenService } from "../../server/services/kitchen-service.js";
import {
  FakeHttpServer,
  type CapturedRequest,
} from "../helpers/fake-http-server.js";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const cartRecording = join(
  repository,
  "test-data/recordings/synthetic-cart.json",
);

interface Harness {
  directory: string;
  importsDirectory: string;
  database: DatabaseSync;
  builtin: BuiltinData;
  clock: Clock;
  store: Store;
  kitchen: KitchenService;
}

interface ImportServiceOptions {
  classifier?: IngredientClassifier;
  classifierConfigured?: boolean;
  mappings?: NameMappingStore;
}

interface CompletionChoice {
  message: {
    role: "assistant";
    content: string;
  };
  finish_reason: "stop" | "length";
}

function completion(
  content: unknown,
  finishReason: "stop" | "length" = "stop",
): { choices: CompletionChoice[] } {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content:
            typeof content === "string" ? content : JSON.stringify(content),
        },
        finish_reason: finishReason,
      },
    ],
  };
}

function classifierAnswer(content: string): ChatExchange {
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
    response: JSON.stringify(completion(content)),
  };
}

function classifierFailure(): ChatExchange {
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
    error: {
      kind: ErrorKind.Timeout,
      detail: "deadline",
      httpStatus: 0,
    },
  };
}

function mixedItems(): unknown[] {
  return [
    {
      raw_name: "鲜鸡蛋10枚",
      canonical_name: "鸡蛋",
      quantity_text: "10枚",
      count: 2,
      category: "food",
      selected: true,
      production_date_text: "昨天生产",
      image_index: 1,
      storage: "fridge",
      shelf_life_days: { fridge: 30, freezer: 60, room: 10 },
    },
    {
      raw_name: "生抽",
      canonical_name: "生抽",
      category: "seasoning",
      selected: true,
    },
    {
      raw_name: "洗洁精",
      canonical_name: "未归类",
      category: "irrelevant",
      selected: true,
    },
  ];
}

class HeldReplayRecognizer extends ReplayRecognizer {
  readonly entered: Promise<void>;
  private enter!: () => void;

  constructor(file: string) {
    super(file);
    this.entered = new Promise((resolve) => {
      this.enter = resolve;
    });
  }

  override recognize(
    _request: RecognitionRequest,
    signal: AbortSignal,
  ): Promise<RecognitionResult> {
    this.enter();
    return new Promise((_resolve, reject) => {
      const abort = (): void => {
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      };
      if (signal.aborted) {
        abort();
      } else {
        signal.addEventListener("abort", abort, { once: true });
      }
    });
  }
}

describe("import service integration", () => {
  let harness: Harness;
  let recordingSequence = 0;
  let httpServers: FakeHttpServer[] = [];

  beforeEach(() => {
    const directory = mkdtempSync(join(tmpdir(), "whilefresh-import-flow-"));
    const importsDirectory = join(directory, "imports");
    mkdirSync(importsDirectory);
    const database = openDatabase(join(directory, "whilefresh.db"));
    const clock = fixedClock(new Date(2026, 9, 21, 12, 0));
    const store = new Store(database, clock, importsDirectory);
    harness = {
      directory,
      importsDirectory,
      database,
      builtin: loadBuiltin(),
      clock,
      store,
      kitchen: new KitchenService({
        store,
        builtin: loadBuiltin(),
        clock,
      }),
    };
  });

  afterEach(async () => {
    const servers = httpServers;
    httpServers = [];
    await Promise.all(servers.map((server) => server.close()));
    harness.database.close();
    rmSync(harness.directory, { recursive: true, force: true });
  });

  function image(
    bytes = "synthetic image",
    withDate = true,
  ): StoredImportFile {
    recordingSequence += 1;
    const path = join(
      harness.importsDirectory,
      `image-${recordingSequence}.jpg`,
    );
    writeFileSync(path, bytes);
    return {
      path,
      sha256: "",
      mimeType: "image/jpeg",
      capturedAt: withDate ? new Date(2026, 9, 21, 9, 0) : null,
      capturedAtSource: withDate
        ? CapturedAtSource.Exif
        : CapturedAtSource.None,
    };
  }

  function imagePayload(file: StoredImportFile): ImportImagesPayload {
    return {
      kind: "images",
      origin: "gallery",
      images: [file],
    };
  }

  async function realImage(
    color: { r: number; g: number; b: number },
  ): Promise<StoredImportFile> {
    recordingSequence += 1;
    const path = join(
      harness.importsDirectory,
      `generated-image-${recordingSequence}.png`,
    );
    await sharp({
      create: {
        width: 8,
        height: 12,
        channels: 3,
        background: color,
      },
    })
      .png()
      .toFile(path);
    return {
      path,
      sha256: "",
      mimeType: "image/png",
      capturedAt: new Date(2026, 9, 21, 9, 0),
      capturedAtSource: CapturedAtSource.Exif,
    };
  }

  function chatReply(rawName: string, canonicalName: string): string {
    return JSON.stringify(
      completion({
        source_type: "cart",
        items: [
          {
            raw_name: rawName,
            canonical_name: canonicalName,
            category: "food",
            storage: "fridge",
          },
        ],
      }),
    );
  }

  function recognizerFor(
    server: FakeHttpServer,
  ): DeepSeekRecognizer {
    return new DeepSeekRecognizer(
      new DeepSeekChatClient({
        credentials: new StaticCredentialProvider("test-key"),
        baseUrl: server.url,
        idleTimeoutMs: 2_000,
        deadlineMs: 4_000,
        retryDelayMs: 0,
      }),
      { batchLimits: { maxImages: 1 } },
    );
  }

  async function recording(
    items: unknown[],
    kind: InputKind = InputKind.Screenshot,
    finishReason: "stop" | "length" = "stop",
  ): Promise<string> {
    recordingSequence += 1;
    const path = join(
      harness.directory,
      `recording-${recordingSequence}.json`,
    );
    const value: Recording = {
      inputKind: kind,
      imageCount: kind === InputKind.OrderText ? 0 : 1,
      textLength: kind === InputKind.OrderText ? 100 : 0,
      promptVersion: "test",
      responses: [
        completion(
          {
            source_type:
              kind === InputKind.OrderText
                ? "text"
                : finishReason === "length"
                  ? "cart"
                  : "cart",
            items,
          },
          finishReason,
        ),
      ],
    };
    await writeRecording(path, value);
    return path;
  }

  function service(
    recognizer: Recognizer,
    demo = false,
    options: ImportServiceOptions = {},
  ): ImportService {
    return new ImportService({
      store: harness.store,
      builtin: harness.builtin,
      clock: harness.clock,
      recognizer,
      demo,
      importsDirectory: harness.importsDirectory,
      classifier: options.classifier,
      classifierConfigured: options.classifierConfigured,
      mappings: options.mappings,
    });
  }

  it("replays an import through draft, confirmation, and deletion", async () => {
    const input = image();
    const imports = service(new ReplayRecognizer(cartRecording));

    expect(await imports.receive(imagePayload(input))).toBe(true);
    expect(await imports.start(false)).toBe(false);
    expect(await imports.start(true)).toBe(true);

    const draft = imports.draft();
    expect(draft).not.toBeNull();
    expect(harness.store.items()).toHaveLength(0);
    expect(harness.store.imports()).toHaveLength(0);
    expect(
      draft!.items.filter(
        (item) => item.category === ItemCategory.Irrelevant,
      ),
    ).toHaveLength(1);
    expect(draft!.items[0]?.item.productionDate?.date).toBe("2026-10-21");
    expect(imports.updateDraft(0, { storedAt: "2026-10-18" })).toBe(true);
    expect(imports.confirm()).toBe(true);

    expect(harness.store.items()).toHaveLength(6);
    expect(harness.store.items()[0]?.entryDate).toBe("2026-10-18");
    const record = harness.store.imports()[0];
    expect(record).toMatchObject({
      isDemo: false,
      sourceType: "cart",
    });
    expect(record?.images).toHaveLength(1);
    expect(record?.images?.[0]?.sha256).toHaveLength(64);

    expect(harness.kitchen.deleteImport(record!.id!)).toBe(true);
    expect(harness.store.items()).toHaveLength(0);
    expect(existsSync(input.path)).toBe(false);
  });

  it("records same-image and similar-item duplicates as skipped", async () => {
    const imports = service(
      new ReplayRecognizer(await recording(mixedItems())),
    );
    const originalImage = image();
    expect(await imports.receive(imagePayload(originalImage))).toBe(true);
    expect(imports.skipDuplicate()).toBe(false);
    expect(await imports.start(true)).toBe(true);
    expect(imports.confirm()).toBe(true);
    const originalId = harness.store.imports()[0]!.id!;
    const itemCount = harness.store.items().length;

    const sameImage = image();
    expect(await imports.receive(imagePayload(sameImage))).toBe(true);
    expect(imports.draft()?.duplicate.kind).toBe("same_image");
    expect(imports.skipDuplicate()).toBe(true);
    expect(existsSync(sameImage.path)).toBe(false);

    const similarImage = image("different bytes");
    expect(await imports.receive(imagePayload(similarImage))).toBe(true);
    expect(await imports.start(true)).toBe(true);
    expect(imports.draft()?.duplicate.kind).toBe("similar_items");
    expect(imports.skipDuplicate()).toBe(true);
    expect(imports.draft()).toBeNull();
    expect(imports.hasUnfinishedJob()).toBe(false);

    const records = harness.store.imports();
    expect(records).toHaveLength(3);
    for (const record of records.slice(0, 2)) {
      expect(record.status).toBe(ImportStatus.SkippedDuplicate);
      expect(record.duplicateOf).toBe(originalId);
      expect(record.images).toEqual([]);
      expect(harness.store.itemsForImport(record.id!)).toEqual([]);
    }
    expect(records[2]?.status).toBe(ImportStatus.Confirmed);
    expect(harness.store.items()).toHaveLength(itemCount);
  });

  it("puts seasonings and staples into stock", async () => {
    const imports = service(
      new ReplayRecognizer(
        await recording([
          {
            raw_name: "生抽500ml×2",
            canonical_name: "生抽",
            quantity_text: "500ml×2",
            category: "seasoning",
          },
          {
            raw_name: "方便面5连包",
            canonical_name: "方便面",
            quantity_text: "5包",
            category: "food",
            storage: "room",
          },
          {
            raw_name: "大米5kg",
            canonical_name: "大米",
            quantity_text: "5kg",
            category: "food",
            storage: "room",
          },
          {
            raw_name: "鲜鸡蛋",
            canonical_name: "鸡蛋",
            quantity_text: "10枚",
            count: 2,
            category: "food",
            storage: "fridge",
            shelf_life_days: { fridge: 30 },
          },
          {
            raw_name: "某牌秘制酱",
            canonical_name: "未归类",
            quantity_text: "约350克",
            category: "seasoning",
          },
        ]),
      ),
    );

    expect(await imports.receive(imagePayload(image()))).toBe(true);
    expect(await imports.start(true)).toBe(true);
    const draftItems = imports.draft()!.items;
    expect(draftItems[0]?.item.kind).toBe(ItemKind.StapleSeasoning);
    expect(draftItems[1]?.item.kind).toBe(ItemKind.StapleFood);
    expect(draftItems[1]?.needsShelfLife).toBe(true);
    expect(draftItems[2]?.item.kind).toBe(ItemKind.StapleFood);
    expect(draftItems[3]?.item.kind).toBe(ItemKind.Food);
    expect(draftItems[3]?.needsShelfLife).toBe(false);
    expect(imports.confirm()).toBe(true);

    const byName = new Map(
      harness.store.items().map((item) => [item.rawName, item]),
    );
    expect(byName.size).toBe(5);
    expect(byName.get("生抽500ml×2")).toMatchObject({
      amount: 1000,
      unit: "ml",
    });
    const instantNoodles = byName.get("方便面5连包")!;
    expect(instantNoodles).toMatchObject({
      amount: 5,
      unit: "包",
    });
    expect(needsShelfLife(instantNoodles)).toBe(true);
    expect(byName.get("大米5kg")?.amount).toBe(5000);
    expect(byName.get("鲜鸡蛋")).toMatchObject({
      amount: 20,
      unit: "枚",
    });
    expect(byName.get("某牌秘制酱")).toMatchObject({
      kind: ItemKind.StapleSeasoning,
      amount: 350,
    });
    expect(
      harness.kitchen.suggestions().map((suggestion) => suggestion.name),
    ).not.toContain("未归类");

    const groups = harness.kitchen.fridge().map((item) =>
      groupOf({ kind: item.kind!, storage: item.storage! }),
    );
    expect(groups[0]).toBe(FridgeGroup.Fridge);
    expect(
      groups.filter((group) => group === FridgeGroup.StapleSeasoning),
    ).toHaveLength(2);
    expect(
      groups.filter((group) => group === FridgeGroup.StapleFood),
    ).toHaveLength(2);
  });

  it("resumes only unfinished batches with byte-identical requests", async () => {
    const input = [
      await realImage({ r: 220, g: 40, b: 40 }),
      await realImage({ r: 40, g: 220, b: 40 }),
      await realImage({ r: 40, g: 40, b: 220 }),
    ];
    const server = await new FakeHttpServer((_request, index) => {
      switch (index) {
        case 0:
          return { body: chatReply("鲜鸡蛋", "鸡蛋") };
        case 1:
        case 2:
          return { status: 500, body: "scripted server error" };
        case 3:
          return { body: chatReply("纯牛奶", "牛奶") };
        default:
          return { body: chatReply("土豆", "土豆") };
      }
    }).start();
    httpServers.push(server);

    const interrupted = service(recognizerFor(server));
    expect(
      await interrupted.receive({
        kind: "images",
        origin: "gallery",
        images: input,
      }),
    ).toBe(true);
    expect(await interrupted.start(true)).toBe(false);
    expect(interrupted.lastError?.httpStatus).toBe(500);

    const firstRun = server.requests.slice();
    expect(firstRun).toHaveLength(3);
    const originalSecondBatch = firstRun[1]!;
    expect(firstRun[2]!.bodyBytes.equals(originalSecondBatch.bodyBytes)).toBe(
      true,
    );
    for (const file of input) {
      expect(existsSync(file.path)).toBe(true);
    }

    const resumed = service(recognizerFor(server));
    expect(resumed.hasUnfinishedJob()).toBe(true);
    expect(await resumed.resume()).toBe(true);
    expect(resumed.hasUnfinishedJob()).toBe(false);

    const resumedRequests: CapturedRequest[] = server.requests.slice(3);
    expect(resumedRequests).toHaveLength(2);
    expect(
      resumedRequests[0]!.bodyBytes.equals(originalSecondBatch.bodyBytes),
    ).toBe(true);
    expect(
      resumedRequests[1]!.bodyBytes.equals(originalSecondBatch.bodyBytes),
    ).toBe(false);
    expect(
      resumed.draft()?.items.map((item) => item.item.canonicalName),
    ).toEqual(["鸡蛋", "牛奶", "土豆"]);
    expect(resumed.draft()?.record.images).toHaveLength(3);
    expect(resumed.confirm()).toBe(true);
    expect(harness.store.importJob()).toBeNull();
    expect(harness.store.imports()[0]?.images).toHaveLength(3);
    expect(harness.store.items()).toHaveLength(3);
  });

  it("resumes a finished job without recognition", async () => {
    const input = image();
    const first = service(
      new ReplayRecognizer(await recording(mixedItems())),
    );
    expect(await first.receive(imagePayload(input))).toBe(true);
    expect(await first.start(true)).toBe(true);
    expect(harness.store.importJob()).not.toBeNull();
    expect(existsSync(input.path)).toBe(true);

    const resumed = service(
      new ReplayRecognizer(join(harness.directory, "missing.json")),
    );
    expect(await resumed.resume()).toBe(true);
    expect(resumed.lastError).toBeNull();
    expect(resumed.draft()?.items).toHaveLength(3);
    expect(
      resumed.draft()?.items[0]?.item.productionDate?.date,
    ).toBe("2026-10-20");
    expect(resumed.confirm()).toBe(true);
    expect(harness.store.importJob()).toBeNull();
  });

  it("can discard or replace unfinished jobs", async () => {
    const missing = join(harness.directory, "missing.json");
    const firstInput = image();
    const first = service(new ReplayRecognizer(missing));
    expect(await first.receive(imagePayload(firstInput))).toBe(true);
    expect(await first.start(true)).toBe(false);

    const imports = service(
      new ReplayRecognizer(await recording(mixedItems())),
    );
    expect(imports.hasUnfinishedJob()).toBe(true);
    expect(imports.discardUnfinishedJob()).toBe(true);
    expect(imports.hasUnfinishedJob()).toBe(false);
    expect(existsSync(firstInput.path)).toBe(false);

    const secondInput = image("second");
    const stale = service(new ReplayRecognizer(missing));
    expect(await stale.receive(imagePayload(secondInput))).toBe(true);
    expect(await stale.start(true)).toBe(false);

    const thirdInput = image("third");
    expect(await imports.receive(imagePayload(thirdInput))).toBe(true);
    expect(existsSync(secondInput.path)).toBe(false);
    expect(imports.discard()).toBe(true);
    expect(harness.store.importJob()).toBeNull();
  });

  it("frees images held by unrestorable jobs", async () => {
    const orphan = (): string => {
      const path = image().path;
      const id = harness.store.insertImportJob(
        JSON.stringify({ images: [{ path }] }),
        new ResumableJob(),
      );
      expect(id).toBeGreaterThan(0);
      harness.database
        .prepare("UPDATE import_jobs SET state = 'done' WHERE id = ?")
        .run(id);
      return path;
    };
    const imports = service(
      new ReplayRecognizer(await recording(mixedItems())),
    );

    const first = orphan();
    expect(harness.store.importJob()).toBeNull();
    expect(imports.hasUnfinishedJob()).toBe(false);
    expect(imports.discardUnfinishedJob()).toBe(true);
    expect(harness.store.importJobRows()).toEqual([]);
    expect(existsSync(first)).toBe(false);

    const second = orphan();
    expect(
      await imports.receive(imagePayload(image("next"))),
    ).toBe(true);
    expect(harness.store.importJobRows()).toEqual([]);
    expect(existsSync(second)).toBe(false);
    expect(imports.discard()).toBe(true);
  });

  it("does not persist text import jobs", async () => {
    const imports = service(
      new ReplayRecognizer(join(harness.directory, "missing.json")),
    );
    expect(
      await imports.receive({
        kind: "text",
        origin: "paste",
        text: "鸡蛋 两盒",
      }),
    ).toBe(true);
    expect(await imports.start(true)).toBe(false);
    expect(harness.store.importJob()).toBeNull();
    const row = harness.database
      .prepare("SELECT COUNT(*) AS count FROM import_jobs")
      .get();
    expect(Number(row?.count)).toBe(0);
  });

  it("stops duplicate images and asks before accepting similar items", async () => {
    const recognizer = new ReplayRecognizer(
      await recording(mixedItems()),
    );
    const imports = service(recognizer);

    expect(await imports.receive(imagePayload(image()))).toBe(true);
    expect(await imports.start(true)).toBe(true);
    expect(imports.confirm()).toBe(true);
    const firstImport = harness.store.imports()[0]!.id!;

    expect(await imports.receive(imagePayload(image()))).toBe(true);
    expect(imports.draft()?.duplicate.kind).toBe("same_image");
    expect(await imports.start(true)).toBe(false);
    expect(imports.state).toBe(ImportState.Duplicate);
    expect(imports.discard()).toBe(true);

    expect(
      await imports.receive(imagePayload(image("different bytes"))),
    ).toBe(true);
    expect(await imports.start(true)).toBe(true);
    expect(imports.draft()?.duplicate.kind).toBe("similar_items");
    expect(imports.draft()?.duplicate.importId).toBe(firstImport);
    expect(imports.confirm()).toBe(false);
    expect(imports.confirm(true)).toBe(true);
    expect(harness.store.imports()).toHaveLength(2);
  });

  it("rolls back a failed confirmation and retries the same draft", async () => {
    const input = image();
    const imports = service(
      new ReplayRecognizer(await recording(mixedItems())),
    );
    expect(await imports.receive(imagePayload(input))).toBe(true);
    expect(await imports.start(true)).toBe(true);

    harness.database.exec(
      `CREATE TRIGGER fail_item BEFORE INSERT ON items
       BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END`,
    );
    expect(imports.confirm()).toBe(false);
    expect(harness.store.imports()).toHaveLength(0);
    expect(harness.store.items()).toHaveLength(0);
    expect(
      harness.store.aiEstimateCache().days("鸡蛋", Storage.Fridge),
    ).toBeNull();
    expect(existsSync(input.path)).toBe(true);

    harness.database.exec("DROP TRIGGER fail_item");
    expect(imports.confirm()).toBe(true);
    expect(harness.store.imports()).toHaveLength(1);
  });

  it("keeps the demo and text imports on the normal confirmation path", async () => {
    const demo = service(new DemoRecognizer(), true);
    expect(await demo.receive(imagePayload(image()))).toBe(true);
    expect(await demo.start(true)).toBe(true);
    expect(demo.draft()?.record.isDemo).toBe(true);
    expect(demo.confirm()).toBe(true);
    expect(harness.store.imports()[0]?.isDemo).toBe(true);
    expect(harness.store.items()).toHaveLength(3);

    expect(harness.kitchen.deleteAllData()).toBe(true);
    const text = "鸡蛋 今天生产";
    const orderText = service(
      new ReplayRecognizer(
        await recording(
          [
            {
              raw_name: "鸡蛋",
              canonical_name: "鸡蛋",
              category: "food",
              production_date_text: "今天生产",
            },
          ],
          InputKind.OrderText,
        ),
      ),
    );
    expect(
      await orderText.receive({
        kind: "text",
        origin: "paste",
        text,
      }),
    ).toBe(true);
    expect(await orderText.start(true)).toBe(true);
    expect(orderText.confirm()).toBe(false);
    expect(orderText.lastError?.kind).toBe(ErrorKind.InvalidInput);
    expect(
      orderText.updateDraft(0, {
        producedAt: "2026-10-18",
        purchasedAt: "2026-10-20",
      }),
    ).toBe(true);
    expect(orderText.confirm()).toBe(true);

    const item = harness.store.items()[0]!;
    expect(item.productionDate?.origin).toBe(DateOrigin.User);
    expect(item.purchaseDate?.origin).toBe(DateOrigin.User);
    expect(item.expiryDate).toBe("2026-11-10");
    const record = harness.store.imports()[0]!;
    expect(record.images).toHaveLength(0);
    expect(record.textLength).toBe(text.length);
  });

  it("marks a name returned by the classifier as AI classified", async () => {
    const client = new RecordedChatClient({
      exchanges: [
        classifierAnswer(
          '{"items":[{"index":1,"raw_name":"花胶 100g","canonical_name":"鱼"}]}',
        ),
      ],
    });
    const imports = service(
      new ReplayRecognizer(
        await recording([
          {
            raw_name: "花胶 100g",
            canonical_name: "未归类",
            category: "food",
            storage: "fridge",
          },
        ]),
      ),
      false,
      { classifier: new IngredientClassifier(client) },
    );

    expect(await imports.receive(imagePayload(image()))).toBe(true);
    expect(await imports.start(true)).toBe(true);

    const item = imports.draft()?.items[0];
    expect(item?.item.canonicalName).toBe("鱼");
    expect(item?.nameSource).toBe(NameSource.AiClassified);
    expect(imports.status().draftItems[0]?.aiClassified).toBe(true);
    expect(client.requests()).toHaveLength(1);
  });

  it("keeps the uncategorized name when classification fails", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const client = new RecordedChatClient({
        exchanges: [classifierFailure()],
      });
      const imports = service(
        new ReplayRecognizer(
          await recording([
            {
              raw_name: "花胶 100g",
              canonical_name: "未归类",
              category: "food",
              storage: "fridge",
            },
          ]),
        ),
        false,
        { classifier: new IngredientClassifier(client) },
      );

      expect(await imports.receive(imagePayload(image()))).toBe(true);
      expect(await imports.start(true)).toBe(true);
      expect(warning).toHaveBeenCalledWith(
        "import: classification failed",
      );

      const item = imports.draft()?.items[0];
      expect(item?.item.canonicalName).toBe("未归类");
      expect(item?.item.displayName).toBe("花胶 100g");
      expect(item?.nameSource).toBe(NameSource.Unresolved);
      expect(imports.confirm()).toBe(true);
      expect(harness.store.imports()).toHaveLength(1);
    } finally {
      warning.mockRestore();
    }
  });

  it("marks a name changed by the user as user edited", async () => {
    const imports = service(
      new ReplayRecognizer(
        await recording([
          {
            raw_name: "藕粉 500g",
            canonical_name: "未归类",
            category: "food",
            storage: "fridge",
          },
        ]),
      ),
    );

    expect(await imports.receive(imagePayload(image()))).toBe(true);
    expect(await imports.start(true)).toBe(true);
    expect(imports.updateDraft(0, { name: "土豆" })).toBe(true);

    const item = imports.draft()?.items[0];
    expect(item?.item.canonicalName).toBe("土豆");
    expect(item?.nameSource).toBe(NameSource.UserEdited);
    expect(imports.status().draftItems[0]?.aiClassified).toBe(false);
  });

  it("remembers only confirmed AI-classified and user-edited names", async () => {
    const client = new RecordedChatClient({
      exchanges: [
        classifierAnswer(
          '{"items":[{"index":1,"raw_name":"花胶 100g","canonical_name":"鱼"}]}',
        ),
      ],
    });
    const mappings = new SqliteNameMappingStore(
      harness.database,
      harness.clock,
    );
    const imports = service(
      new ReplayRecognizer(
        await recording([
          {
            raw_name: "花胶 100g",
            canonical_name: "未归类",
            category: "food",
            storage: "fridge",
          },
          {
            raw_name: "藕粉 500g",
            canonical_name: "未归类",
            category: "food",
            storage: "fridge",
          },
          {
            raw_name: "黑猪梅花肉切片 300g",
            canonical_name: "猪肉",
            category: "food",
            storage: "fridge",
          },
          {
            raw_name: "有机小番茄 250g",
            canonical_name: "未归类",
            category: "food",
            storage: "fridge",
          },
        ]),
      ),
      false,
      {
        classifier: new IngredientClassifier(client),
        mappings,
      },
    );

    expect(await imports.receive(imagePayload(image()))).toBe(true);
    expect(await imports.start(true)).toBe(true);
    expect(imports.updateDraft(1, { name: "土豆" })).toBe(true);
    expect(imports.draft()?.items.map((item) => item.nameSource)).toEqual([
      NameSource.AiClassified,
      NameSource.UserEdited,
      NameSource.Recognized,
      NameSource.LocalMatch,
    ]);
    expect(imports.confirm()).toBe(true);

    expect(mappings.mapped("花胶 100g")).toBe("鱼");
    expect(mappings.mapped("藕粉 500g")).toBe("土豆");
    expect(mappings.mapped("黑猪梅花肉切片 300g")).toBe("");
    expect(mappings.mapped("有机小番茄 250g")).toBe("");
    expect(mappings.entries()).toHaveLength(2);
  });

  it("uses the user mapping directly on the next identical import", async () => {
    const client = new RecordedChatClient({
      exchanges: [
        classifierAnswer(
          '{"items":[{"index":1,"raw_name":"花胶 100g","canonical_name":"鱼"}]}',
        ),
      ],
    });
    const mappings = new SqliteNameMappingStore(
      harness.database,
      harness.clock,
    );
    const imports = service(
      new ReplayRecognizer(
        await recording([
          {
            raw_name: "花胶 100g",
            canonical_name: "未归类",
            category: "food",
            storage: "fridge",
          },
        ]),
      ),
      false,
      {
        classifier: new IngredientClassifier(client),
        mappings,
      },
    );

    expect(await imports.receive(imagePayload(image("first")))).toBe(true);
    expect(await imports.start(true)).toBe(true);
    expect(imports.confirm()).toBe(true);
    expect(await imports.receive(imagePayload(image("second")))).toBe(true);
    expect(await imports.start(true)).toBe(true);

    const item = imports.draft()?.items[0];
    expect(item?.item.canonicalName).toBe("鱼");
    expect(item?.nameSource).toBe(NameSource.UserMapping);
    expect(imports.status().draftItems[0]?.aiClassified).toBe(false);
    expect(client.requests()).toHaveLength(1);
  });

  it("does not call the classifier in demo mode", async () => {
    const client = new RecordedChatClient({
      exchanges: [
        classifierAnswer(
          '{"items":[{"index":1,"raw_name":"花胶 100g","canonical_name":"鱼"}]}',
        ),
      ],
    });
    const imports = service(
      new ReplayRecognizer(
        await recording([
          {
            raw_name: "花胶 100g",
            canonical_name: "未归类",
            category: "food",
            storage: "fridge",
          },
        ]),
      ),
      true,
      {
        classifier: new IngredientClassifier(client),
        classifierConfigured: false,
      },
    );

    expect(await imports.receive(imagePayload(image()))).toBe(true);
    expect(await imports.start(true)).toBe(true);
    expect(imports.draft()?.record.isDemo).toBe(true);
    expect(imports.draft()?.items[0]?.item.canonicalName).toBe("未归类");
    expect(imports.draft()?.items[0]?.nameSource).toBe(
      NameSource.Unresolved,
    );
    expect(client.requests()).toHaveLength(0);
  });

  it("cancels an in-flight recognition before deleting all data", async () => {
    const input = image();
    const recognizer = new HeldReplayRecognizer(
      await recording(mixedItems()),
    );
    const imports = service(recognizer);
    expect(await imports.receive(imagePayload(input))).toBe(true);

    const pending = imports.start(true);
    await recognizer.entered;
    expect(imports.state).toBe(ImportState.Recognizing);

    expect(imports.discard()).toBe(true);
    expect(harness.kitchen.deleteAllData()).toBe(true);
    await expect(pending).resolves.toBe(false);

    expect(imports.state).toBe(ImportState.Idle);
    expect(imports.draft()).toBeNull();
    expect(harness.store.imports()).toHaveLength(0);
    expect(existsSync(input.path)).toBe(false);
  });
});
