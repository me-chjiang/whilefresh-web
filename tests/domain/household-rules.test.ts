import { describe, expect, it } from "vitest";

import {
  ItemStatus,
  ShoppingOrigin,
  SuggestionKind,
} from "../../shared/enums.js";
import { Catalog } from "../../server/domain/catalog.js";
import {
  DuplicateCheck,
  checkSameImage,
  checkSimilarItems,
  type ImportFingerprint,
  type ImportItem,
} from "../../server/domain/import-duplicates.js";
import {
  PantryRules,
  statusAfterUse,
  suggestionsAfterAbsent,
  suggestionsAfterPurchase,
} from "../../server/domain/pantry.js";
import {
  RecipeMatcher,
  type Recipe,
  type RecipeIngredient,
} from "../../server/domain/recipe.js";
import {
  dedupeKey,
  displayName,
  entriesForMissing,
  makeShoppingEntry,
  sections,
  toText,
} from "../../server/domain/shopping-list.js";

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

function ingredient(
  raw: string,
  name: string,
  groups: string[][],
  optional = false,
): RecipeIngredient {
  return {
    raw,
    name,
    optional,
    kind: "ingredient",
    groups,
  };
}

function recipe(ingredients: RecipeIngredient[]): Recipe {
  return {
    id: "t/汤",
    name: "奶油土豆汤",
    category: "",
    categoryZh: "",
    difficulty: null,
    caloriesKcal: null,
    timeMinutes: null,
    summary: "",
    ingredients,
    ingredientNotes: [],
    quantities: [],
    quantityNotes: [],
    steps: [],
    notes: "",
    sourceUrl: "",
  };
}

