import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../server/data/db.js";

const versionThreeDowngrade = `
  DROP TRIGGER imports_stock_on_insert;
  DROP TRIGGER items_stock_on_insert;
  DROP TRIGGER items_stock_on_update;
  DROP TRIGGER items_stock_on_delete;
  DROP INDEX imports_active;
  ALTER TABLE imports DROP COLUMN stock_cleared;
`;

describe("database", () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "whilefresh-db-"));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("migrates an empty database to all seventeen tables", () => {
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
        "cleanup_sessions",
        "file_cleanup",
        "import_images",
        "import_job_batches",
        "import_jobs",
        "import_products",
        "imports",
        "items",
        "name_mappings",
        "pantry_overrides",
        "preferences",
        "settings",
        "shelf_life_rules",
        "shopping_items",
        "storage_rules",
        "suggestions",
      ]);
      expect(
        Number(database.prepare("PRAGMA user_version").get()?.user_version),
      ).toBe(3);
    } finally {
      database.close();
    }
  });

  it("upgrades a version one database with the round two defaults", () => {
    const path = join(directory, "version-one.db");
    const latest = openDatabase(path);
    latest
      .prepare(
        "INSERT INTO imports (created_at, input_kind) VALUES (?, ?)",
      )
      .run("2026-10-01T00:00:00.000Z", "screenshot");
    latest
      .prepare(
        `INSERT INTO items (
          import_id, canonical_name, display_name, quantity_text, storage,
          entry_date, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        1,
        "鸡蛋",
        "鸡蛋",
        "10枚",
        "fridge",
        "2026-10-01",
        "2026-10-01T00:00:00.000Z",
        "2026-10-01T00:00:00.000Z",
      );
    latest.close();

    const legacy = new DatabaseSync(path);
    legacy.exec(versionThreeDowngrade);
    legacy.exec(`
      DROP TABLE import_job_batches;
      DROP TABLE import_jobs;
      DROP TABLE cleanup_sessions;
      DROP TABLE preferences;
      DROP TABLE name_mappings;
      ALTER TABLE items DROP COLUMN kind;
      ALTER TABLE items DROP COLUMN amount;
      ALTER TABLE items DROP COLUMN unit;
      ALTER TABLE items DROP COLUMN snoozed_until;
      ALTER TABLE imports DROP COLUMN status;
      ALTER TABLE imports DROP COLUMN duplicate_of;
      ALTER TABLE imports DROP COLUMN deleted_at;
      PRAGMA user_version = 1;
    `);
    legacy.close();

    const upgraded = openDatabase(path);
    try {
      expect(
        Number(upgraded.prepare("PRAGMA user_version").get()?.user_version),
      ).toBe(3);
      expect(
        upgraded
          .prepare(
            "SELECT kind, amount, unit, snoozed_until FROM items WHERE canonical_name = ?",
          )
          .get("鸡蛋"),
      ).toEqual({
        kind: "food",
        amount: 0,
        unit: "",
        snoozed_until: null,
      });
      expect(
        upgraded
          .prepare("SELECT status, duplicate_of, deleted_at FROM imports")
          .get(),
      ).toEqual({
        status: "confirmed",
        duplicate_of: null,
        deleted_at: null,
      });
      expect(
        upgraded.prepare("SELECT stock_cleared FROM imports").get(),
      ).toEqual({ stock_cleared: 0 });
    } finally {
      upgraded.close();
    }
  });

  it("marks version two imports that have no stock left", () => {
    const path = join(directory, "version-two.db");
    const latest = openDatabase(path);
    const insertImport = latest.prepare(
      "INSERT INTO imports (created_at, input_kind) VALUES (?, ?)",
    );
    const insertItem = latest.prepare(
      `INSERT INTO items (
        import_id, canonical_name, display_name, quantity_text, storage,
        entry_date, created_at, updated_at, status
      ) VALUES (?, ?, ?, '', 'fridge', '2026-10-01', ?, ?, ?)`,
    );
    const at = "2026-10-01T00:00:00.000Z";
    for (let index = 0; index < 3; index += 1) {
      insertImport.run(at, "screenshot");
    }
    insertItem.run(1, "鸡蛋", "鸡蛋", at, at, "in_stock");
    insertItem.run(1, "土豆", "土豆", at, at, "used");
    insertItem.run(2, "菠菜", "菠菜", at, at, "discarded");
    latest.close();

    const legacy = new DatabaseSync(path);
    legacy.exec(versionThreeDowngrade);
    legacy.exec("PRAGMA user_version = 2");
    legacy.close();

    const upgraded = openDatabase(path);
    try {
      expect(
        upgraded
          .prepare("SELECT id, stock_cleared FROM imports ORDER BY id")
          .all(),
      ).toEqual([
        { id: 1, stock_cleared: 0 },
        { id: 2, stock_cleared: 1 },
        { id: 3, stock_cleared: 1 },
      ]);
    } finally {
      upgraded.close();
    }
  });

  it("refuses to open a database with a newer schema", () => {
    const path = join(directory, "newer.db");
    const database = new DatabaseSync(path);
    database.exec("PRAGMA user_version = 4");
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
