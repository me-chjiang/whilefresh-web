import {
  importDuplicateImage,
  importPossibleDuplicate,
} from "./texts.js";

export const DuplicateKind = {
  None: "none",
  SameImage: "same_image",
  SimilarItems: "similar_items",
} as const;

export type DuplicateKind =
  (typeof DuplicateKind)[keyof typeof DuplicateKind];

export const DuplicateRules = {
  minimumOverlap: 0.8,
  withinDays: 3,
  minimumItems: 2,
} as const;

export type ImportItem = readonly [name: string, quantity: string];

export interface ImportFingerprint {
  importId: number;
  createdAt: Date;
  imageSha256: readonly string[];
  items: readonly ImportItem[];
}

export class DuplicateCheck {
  static readonly Kind = DuplicateKind;

  readonly kind: DuplicateKind;
  readonly importId: number;
  readonly importedAt: Date | null;
  readonly overlap: number;

  constructor(
    kind: DuplicateKind = DuplicateKind.None,
    importId = 0,
    importedAt: Date | null = null,
    overlap = 0,
  ) {
    this.kind = kind;
    this.importId = importId;
    this.importedAt = importedAt;
    this.overlap = overlap;
  }

  isDuplicate(): boolean {
    return this.kind !== DuplicateKind.None;
  }

  message(): string {
    switch (this.kind) {
      case DuplicateKind.None:
        return "";
      case DuplicateKind.SameImage:
        return importDuplicateImage();
      case DuplicateKind.SimilarItems:
        return importPossibleDuplicate();
    }
  }
}

function countPairs(items: readonly ImportItem[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [itemName, quantity] of items) {
    const name = itemName.trim();
    if (name.length === 0 || name === "未归类") {
      continue;
    }
    const key = `${name}\x1f${quantity.trim()}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function total(counts: ReadonlyMap<string, number>): number {
  let sum = 0;
  for (const count of counts.values()) {
    sum += count;
  }
  return sum;
}

export function checkSameImage(
  imageSha256: readonly string[],
  previous: readonly ImportFingerprint[],
): DuplicateCheck {
  const wanted = new Set(imageSha256);
  for (const earlier of previous) {
    for (const sha of earlier.imageSha256) {
      if (sha.length > 0 && wanted.has(sha)) {
        return new DuplicateCheck(
          DuplicateKind.SameImage,
          earlier.importId,
          earlier.createdAt,
          1,
        );
      }
    }
  }
  return new DuplicateCheck();
}

export function checkSimilarItems(
  items: readonly ImportItem[],
  now: Date,
  previous: readonly ImportFingerprint[],
): DuplicateCheck {
  const current = countPairs(items);
  const currentTotal = total(current);
  if (currentTotal < DuplicateRules.minimumItems) {
    return new DuplicateCheck();
  }

  let best = new DuplicateCheck();
  const maximumAge = DuplicateRules.withinDays * 86_400_000;
  for (const earlier of previous) {
    const age = Math.abs(earlier.createdAt.getTime() - now.getTime());
    if (!Number.isFinite(age) || age > maximumAge) {
      continue;
    }

    const other = countPairs(earlier.items);
    let common = 0;
    for (const [key, count] of current) {
      common += Math.min(count, other.get(key) ?? 0);
    }

    const overlap = common / Math.max(currentTotal, total(other));
    if (
      overlap >= DuplicateRules.minimumOverlap &&
      overlap > best.overlap
    ) {
      best = new DuplicateCheck(
        DuplicateKind.SimilarItems,
        earlier.importId,
        earlier.createdAt,
        overlap,
      );
    }
  }
  return best;
}
