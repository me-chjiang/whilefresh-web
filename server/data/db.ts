import { DatabaseSync } from "node:sqlite";

// Append-only. Never edit a migration after it has shipped.
const migrations: readonly (readonly string[])[] = [
  [
    `CREATE TABLE imports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      input_kind TEXT NOT NULL,
      origin TEXT NOT NULL DEFAULT '',
      is_demo INTEGER NOT NULL DEFAULT 0,
      truncated INTEGER NOT NULL DEFAULT 0,
      text_length INTEGER NOT NULL DEFAULT 0,
      source_type TEXT NOT NULL DEFAULT 'other'
    )`,
    `CREATE TABLE import_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      import_id INTEGER NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      path TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      mime_type TEXT NOT NULL DEFAULT '',
      captured_at TEXT,
      captured_at_source TEXT NOT NULL DEFAULT ''
    )`,
    "CREATE INDEX import_images_sha256 ON import_images(sha256)",
    `CREATE TABLE items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      import_id INTEGER REFERENCES imports(id) ON DELETE CASCADE,
      canonical_name TEXT NOT NULL,
      display_name TEXT NOT NULL,
      raw_name TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'other',
      quantity_text TEXT NOT NULL DEFAULT '',
      count INTEGER NOT NULL DEFAULT 1,
      storage TEXT NOT NULL,
      storage_source TEXT NOT NULL DEFAULT 'default',
      use_first INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'in_stock',
      status_changed_at TEXT,
      purchase_date TEXT,
      purchase_date_origin TEXT NOT NULL DEFAULT 'none',
      purchase_date_text TEXT NOT NULL DEFAULT '',
      entry_date TEXT NOT NULL,
      production_date TEXT,
      production_date_origin TEXT NOT NULL DEFAULT 'none',
      production_date_text TEXT NOT NULL DEFAULT '',
      package_expiry_date TEXT,
      package_expiry_origin TEXT NOT NULL DEFAULT 'none',
      package_expiry_text TEXT NOT NULL DEFAULT '',
      labelled_days INTEGER,
      manual_days INTEGER,
      ai_fridge_days INTEGER,
      ai_freezer_days INTEGER,
      ai_room_days INTEGER,
      shelf_life_source TEXT NOT NULL DEFAULT 'none',
      shelf_life_days INTEGER,
      expiry_date TEXT,
      start_basis TEXT NOT NULL DEFAULT 'none',
      shelf_life_note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      reference_conditions_confirmed INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE shelf_life_rules (
      canonical_name TEXT NOT NULL,
      storage TEXT NOT NULL,
      days INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (canonical_name, storage)
    )`,
    `CREATE TABLE storage_rules (
      canonical_name TEXT PRIMARY KEY,
      storage TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE ai_shelf_life_cache (
      canonical_name TEXT NOT NULL,
      storage TEXT NOT NULL,
      days INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (canonical_name, storage)
    )`,
    `CREATE TABLE pantry_overrides (
      canonical_name TEXT PRIMARY KEY,
      is_pantry INTEGER,
      is_bulk INTEGER,
      is_out INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE suggestions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      canonical_name TEXT NOT NULL,
      message TEXT NOT NULL,
      import_id INTEGER REFERENCES imports(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      resolved_at TEXT
    )`,
    `CREATE TABLE shopping_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      names TEXT NOT NULL,
      dedupe_key TEXT NOT NULL UNIQUE,
      category TEXT NOT NULL DEFAULT 'other',
      origin TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,
    "CREATE INDEX items_import_id ON items(import_id)",
    "CREATE INDEX items_status ON items(status)",
    "CREATE INDEX suggestions_status ON suggestions(status)",
    `CREATE TABLE import_products (
      import_id INTEGER NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
      canonical_name TEXT NOT NULL,
      quantity TEXT NOT NULL
    )`,
    "CREATE TABLE file_cleanup (path TEXT PRIMARY KEY)",
  ],
];

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);

  try {
    db.exec("PRAGMA foreign_keys = ON");

    const row = db.prepare("PRAGMA user_version").get();
    const version = Number(row?.user_version ?? 0);
    if (!Number.isInteger(version) || version < 0) {
      throw new Error(`database: invalid schema version ${version}`);
    }
    if (version > migrations.length) {
      throw new Error(
        `database: schema version ${version} is newer than supported version ${migrations.length}`,
      );
    }

    for (let index = version; index < migrations.length; index += 1) {
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const statement of migrations[index]) {
          db.exec(statement);
        }
        db.exec(`PRAGMA user_version = ${index + 1}`);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }

    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
