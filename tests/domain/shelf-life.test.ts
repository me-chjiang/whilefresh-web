import { describe, expect, it } from "vitest";

import {
  ShelfLifeSource,
  StartBasis,
  Storage,
  StorageSource,
} from "../../shared/enums.js";
import { Catalog } from "../../server/domain/catalog.js";
import {
  AiEstimateCache,
  RuleBook,
  ShelfLifeTable,
  proposeShelfLifeRule,
  proposeStorageRule,
  resolveShelfLife,
  suggestStorage,
  type ShelfLifeContext,
  type ShelfLifeInput,
} from "../../server/domain/shelf-life.js";
import {
  sourceAiEstimate,
  sourceLocalRule,
  sourceNone,
  sourcePackage,
  sourceReference,
} from "../../server/domain/texts.js";

const catalog = Catalog.fromJson(`{
  "categories": [
    {"code": "vegetable", "name": "蔬菜"},
    {"code": "meat", "name": "肉类"},
    {"code": "egg_dairy", "name": "蛋奶"},
    {"code": "staple", "name": "主食粮油"},
    {"code": "seasoning", "name": "调料"}
  ],
  "items": [
    {"name": "西红柿", "category": "vegetable", "aliases": ["番茄"]},
    {"name": "圣女果", "category": "vegetable", "aliases": ["小番茄"], "parent": "西红柿"},
    {"name": "土豆", "category": "vegetable", "aliases": []},
    {"name": "猪肉", "category": "meat", "aliases": []},
    {"name": "五花肉", "category": "meat", "aliases": [], "parent": "猪肉"},
    {"name": "牛奶", "category": "egg_dairy", "aliases": []},
    {"name": "淡奶油", "category": "egg_dairy", "aliases": []},
    {"name": "鸡蛋", "category": "egg_dairy", "aliases": [], "bulk_default": true},
    {"name": "食用油", "category": "staple", "aliases": [], "pantry_default": true, "bulk_default": true},
    {"name": "盐", "category": "seasoning", "aliases": [], "pantry_default": true, "bulk_default": true},
    {"name": "白糖", "category": "seasoning", "aliases": [], "pantry_default": true, "bulk_default": true},
    {"name": "酱油", "category": "seasoning", "aliases": [], "pantry_default": true, "bulk_default": true},
    {"name": "生抽", "category": "seasoning", "aliases": [], "parent": "酱油", "pantry_default": true, "bulk_default": true},
    {"name": "豆瓣酱", "category": "seasoning", "aliases": [], "bulk_default": true},
    {"name": "葱", "category": "vegetable", "aliases": [], "pantry_default": true},
    {"name": "小葱", "category": "vegetable", "aliases": [], "parent": "葱", "pantry_default": true}
  ]
}`);

const table = ShelfLifeTable.fromJson(`{
  "version": 1,
  "source": "USDA FoodKeeper",
  "foodkeeper_version": "v128",
  "items": {
    "猪肉": {
      "fridge_days": 3,
      "freezer_days": 120,
      "room_days": null,
      "source": "foodkeeper",
      "foodkeeper_id": 74,
      "basis": {"fridge": "DOP_Refrigerate_Min", "freezer": "DOP_Freeze_Min"}
    },
    "鸡蛋": {
      "fridge_days": 21,
      "freezer_days": null,
      "room_days": null,
      "source": "foodkeeper",
      "foodkeeper_id": 21,
      "basis": {"fridge": "DOP_Refrigerate_Min"}
    },
    "土豆": {
      "fridge_days": null,
      "freezer_days": null,
      "room_days": 30,
      "source": "foodkeeper",
      "foodkeeper_id": 297,
      "basis": {"room": "DOP_Pantry_Min"}
    },
    "西红柿": {
      "fridge_days": 7,
      "freezer_days": null,
      "room_days": 3,
      "source": "foodkeeper",
      "foodkeeper_id": 300,
      "basis": {"fridge": "manual", "room": "DOP_Pantry_Min"}
    },
    "圣女果": {
      "fridge_days": null,
      "freezer_days": null,
      "room_days": 2,
      "source": "foodkeeper",
      "foodkeeper_id": 301,
      "basis": {"room": "manual"}
    }
  }
}`);

function input(
  name: string,
  storage: Storage = Storage.Fridge,
): ShelfLifeInput {
  return {
    name,
    storage,
    entryDate: "2026-10-21",
  };
}

