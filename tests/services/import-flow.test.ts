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

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DateOrigin,
  ImportState,
  Storage,
} from "../../shared/enums.js";
import { loadBuiltin, type BuiltinData } from "../../server/data/builtin.js";
import { openDatabase } from "../../server/data/db.js";
import { Store } from "../../server/data/store.js";
import { fixedClock, type Clock } from "../../server/domain/clock.js";
import { CapturedAtSource } from "../../server/import/captured-at.js";
import type { StoredImportFile } from "../../server/import/import-files.js";
import {
  writeRecording,
  type Recording,
} from "../../server/recognition/recording.js";
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

  afterEach(() => {
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

  function service(recognizer: Recognizer, demo = false): ImportService {
    return new ImportService({
      store: harness.store,
      builtin: harness.builtin,
      clock: harness.clock,
      recognizer,
      demo,
      importsDirectory: harness.importsDirectory,
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
