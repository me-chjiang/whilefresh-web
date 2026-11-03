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
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DateOrigin,
  ImportStatus,
  ItemStatus,
  ShelfLifeSource,
  ShoppingOrigin,
  StartBasis,
  Storage,
  StorageSource,
  SuggestionKind,
} from "../../shared/enums.js";
import { openDatabase } from "../../server/data/db.js";
import {
  Store,
  type FridgeItem,
  type ImportRecord,
  type StoredSuggestion,
} from "../../server/data/store.js";
import { fixedClock, type Clock } from "../../server/domain/clock.js";
import { PantryRules } from "../../server/domain/pantry.js";
import {
  BatchState,
  JobState,
  ResumableJob,
} from "../../server/domain/resumable-job.js";
import { makeShoppingEntry } from "../../server/domain/shopping-list.js";

interface StoreHarness {
  directory: string;
  importsDirectory: string;
  database: DatabaseSync;
  clock: Clock;
  store: Store;
}

function sampleItem(
  importId: number,
  name: string,
  quantity: string,
): FridgeItem {
  return {
    importId,
    canonicalName: name,
    displayName: name,
    quantityText: quantity,
    category: "vegetable",
  };
}

function touch(path: string): void {
  writeFileSync(path, "x");
}

describe("store", () => {
  let harness: StoreHarness;

  beforeEach(() => {
    const directory = mkdtempSync(join(tmpdir(), "whilefresh-store-"));
    const importsDirectory = join(directory, "imports");
    mkdirSync(importsDirectory);
    const database = openDatabase(join(directory, "whilefresh.db"));
    const clock = fixedClock(new Date(2026, 9, 21, 10, 0));
    harness = {
      directory,
      importsDirectory,
      database,
      clock,
      store: new Store(database, clock, importsDirectory),
    };
  });

  afterEach(() => {
    harness.database.close();
    rmSync(harness.directory, { recursive: true, force: true });
  });

  it("round-trips an item", () => {
    const item = sampleItem(0, "牛奶", "950ml");
    Object.assign(item, {
      rawName: "全脂鲜牛奶",
      storage: Storage.Fridge,
      storageSource: StorageSource.Reference,
      useFirst: true,
      purchaseDate: {
        date: "2026-10-20",
        origin: DateOrigin.Visible,
        text: "10月20日",
      },
      productionDate: {
        date: null,
        origin: DateOrigin.None,
        text: "看不清",
      },
      packageExpiry: {
        date: "2026-11-03",
        origin: DateOrigin.User,
        text: "",
      },
      labelledDays: 7,
      aiDays: { fridge: 7, freezer: null, room: 1 },
      shelfLifeSource: ShelfLifeSource.Package,
      shelfLifeDays: 14,
      expiryDate: "2026-11-03",
      startBasis: StartBasis.PurchaseDate,
      shelfLifeNote: "包装到期日",
    } satisfies Partial<FridgeItem>);

    const id = harness.store.insertItem(item);
    expect(id).toBeGreaterThan(0);
    expect(item.entryDate).toBe("2026-10-21");

    const loaded = harness.store.item(id);
    expect(loaded).toBeDefined();
    if (!loaded) {
      return;
    }
    expect(loaded.importId).toBe(0);
    expect(loaded.rawName).toBe("全脂鲜牛奶");
    expect(loaded.storageSource).toBe(StorageSource.Reference);
    expect(loaded.useFirst).toBe(true);
    expect(loaded.purchaseDate).toEqual({
      date: "2026-10-20",
      origin: DateOrigin.Visible,
      text: "10月20日",
    });
    expect(loaded.productionDate).toEqual({
      date: null,
      origin: DateOrigin.None,
      text: "看不清",
    });
    expect(loaded.packageExpiry?.origin).toBe(DateOrigin.User);
    expect(loaded.labelledDays).toBe(7);
    expect(loaded.manualDays).toBeNull();
    expect(loaded.aiDays).toEqual({ fridge: 7, freezer: null, room: 1 });
    expect(loaded.shelfLifeSource).toBe(ShelfLifeSource.Package);
    expect(loaded.expiryDate).toBe("2026-11-03");
    expect(loaded.startBasis).toBe(StartBasis.PurchaseDate);
    expect(loaded.createdAt).toEqual(harness.clock.now());

    loaded.status = ItemStatus.Used;
    expect(harness.store.updateItem(loaded)).toBe(true);
    expect(harness.store.items()).toEqual([]);
    expect(harness.store.items(null)).toHaveLength(1);
    expect(harness.store.items(ItemStatus.Used)).toHaveLength(1);
  });

  it("deletes an import with its items and files", () => {
    const image = join(harness.importsDirectory, "a.jpg");
    const other = join(harness.importsDirectory, "b.jpg");
    const outside = join(harness.directory, "outside.jpg");
    touch(image);
    touch(other);
    touch(outside);

    const first: ImportRecord = {
      inputKind: "screenshot",
      images: [
        {
          path: image,
          sha256: "sha-a",
          mimeType: "image/jpeg",
          capturedAt: harness.clock.now(),
          capturedAtSource: "Exif",
        },
        { path: outside, sha256: "sha-x" },
      ],
    };
    expect(harness.store.insertImport(first)).toBeGreaterThan(0);
    const second: ImportRecord = {
      inputKind: "screenshot",
      images: [{ path: other, sha256: "sha-b" }],
    };
    expect(harness.store.insertImport(second)).toBeGreaterThan(0);

    const inStock = sampleItem(first.id!, "土豆", "500g");
    const used = sampleItem(first.id!, "西红柿", "500g");
    used.status = ItemStatus.Used;
    const discarded = sampleItem(first.id!, "菠菜", "300g");
    discarded.status = ItemStatus.Discarded;
    const fromSecond = sampleItem(second.id!, "西红柿", "500g");
    const manual = sampleItem(0, "鸡蛋", "10枚");
    for (const item of [inStock, used, discarded, fromSecond, manual]) {
      expect(harness.store.insertItem(item)).toBeGreaterThan(0);
    }

    const suggestion: StoredSuggestion = {
      kind: SuggestionKind.MarkPantryHave,
      name: "生抽",
      message: "?",
      importId: first.id,
    };
    expect(harness.store.addSuggestion(suggestion)).toBeGreaterThan(0);

    const loaded = harness.store.importRecord(first.id!);
    expect(loaded?.images).toHaveLength(2);
    expect(loaded?.images?.[0]?.capturedAtSource).toBe("Exif");

    expect(harness.store.deleteImport(first.id!)).toBe(false);
    expect(existsSync(image)).toBe(false);
    expect(existsSync(outside)).toBe(true);
    expect(existsSync(other)).toBe(true);
    expect(harness.store.importRecord(first.id!)).toBeUndefined();
    expect(harness.store.items()).toHaveLength(2);
    expect(harness.store.item(inStock.id!)).toBeUndefined();
    expect(harness.store.item(fromSecond.id!)).toBeDefined();
    expect(harness.store.item(manual.id!)).toBeDefined();
    expect(harness.store.itemsForImport(first.id!)).toHaveLength(2);
    expect(
      harness.store.itemsForImport(first.id!).map((item) => item.status),
    ).toEqual([ItemStatus.Used, ItemStatus.Discarded]);
    expect(harness.store.imports()).toHaveLength(1);
    expect(harness.store.imports(true)).toHaveLength(2);
    expect(
      harness.store
        .imports(true)
        .find((record) => record.id === first.id)?.deletedAt,
    ).toEqual(harness.clock.now());
    expect(
      harness.store.importFingerprints().map((fingerprint) => fingerprint.importId),
    ).toEqual([second.id]);
    expect(harness.store.pendingSuggestions()).toEqual([]);
    expect(harness.store.deleteImport(first.id!)).toBe(false);
  });

  it("clears import history without emptying the fridge", () => {
    const paths = [
      join(harness.importsDirectory, "a.jpg"),
      join(harness.importsDirectory, "b.jpg"),
    ];
    paths.forEach(touch);
    const importIds: number[] = [];

    for (const path of paths) {
      const record: ImportRecord = {
        inputKind: "screenshot",
        images: [{ path, sha256: path.slice(-5) }],
      };
      expect(harness.store.insertImport(record)).toBeGreaterThan(0);
      importIds.push(record.id!);
      expect(
        harness.store.insertItem(sampleItem(record.id!, "土豆", "500g")),
      ).toBeGreaterThan(0);
    }
    expect(
      harness.store.insertItem(sampleItem(0, "鸡蛋", "10枚")),
    ).toBeGreaterThan(0);

    expect(harness.store.clearImportHistory()).toBe(true);
    expect(harness.store.imports()).toEqual([]);
    expect(harness.store.imports(true)).toHaveLength(2);
    expect(harness.store.items()).toHaveLength(3);
    for (const importId of importIds) {
      expect(harness.store.itemsForImport(importId)).toHaveLength(1);
    }
    expect(paths.every((path) => !existsSync(path))).toBe(true);
    expect(harness.store.importFingerprints()).toEqual([]);
  });

  it("records skipped duplicate imports", () => {
    const original: ImportRecord = { inputKind: "screenshot" };
    expect(harness.store.insertImport(original)).toBeGreaterThan(0);
    const skipped: ImportRecord = {
      inputKind: "screenshot",
      status: ImportStatus.SkippedDuplicate,
      duplicateOf: original.id,
    };
    expect(harness.store.insertImport(skipped)).toBeGreaterThan(0);

    expect(harness.store.importRecord(skipped.id!)).toMatchObject({
      status: ImportStatus.SkippedDuplicate,
      duplicateOf: original.id,
    });
    expect(harness.store.importRecord(original.id!)).toMatchObject({
      status: ImportStatus.Confirmed,
    });
    expect(
      harness.store.importRecord(original.id!)?.duplicateOf,
    ).toBe(0);
  });

  it("round-trips import jobs", () => {
    expect(harness.store.importJob()).toBeNull();
    const job = new ResumableJob();
    expect(job.start()).toBe(true);
    const id = harness.store.insertImportJob('{"images":[]}', job);
    expect(id).toBeGreaterThan(0);

    expect(job.plan(3)).toBe(true);
    expect(job.completeBatch(0, "first")).toBe(true);
    expect(harness.store.saveImportJob(id, job)).toBe(true);

    let loaded = harness.store.importJob();
    expect(loaded).toMatchObject({
      id,
      payload: Buffer.from('{"images":[]}'),
      createdAt: harness.clock.now(),
    });
    expect(loaded?.job.state).toBe(JobState.Failed);
    expect(loaded?.job.batchCount).toBe(3);
    expect(loaded?.job.nextBatch()).toBe(1);
    expect(loaded?.job.results()).toEqual(["first"]);

    job.reset();
    expect(job.start()).toBe(true);
    expect(job.plan(1)).toBe(true);
    expect(job.completeBatch(0, "whole")).toBe(true);
    expect(harness.store.saveImportJob(id, job)).toBe(true);

    loaded = harness.store.importJob();
    expect(loaded?.job.state).toBe(JobState.Done);
    expect(loaded?.job.results()).toEqual(["whole"]);
    expect(harness.store.deleteImportJob(id)).toBe(true);
    expect(harness.store.importJob()).toBeNull();
    expect(
      Number(
        harness.database
          .prepare("SELECT COUNT(*) AS count FROM import_job_batches")
          .get()?.count,
      ),
    ).toBe(0);
  });

  it("rolls back partially written import jobs", () => {
    const job = new ResumableJob();
    expect(job.start()).toBe(true);
    expect(job.plan(2)).toBe(true);
    expect(job.completeBatch(0, "a")).toBe(true);
    const id = harness.store.insertImportJob("{}", job);
    expect(id).toBeGreaterThan(0);

    harness.database.exec(`
      CREATE TRIGGER fail_batch
      BEFORE UPDATE ON import_job_batches
      WHEN NEW.batch_index = 1
      BEGIN
        SELECT RAISE(ABORT, 'synthetic failure');
      END;
    `);
    expect(job.completeBatch(1, "b")).toBe(true);
    expect(job.state).toBe(JobState.Done);
    expect(harness.store.saveImportJob(id, job)).toBe(false);
    const loaded = harness.store.importJob();
    expect(loaded?.job.state).toBe(JobState.Failed);
    expect(loaded?.job.nextBatch()).toBe(1);
    expect(loaded?.job.results()).toEqual(["a"]);
    expect(loaded?.job.batches[1]?.state).toBe(BatchState.Failed);
    harness.database.exec("DROP TRIGGER fail_batch");

    harness.database.exec(`
      CREATE TRIGGER fail_insert
      BEFORE INSERT ON import_job_batches
      BEGIN
        SELECT RAISE(ABORT, 'synthetic failure');
      END;
    `);
    expect(harness.store.insertImportJob("{}", job)).toBe(0);
    expect(harness.store.importJobRows()).toHaveLength(1);
    expect(harness.store.importJob()?.id).toBe(id);
  });

  it("truncates preferences and rejects normalized duplicates", () => {
    expect(harness.store.preferences()).toEqual([]);
    expect(harness.store.addPreference(" 不吃  香菜 ")).toBeGreaterThan(0);
    expect(harness.store.preferences()[0]?.text).toBe("不吃 香菜");
    expect(harness.store.addPreference("不吃 香菜")).toBe(0);

    const longId = harness.store.addPreference("a".repeat(150));
    expect(longId).toBeGreaterThan(0);
    const longPreference = harness.store.preferences().at(-1);
    expect(longPreference?.text).toHaveLength(100);
    expect(longPreference?.text).toBe("a".repeat(100));
  });

  it("caps preferences at 50 items", () => {
    for (let index = 0; index < 50; index += 1) {
      expect(harness.store.addPreference(`偏好${index}`)).toBeGreaterThan(0);
    }
    expect(harness.store.preferences()).toHaveLength(50);
    expect(harness.store.addPreference("多出来的")).toBe(0);

    const first = harness.store.preferences()[0]!;
    expect(harness.store.deletePreference(first.id)).toBe(true);
    const replacement = harness.store.addPreference("z".repeat(150));
    expect(replacement).toBeGreaterThan(0);
    expect(harness.store.preferences().at(-1)?.text).toBe("z".repeat(100));
  });

  it("deletes all data", () => {
    const image = join(harness.importsDirectory, "a.jpg");
    const stray = join(harness.importsDirectory, "old.part");
    touch(image);
    touch(stray);

    const record: ImportRecord = {
      inputKind: "receipt",
      images: [{ path: image, sha256: "sha" }],
    };
    expect(harness.store.insertImport(record)).toBeGreaterThan(0);
    expect(
      harness.store.insertItem(sampleItem(record.id!, "土豆", "")),
    ).toBeGreaterThan(0);
    expect(
      harness.store.saveShelfLifeRule({
        name: "土豆",
        storage: Storage.Room,
        days: 20,
      }),
    ).toBe(true);
    expect(harness.store.setSetting("demo", "1")).toBe(true);
    expect(
      harness.store.addShoppingEntry(
        makeShoppingEntry(["盐"], ShoppingOrigin.Manual, "", null),
      ),
    ).toBeGreaterThan(0);

    expect(harness.store.deleteAllData()).toBe(true);
    expect(harness.store.items(null)).toEqual([]);
    expect(harness.store.imports()).toEqual([]);
    expect(harness.store.shelfLifeRules()).toEqual([]);
    expect(harness.store.shoppingEntries()).toEqual([]);
    expect(harness.store.setting("demo", "0")).toBe("0");
    expect(existsSync(image)).toBe(false);
    expect(existsSync(stray)).toBe(false);
    expect(
      Number(harness.database.prepare("PRAGMA user_version").get()?.user_version),
    ).toBe(3);
  });

  it("keeps real import files when deleting demo data", () => {
    const demoDatabase = openDatabase(join(harness.directory, "demo.db"));
    try {
      const demoStore = new Store(
        demoDatabase,
        harness.clock,
        harness.importsDirectory,
        false,
      );
      const realImage = join(harness.importsDirectory, "real.jpg");
      const demoImage = join(harness.importsDirectory, "demo.jpg");
      touch(realImage);
      touch(demoImage);

      const real: ImportRecord = {
        inputKind: "screenshot",
        images: [{ path: realImage, sha256: "real" }],
      };
      expect(harness.store.insertImport(real)).toBeGreaterThan(0);
      const demo: ImportRecord = {
        inputKind: "screenshot",
        images: [{ path: demoImage, sha256: "demo" }],
      };
      expect(demoStore.insertImport(demo)).toBeGreaterThan(0);

      expect(demoStore.deleteAllData()).toBe(true);
      expect(existsSync(realImage)).toBe(true);
      expect(existsSync(demoImage)).toBe(false);
      expect(harness.store.importRecord(real.id!)).toBeDefined();
    } finally {
      demoDatabase.close();
    }
  });

  it("saves and removes rules and caches AI estimates", () => {
    expect(
      harness.store.saveShelfLifeRule({
        name: "鸡蛋",
        storage: Storage.Fridge,
        days: 30,
      }),
    ).toBe(true);
    expect(
      harness.store.saveShelfLifeRule({
        name: "鸡蛋",
        storage: Storage.Fridge,
        days: 25,
      }),
    ).toBe(true);
    expect(
      harness.store.saveShelfLifeRule({
        name: "未归类",
        storage: Storage.Fridge,
        days: 5,
      }),
    ).toBe(false);
    expect(
      harness.store.saveStorageRule({
        name: "香蕉",
        storage: Storage.Room,
      }),
    ).toBe(true);

    const book = harness.store.ruleBook();
    expect(book.shelfLifeDays("鸡蛋", Storage.Fridge)).toBe(25);
    expect(book.storage("香蕉")).toBe(Storage.Room);
    expect(
      harness.store.deleteShelfLifeRule("鸡蛋", Storage.Fridge),
    ).toBe(true);
    expect(harness.store.deleteStorageRule("香蕉")).toBe(true);
    expect(harness.store.shelfLifeRules()).toEqual([]);

    expect(
      harness.store.cacheAiEstimate({
        name: "牛奶",
        storage: Storage.Fridge,
        days: 7,
      }),
    ).toBe(true);
    expect(
      harness.store.cacheAiEstimate({
        name: "牛奶",
        storage: Storage.Fridge,
        days: 14,
      }),
    ).toBe(true);
    expect(
      harness.store.aiEstimateCache().days("牛奶", Storage.Fridge),
    ).toBe(7);
  });

  it("stores pantry overrides", () => {
    expect(
      harness.store.savePantryOverride({ name: "盐", out: true }),
    ).toBe(true);
    expect(
      harness.store.savePantryOverride({
        name: "豆瓣酱",
        pantry: true,
        bulk: false,
      }),
    ).toBe(true);

    const overrides = harness.store.pantryOverrides();
    expect(overrides).toHaveLength(2);
    expect(overrides[0]?.name).toBe("盐");
    expect(overrides[0]?.out).toBe(true);
    expect(overrides[0]?.pantry).toBeUndefined();
    expect(overrides[1]?.bulk).toBe(false);

    const rules = new PantryRules();
    for (const override of overrides) {
      rules.setOverride(override);
    }
    expect(rules.isPantry("豆瓣酱")).toBe(true);
    expect(harness.store.deletePantryOverride("盐")).toBe(true);
    expect(harness.store.pantryOverrides()).toHaveLength(1);
  });

  it("deduplicates pending suggestions and resolves them once", () => {
    const first: StoredSuggestion = {
      kind: SuggestionKind.AddToShopping,
      name: "盐",
      message: "加入待买吗？",
    };
    const id = harness.store.addSuggestion(first);
    expect(id).toBeGreaterThan(0);
    expect(harness.store.addSuggestion({ ...first })).toBe(id);
    expect(harness.store.pendingSuggestions()).toHaveLength(1);
    expect(harness.store.suggestion(id)).toBeDefined();
    expect(harness.store.resolveSuggestion(id, true)).toBe(true);
    expect(harness.store.resolveSuggestion(id, false)).toBe(false);
    expect(harness.store.pendingSuggestions()).toEqual([]);
    expect(harness.store.suggestion(id)).toBeUndefined();
    expect(harness.store.addSuggestion({ ...first })).not.toBe(id);
  });

  it("deduplicates and removes shopping entries", () => {
    const first = makeShoppingEntry(
      ["牛奶", "淡奶油"],
      ShoppingOrigin.Recipe,
      "奶油汤",
      null,
    );
    const second = makeShoppingEntry(
      ["淡奶油", "牛奶"],
      ShoppingOrigin.Manual,
      "",
      null,
    );
    expect(harness.store.addShoppingEntry(first)).toBeGreaterThan(0);
    expect(harness.store.addShoppingEntry(second)).toBe(0);

    const entries = harness.store.shoppingEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.names).toEqual(["牛奶", "淡奶油"]);
    expect(entries[0]?.origin).toBe(ShoppingOrigin.Recipe);
    expect(entries[0]?.note).toBe("奶油汤");
    expect(harness.store.removeShoppingEntry(first.id)).toBe(true);
    expect(harness.store.shoppingEntries()).toEqual([]);
  });

  it("builds import fingerprints", () => {
    const record: ImportRecord = {
      inputKind: "screenshot",
      images: [{ path: "/nowhere/a.jpg", sha256: "sha-a" }],
    };
    expect(harness.store.insertImport(record)).toBeGreaterThan(0);
    expect(
      harness.store.insertItem(sampleItem(record.id!, "土豆", "500g")),
    ).toBeGreaterThan(0);

    const fingerprints = harness.store.importFingerprints();
    expect(fingerprints).toHaveLength(1);
    expect(fingerprints[0]?.imageSha256).toEqual(["sha-a"]);
    expect(fingerprints[0]?.items).toHaveLength(1);
    expect(fingerprints[0]?.createdAt).toEqual(harness.clock.now());
  });

  it("leaves imports with no stock out of fingerprints until stock returns", () => {
    const record: ImportRecord = {
      inputKind: "screenshot",
      images: [{ path: "/nowhere/a.jpg", sha256: "sha-a" }],
    };
    const other: ImportRecord = {
      inputKind: "screenshot",
      images: [{ path: "/nowhere/b.jpg", sha256: "sha-b" }],
    };
    const empty: ImportRecord = { inputKind: "screenshot" };
    for (const value of [record, other, empty]) {
      expect(harness.store.insertImport(value)).toBeGreaterThan(0);
    }
    const potato = sampleItem(record.id!, "土豆", "500g");
    const egg = sampleItem(record.id!, "鸡蛋", "10枚");
    const spinach = sampleItem(other.id!, "菠菜", "300g");
    for (const item of [potato, egg, spinach]) {
      expect(harness.store.insertItem(item)).toBeGreaterThan(0);
    }
    const activeIds = () =>
      harness.store
        .importFingerprints()
        .map((fingerprint) => fingerprint.importId)
        .sort((left, right) => left - right);

    expect(activeIds()).toEqual([record.id, other.id]);

    potato.status = ItemStatus.Used;
    expect(harness.store.updateItem(potato)).toBe(true);
    expect(activeIds()).toEqual([record.id, other.id]);

    egg.status = ItemStatus.Absent;
    expect(harness.store.updateItem(egg)).toBe(true);
    expect(activeIds()).toEqual([other.id]);

    potato.status = ItemStatus.InStock;
    expect(harness.store.updateItem(potato)).toBe(true);
    expect(activeIds()).toEqual([record.id, other.id]);
    expect(
      harness.store
        .importFingerprints()
        .find((fingerprint) => fingerprint.importId === record.id)?.items,
    ).toHaveLength(2);

    spinach.status = ItemStatus.Discarded;
    expect(harness.store.updateItem(spinach)).toBe(true);
    expect(activeIds()).toEqual([record.id]);
  });
});
