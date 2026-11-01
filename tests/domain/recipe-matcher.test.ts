import { describe, expect, it } from "vitest";

import { Catalog } from "../../server/domain/catalog.js";
import {
  RecipeMatcher,
  rankForBrowsing,
  rankForClearFridge,
  type Recipe,
  type RecipeIngredient,
  type RecipeMatch,
  type RequirementGroup,
  type StockEntry,
} from "../../server/domain/recipe.js";

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
  groups: RequirementGroup[],
  optional = false,
  kind = "ingredient",
): RecipeIngredient {
  return { raw, name: raw, optional, kind, groups };
}

function recipe(name: string, ingredients: RecipeIngredient[]): Recipe {
  return {
    id: `test/${name}`,
    name,
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

function item(
  name: string,
  itemId: number,
  selected = false,
  nearExpiry = false,
): StockEntry {
  return { name, itemId, selected, nearExpiry };
}

function pantry(name: string): StockEntry {
  return { name, itemId: 0, pantry: true };
}

function names(matches: readonly RecipeMatch[]): string[] {
  return matches.map((match) => match.recipe.name);
}

describe("recipe matching", () => {
  it("matches alternatives and requires every group", () => {
    const soup = recipe("奶油汤", [
      ingredient("牛奶或淡奶油", [["牛奶", "淡奶油"]]),
      ingredient("土豆", [["土豆"]]),
    ]);
    const matcher = new RecipeMatcher(catalog, [
      item("淡奶油", 1),
    ]);

    const match = matcher.match(soup);

    expect(match.haveCount).toBe(1);
    expect(match.missingCount).toBe(1);
    expect(match.groups[0]?.satisfiedBy[0]?.itemId).toBe(1);
    expect(match.missingGroups()).toEqual([["土豆"]]);
  });

  it("lets descendants satisfy ancestors but not the reverse", () => {
    const wantsPork = recipe("回锅肉", [
      ingredient("猪肉", [["猪肉"]]),
    ]);
    const wantsBelly = recipe("红烧肉", [
      ingredient("五花肉", [["五花肉"]]),
    ]);
    const withBelly = new RecipeMatcher(catalog, [item("五花肉", 1)]);

    expect(withBelly.match(wantsPork).missingCount).toBe(0);
    expect(withBelly.match(wantsBelly).missingCount).toBe(0);

    const withPork = new RecipeMatcher(catalog, [item("猪肉", 2)]);

    expect(withPork.match(wantsPork).missingCount).toBe(0);
    expect(withPork.match(wantsBelly).missingCount).toBe(1);
  });

  it("handles optional, pantry, and ignored ingredients", () => {
    const dish = recipe("西红柿炒鸡蛋", [
      ingredient("西红柿", [["西红柿"]]),
      ingredient("盐", [["盐"]]),
      ingredient("生抽", [["酱油"]]),
      ingredient("糖（可选）", [["白糖"]], true),
      ingredient("淡奶油（可选）", [["淡奶油"]], true),
      ingredient("冰块", []),
      ingredient("炒锅", [["土豆"]], false, "tool"),
    ]);
    const matcher = new RecipeMatcher(catalog, [
      item("圣女果", 1),
      pantry("盐"),
      pantry("生抽"),
    ]);

    const match = matcher.match(dish);

    expect(match.missingCount).toBe(0);
    expect(match.haveCount).toBe(3);
    expect(match.groups).toHaveLength(5);
    expect(match.inventoryUsed).toBe(1);
  });

  it("ranks recipes for clearing the fridge", () => {
    const recipes = [
      recipe("乙 用两样缺一", [
        ingredient("五花肉", [["五花肉"]]),
        ingredient("西红柿", [["西红柿"]]),
        ingredient("牛奶", [["牛奶"]]),
      ]),
      recipe("甲 用两样缺一", [
        ingredient("猪肉", [["猪肉"]]),
        ingredient("土豆", [["土豆"]]),
        ingredient("牛奶", [["牛奶"]]),
      ]),
      recipe("丙 用一样不缺", [
        ingredient("西红柿", [["西红柿"]]),
      ]),
      recipe("丁 用两样缺二", [
        ingredient("猪肉", [["猪肉"]]),
        ingredient("土豆", [["土豆"]]),
        ingredient("牛奶", [["牛奶"]]),
        ingredient("淡奶油", [["淡奶油"]]),
      ]),
      recipe("戊 不用所选", [
        ingredient("鸡蛋", [["鸡蛋"]]),
      ]),
      recipe("己 用两样缺一临期多", [
        ingredient("五花肉", [["五花肉"]]),
        ingredient("土豆", [["土豆"]]),
        ingredient("牛奶", [["牛奶"]]),
      ]),
    ];
    const matcher = new RecipeMatcher(catalog, [
      item("五花肉", 1, true, true),
      item("西红柿", 2, true),
      item("土豆", 3, true, true),
      item("鸡蛋", 4),
    ]);

    expect(names(rankForClearFridge(matcher.matchAll(recipes)))).toEqual([
      "己 用两样缺一临期多",
      "甲 用两样缺一",
      "乙 用两样缺一",
      "丁 用两样缺二",
      "丙 用一样不缺",
    ]);
  });

  it("sorts recipes for browsing", () => {
    const recipes = [
      recipe("B 缺一", [
        ingredient("牛奶", [["牛奶"]]),
      ]),
      recipe("A 不缺用一", [
        ingredient("土豆", [["土豆"]]),
      ]),
      recipe("C 不缺用二", [
        ingredient("土豆", [["土豆"]]),
        ingredient("鸡蛋", [["鸡蛋"]]),
      ]),
    ];
    const matcher = new RecipeMatcher(catalog, [
      item("土豆", 1),
      item("鸡蛋", 2),
    ]);

    expect(names(rankForBrowsing(matcher.matchAll(recipes)))).toEqual([
      "C 不缺用二",
      "A 不缺用一",
      "B 缺一",
    ]);
  });
});
