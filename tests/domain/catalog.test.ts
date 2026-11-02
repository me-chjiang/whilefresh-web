import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { Catalog } from "../../server/domain/catalog.js";

interface ResolveCase {
  raw: string;
  expected: string;
}

const realCatalog = Catalog.fromJson(
  readFileSync(
    new URL("../../assets/data/vocabulary.json", import.meta.url),
    "utf8",
  ),
);

const resolveCases = JSON.parse(
  readFileSync(
    new URL(
      "../../test-data/vocabulary/resolve-cases.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as ResolveCase[];

describe("catalog", () => {
  it("prefers standard names to aliases regardless of file order", () => {
    const catalog = Catalog.fromJson(`{"items":[
      {"name":"小白菜","category":"vegetable","aliases":["青菜","菜心"]},
      {"name":"菜心","category":"vegetable"},
      {"name":"西红柿","category":"vegetable","aliases":["番茄"]},
      {"name":"圣女果","category":"vegetable","aliases":["番茄","小番茄"]}
    ]}`);

    expect(catalog.resolve("菜心")).toBe("菜心");
    expect(catalog.resolve(" 青菜 ")).toBe("小白菜");
    expect(catalog.resolve("番茄")).toBe("西红柿");
    expect(catalog.resolveFinest("新鲜菜心")).toBe("菜心");
    expect(catalog.resolveFinest("有机番茄")).toBe("西红柿");
  });

  it("resolves the finest matching entry", () => {
    const catalog = Catalog.fromJson(`{
      "categories": [{"code":"meat","name":"肉类"}, {"code":"staple","name":"主食粮油"}],
      "items": [
        {"name":"猪肉", "category":"meat"},
        {"name":"梅花肉", "category":"meat"},
        {"name":"五花肉", "category":"meat", "aliases":["五花三层"], "parent":"猪肉"},
        {"name":"莲藕", "category":"vegetable", "aliases":["藕"]},
        {"name":"饼", "category":"staple"},
        {"name":"鸡蛋", "category":"egg_dairy"}
      ]
    }`);

    expect(catalog.resolveFinest("梅花肉")).toBe("梅花肉");
    expect(catalog.resolveFinest("黑猪梅花肉切片")).toBe("梅花肉");
    expect(catalog.resolveFinest("黑猪梅花肉切片300g")).toBe("梅花肉");
    expect(catalog.resolveFinest("土猪肉 500g")).toBe("猪肉");
    expect(catalog.resolveFinest("猪肉五花三层")).toBe("五花肉");
    expect(catalog.resolveFinest("藕粉 500g")).toBe("");
    expect(catalog.resolveFinest("湖北 藕")).toBe("莲藕");
    expect(catalog.resolveFinest("鸡蛋饼")).toBe("饼");
    expect(catalog.resolveFinest("完全未知")).toBe("");
    expect(catalog.resolveFinest("  ")).toBe("");
  });

  it("groups hierarchy families under their categories", () => {
    const catalog = Catalog.fromJson(`{
      "categories": [{"code":"vegetable","name":"蔬菜"}, {"code":"meat","name":"肉类"},
                     {"code":"seasoning","name":"调料"}, {"code":"other","name":"其他"}],
      "items": [
        {"name":"猪肉", "category":"meat"},
        {"name":"五花肉", "category":"meat", "parent":"猪肉"},
        {"name":"梅花肉", "category":"meat"},
        {"name":"里脊", "category":"meat", "parent":"猪肉"},
        {"name":"土豆", "category":"vegetable"},
        {"name":"料酒", "category":"seasoning"},
        {"name":"花雕酒", "category":"other", "parent":"料酒"},
        {"name":"孤儿", "category":"other", "parent":"不存在"}
      ]
    }`);

    expect(catalog.hierarchyText()).toBe(
      "【蔬菜】\n土豆\n【肉类】\n猪肉 > 五花肉、里脊\n梅花肉\n【调料】\n料酒 > 花雕酒\n【其他】\n孤儿",
    );
  });

  it("lists every real vocabulary entry exactly once", () => {
    const text = realCatalog.hierarchyText();
    expect(text).toContain("\n猪肉 > 五花肉、前腿肉、里脊\n");
    expect(text).toContain("\n酱油 > 生抽、老抽、蒸鱼豉油\n");

    const flat = text
      .replace(/【[^】]*】/gu, "\n")
      .replaceAll(" > ", "、");
    const listed = flat.split(/[\n、]+/u).filter((name) => name.length > 0);

    expect(listed).toHaveLength(realCatalog.entries.length);
    expect(new Set(listed).size).toBe(realCatalog.entries.length);
  });

  it("contains all 55 reviewed resolve cases", () => {
    expect(resolveCases).toHaveLength(55);
  });

  it.each(resolveCases)("resolves $raw", ({ raw, expected }) => {
    if (expected.length > 0) {
      expect(realCatalog.entries.some((entry) => entry.name === expected)).toBe(
        true,
      );
    }
    expect(realCatalog.resolveFinest(raw)).toBe(expected);
  });
});
