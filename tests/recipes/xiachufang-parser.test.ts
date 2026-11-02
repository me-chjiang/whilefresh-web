import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import {
  RecipeErrorKind,
  type RecipeSearchResult,
  type WebRecipe,
} from "../../server/recipes/types.js";
import {
  parseContract,
  type RecipeParseOutcome,
} from "../../server/recipes/xiachufang-parser.js";

function sample(name: string): string {
  return readFileSync(
    new URL(
      `../../test-data/recipes/xiachufang/${name}`,
      import.meta.url,
    ),
    "utf8",
  );
}

function parseYaml(source: string): RecipeParseOutcome {
  try {
    return parseContract(YAML.parse(source));
  } catch (error) {
    return {
      result: null,
      error: {
        kind: RecipeErrorKind.BadResponse,
        detail:
          error instanceof Error ? error.message : "malformed YAML",
      },
    };
  }
}

function searchResult(outcome: RecipeParseOutcome): RecipeSearchResult {
  if (!outcome.result || !("items" in outcome.result)) {
    throw new Error(`expected a search result: ${outcome.error.detail}`);
  }
  return outcome.result;
}

function recipeResult(outcome: RecipeParseOutcome): WebRecipe {
  if (!outcome.result || "items" in outcome.result) {
    throw new Error(`expected a recipe result: ${outcome.error.detail}`);
  }
  return outcome.result;
}

function minimalDocument(version: string, status: string): string {
  return `schema_version: '${version}'
query: {keyword: x, page: 1}
operation: search
source: {name: xiachufang}
status:
  code: ${status}
  message: m
  incomplete: []
  warnings: []
results: []
`;
}