function context(
  rules = new RuleBook(),
  aiCache = new AiEstimateCache(),
): ShelfLifeContext {
  return { catalog, table, rules, aiCache };
}

describe("shelf-life resolution", () => {
  it("loads all shelf-life table layouts", () => {
    expect(table.size()).toBe(5);
    expect(table.sourceName()).toBe("USDA FoodKeeper");
    expect(table.row("猪肉", catalog)?.reference.foodkeeperId).toBe("74");
    expect(table.row("猪肉", catalog)?.reference.basis.fridge).toBe(
      "DOP_Refrigerate_Min",
    );

    const bare = ShelfLifeTable.fromJson(
      '{"version":1,"盐":{"room_days":1000,"basis":"manual"}}',
    );
    expect(bare.size()).toBe(1);

    const array = ShelfLifeTable.fromJson(
      '{"items":[{"name":"盐","room_days":1000}]}',
    );
    expect(array.lookup("盐", Storage.Room, catalog)?.days).toBe(1000);
    expect(() => ShelfLifeTable.fromJson("nope")).toThrow();
  });

  it("lets package expiry win and records unseen AI estimates", () => {
    const rules = new RuleBook();
    rules.setShelfLife({ name: "猪肉", storage: Storage.Fridge, days: 2 });
    const result = resolveShelfLife(
      {
        ...input("猪肉"),
        packageExpiry: "2026-10-30",
        aiDays: { fridge: 5 },
      },
      context(rules),
    );

    expect(result.source).toBe(ShelfLifeSource.Package);
    expect(result.expiryDate).toBe("2026-10-30");
    expect(result.days).toBe(9);
    expect(result.isEstimate).toBe(false);
    expect(result.newAiEstimates).toHaveLength(1);
  });

  it("starts from purchase date before entry date", () => {
    const item = input("牛奶");
    item.aiDays = { fridge: 3 };
    let result = resolveShelfLife(item, context());
    expect(result.startBasis).toBe(StartBasis.EntryDate);
    expect(result.expiryDate).toBe("2026-10-24");

    item.purchaseDate = "2026-10-19";
    result = resolveShelfLife(item, context());
    expect(result.startBasis).toBe(StartBasis.PurchaseDate);
    expect(result.expiryDate).toBe("2026-10-22");

    item.productionDate = "2026-10-18";
    result = resolveShelfLife(item, context());
    expect(result.startBasis).toBe(StartBasis.PurchaseDate);
    expect(result.expiryDate).toBe("2026-10-22");

    item.purchaseDate = null;
    result = resolveShelfLife(item, context());
    expect(result.startBasis).toBe(StartBasis.EntryDate);
    expect(result.expiryDate).toBe("2026-10-24");
  });

  it("resolves sources in the full precedence order", () => {
    const rules = new RuleBook();
    const item = input("猪肉");
    item.aiDays = { fridge: 5 };

    let result = resolveShelfLife(item, context(rules));
    expect(result.source).toBe(ShelfLifeSource.Reference);
    expect(result.days).toBe(3);
    expect(result.note).toContain("USDA FoodKeeper");

    rules.setShelfLife({ name: "猪肉", storage: Storage.Fridge, days: 4 });
    result = resolveShelfLife(item, context(rules));
    expect(result.source).toBe(ShelfLifeSource.LocalRule);
    expect(result.days).toBe(4);

    item.labelledDays = 10;
    result = resolveShelfLife(item, context(rules));
    expect(result.source).toBe(ShelfLifeSource.Package);
    expect(result.days).toBe(10);

    item.manualDays = 6;
    item.packageExpiry = "2026-12-01";
    result = resolveShelfLife(item, context(rules));
    expect(result.source).toBe(ShelfLifeSource.Manual);
    expect(result.expiryDate).toBe("2026-10-27");
  });

  it("falls back to the parent reference row", () => {
    const result = resolveShelfLife(
      input("五花肉", Storage.Freezer),
      context(),
    );

    expect(result.source).toBe(ShelfLifeSource.Reference);
    expect(result.days).toBe(120);
    expect(result.note).toContain("猪肉");
  });

  it("does not use an ancestor when the listed row has null", () => {
    const item = input("圣女果");
    item.aiDays = { fridge: 6 };
    let result = resolveShelfLife(item, context());
    expect(result.source).toBe(ShelfLifeSource.AiEstimate);
    expect(result.days).toBe(6);

    item.storage = Storage.Room;
    result = resolveShelfLife(item, context());
    expect(result.source).toBe(ShelfLifeSource.Reference);
    expect(result.days).toBe(2);
  });

  it("falls through when the reference lacks the selected storage", () => {
    const result = resolveShelfLife(
      {
        ...input("猪肉", Storage.Room),
        aiDays: { room: 1 },
      },
      context(),
    );

    expect(result.source).toBe(ShelfLifeSource.AiEstimate);
    expect(result.days).toBe(1);
  });

  it("uses no reference when the table is missing", () => {
    const empty = new ShelfLifeTable();
    const result = resolveShelfLife(
      {
        ...input("猪肉"),
        aiDays: { fridge: 5 },
      },
      { catalog, table: empty, rules: new RuleBook(), aiCache: new AiEstimateCache() },
    );

    expect(result.source).toBe(ShelfLifeSource.AiEstimate);
    expect(result.days).toBe(5);
  });

  it("caches AI estimates and reuses the first value", () => {
    const aiCache = new AiEstimateCache();
    const ctx = context(new RuleBook(), aiCache);
    const first = {
      ...input("牛奶"),
      aiDays: { fridge: 7, freezer: 30, room: null },
    };
    let result = resolveShelfLife(first, ctx);
    expect(result.source).toBe(ShelfLifeSource.AiEstimate);
    expect(result.days).toBe(7);
    expect(result.newAiEstimates).toHaveLength(2);
    for (const entry of result.newAiEstimates) {
      aiCache.insert(entry.name, entry.storage, entry.days);
    }

    const second = {
      ...input("牛奶"),
      aiDays: { fridge: 14, freezer: 60, room: 3 },
    };
    result = resolveShelfLife(second, ctx);
    expect(result.days).toBe(7);
    expect(result.newAiEstimates).toHaveLength(1);
    expect(result.newAiEstimates[0].storage).toBe(Storage.Room);

    second.storage = Storage.Freezer;
    expect(resolveShelfLife(second, ctx).days).toBe(30);
  });

  it("skips rules and cache for uncategorized items", () => {
    const rules = new RuleBook();
    rules.setShelfLife({
      name: "未归类",
      storage: Storage.Fridge,
      days: 99,
    });
    const result = resolveShelfLife(
      {
        ...input("未归类"),
        aiDays: { fridge: 4 },
      },
      context(rules),
    );

    expect(result.source).toBe(ShelfLifeSource.AiEstimate);
    expect(result.days).toBe(4);
    expect(result.newAiEstimates).toHaveLength(0);
  });

  it("returns no resolution when nothing is known", () => {
    const result = resolveShelfLife(input("淡奶油"), context());
    expect(result.source).toBe(ShelfLifeSource.None);
    expect(result.expiryDate).toBeNull();
    expect(result.days).toBeNull();
  });

  it("recomputes changed storage from stored AI estimates", () => {
    const item = {
      ...input("五花肉"),
      purchaseDate: "2026-10-21",
      referenceConditionsConfirmed: true,
      aiDays: { fridge: 2, freezer: 90, room: null },
    };
    let result = resolveShelfLife(item, context());
    expect(result.source).toBe(ShelfLifeSource.Reference);
    expect(result.expiryDate).toBe("2026-10-24");

    item.storage = Storage.Freezer;
    result = resolveShelfLife(item, context());
    expect(result.days).toBe(120);
    expect(result.expiryDate).toBe("2027-02-18");

    item.storage = Storage.Room;
    result = resolveShelfLife(item, context());
    expect(result.source).toBe(ShelfLifeSource.None);
  });

  it("starts estimates from purchase or entry date", () => {
    const rules = new RuleBook();
    const item: ShelfLifeInput = {
      ...input("猪肉"),
      productionDate: "2026-10-01",
      purchaseDate: "2026-10-20",
    };
    let result = resolveShelfLife(item, context(rules));
    expect(result.startBasis).toBe(StartBasis.PurchaseDate);
    expect(result.expiryDate).toBe("2026-10-23");

    item.purchaseDate = null;
    result = resolveShelfLife(item, context(rules));
    expect(result.startBasis).toBe(StartBasis.EntryDate);
    expect(result.expiryDate).toBe("2026-10-24");

    item.purchaseDate = "2026-10-20";
    rules.setShelfLife({ name: "猪肉", storage: Storage.Fridge, days: 4 });
    result = resolveShelfLife(item, context(rules));
    expect(result.source).toBe(ShelfLifeSource.LocalRule);
    expect(result.expiryDate).toBe("2026-10-24");

    item.manualDays = 6;
    result = resolveShelfLife(item, context(rules));
    expect(result.source).toBe(ShelfLifeSource.Manual);
    expect(result.expiryDate).toBe("2026-10-26");

    item.packageExpiry = "2026-11-01";
    result = resolveShelfLife(item, context(rules));
    expect(result.source).toBe(ShelfLifeSource.Manual);
    expect(result.expiryDate).toBe("2026-10-26");

    item.manualDays = null;
    result = resolveShelfLife(item, context(rules));
    expect(result.source).toBe(ShelfLifeSource.Package);
    expect(result.startBasis).toBe(StartBasis.ProductionDate);
    expect(result.expiryDate).toBe("2026-11-01");

    item.packageExpiry = null;
    item.labelledDays = 10;
    result = resolveShelfLife(item, context(rules));
    expect(result.source).toBe(ShelfLifeSource.Package);
    expect(result.startBasis).toBe(StartBasis.ProductionDate);
    expect(result.expiryDate).toBe("2026-10-11");
  });

  it("suggests the most specific available storage", () => {
    const ctx = context();
    expect(suggestStorage("土豆", Storage.Fridge, false, ctx)).toStrictEqual({
      storage: Storage.Room,
      source: StorageSource.Reference,
    });
    expect(suggestStorage("猪肉", Storage.Freezer, false, ctx)).toStrictEqual({
      storage: Storage.Freezer,
      source: StorageSource.Reference,
    });
    expect(suggestStorage("猪肉", null, false, ctx)).toStrictEqual({
      storage: Storage.Fridge,
      source: StorageSource.Reference,
    });
    expect(suggestStorage("牛奶", Storage.Fridge, false, ctx).source).toBe(
      StorageSource.AiEstimate,
    );
    expect(suggestStorage("豆瓣酱", null, true, ctx).storage).toBe(
      Storage.Room,
    );

    const rules = new RuleBook();
    rules.setStorage({ name: "猪肉", storage: Storage.Freezer });
    expect(
      suggestStorage("猪肉", Storage.Fridge, false, context(rules)),
    ).toStrictEqual({
      storage: Storage.Freezer,
      source: StorageSource.LocalRule,
    });
  });

  it("returns proposals without applying them", () => {
    const proposal = proposeShelfLifeRule("鸡蛋", Storage.Fridge, 30);
    expect(proposal).not.toBeNull();
    expect(proposal?.question).toBe("以后「鸡蛋」冷藏都按 30 天算吗？");

    const rules = new RuleBook();
    expect(rules.shelfLifeDays("鸡蛋", Storage.Fridge)).toBeNull();
    expect(proposeShelfLifeRule("未归类", Storage.Fridge, 3)).toBeNull();
    expect(proposeShelfLifeRule("鸡蛋", Storage.Fridge, 0)).toBeNull();
    expect(proposeStorageRule("鸡蛋", Storage.Room)).not.toBeNull();
  });

  it("keeps source keys and labels stable", () => {
    const labels = {
      [ShelfLifeSource.None]: sourceNone(),
      [ShelfLifeSource.Package]: sourcePackage(),
      [ShelfLifeSource.Manual]: "你填写的",
      [ShelfLifeSource.LocalRule]: sourceLocalRule(),
      [ShelfLifeSource.Reference]: sourceReference(),
      [ShelfLifeSource.AiEstimate]: sourceAiEstimate(),
    };

    for (const source of Object.values(ShelfLifeSource)) {
      expect(source.length).toBeGreaterThan(0);
      expect(labels[source].length).toBeGreaterThan(0);
    }
    expect(labels[ShelfLifeSource.Package]).toBe("包装标注");
    expect(labels[ShelfLifeSource.LocalRule]).toBe("你的设置");
    expect(labels[ShelfLifeSource.Reference]).toBe("参考表");
    expect(labels[ShelfLifeSource.AiEstimate]).toBe("AI 估计");
  });
});
