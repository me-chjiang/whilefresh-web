import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../server/data/db.js";
import { SqliteNameMappingStore, Store } from "../../server/data/store.js";
import { fixedClock } from "../../server/domain/clock.js";

describe("name mappings", () => {
  let directory: string;
  let importsDirectory: string;
  let database: DatabaseSync;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "whilefresh-name-mappings-"));
    importsDirectory = join(directory, "imports");
    mkdirSync(importsDirectory);
    database = openDatabase(join(directory, "whilefresh.db"));
  });

  afterEach(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("lists, forgets and clears mappings", () => {
    const names = new SqliteNameMappingStore(
      database,
      fixedClock(new Date("2026-10-30T09:00:00.000Z")),
    );
    expect(names.entries()).toEqual([]);
    expect(names.remember("土猪肉", "猪肉")).toBe(true);
    expect(names.remember("冰鲜 鸡全腿", "鸡腿")).toBe(true);

    const entries = names.entries();
    expect(entries).toHaveLength(2);
    expect(entries[0]?.[1]).not.toBe("");
    expect(names.forget(" 冰鲜  鸡全腿 ")).toBe(true);
    expect(names.forget("冰鲜 鸡全腿")).toBe(false);
    expect(names.mapped("冰鲜 鸡全腿")).toBe("");
    expect(names.mapped("土猪肉")).toBe("猪肉");
    expect(names.clear()).toBe(true);
    expect(names.entries()).toEqual([]);
    expect(names.clear()).toBe(true);
  });

  it("remembers and overwrites by normalized raw name", () => {
    const names = new SqliteNameMappingStore(
      database,
      fixedClock(new Date("2026-10-30T09:00:00.000Z")),
    );
    expect(names.remember(" 农家  土猪肉 ", "猪肉")).toBe(true);
    expect(names.mapped("农家 土猪肉")).toBe("猪肉");

    const nextDayNames = new SqliteNameMappingStore(
      database,
      fixedClock(new Date("2026-10-31T09:00:00.000Z")),
    );
    expect(nextDayNames.remember("农家 土猪肉", "五花肉")).toBe(true);
    expect(nextDayNames.mapped("农家 土猪肉")).toBe("五花肉");
    expect(nextDayNames.mapped("别的")).toBe("");
    expect(nextDayNames.remember("  ", "猪肉")).toBe(false);

    expect(
      database
        .prepare(
          "SELECT raw_name, canonical_name, confirmed_at FROM name_mappings",
        )
        .all(),
    ).toEqual([
      {
        raw_name: "农家 土猪肉",
        canonical_name: "五花肉",
        confirmed_at: "2026-10-31T09:00:00.000Z",
      },
    ]);
  });

  it("forgets mappings when deleting all data", () => {
    const clock = fixedClock(new Date("2026-10-30T09:00:00.000Z"));
    const names = new SqliteNameMappingStore(database, clock);
    expect(names.remember("冰鲜鸡全腿", "鸡腿")).toBe(true);

    const store = new Store(database, clock, importsDirectory);
    expect(store.deleteAllData()).toBe(true);
    expect(names.mapped("冰鲜鸡全腿")).toBe("");
  });
});
