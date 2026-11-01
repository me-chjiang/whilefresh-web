export interface CatalogEntry {
  name: string;
  category: string;
  aliases: string[];
  parent: string;
  pantryDefault: boolean;
  bulkDefault: boolean;
}

export interface CatalogCategory {
  code: string;
  name: string;
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function flag(value: unknown): boolean {
  return value === true;
}

export class Catalog {
  readonly entries: readonly CatalogEntry[];
  readonly categories: readonly CatalogCategory[];

  private readonly index: ReadonlyMap<string, CatalogEntry>;
  private readonly aliases: ReadonlyMap<string, string>;

  private constructor(
    entries: CatalogEntry[],
    categories: CatalogCategory[],
  ) {
    this.entries = entries;
    this.categories = categories;

    const index = new Map<string, CatalogEntry>();
    const aliases = new Map<string, string>();
    for (const entry of entries) {
      index.set(entry.name, entry);
      for (const alias of entry.aliases) {
        if (!aliases.has(alias)) {
          aliases.set(alias, entry.name);
        }
      }
    }
    this.index = index;
    this.aliases = aliases;
  }

  static fromJson(json: string): Catalog {
    let root: unknown;
    try {
      root = JSON.parse(json) as unknown;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`vocabulary: ${message}`);
    }

    const categories: CatalogCategory[] = [];
    const addCategory = (codeValue: unknown, nameValue: unknown): void => {
      const code = text(codeValue);
      if (code.length === 0 || categories.some((item) => item.code === code)) {
        return;
      }
      const name = text(nameValue);
      categories.push({ code, name: name || code });
    };

    const rootObject = isObject(root) ? root : {};
    const categoryValue = rootObject.categories;
    if (Array.isArray(categoryValue)) {
      for (const value of categoryValue) {
        const item = isObject(value) ? value : {};
        addCategory(item.code, item.name);
      }
    } else if (isObject(categoryValue)) {
      for (const [code, name] of Object.entries(categoryValue)) {
        addCategory(code, name);
      }
    }

    const itemValues = Array.isArray(root) ? root : rootObject.items;
    const entries: CatalogEntry[] = [];
    if (Array.isArray(itemValues)) {
      for (const value of itemValues) {
        if (!isObject(value)) {
          continue;
        }
        const name = text(value.name);
        if (name.length === 0 || entries.some((entry) => entry.name === name)) {
          continue;
        }
        const aliases = Array.isArray(value.aliases)
          ? value.aliases.map(text).filter((alias) => alias.length > 0)
          : [];
        entries.push({
          name,
          category: text(value.category),
          aliases,
          parent: text(value.parent),
          pantryDefault: flag(value.pantry_default),
          bulkDefault: flag(value.bulk_default),
        });
      }
    }

    if (entries.length === 0) {
      throw new Error("vocabulary: no items");
    }
    return new Catalog(entries, categories);
  }

  get size(): number {
    return this.entries.length;
  }

  resolve(nameOrAlias: string): string {
    const name = nameOrAlias.trim();
    if (this.index.has(name)) {
      return name;
    }
    return this.aliases.get(name) ?? "";
  }

  categoryOf(name: string): string {
    const category = this.index.get(name)?.category;
    return category || "other";
  }

  ancestors(name: string): string[] {
    const chain: string[] = [];
    const seen = new Set([name]);
    let current = this.index.get(name);

    while (current && current.parent.length > 0 && !seen.has(current.parent)) {
      chain.push(current.parent);
      seen.add(current.parent);
      current = this.index.get(current.parent);
    }
    return chain;
  }

  satisfies(name: string, requirement: string): boolean {
    return name === requirement || this.ancestors(name).includes(requirement);
  }

  isEligible(name: string): boolean {
    return name.trim().length > 0 && name !== "未归类";
  }

  pantryDefault(name: string): boolean {
    return this.index.get(name)?.pantryDefault ?? false;
  }

  bulkDefault(name: string): boolean {
    return this.index.get(name)?.bulkDefault ?? false;
  }
}
