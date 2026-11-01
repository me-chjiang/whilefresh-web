import { describe, expect, it } from "vitest";

import {
  ShelfLifeSource,
  Storage,
} from "../../shared/enums.js";
import { loadBuiltin } from "../../server/data/builtin.js";
import { resolveShelfLife } from "../../server/domain/shelf-life.js";

const data = loadBuiltin();
const context = {
  catalog: data.catalog,
  table: data.shelfLife,
};

describe("built-in data", () => {
  it("loads the shipped recipe and vocabulary sizes", () => {
    expect(data.recipes).toHaveLength(372);
    expect(data.catalog.entries).toHaveLength(546);
    expect(data.shelfLife.isEmpty()).toBe(false);
    expect(data.shelfLife.sourceName()).toBe("USDA FoodKeeper");
    expect(data.vocabularyJson.length).toBeGreaterThan(0);
  });

  it("resolves known reference values in the shipped shelf-life data", () => {
    const base = {
      entryDate: "2026-10-21",
      storage: Storage.Fridge,
    };

    const chicken = resolveShelfLife(
      { ...base, name: "鸡胸肉" },
      context,
    );
    expect(chicken.source).toBe(ShelfLifeSource.Reference);
    expect(chicken.days).toBe(2);

    const spinach = resolveShelfLife(
      { ...base, name: "空心菜" },
      context,
    );
    expect(spinach.source).toBe(ShelfLifeSource.Reference);
    expect(spinach.days).toBe(4);

    const potato = resolveShelfLife(
      { ...base, name: "土豆" },
      context,
    );
    expect(potato.source).toBe(ShelfLifeSource.None);

    const estimatedPotato = resolveShelfLife(
      { ...base, name: "土豆", aiDays: { fridge: 14 } },
      context,
    );
    expect(estimatedPotato.source).toBe(ShelfLifeSource.AiEstimate);
    expect(estimatedPotato.days).toBe(14);

    const roomPotato = resolveShelfLife(
      { ...base, name: "土豆", storage: Storage.Room },
      context,
    );
    expect(roomPotato.source).toBe(ShelfLifeSource.Reference);
    expect(roomPotato.days).toBe(30);
  });

  it("falls back to a listed parent on real data", () => {
    expect(data.shelfLife.row("羊肉卷")).toBeNull();

    const row = data.shelfLife.row("羊肉卷", data.catalog);
    expect(row?.matchedName).toBe("羊肉");
    expect(row?.reference.days.fridge).toBe(3);
    expect(data.catalog.ancestors("羊肉卷")).toContain(row?.matchedName);

    const result = resolveShelfLife(
      {
        name: "羊肉卷",
        storage: Storage.Fridge,
        entryDate: "2026-10-21",
      },
      context,
    );
    expect(result.source).toBe(ShelfLifeSource.Reference);
    expect(result.days).toBe(3);
    expect(result.note).toContain("羊肉");
  });
});
