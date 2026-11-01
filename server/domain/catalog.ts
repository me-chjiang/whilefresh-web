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

  resolveFinest(title: string): string {
    const trimmed = title.trim();
    if (trimmed.length === 0) {
      return "";
    }
    const exact = this.resolve(trimmed);
    if (exact.length > 0) {
      return exact;
    }

    const tokens = trimmed
      .split(/[\s\p{P}\p{S}]+|\d+(?:\.\d+)?[A-Za-z]*/gu)
      .filter((token) => token.length > 0);
    interface Candidate {
      readonly name: string;
      readonly length: number;
      readonly end: number;
      readonly token: number;
    }
    const candidates: Candidate[] = [];
    const consider = (surface: string, name: string): void => {
      for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex += 1) {
        const token = tokens[tokenIndex];
        const at = token.lastIndexOf(surface);
        if (at < 0) {
          continue;
        }
        const end = at + surface.length;
        if (surface.length === 1 && end !== token.length) {
          continue;
        }
        candidates.push({
          name,
          length: surface.length,
          end,
          token: tokenIndex,
        });
      }
    };

    for (const entry of this.entries) {
      consider(entry.name, entry.name);
      for (const alias of entry.aliases) {
        if (
          alias.length > 0 &&
          !this.index.has(alias) &&
          this.aliases.get(alias) === entry.name
        ) {
          consider(alias, entry.name);
        }
      }
    }

    const broader = new Set<string>();
    for (const candidate of candidates) {
      for (const ancestor of this.ancestors(candidate.name)) {
        broader.add(ancestor);
      }
    }

    const bestInToken = new Map<number, Candidate>();
    for (const candidate of candidates) {
      if (broader.has(candidate.name)) {
        continue;
      }
      const previous = bestInToken.get(candidate.token);
      if (
        previous === undefined ||
        candidate.end > previous.end ||
        (candidate.end === previous.end && candidate.length > previous.length)
      ) {
        bestInToken.set(candidate.token, candidate);
      }
    }

    let best: Candidate | undefined;
    for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex += 1) {
      const candidate = bestInToken.get(tokenIndex);
      if (candidate !== undefined && (best === undefined || candidate.length > best.length)) {
        best = candidate;
      }
    }
    return best?.name ?? "";
  }

  hierarchyText(): string {
    const rootOf = (name: string): string => {
      let root = "";
      for (const ancestor of this.ancestors(name)) {
        if (this.index.has(ancestor)) {
          root = ancestor;
        }
      }
      return root;
    };

    const children = new Map<string, string[]>();
    const nested = new Set<string>();
    for (const entry of this.entries) {
      const root = rootOf(entry.name);
      if (root.length > 0) {
        const names = children.get(root) ?? [];
        names.push(entry.name);
        children.set(root, names);
        nested.add(entry.name);
      }
    }

    interface Block {
      readonly code: string;
      readonly families: string[];
      readonly standalone: string[];
    }
    const blocks: Block[] = [];
    const blockFor = (code: string): Block => {
      const existing = blocks.find((block) => block.code === code);
      if (existing !== undefined) {
        return existing;
      }
      const block: Block = { code, families: [], standalone: [] };
      blocks.push(block);
      return block;
    };

    for (const category of this.categories) {
      blockFor(category.code);
    }
    for (const entry of this.entries) {
      if (nested.has(entry.name)) {
        continue;
      }
      const block = blockFor(entry.category);
      const descendants = children.get(entry.name) ?? [];
      if (descendants.length > 0) {
        block.families.push(`${entry.name} > ${descendants.join("、")}`);
      } else {
        block.standalone.push(entry.name);
      }
    }

    const lines: string[] = [];
    for (const block of blocks) {
      if (block.families.length === 0 && block.standalone.length === 0) {
        continue;
      }
      const label =
        block.code.length === 0
          ? "其他"
          : this.categories.find((category) => category.code === block.code)?.name ??
            block.code;
      lines.push(`【${label}】`);
      lines.push(...block.families);
      if (block.standalone.length > 0) {
        lines.push(block.standalone.join("、"));
      }
    }
    return lines.join("\n");
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
