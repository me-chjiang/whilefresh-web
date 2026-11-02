import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { RecipeErrorKind } from "../../server/recipes/types.js";
import { WebRecipeService } from "../../server/services/web-recipe-service.js";
import { RecordedRecipeSource } from "../helpers/recorded-recipe-source.js";

const samples = fileURLToPath(
  new URL("../../test-data/recipes/xiachufang/", import.meta.url),
);

function recordedSource(): RecordedRecipeSource {
  const source = new RecordedRecipeSource();
  expect(source.addDirectory(samples)).toBe(7);
  return source;
}

describe("web recipe service", () => {
  it("shows only results from the current search", async () => {
    const service = new WebRecipeService(recordedSource());
    const first = service.search(
      " 虾仁 ",
      1,
      new AbortController().signal,
    );
    expect(service.searchState()).toBe("busy");

    const second = service.search(
      "番茄炒蛋",
      1,
      new AbortController().signal,
    );
    expect(service.searchState()).toBe("busy");
    expect(service.results()).toEqual([]);

    const [firstResults, secondResults] = await Promise.all([first, second]);
    expect(firstResults).toEqual([]);
    expect(secondResults.map(({ name }) => name)).toEqual([
      "超嫩滑的番茄炒蛋",
      "简单美味❗️好吃到舔盘的番茄炒蛋拌饭",
    ]);
    expect(service.results()).toEqual(secondResults);
  });

  it("adds source attribution and caches details in memory", async () => {
    const source = recordedSource();
    const detailRequest = vi.spyOn(source, "detail");
    const service = new WebRecipeService(source);

    const detail = await service.detail(
      "103468406",
      new AbortController().signal,
    );
    expect(detail).toMatchObject({
      id: "103468406",
      name: "【虾仁滑蛋】超嫩滑，复刻茶餐厅经典",
      rating: 8.1,
      partial: false,
      ingredients: [
        { raw: "鸡蛋 4个" },
        { raw: "虾仁 200克" },
        { raw: "葱 1束" },
      ],
      steps: [
        { order: 1, text: "准备食材" },
        { order: 2, text: expect.stringContaining("虾仁冲洗后") },
      ],
      tips: [expect.stringContaining("我这里用了冷冻虾仁")],
      attribution: {
        source: "下厨房",
        url: "https://www.xiachufang.com/recipe/103468406/",
        author: "",
      },
    });
    expect(service.detailState()).toBe("done");

    const cached = await service.detail(
      "103468406",
      new AbortController().signal,
    );
    expect(cached).toBe(detail);
    expect(detailRequest).toHaveBeenCalledTimes(1);
  });

  it("turns recipe errors into short Chinese labels", async () => {
    const service = new WebRecipeService(recordedSource());

    await expect(
      service.detail("abc", new AbortController().signal),
    ).resolves.toBeNull();
    expect(service.detailState()).toBe("error");
    expect(service.detailError()).toBe("输入有误");

    await expect(
      service.search("没录过", 1, new AbortController().signal),
    ).resolves.toEqual([]);
    expect(service.searchState()).toBe("error");
    expect(service.searchError()).toBe("没有找到");

    expect(WebRecipeService.errorLabel(RecipeErrorKind.Blocked)).toBe(
      "下厨房拦截",
    );
    expect(WebRecipeService.errorLabel(RecipeErrorKind.NotConfigured)).toBe(
      "未配置 Lexmount",
    );
    expect(WebRecipeService.errorLabel(RecipeErrorKind.NetworkError)).toBe(
      "网络错误",
    );
    expect(WebRecipeService.errorLabel(RecipeErrorKind.Timeout)).toBe(
      "超时",
    );
    expect(WebRecipeService.errorLabel(RecipeErrorKind.BadResponse)).toBe(
      "菜谱源不可用",
    );
  });

  it("reset discards results and the detail cache", async () => {
    const source = recordedSource();
    const detailRequest = vi.spyOn(source, "detail");
    const service = new WebRecipeService(source);

    await service.search("虾仁", 1, new AbortController().signal);
    await service.detail("103468406", new AbortController().signal);
    expect(service.results()).toHaveLength(2);
    expect(service.detailState()).toBe("done");

    service.reset();
    expect(service.results()).toEqual([]);
    expect(service.searchState()).toBe("idle");
    expect(service.detailState()).toBe("idle");

    await service.detail("103468406", new AbortController().signal);
    expect(detailRequest).toHaveBeenCalledTimes(2);
  });

  it("cancels both active searches and detail requests", async () => {
    const source = recordedSource();
    const searchRequest = vi.spyOn(source, "search");
    const detailRequest = vi.spyOn(source, "detail");
    const service = new WebRecipeService(source);
    const controller = new AbortController();

    const search = service.search("虾仁", 1, controller.signal);
    const detail = service.detail("103468406", controller.signal);
    controller.abort();

    await expect(search).resolves.toEqual([]);
    await expect(detail).resolves.toBeNull();
    expect(searchRequest.mock.calls[0]?.[2].aborted).toBe(true);
    expect(detailRequest.mock.calls[0]?.[1].aborted).toBe(true);
  });
});
