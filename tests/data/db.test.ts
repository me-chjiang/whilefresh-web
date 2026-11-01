import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../server/data/db.js";

describe("database", () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "whilefresh-db-"));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("migrates an empty database to all twelve tables", () => {
    const database = openDatabase(join(directory, "whilefresh.db"));
    try {
      const tables = database
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
           ORDER BY name`,
        )
        .all()
        .map((row) => String(row.name));

      expect(tables).toEqual([
        "ai_shelf_life_cache",
        "file_cleanup",
        "import_images",
        "import_products",
        "imports",
        "items",
        "pantry_overrides",
        "settings",
        "shelf_life_rules",
        "shopping_items",
        "storage_rules",
        "suggestions",
      ]);
      expect(
        Number(database.prepare("PRAGMA user_version").get()?.user_version),
      ).toBe(1);
    } finally {
      database.close();
    }
  });

  it("refuses to open a database with a newer schema", () => {
    const path = join(directory, "newer.db");
    const database = new DatabaseSync(path);
    database.exec("PRAGMA user_version = 2");
    database.close();

    expect(() => openDatabase(path)).toThrow(/newer/);
  });

  it("allows two connections to coexist", () => {
    const path = join(directory, "shared.db");
    const first = openDatabase(path);
    const second = openDatabase(path);
    try {
      first
        .prepare("INSERT INTO settings (key, value) VALUES (?, ?)")
        .run("from-first", "1");
      expect(
        second
          .prepare("SELECT value FROM settings WHERE key = ?")
          .get("from-first")?.value,
      ).toBe("1");

      second
        .prepare("INSERT INTO settings (key, value) VALUES (?, ?)")
        .run("from-second", "2");
      expect(
        first
          .prepare("SELECT value FROM settings WHERE key = ?")
          .get("from-second")?.value,
      ).toBe("2");
    } finally {
      second.close();
      first.close();
    }
  });
});