describe("xiachufang YAML parser", () => {
  it("gives summaries for the search sample", () => {
    const outcome = parseYaml(sample("search-tomato-egg.yaml"));
    expect(outcome.error).toMatchObject({ kind: RecipeErrorKind.BadResponse });
    const search = searchResult(outcome);

    expect(search.keyword).toBe("番茄炒蛋");
    expect(search.page).toBe(1);
    expect(search.items).toHaveLength(2);
    expect(search.totalCandidates).toBe(2);
    expect(search.partial).toBe(true);
    expect(search.incomplete).toEqual(["full_details"]);

    expect(search.items[0]).toMatchObject({
      id: "104493058",
      name: "超嫩滑的番茄炒蛋",
      attribution: {
        sourceUrl: "https://www.xiachufang.com/recipe/104493058/",
        sourceName: "xiachufang",
        provider: "direct",
      },
    });
    expect(search.items[0]?.imageUrl).toMatch(
      /^https:\/\/i2\.chuimg\.com\//,
    );
  });

  it("parses the second search sample", () => {
    const search = searchResult(parseYaml(sample("search-shrimp.yaml")));
    expect(search.items).toHaveLength(2);
    expect(search.items[0]?.id).toBe("103468406");
    expect(search.items[0]?.name).toContain("虾仁");
  });

  it("keeps detail steps, ingredients, and tips apart", () => {
    const recipe = recipeResult(
      parseYaml(sample("detail-lexmount-103468406.yaml")),
    );

    expect(recipe.partial).toBe(false);
    expect(recipe.id).toBe("103468406");
    expect(recipe.name).toBe("【虾仁滑蛋】超嫩滑，复刻茶餐厅经典");
    expect(recipe.attribution).toMatchObject({
      sourceUrl: "https://www.xiachufang.com/recipe/103468406/",
      provider: "lexmount",
    });
    expect(recipe.imageUrl).toMatch(/^https:\/\/i2\.chuimg\.com\//);
    expect(recipe.rating).toBe(8.1);
    expect(recipe.ratingCount).toBeNull();

    expect(recipe.steps).toHaveLength(2);
    expect(recipe.steps[0]).toMatchObject({ order: 1, text: "准备食材" });
    expect(recipe.steps[0]?.imageUrl).toMatch(
      /^https:\/\/i2\.chuimg\.com\//,
    );
    expect(recipe.steps[1]?.order).toBe(2);
    expect(recipe.steps[1]?.text).toMatch(/^虾仁冲洗后/);

    expect(recipe.tips).toHaveLength(1);
    expect(recipe.tips[0]).toContain("冷冻虾仁");
    for (const step of recipe.steps) {
      expect(step.text).not.toContain("冷冻虾仁");
    }

    expect(recipe.ingredients).toHaveLength(3);
    expect(recipe.ingredients[0]).toMatchObject({
      raw: "鸡蛋 4个",
      name: "鸡蛋",
      amount: "4个",
      required: "unknown",
    });
    expect(recipe.ingredients[2]?.raw).toBe("葱 1束");
  });

  it("parses the second detail sample with no tips", () => {
    const recipe = recipeResult(
      parseYaml(sample("detail-lexmount-107114615.yaml")),
    );
    expect(recipe.name).toBe("清炒虾仁");
    expect(recipe.rating).toBe(7.2);
    expect(recipe.tips).toEqual([]);
    expect(recipe.ingredients[0]?.raw).toBe("南美虾 12");
    expect(recipe.steps[1]?.text).toBe(
      "剥虾小技巧，放冰箱冷冻20分钟拿出来非常好剥",
    );
  });

  it("sets the partial flag for a partial detail", () => {
    const recipe = recipeResult(
      parseYaml(sample("detail-partial-synthetic.yaml")),
    );
    expect(recipe.partial).toBe(true);
    expect(recipe.incomplete).toEqual(["steps"]);
    expect(recipe.steps).toEqual([]);
    expect(recipe.ingredients).toHaveLength(4);
    expect(recipe.tips).toEqual([]);
  });

  it("maps error statuses to typed errors", () => {
    const blocked = parseYaml(sample("error-detail-blocked.yaml"));
    expect(blocked.result).toBeNull();
    expect(blocked.error.kind).toBe(RecipeErrorKind.Unavailable);
    expect(blocked.error.detail).toContain("unrecognized detail page");

    const invalid = parseYaml(sample("error-invalid-id.yaml"));
    expect(invalid.result).toBeNull();
    expect(invalid.error.kind).toBe(RecipeErrorKind.InvalidQuery);
  });

  it("accepts supported minor schema versions and rejects unknown majors", () => {
    const minor = parseYaml(minimalDocument("1.7", "complete"));
    expect(minor.result).not.toBeNull();

    const unknown = parseYaml(minimalDocument("2.0", "complete"));
    expect(unknown.result).toBeNull();
    expect(unknown.error.kind).toBe(RecipeErrorKind.BadResponse);
    expect(unknown.error.detail).toContain("2.0");

    expect(
      parseYaml(minimalDocument("", "complete")).error.kind,
    ).toBe(RecipeErrorKind.BadResponse);
  });

  it("treats null results as empty", () => {
    const search = searchResult(
      parseYaml(
        minimalDocument("1.0", "complete").replace(
          "results: []",
          "results: null",
        ),
      ),
    );
    expect(search.items).toEqual([]);
    expect(search.partial).toBe(false);
  });

  it("rejects unknown statuses", () => {
    expect(
      parseYaml(minimalDocument("1.0", "weird")).error.kind,
    ).toBe(RecipeErrorKind.BadResponse);
  });

  it.each([
    ["empty", ""],
    ["scalar", "just text"],
    ["list", "- a\n- b\n"],
    [
      "unterminated flow",
      "schema_version: '1.0'\nquery: {a: [1, 2\n",
    ],
    ["tab indentation", "a:\n\t- b\n  c: d\n"],
    ["binary", "\u0000\u00ff\u00fe\u0001 :: [[{"],
    [
      "results not a list",
      "schema_version: '1.0'\noperation: search\nstatus: {code: complete}\nresults: 5\n",
    ],
    [
      "step not a mapping",
      "schema_version: '1.0'\noperation: detail\nstatus: {code: complete}\nresults:\n- id: '1'\n  name: x\n  steps:\n  - just a string\n",
    ],
    [
      "rating not a number",
      "schema_version: '1.0'\noperation: detail\nstatus: {code: complete}\nresults:\n- id: '1'\n  name: x\n  rating: much\n",
    ],
    [
      "missing operation",
      "schema_version: '1.0'\nstatus: {code: complete}\n",
    ],
    [
      "detail without result",
      "schema_version: '1.0'\noperation: detail\nstatus: {code: complete}\nresults: []\n",
    ],
  ])("rejects malformed input: %s", (_name, source) => {
    const outcome = parseYaml(source);
    expect(outcome.result).toBeNull();
    expect(outcome.error.kind).toBe(RecipeErrorKind.BadResponse);
    expect(outcome.error.detail).not.toBe("");
  });
});
