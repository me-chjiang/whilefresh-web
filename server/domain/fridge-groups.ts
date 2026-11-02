import { ItemKind, Storage } from "../../shared/enums.js";
import type { Catalog } from "./catalog.js";
import { evaluateFreshness } from "./freshness.js";
import type { ShelfLifeTable } from "./shelf-life.js";

const MINIMUM_ROOM_DAYS = 30;

export const FridgeGroup = {
  Fridge: "fridge",
  Freezer: "freezer",
  Room: "room",
  StapleSeasoning: "staple_seasoning",
  StapleFood: "staple_food",
} as const;

export type FridgeGroup = (typeof FridgeGroup)[keyof typeof FridgeGroup];

export interface FridgeItem {
  id: number;
  canonicalName: string;
  displayName: string;
  kind: ItemKind;
  storage: Storage;
  expiryDate?: string | null;
  shelfLifeDays?: number | null;
}

export function classifyItemKind(
  name: string,
  recognizedAsSeasoning: boolean,
  storage: Storage,
  catalog: Catalog | null,
  shelfLifeTable: ShelfLifeTable | null,
): ItemKind {
  const entry = catalog?.entries.find((candidate) => candidate.name === name);
  if (
    recognizedAsSeasoning ||
    (entry?.category === "seasoning")
  ) {
    return ItemKind.StapleSeasoning;
  }
  if (entry?.category !== "staple") {
    return ItemKind.Food;
  }
  if (entry.pantryDefault || entry.bulkDefault) {
    return ItemKind.StapleFood;
  }
  if (storage !== Storage.Room) {
    return ItemKind.Food;
  }

  const hit = shelfLifeTable?.lookup(name, Storage.Room, catalog) ?? null;
  return hit !== null && hit.days < MINIMUM_ROOM_DAYS
    ? ItemKind.Food
    : ItemKind.StapleFood;
}

export function groupOf(
  item: Pick<FridgeItem, "kind" | "storage">,
): FridgeGroup {
  switch (item.kind) {
    case ItemKind.StapleSeasoning:
      return FridgeGroup.StapleSeasoning;
    case ItemKind.StapleFood:
      return FridgeGroup.StapleFood;
    case ItemKind.Food:
      break;
  }

  switch (item.storage) {
    case Storage.Fridge:
      return FridgeGroup.Fridge;
    case Storage.Freezer:
      return FridgeGroup.Freezer;
    case Storage.Room:
      return FridgeGroup.Room;
  }
}

const GROUP_RANK: Readonly<Record<FridgeGroup, number>> = {
  [FridgeGroup.Fridge]: 0,
  [FridgeGroup.Freezer]: 1,
  [FridgeGroup.Room]: 2,
  [FridgeGroup.StapleSeasoning]: 3,
  [FridgeGroup.StapleFood]: 4,
};

export function sortForFridge<T extends FridgeItem>(
  items: readonly T[],
  today: string,
): T[] {
  return items
    .map((item, index) => {
      const remaining = evaluateFreshness(
        item.expiryDate,
        item.shelfLifeDays,
        today,
      ).remainingDays;
      return {
        item,
        index,
        group: GROUP_RANK[groupOf(item)],
        unknown: remaining === null ? 1 : 0,
        remaining: remaining ?? 0,
        name: item.displayName || item.canonicalName,
      };
    })
    .sort((a, b) => {
      return (
        a.group - b.group ||
        a.unknown - b.unknown ||
        a.remaining - b.remaining ||
        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
        a.item.id - b.item.id ||
        a.index - b.index
      );
    })
    .map(({ item }) => item);
}
