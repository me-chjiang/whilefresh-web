import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ItemStatus,
  ShelfLifeSource,
  Storage,
} from "../../shared/enums.js";
import { loadBuiltin, type BuiltinData } from "../../server/data/builtin.js";
import { openDatabase } from "../../server/data/db.js";
import { Store, type FridgeItem } from "../../server/data/store.js";
import { fixedClock, type Clock } from "../../server/domain/clock.js";
import { proposeShelfLifeRule } from "../../server/domain/shelf-life.js";
import { KitchenService } from "../../server/services/kitchen-service.js";

interface Harness {
  directory: string;
  database: DatabaseSync;
  builtin: BuiltinData;
  clock: Clock;
  store: Store;
  kitchen: KitchenService;
}

function manual(name: string): FridgeItem {
  return {
    canonicalName: name,
    displayName: name,
    rawName: name,
    quantityText: "1份",
    storage: Storage.Fridge,
  };
}

describe("kitchen service integration", () => {
  let harness: Harness;

  beforeEach(() => {
    const directory = mkdtempSync(join(tmpdir(), "whilefresh-kitchen-"));
    const importsDirectory = join(directory, "imports");
    mkdirSync(importsDirectory);
    const database = openDatabase(join(directory, "whilefresh.db"));
    const clock = fixedClock(new Date(2026, 9, 21, 12, 0));
    const builtin = loadBuiltin();
    const store = new Store(database, clock, importsDirectory);
    harness = {
      directory,
      database,
      builtin,
      clock,
      store,
      kitchen: new KitchenService({ store, builtin, clock }),
    };
  });

  afterEach(() => {
    harness.database.close();
    rmSync(harness.directory, { recursive: true, force: true });
  });

  function save(item: FridgeItem): number {
    expect(harness.kitchen.saveItem(item).ok).toBe(true);
    expect(item.id).toBeGreaterThan(0);
    return item.id!;
  }

  it("keeps bulk packages in stock and suggests buying when they run out", () => {
    const egg = manual("鸡蛋");
    const pork = manual("五花肉");
    const eggId = save(egg);
    const porkId = save(pork);

    expect(harness.kitchen.useItem(eggId)).toBe(true);
    expect(harness.store.item(eggId)?.status).toBe(ItemStatus.InStock);
    expect(harness.kitchen.useItem(porkId)).toBe(true);
    expect(harness.store.item(porkId)?.status).toBe(ItemStatus.Used);
    expect(harness.kitchen.markAbsent(eggId)).toBe(true);
    expect(harness.kitchen.fridge()).toHaveLength(0);
    expect(harness.kitchen.shopping()).toHaveLength(0);

    const suggestions = harness.kitchen.suggestions();
    expect(suggestions).toHaveLength(1);
    expect(harness.kitchen.decideSuggestion(suggestions[0]!.id!, true)).toBe(
      true,
    );
    expect(harness.kitchen.shopping()[0]?.names).toEqual(["鸡蛋"]);
    expect(harness.kitchen.shoppingText()).toContain("【蛋奶】");
  });

  it("stores an edited rule only after separate consent", () => {
    const egg = manual("鸡蛋");
    save(egg);
    egg.manualDays = 8;

    const edited = harness.kitchen.saveItem(egg);
    expect(edited.ok).toBe(true);
    expect(edited.proposals).toHaveLength(1);
    expect(harness.store.shelfLifeRules()).toHaveLength(0);

    expect(harness.kitchen.confirmRule(edited.proposals[0]!)).toBe(true);
    expect(harness.store.shelfLifeRules()).toEqual([
      { name: "鸡蛋", storage: Storage.Fridge, days: 8 },
    ]);

    const next = manual("鸡蛋");
    save(next);
    expect(next.shelfLifeSource).toBe(ShelfLifeSource.LocalRule);
    expect(next.shelfLifeDays).toBe(8);
  });

  it("rolls back a rule move when the old rule cannot be deleted", () => {
    const before = proposeShelfLifeRule("鸡蛋", Storage.Fridge, 7);
    const after = proposeShelfLifeRule("鸡蛋", Storage.Freezer, 30);
    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    expect(harness.kitchen.confirmRule(before!)).toBe(true);

    harness.database.exec(
      `CREATE TRIGGER refuse_rule_delete
       BEFORE DELETE ON shelf_life_rules
       BEGIN SELECT RAISE(FAIL, 'test failure'); END`,
    );
    expect(
      harness.kitchen.replaceRule(after!, Storage.Fridge),
    ).toBe(false);
    expect(harness.store.shelfLifeRules()).toEqual([
      { name: "鸡蛋", storage: Storage.Fridge, days: 7 },
    ]);

    harness.database.exec("DROP TRIGGER refuse_rule_delete");
    expect(
      harness.kitchen.replaceRule(after!, Storage.Fridge),
    ).toBe(true);
    expect(harness.store.shelfLifeRules()).toEqual([
      { name: "鸡蛋", storage: Storage.Freezer, days: 30 },
    ]);
  });

  it("uses the stored AI estimate when storage changes", () => {
    const potato = manual("土豆");
    potato.aiDays = { fridge: 14, freezer: 40, room: null };
    const id = save(potato);
    expect(harness.store.item(id)?.shelfLifeDays).toBe(14);

    const moved = harness.store.item(id)!;
    moved.storage = Storage.Freezer;
    expect(harness.kitchen.saveItem(moved).ok).toBe(true);

    const stored = harness.store.item(id)!;
    expect(stored.storage).toBe(Storage.Freezer);
    expect(stored.shelfLifeDays).toBe(40);
    expect(stored.shelfLifeSource).toBe(ShelfLifeSource.AiEstimate);
    expect(harness.store.storageRules()).toHaveLength(0);
  });

  it("separates clear-fridge selection from confirmation and ignores seasoning", () => {
    const tomato = manual("西红柿");
    const salt = manual("盐");
    const tomatoId = save(tomato);
    const saltId = save(salt);

    const preview = harness.kitchen.clearFridgePreview([
      tomatoId,
      saltId,
    ]);
    expect(preview.selectedCount).toBe(1);
    expect(preview.candidateCount).toBeGreaterThan(0);
    expect(preview.completeCount).toBeGreaterThan(0);
    expect(harness.kitchen.shopping()).toHaveLength(0);

    expect(harness.kitchen.clearFridge([])).toEqual([]);
    const recipes = harness.kitchen.clearFridge([tomatoId, saltId]);
    expect(recipes.length).toBeGreaterThan(0);
    for (const recipe of recipes) {
      expect(recipe.usedSelected).not.toContain("盐");
      expect(recipe.unusedSelected).not.toContain("盐");
    }

    const missing = recipes.find((recipe) => recipe.missingCount > 0);
    if (missing) {
      expect(
        harness.kitchen.addMissing(missing.recipe.id, [
          tomatoId,
          saltId,
        ]),
      ).toBeGreaterThan(0);
      expect(harness.kitchen.shopping().length).toBeGreaterThan(0);
    }
  });
});
