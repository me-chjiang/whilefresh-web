import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { RecipeErrorKind } from "../../server/recipes/types.js";
import {
  NOT_FOUND_RECORDING_DETAIL,
  RecordedRecipeSource,
} from "../helpers/recorded-recipe-source.js";

const samples = fileURLToPath(
  new URL("../../test-data/recipes/xiachufang/", import.meta.url),
);

function source(): RecordedRecipeSource {
  const recorded = new RecordedRecipeSource();
  expect(recorded.addDirectory(samples)).toBe(7);
  return recorded;
}

describe("recorded recipe source", () => {
  it("loads a directory and rejects source files", () => {
    const recorded = new RecordedRecipeSource();
    expect(recorded.addDirectory(samples)).toBe(7);
    expect(recorded.addFile(`${samples}SOURCE.md`)).toBe(false);
    expect(recorded.addFile("/nonexistent.yaml")).toBe(false);
  });

  it("answers searches asynchronously", async () => {
    const recorded = source();
    let settled = false;
    const answer = recorded
      .search("虾仁", 1, new AbortController().signal)
      .then((result) => {
        settled = true;
        return result;
      });

    expect(settled).toBe(false);
    await expect(answer).resolves.toMatchObject({ items: [{}, {}] });
  });

  it("answers detail requests", async () => {
    const recorded = source();
    await expect(
      recorded.detail("900000002", new AbortController().signal),
    ).resolves.toMatchObject({ id: "900000002", partial: true });
  });

  it("keeps recorded errors typed", async () => {
    const recorded = source();
    const results = await Promise.allSettled([
      recorded.detail("107722218", new AbortController().signal),
      recorded.detail("abc", new AbortController().signal),
    ]);

    expect(results[0]).toMatchObject({
      status: "rejected",
      reason: { kind: RecipeErrorKind.Unavailable },
    });
    expect(results[1]).toMatchObject({
      status: "rejected",
      reason: { kind: RecipeErrorKind.InvalidQuery },
    });
  });

  it("reports unrecorded requests as not found", async () => {
    const recorded = source();
    const results = await Promise.allSettled([
      recorded.search("没录过", 1, new AbortController().signal),
      recorded.search("虾仁", 2, new AbortController().signal),
    ]);

    expect(results[0]).toMatchObject({
      status: "rejected",
      reason: {
        kind: RecipeErrorKind.NotFound,
        detail: NOT_FOUND_RECORDING_DETAIL,
      },
    });
    expect(results[1]).toMatchObject({
      status: "rejected",
      reason: { kind: RecipeErrorKind.NotFound },
    });
  });

  it("does not answer a cancelled request", async () => {
    const recorded = source();
    const controller = new AbortController();
    const cancelled = recorded.search("虾仁", 1, controller.signal);
    controller.abort();
    const pending = recorded.search(
      "番茄炒蛋",
      1,
      new AbortController().signal,
    );

    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    await expect(pending).resolves.toMatchObject({
      keyword: "番茄炒蛋",
      page: 1,
    });
  });
});
