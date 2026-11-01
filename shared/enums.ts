export const Storage = {
  Fridge: "fridge",
  Freezer: "freezer",
  Room: "room",
} as const;

export type Storage = (typeof Storage)[keyof typeof Storage];

export const ItemStatus = {
  InStock: "in_stock",
  Used: "used",
  Absent: "absent",
} as const;

export type ItemStatus = (typeof ItemStatus)[keyof typeof ItemStatus];

export const DateOrigin = {
  None: "none",
  Visible: "visible",
  User: "user",
} as const;

export type DateOrigin = (typeof DateOrigin)[keyof typeof DateOrigin];

export const Freshness = {
  Unknown: "unknown",
  Fresh: "fresh",
  NearExpiry: "near_expiry",
  BeyondEstimate: "beyond_estimate",
} as const;

export type Freshness = (typeof Freshness)[keyof typeof Freshness];

export const ShelfLifeSource = {
  None: "none",
  Package: "package",
  Manual: "manual",
  LocalRule: "local_rule",
  Reference: "reference",
  AiEstimate: "ai_estimate",
} as const;

export type ShelfLifeSource =
  (typeof ShelfLifeSource)[keyof typeof ShelfLifeSource];

export const StartBasis = {
  None: "none",
  ProductionDate: "production",
  PurchaseDate: "purchase",
  EntryDate: "entry",
} as const;

export type StartBasis = (typeof StartBasis)[keyof typeof StartBasis];

export const StorageSource = {
  Default: "default",
  LocalRule: "local_rule",
  Reference: "reference",
  AiEstimate: "ai_estimate",
} as const;

export type StorageSource = (typeof StorageSource)[keyof typeof StorageSource];

export const SuggestionKind = {
  MarkPantryHave: "mark_pantry_have",
  AddToPantry: "add_to_pantry",
  AddToShopping: "add_to_shopping",
} as const;

export type SuggestionKind = (typeof SuggestionKind)[keyof typeof SuggestionKind];

export const ShoppingOrigin = {
  Recipe: "recipe",
  Pantry: "pantry",
  Manual: "manual",
} as const;

export type ShoppingOrigin =
  (typeof ShoppingOrigin)[keyof typeof ShoppingOrigin];

export const ImportState = {
  Idle: "idle",
  Prepared: "prepared",
  Recognizing: "recognizing",
  Duplicate: "duplicate",
  Draft: "draft",
  Failed: "failed",
} as const;

export type ImportState = (typeof ImportState)[keyof typeof ImportState];

export const CategoryCode = {
  Vegetable: "vegetable",
  Fruit: "fruit",
  Meat: "meat",
  Seafood: "seafood",
  EggDairy: "egg_dairy",
  Soy: "soy",
  Staple: "staple",
  Seasoning: "seasoning",
  Processed: "processed",
  Other: "other",
} as const;

export type CategoryCode = (typeof CategoryCode)[keyof typeof CategoryCode];
