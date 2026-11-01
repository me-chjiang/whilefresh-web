import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { config } from "../config.js";
import { Catalog } from "../domain/catalog.js";
import {
  RecipeBook,
  type Recipe,
  type RecipeSource,
} from "../domain/recipe.js";
import { ShelfLifeTable } from "../domain/shelf-life.js";

export interface BuiltinData {
  readonly catalog: Catalog;
  readonly recipes: readonly Recipe[];
  readonly recipeSource: RecipeSource;
  readonly shelfLife: ShelfLifeTable;
  readonly vocabularyJson: string;
}

const builtinDirectory = resolve(config.assetsDir, "data");
let cached: BuiltinData | undefined;

function readDataFile(name: string): string {
  const path = resolve(builtinDirectory, name);
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot read ${path}: ${message}`);
  }
}

export function loadBuiltin(): BuiltinData {
  if (cached) {
    return cached;
  }

  const vocabularyJson = readDataFile("vocabulary.json");
  const catalog = Catalog.fromJson(vocabularyJson);
  const recipeBook = RecipeBook.fromJson(readDataFile("recipes.json"));
  const shelfLife = existsSync(resolve(builtinDirectory, "shelf-life.json"))
    ? ShelfLifeTable.fromJson(readDataFile("shelf-life.json"))
    : new ShelfLifeTable();

  cached = Object.freeze({
    catalog,
    recipes: recipeBook.recipes,
    recipeSource: recipeBook.source,
    shelfLife,
    vocabularyJson,
  });
  return cached;
}
