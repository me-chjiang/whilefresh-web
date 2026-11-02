import { describe, expect, it } from "vitest";

import { Catalog } from "../../server/domain/catalog.js";
import {
  MemoryNameMappingStore,
  NameSource,
  resolveName,
  unresolvedNames,
  type NameResolution,
} from "../../server/domain/vocabulary-resolver.js";

const smallCatalog = Catalog.fromJson(`{
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
    {"name": "梅花肉", "category": "meat", "aliases": []},
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

describe("vocabulary resolver", () => {
  it("uses the user mapping first", () => {
    const mappings = new MemoryNameMappingStore();
    expect(mappings.remember(" 农家  土猪肉 ", "五花肉")).toBe(true);

    expect(
      resolveName("农家 土猪肉", "猪肉", smallCatalog, mappings),
    ).toEqual({
      canonical: "五花肉",
      source: NameSource.UserMapping,
    });
  });

  it("ignores a mapping to a name no longer in the catalog", () => {
    const mappings = new MemoryNameMappingStore();
    mappings.remember("某商品", "已删除的词条");

    expect(resolveName("某商品", "", smallCatalog, mappings).source).toBe(
      NameSource.Unresolved,
    );
  });

  it("refines a suggestion only to a descendant or same-category child", () => {
    let resolution = resolveName("精选五花肉 500g", "猪肉", smallCatalog);
    expect(resolution.canonical).toBe("五花肉");
    expect(resolution.source).toBe(NameSource.Recognized);

    resolution = resolveName("土豆炖五花肉 料理包", "土豆", smallCatalog);
    expect(resolution.canonical).toBe("土豆");

    expect(
      resolveName("黑猪梅花肉切片", "猪肉", smallCatalog).canonical,
    ).toBe("梅花肉");

    resolution = resolveName("番茄", "番茄", smallCatalog);
    expect(resolution.canonical).toBe("西红柿");
  });

  it("falls back to a local match when the recognizer has no usable result", () => {
    let resolution = resolveName("有机小番茄 250g", "未归类", smallCatalog);
    expect(resolution.canonical).toBe("圣女果");
    expect(resolution.source).toBe(NameSource.LocalMatch);

    resolution = resolveName("洗衣液 2kg", "", smallCatalog);
    expect(resolution.canonical).toBe("");
    expect(resolution.source).toBe(NameSource.Unresolved);
  });

  it("collects each unresolved name once", () => {
    const raw = ["花胶", "土豆", " 花胶 ", "罗汉果"];
    const resolutions: NameResolution[] = [
      { canonical: "", source: NameSource.Unresolved },
      { canonical: "土豆", source: NameSource.LocalMatch },
      { canonical: "", source: NameSource.Unresolved },
      { canonical: "", source: NameSource.Unresolved },
    ];

    expect(unresolvedNames(raw, resolutions)).toEqual(["花胶", "罗汉果"]);
  });
});