function daysFrom(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

describe("household rules", () => {
  it("uses pantry defaults unless an explicit override wins", () => {
    const rules = new PantryRules(catalog);

    expect(rules.isPantry("盐")).toBe(true);
    expect(rules.isAtHome("盐")).toBe(true);
    expect(rules.isPantry("豆瓣酱")).toBe(false);
    expect(rules.isBulk("鸡蛋")).toBe(true);
    expect(rules.isBulk("猪肉")).toBe(false);

    rules.setOverride({ name: "盐", out: true });
    expect(rules.isPantry("盐")).toBe(true);
    expect(rules.isAtHome("盐")).toBe(false);
    expect(rules.namesAtHome()).not.toContain("盐");

    rules.setOverride({ name: "豆瓣酱", pantry: true });
    rules.setOverride({ name: "白糖", pantry: false });
    rules.setOverride({ name: "鸡蛋", bulk: false });
    rules.setOverride({ name: "自制辣酱", pantry: true });

    expect(rules.pantryNames()).toContain("豆瓣酱");
    expect(rules.pantryNames()).not.toContain("白糖");
    expect(rules.pantryNames().at(-1)).toBe("自制辣酱");
    expect(rules.isBulk("鸡蛋")).toBe(false);
  });

  it("keeps bulk packages in stock after use", () => {
    expect(statusAfterUse(true)).toBe(ItemStatus.InStock);
    expect(statusAfterUse(false)).toBe(ItemStatus.Used);
  });

  it("returns suggestions without changing household state", () => {
    const rules = new PantryRules(catalog);

    expect(suggestionsAfterPurchase("生抽", rules)).toBeNull();

    rules.setOverride({ name: "生抽", out: true });
    const have = suggestionsAfterPurchase("生抽", rules);
    expect(have).toMatchObject({
      kind: SuggestionKind.MarkPantryHave,
      name: "生抽",
    });
    expect(have?.message).not.toBe("");
    expect(rules.isOut("生抽")).toBe(true);

    expect(suggestionsAfterPurchase("豆瓣酱", rules)?.kind).toBe(
      SuggestionKind.AddToPantry,
    );
    expect(suggestionsAfterAbsent("盐", rules)?.kind).toBe(
      SuggestionKind.AddToShopping,
    );
    expect(suggestionsAfterAbsent("鸡蛋", rules)?.kind).toBe(
      SuggestionKind.AddToShopping,
    );
    expect(suggestionsAfterAbsent("猪肉", rules)).toBeNull();
    expect(suggestionsAfterPurchase("未归类", rules)).toBeNull();
  });

  it("turns missing recipe groups into categorized shopping entries", () => {
    const soup = recipe([
      ingredient("牛奶或淡奶油", "牛奶或淡奶油", [["牛奶", "淡奶油"]]),
      ingredient("土豆", "土豆", [["土豆"]]),
      ingredient("盐", "盐", [["盐"]]),
      ingredient("五花肉", "五花肉", [["五花肉"]], true),
    ]);
    const matcher = new RecipeMatcher(catalog, [
      { name: "盐", itemId: 0, pantry: true },
    ]);

    const entries = entriesForMissing(
      soup,
      matcher.match(soup),
      catalog,
    );

    expect(entries).toHaveLength(2);
    expect(displayName(entries[0]!)).toBe("牛奶 或 淡奶油");
    expect(entries[0]?.category).toBe("egg_dairy");
    expect(entries[0]?.note).toBe("奶油土豆汤");
    expect(entries[1]?.category).toBe("vegetable");
  });

  it("groups shopping entries and exports stable text", () => {
    const entries = [
      makeShoppingEntry(["生抽"], ShoppingOrigin.Pantry, "", catalog),
      makeShoppingEntry(
        ["牛奶", "淡奶油"],
        ShoppingOrigin.Recipe,
        "",
        catalog,
      ),
      makeShoppingEntry(["土豆"], ShoppingOrigin.Recipe, "", catalog),
      makeShoppingEntry(["西红柿"], ShoppingOrigin.Recipe, "", catalog),
      makeShoppingEntry(["不认识的"], ShoppingOrigin.Manual, "", catalog),
    ];

    const grouped = sections(entries, catalog);
    expect(grouped).toHaveLength(4);
    expect(grouped[0]?.title).toBe("蔬菜");
    expect(grouped[0]?.entries).toHaveLength(2);
    expect(grouped.at(-1)?.title).toBe("其他");
    expect(toText(entries, catalog)).toBe(
      "待买清单\n\n" +
        "【蔬菜】\n- 土豆\n- 西红柿\n\n" +
        "【蛋奶】\n- 牛奶 或 淡奶油\n\n" +
        "【调料】\n- 生抽\n\n" +
        "【其他】\n- 不认识的\n",
    );
    expect(dedupeKey(entries[1]!)).toBe(
      dedupeKey(
        makeShoppingEntry(
          ["淡奶油", "牛奶"],
          ShoppingOrigin.Manual,
          "",
          catalog,
        ),
      ),
    );
  });

  it("detects an image that was imported before", () => {
    const previous: ImportFingerprint[] = [
      {
        importId: 7,
        createdAt: new Date(2026, 9, 1, 8, 0),
        imageSha256: ["abc"],
        items: [],
      },
    ];

    const same = checkSameImage(["zzz", "abc"], previous);
    expect(same.kind).toBe(DuplicateCheck.Kind.SameImage);
    expect(same.importId).toBe(7);
    expect(same.message()).not.toBe("");
    expect(checkSameImage(["zzz"], previous).isDuplicate()).toBe(false);
  });

  it("detects an 80% item overlap only within the last three days", () => {
    const now = new Date(2026, 9, 21, 12, 0);
    const earlierItems: ImportItem[] = [
      ["鸡蛋", "10枚"],
      ["牛奶", "950ml"],
      ["土豆", "500g"],
      ["西红柿", "500g"],
      ["五花肉", "300g"],
    ];
    const previous: ImportFingerprint[] = [
      {
        importId: 3,
        createdAt: daysFrom(now, -1),
        imageSha256: [],
        items: earlierItems,
      },
      {
        importId: 2,
        createdAt: daysFrom(now, -10),
        imageSha256: [],
        items: earlierItems,
      },
    ];

    const current = [...earlierItems];
    current[4] = ["五花肉", "500g"];
    const similar = checkSimilarItems(current, now, previous);
    expect(similar.kind).toBe(DuplicateCheck.Kind.SimilarItems);
    expect(similar.importId).toBe(3);
    expect(similar.overlap).toBe(0.8);

    current[3] = ["西红柿", "1kg"];
    expect(checkSimilarItems(current, now, previous).isDuplicate()).toBe(false);
    expect(
      checkSimilarItems(earlierItems, now, [previous[1]!]).isDuplicate(),
    ).toBe(false);
    expect(
      checkSimilarItems(
        [["鸡蛋", "10枚"]],
        now,
        [
          {
            importId: 9,
            createdAt: now,
            imageSha256: [],
            items: [["鸡蛋", "10枚"]],
          },
        ],
      ).isDuplicate(),
    ).toBe(false);
  });
});
