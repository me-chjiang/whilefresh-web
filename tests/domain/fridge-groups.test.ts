import { describe, expect, it } from "vitest";

import { ItemKind, Storage } from "../../shared/enums.js";
import { needsShelfLife } from "../../server/data/store.js";
import { Catalog } from "../../server/domain/catalog.js";
import {
  FridgeGroup,
  classifyItemKind,
  groupOf,
  sortForFridge,
  type FridgeItem,
} from "../../server/domain/fridge-groups.js";
import { ShelfLifeTable } from "../../server/domain/shelf-life.js";

const today = "2026-10-30";

const catalog = Catalog.fromJson(`{
  "categories": [
    {"code": "vegetable", "name": "蔬菜"},
    {"code": "staple", "name": "主食粮油"},
    {"code": "seasoning", "name": "调料"}
  ],
  "items": [
    {"name": "生抽", "category": "seasoning"},
    {"name": "食用油", "category": "staple", "pantry_default": true, "bulk_default": true},
    {"name": "土豆", "category": "vegetable"},
    {"name": "挂面", "category": "staple"},
    {"name": "鲜面条", "category": "staple"},
    {"name": "面包", "category": "staple"}
  ]
}`);

const table = ShelfLifeTable.fromJson(`{
  "items": {
    "面包": {"room_days": 7}
  }
}`);

function dateWithDaysLeft(daysLeft: number): string {
  const date = new Date(`${today}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + daysLeft);
  return date.toISOString().slice(0, 10);
}

function item(
  id: number,
  name: string,
  daysLeft: number | null,
  storage: Storage = Storage.Fridge,
  kind: ItemKind = ItemKind.Food,
): FridgeItem {
  return {
    id,
    canonicalName: name,
    displayName: name,
    storage,
    kind,
    shelfLifeDays: daysLeft === null ? null : 10,
    expiryDate: daysLeft === null ? null : dateWithDaysLeft(daysLeft),
  };
}

function names(items: readonly FridgeItem[]): string[] {
  return items.map((entry) => entry.displayName);
}

const kindRules: readonly [
  string,
  string,
  boolean,
  Storage,
  ItemKind,
][] = [
  ["vocabulary seasoning", "生抽", false, Storage.Room, ItemKind.StapleSeasoning],
  ["recognized seasoning, unknown name", "某品牌酱", true, Storage.Fridge, ItemKind.StapleSeasoning],
  ["pantry staple anywhere", "食用油", false, Storage.Fridge, ItemKind.StapleFood],
  ["dry noodles at room temperature", "挂面", false, Storage.Room, ItemKind.StapleFood],
  ["staple kept cold", "鲜面条", false, Storage.Fridge, ItemKind.Food],
  ["short room life", "面包", false, Storage.Room, ItemKind.Food],
  ["ordinary food", "土豆", false, Storage.Room, ItemKind.Food],
  ["unknown food", "未归类", false, Storage.Room, ItemKind.Food],
];

describe("fridge groups", () => {
  it("sorts expired first, then days left, then unknown", () => {
    const items = [
      item(1, "牛奶", 5),
      item(2, "豆腐", null),
      item(3, "鸡蛋", 2),
      item(4, "酸奶", -3),
      item(5, "菠菜", 0),
      item(6, "白菜", 2),
      item(7, "芹菜", null),
    ];

    expect(names(sortForFridge(items, today))).toEqual([
      "酸奶",
      "菠菜",
      "白菜",
      "鸡蛋",
      "牛奶",
      "芹菜",
      "豆腐",
    ]);
  });

  it("keeps groups in their fixed order", () => {
    const items = [
      item(1, "挂面", null, Storage.Room, ItemKind.StapleFood),
      item(2, "生抽", 100, Storage.Room, ItemKind.StapleSeasoning),
      item(3, "土豆", 20, Storage.Room),
      item(4, "虾仁", 60, Storage.Freezer),
      item(5, "牛奶", 1, Storage.Fridge),
      item(6, "豆瓣酱", -1, Storage.Fridge, ItemKind.StapleSeasoning),
    ];

    const sorted = sortForFridge(items, today);
    expect(names(sorted)).toEqual([
      "牛奶",
      "虾仁",
      "土豆",
      "豆瓣酱",
      "生抽",
      "挂面",
    ]);
    expect(sorted.map(groupOf)).toEqual([
      FridgeGroup.Fridge,
      FridgeGroup.Freezer,
      FridgeGroup.Room,
      FridgeGroup.StapleSeasoning,
      FridgeGroup.StapleSeasoning,
      FridgeGroup.StapleFood,
    ]);
  });

  it("uses id to order otherwise equal keys", () => {
    const items = [
      item(9, "鸡蛋", 3),
      item(4, "鸡蛋", 3),
    ];

    expect(sortForFridge(items, today).map((entry) => entry.id)).toEqual([
      4,
      9,
    ]);
  });

  it.each(kindRules)(
    "classifies %s",
    (_label, name, recognizedAsSeasoning, storage, expected) => {
      expect(
        classifyItemKind(
          name,
          recognizedAsSeasoning,
          storage,
          catalog,
          table,
        ),
      ).toBe(expected);
    },
  );

  it("asks for shelf life on a staple without an expiry", () => {
    const staple = item(
      1,
      "挂面",
      null,
      Storage.Room,
      ItemKind.StapleFood,
    );
    expect(needsShelfLife(staple)).toBe(true);

    staple.expiryDate = dateWithDaysLeft(300);
    expect(needsShelfLife(staple)).toBe(false);
    expect(needsShelfLife(item(2, "豆腐", null))).toBe(false);
  });
});
