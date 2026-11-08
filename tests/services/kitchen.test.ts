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
  ItemKind,
  ItemStatus,
  ShelfLifeSource,
  Storage,
} from "../../shared/enums.js";
import { loadBuiltin, type BuiltinData } from "../../server/data/builtin.js";
import { openDatabase } from "../../server/data/db.js";
import { Store, type FridgeItem } from "../../server/data/store.js";
import { addDays, type Clock } from "../../server/domain/clock.js";
import { proposeShelfLifeRule } from "../../server/domain/shelf-life.js";
import { KitchenService } from "../../server/services/kitchen-service.js";

interface Harness {
  directory: string;
  importsDirectory: string;
  database: DatabaseSync;
  builtin: BuiltinData;
  clock: Clock;
  store: Store;
  kitchen: KitchenService;
  advanceDays: (days: number) => void;
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
    let today = "2026-10-21";
    const clock: Clock = {
      now: () => new Date(`${today}T12:00:00`),
      today: () => today,
    };
    const builtin = loadBuiltin();
    const store = new Store(database, clock, importsDirectory);
    harness = {
      directory,
      importsDirectory,
      database,
      builtin,
      clock,
      store,
      kitchen: new KitchenService({ store, builtin, clock }),
      advanceDays: (days) => {
        today = addDays(today, days);
      },
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

  function imported(name: string): FridgeItem {
    return {
      ...manual(name),
      entryDate: harness.clock.today(),
    };
  }

  function createImport(
    items: FridgeItem[],
    withImage = false,
  ): number {
    const imagePath = join(
      harness.importsDirectory,
      `synthetic-${items.length}-${Date.now()}.jpg`,
    );
    if (withImage) {
      writeFileSync(imagePath, "synthetic image");
    }
    const importId = harness.store.insertImport({
      inputKind: "screenshot",
      images: withImage
        ? [{ path: imagePath, sha256: "synthetic-sha256" }]
        : [],
    });
    expect(importId).toBeGreaterThan(0);
    for (const item of items) {
      item.importId = importId;
      expect(harness.store.insertItem(item)).toBeGreaterThan(0);
    }
    return importId;
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

  it("sorts the fridge by group and remaining shelf life", () => {
    const pork = manual("五花肉");
    pork.manualDays = 2;
    save(pork);
    const milk = manual("牛奶");
    milk.manualDays = 8;
    save(milk);
    const egg = manual("鸡蛋");
    egg.storage = Storage.Freezer;
    egg.manualDays = 10;
    save(egg);
    const potato = manual("土豆");
    potato.storage = Storage.Room;
    potato.manualDays = 20;
    save(potato);
    const salt = manual("盐");
    salt.storage = Storage.Room;
    salt.manualDays = 100;
    save(salt);
    const noodles = manual("挂面");
    noodles.storage = Storage.Room;
    noodles.manualDays = 100;
    save(noodles);

    expect(harness.kitchen.fridge().map((item) => item.displayName)).toEqual([
      "五花肉",
      "牛奶",
      "鸡蛋",
      "土豆",
      "盐",
      "挂面",
    ]);
  });

  it("recalculates kind after changing storage", () => {
    const noodles = manual("挂面");
    noodles.storage = Storage.Room;
    const id = save(noodles);
    expect(harness.store.item(id)?.kind).toBe(ItemKind.StapleFood);

    expect(harness.kitchen.changeStorage(id, Storage.Fridge)).toBe(true);
    expect(harness.store.item(id)?.kind).toBe(ItemKind.Food);

    expect(harness.kitchen.changeStorage(id, Storage.Room)).toBe(true);
    expect(harness.store.item(id)?.kind).toBe(ItemKind.StapleFood);
  });

  it("discards and snoozes only current fridge items", () => {
    const milk = manual("牛奶");
    milk.manualDays = 8;
    const milkId = save(milk);
    const pork = manual("五花肉");
    pork.manualDays = 2;
    const porkId = save(pork);
    harness.advanceDays(6);

    expect(harness.kitchen.attention()).toHaveLength(2);
    expect(harness.kitchen.snoozeItem(porkId)).toBe(false);
    expect(harness.kitchen.snoozeItem(milkId)).toBe(true);
    expect(harness.kitchen.attention().map((item) => item.id)).toEqual([
      porkId,
    ]);
    expect(harness.kitchen.fridge()).toHaveLength(2);

    harness.advanceDays(1);
    expect(harness.kitchen.attention()).toHaveLength(2);

    expect(harness.kitchen.discardItem(porkId)).toBe(true);
    expect(harness.store.item(porkId)?.status).toBe(ItemStatus.Discarded);
    expect(harness.kitchen.fridge()).toHaveLength(1);
    expect(harness.kitchen.discardItem(porkId)).toBe(false);
  });

  it("excludes snoozed items from attention", () => {
    const milk = manual("牛奶");
    milk.manualDays = 8;
    const milkId = save(milk);
    const pork = manual("五花肉");
    pork.manualDays = 2;
    const porkId = save(pork);
    harness.advanceDays(6);

    expect(harness.kitchen.snoozeItem(milkId)).toBe(true);

    expect(harness.kitchen.attention().map((item) => item.id)).toEqual([
      porkId,
    ]);
    expect(harness.kitchen.fridge().map((item) => item.id)).toContain(milkId);
  });

  it("only snoozes items near expiry", () => {
    const potato = manual("土豆");
    potato.manualDays = 20;
    const potatoId = save(potato);
    expect(harness.kitchen.snoozeItem(potatoId)).toBe(false);

    const milk = manual("牛奶");
    milk.manualDays = 8;
    const milkId = save(milk);
    const pork = manual("五花肉");
    pork.manualDays = 2;
    const porkId = save(pork);
    harness.advanceDays(6);

    expect(harness.kitchen.snoozeItem(porkId)).toBe(false);
    expect(harness.kitchen.snoozeItem(milkId)).toBe(true);
  });

  it("gives manually entered items an amount and unit", () => {
    const potato = manual("土豆");
    potato.quantityText = "1.5kg";
    const id = save(potato);
    expect(harness.store.item(id)?.amount).toBe(1500);

    potato.quantityText = "3个";
    expect(harness.kitchen.saveItem(potato).ok).toBe(true);
    expect(harness.store.item(id)?.amount).toBe(3);
    expect(harness.store.item(id)?.unit).toBe("个");
  });

  it("deleting an import keeps what was eaten", () => {
    const importId = createImport([
      imported("鸡蛋"),
      imported("牛奶"),
      imported("土豆"),
    ]);
    const manualEgg = manual("鸡蛋");
    const manualEggId = save(manualEgg);
    const importedItems = harness.store.itemsForImport(importId);
    expect(importedItems).toHaveLength(3);

    const used = importedItems[0]!;
    used.status = ItemStatus.Used;
    expect(harness.store.updateItem(used)).toBe(true);
    expect(harness.kitchen.discardItem(importedItems[1]!.id!)).toBe(true);

    expect(harness.kitchen.deleteImport(importId)).toBe(true);
    expect(harness.kitchen.imports()).toHaveLength(0);
    expect(harness.kitchen.fridge().map((item) => item.id)).toEqual([
      manualEggId,
    ]);
    const kept = harness.store.itemsForImport(importId);
    expect(kept).toHaveLength(2);
    expect(kept.every((item) => item.status !== ItemStatus.InStock)).toBe(
      true,
    );
  });

  it("clearing history keeps the fridge", () => {
    const importId = createImport(
      [imported("鸡蛋"), imported("牛奶"), imported("土豆")],
      true,
    );
    const imagePath = harness.store.importRecord(importId)?.images?.[0]?.path;
    expect(imagePath).toBeDefined();
    expect(existsSync(imagePath!)).toBe(true);
    const before = harness.kitchen.fridge().map((item) => item.id);
    expect(before.length).toBeGreaterThan(0);

    expect(harness.kitchen.clearImportHistory()).toBe(true);

    expect(harness.kitchen.imports()).toHaveLength(0);
    expect(harness.kitchen.fridge().map((item) => item.id)).toEqual(before);
    expect(existsSync(imagePath!)).toBe(false);
  });

  describe("undo journal", () => {
    function stockCleared(importId: number): number {
      const row = harness.database
        .prepare("SELECT stock_cleared FROM imports WHERE id = ?")
        .get(importId) as { stock_cleared: number } | undefined;
      return Number(row?.stock_cleared);
    }

    it("restores a discarded item and the import stock flag", () => {
      const item = imported("土豆");
      const importId = createImport([item]);
      const id = item.id!;
      expect(stockCleared(importId)).toBe(0);

      const result = harness.kitchen.runUndoable([id], () =>
        harness.kitchen.discardItem(id),
      );
      expect(result.ok).toBe(true);
      expect(result.token).not.toBe("");
      expect(harness.store.item(id)?.status).toBe(ItemStatus.Discarded);
      expect(stockCleared(importId)).toBe(1);

      expect(harness.kitchen.undo(result.token)).toBe("ok");
      const restored = harness.store.item(id);
      expect(restored?.status).toBe(ItemStatus.InStock);
      expect(restored?.statusChangedAt ?? null).toBeNull();
      expect(stockCleared(importId)).toBe(0);
    });

    it("undoes markAbsent on a pantry item including override and suggestion", () => {
      const id = save(manual("生抽"));
      const result = harness.kitchen.runUndoable([id], () =>
        harness.kitchen.markAbsent(id),
      );
      expect(result.ok).toBe(true);
      expect(result.suggestions).toEqual(["生抽"]);
      expect(harness.store.pantryOverrides()).toEqual([
        expect.objectContaining({ name: "生抽", out: true }),
      ]);
      expect(harness.kitchen.suggestions()).toHaveLength(1);

      expect(harness.kitchen.undo(result.token)).toBe("ok");
      expect(harness.store.item(id)?.status).toBe(ItemStatus.InStock);
      expect(harness.store.pantryOverrides()).toEqual([]);
      expect(harness.kitchen.suggestions()).toHaveLength(0);
    });

    it("restores a previous override and keeps a suggestion that already existed", () => {
      expect(
        harness.kitchen.setPantryOverride({ name: "生抽", pantry: true, out: false }),
      ).toBe(true);
      const id = save(manual("生抽"));
      expect(harness.kitchen.markAbsent(id)).toBe(true);
      const second = save(manual("生抽"));
      expect(harness.kitchen.suggestions()).toHaveLength(1);

      const result = harness.kitchen.runUndoable([second], () =>
        harness.kitchen.markAbsent(second),
      );
      expect(result.suggestions).toEqual(["生抽"]);
      expect(harness.kitchen.undo(result.token)).toBe("ok");
      expect(harness.store.item(second)?.status).toBe(ItemStatus.InStock);
      expect(harness.kitchen.suggestions()).toHaveLength(1);
    });

    it("undoes a bulk removal in one call", () => {
      const first = save(manual("生菜"));
      const second = save(manual("油菜"));
      const result = harness.kitchen.runUndoable([first, second], () =>
        [first, second].every((id) => harness.kitchen.markAbsent(id)),
      );
      expect(result.ok).toBe(true);
      expect(harness.kitchen.fridge()).toHaveLength(0);

      expect(harness.kitchen.undo(result.token)).toBe("ok");
      expect(harness.kitchen.fridge().map((item) => item.id).sort()).toEqual(
        [first, second].sort(),
      );
    });

    it("clears the snooze on undo", () => {
      const item = manual("牛奶");
      item.manualDays = 8;
      item.entryDate = addDays(harness.clock.today(), -7);
      const id = save(item);
      const result = harness.kitchen.runUndoable([id], () =>
        harness.kitchen.snoozeItem(id),
      );
      expect(result.ok).toBe(true);
      expect(harness.store.item(id)?.snoozedUntil).toBeTruthy();

      expect(harness.kitchen.undo(result.token)).toBe("ok");
      expect(harness.store.item(id)?.snoozedUntil ?? null).toBeNull();
    });

    it("refuses to undo when the item changed afterwards", () => {
      const id = save(manual("黄瓜"));
      const result = harness.kitchen.runUndoable([id], () =>
        harness.kitchen.useItem(id),
      );
      expect(harness.kitchen.markAbsent(id)).toBe(true);
      expect(harness.kitchen.undo(result.token)).toBe("changed");
      expect(harness.store.item(id)?.status).toBe(ItemStatus.Absent);
    });

    it("expires after the TTL and rejects a token used twice", () => {
      const id = save(manual("黄瓜"));
      const expired = harness.kitchen.runUndoable([id], () =>
        harness.kitchen.useItem(id),
      );
      harness.advanceDays(1);
      expect(harness.kitchen.undo(expired.token)).toBe("expired");

      const other = save(manual("西红柿"));
      const result = harness.kitchen.runUndoable([other], () =>
        harness.kitchen.discardItem(other),
      );
      expect(harness.kitchen.undo(result.token)).toBe("ok");
      expect(harness.kitchen.undo(result.token)).toBe("expired");
      expect(harness.kitchen.undo("missing")).toBe("expired");
    });

    it("records no token when the action fails", () => {
      const result = harness.kitchen.runUndoable([9999], () =>
        harness.kitchen.discardItem(9999),
      );
      expect(result).toEqual({ ok: false, token: "", suggestions: [] });
    });
  });
});
