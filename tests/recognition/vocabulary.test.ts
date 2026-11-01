import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { Catalog } from "../../server/domain/catalog.js";

function groupedNames(catalog: Catalog): Array<{
  code: string;
  label: string;
  names: string[];
}> {
  const groups: Array<{ code: string; names: string[] }> = [];
  const groupFor = (code: string): string[] => {
    let group = groups.find((item) => item.code === code);
    if (!group) {
      group = { code, names: [] };
      groups.push(group);
    }
    return group.names;
  };

  for (const category of catalog.categories) {
    groupFor(category.code);
  }
  for (const entry of catalog.entries) {
    groupFor(entry.category).push(entry.name);
  }

  return groups
    .filter((group) => group.names.length > 0)
    .map((group) => {
      const category = catalog.categories.find(
        (item) => item.code === group.code,
      );
      return {
        code: group.code,
        label: category?.name ?? group.code,
        names: group.names,
      };
    });
}

function groupLabels(catalog: Catalog): string[] {
  return groupedNames(catalog).map((group) => group.label);
}

const syntheticVocabulary = Catalog.fromJson(
  readFileSync(
    new URL(
      "../../test-data/vocabulary/synthetic-vocabulary.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

describe("vocabulary", () => {
  it("keeps category file order and exposes Chinese display names", () => {
    const vocabulary = Catalog.fromJson(
      '{"version":1,"note":"\\"categories\\": {x:1}",' +
        '"categories":{"meat":"肉类","vegetable":"蔬菜","aaa":"甲类"},' +
        '"items":[{"name":"白菜","category":"vegetable"},' +
        '{"name":"五花肉","category":"meat","aliases":["猪五花"],' +
        '"parent":null,"pantry_default":false,"bulk_default":true},' +
        '{"name":"神秘物","category":"aaa"}]}',
    );

    expect(groupLabels(vocabulary)).toEqual(["肉类", "蔬菜", "甲类"]);
    expect(vocabulary.categories).toHaveLength(3);
    expect(vocabulary.categories[0].code).toBe("meat");
    expect(vocabulary.entries[1].category).toBe("meat");
    expect(
      vocabulary.categories.find((category) => category.code === "vegetable")
        ?.name,
    ).toBe("蔬菜");
    expect(vocabulary.resolve("猪五花")).toBe("五花肉");
  });

  it("follows undeclared categories after declared ones", () => {
    const vocabulary = Catalog.fromJson(
      JSON.stringify({
        categories: { meat: "肉类", vegetable: "蔬菜" },
        items: [
          { name: "x", category: "mystery" },
          { name: "白菜", category: "vegetable" },
          { name: "y", category: "" },
          { name: "z", category: "mystery" },
        ],
      }),
    );

    expect(groupLabels(vocabulary)).toEqual(["蔬菜", "mystery", ""]);
  });

  it("uses the category itself as its display name without declarations", () => {
    const vocabulary = Catalog.fromJson(
      JSON.stringify({
        items: [
          { name: "鸡蛋", category: "蛋奶" },
          { name: "白菜", category: "蔬菜" },
        ],
      }),
    );

    expect(vocabulary.categories).toEqual([]);
    expect(groupLabels(vocabulary)).toEqual(["蛋奶", "蔬菜"]);
  });

  it("loads the official synthetic fixture format", () => {
    expect(syntheticVocabulary.categories).toHaveLength(10);
    expect(syntheticVocabulary.categories[0].code).toBe("vegetable");
    expect(syntheticVocabulary.categories.at(-1)?.code).toBe("other");
    expect(groupLabels(syntheticVocabulary)[0]).toBe("蔬菜");
  });

  it("prefers a standard name over an alias regardless of file order", () => {
    const vocabulary = Catalog.fromJson(
      JSON.stringify({
        items: [
          { name: "小白菜", category: "v", aliases: ["菜心", "青菜"] },
          { name: "菜心", category: "v" },
        ],
      }),
    );

    expect(vocabulary.resolve("菜心")).toBe("菜心");
    expect(vocabulary.resolve("青菜")).toBe("小白菜");
  });

  it("gives an alias claimed twice to the first entry", () => {
    const vocabulary = Catalog.fromJson(
      JSON.stringify({
        items: [
          { name: "西红柿", category: "v", aliases: ["番茄"] },
          {
            name: "圣女果",
            category: "v",
            aliases: ["番茄", "小番茄"],
          },
        ],
      }),
    );

    expect(vocabulary.resolve("番茄")).toBe("西红柿");
    expect(vocabulary.resolve("小番茄")).toBe("圣女果");
  });

  it("skips repeated and empty standard names", () => {
    const vocabulary = Catalog.fromJson(
      JSON.stringify({
        items: [
          { name: "鸡蛋", category: "v" },
          { name: "鸡蛋", category: "w" },
          { name: " ", category: "v" },
        ],
      }),
    );

    expect(vocabulary.entries).toHaveLength(1);
  });

  it("loads clean aliases silently", () => {
    const vocabulary = Catalog.fromJson(
      JSON.stringify({
        items: [
          {
            name: "鸡蛋",
            category: "v",
            aliases: ["鸡蛋", "土鸡蛋", "土鸡蛋"],
          },
        ],
      }),
    );

    expect(vocabulary.resolve("鸡蛋")).toBe("鸡蛋");
    expect(vocabulary.resolve("土鸡蛋")).toBe("鸡蛋");
  });

  it("still loads the legacy format", () => {
    const vocabulary = Catalog.fromJson(
      JSON.stringify({
        items: [
          {
            name: "鸡蛋",
            category: "蛋奶",
            aliases: ["土鸡蛋"],
            staple: false,
          },
          { name: "牛奶", category: "蛋奶" },
        ],
      }),
    );

    expect(groupedNames(vocabulary)).toHaveLength(1);
    expect(groupLabels(vocabulary)[0]).toBe("蛋奶");
    expect(vocabulary.resolve("土鸡蛋")).toBe("鸡蛋");
  });
});
