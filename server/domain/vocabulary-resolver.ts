import type { Catalog } from "./catalog.js";

export const NameSource = {
  Unresolved: "unresolved",
  UserMapping: "user-mapping",
  Recognized: "recognized",
  LocalMatch: "local-match",
  AiClassified: "ai-classified",
  UserEdited: "user-edited",
} as const;

export type NameSource = (typeof NameSource)[keyof typeof NameSource];

export interface NameMappingStore {
  mapped(raw: string): string;
  remember(raw: string, canonical: string): boolean;
  entries(): [key: string, canonical: string][];
  forget(raw: string): boolean;
  clear(): boolean;
}

export function nameKey(raw: string): string {
  return raw.trim().replace(/\s+/gu, " ");
}

export class MemoryNameMappingStore implements NameMappingStore {
  private readonly names = new Map<string, string>();

  mapped(raw: string): string {
    return this.names.get(nameKey(raw)) ?? "";
  }

  remember(raw: string, canonical: string): boolean {
    const key = nameKey(raw);
    if (key.length === 0 || canonical.length === 0) {
      return false;
    }
    this.names.set(key, canonical);
    return true;
  }

  entries(): [key: string, canonical: string][] {
    return [...this.names.entries()].sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
  }

  forget(raw: string): boolean {
    return this.names.delete(nameKey(raw));
  }

  clear(): boolean {
    this.names.clear();
    return true;
  }

  get size(): number {
    return this.names.size;
  }
}

export interface NameResolution {
  canonical: string;
  source: NameSource;
}

function hasChildren(catalog: Catalog, name: string): boolean {
  return catalog.entries.some(
    (entry) => entry.parent === name && entry.name !== name,
  );
}

function contains(catalog: Catalog, name: string): boolean {
  return catalog.entries.some((entry) => entry.name === name);
}

export function resolveName(
  raw: string,
  suggested: string,
  catalog: Catalog,
  mappings?: NameMappingStore,
): NameResolution {
  if (mappings) {
    const mapped = mappings.mapped(raw);
    if (contains(catalog, mapped)) {
      return { canonical: mapped, source: NameSource.UserMapping };
    }
  }

  const finest = catalog.resolveFinest(raw);
  const model = catalog.resolve(suggested);
  if (model.length > 0) {
    const finer =
      finest.length > 0 &&
      finest !== model &&
      (catalog.satisfies(finest, model) ||
        (catalog.categoryOf(finest) === catalog.categoryOf(model) &&
          hasChildren(catalog, model)));
    return {
      canonical: finer ? finest : model,
      source: NameSource.Recognized,
    };
  }
  if (finest.length > 0) {
    return { canonical: finest, source: NameSource.LocalMatch };
  }
  return { canonical: "", source: NameSource.Unresolved };
}

export function unresolvedNames(
  raws: readonly string[],
  resolutions: readonly NameResolution[],
): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const count = Math.min(raws.length, resolutions.length);
  for (let index = 0; index < count; index += 1) {
    const key = nameKey(raws[index] ?? "");
    if (
      resolutions[index]?.source !== NameSource.Unresolved ||
      key.length === 0 ||
      seen.has(key)
    ) {
      continue;
    }
    seen.add(key);
    names.push(key);
  }
  return names;
}
