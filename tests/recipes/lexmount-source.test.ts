import { afterEach, describe, expect, it } from "vitest";

import {
  LexmountRecipeError,
  LexmountRecipeSource,
  type LexmountSourceOptions,
} from "../../server/recipes/lexmount-source.js";
import {
  RecipeErrorKind,
  type WebRecipe,
} from "../../server/recipes/types.js";
import { FakeLexmountServer } from "../helpers/fake-lexmount-server.js";

function detailScrape(): Record<string, unknown> {
  return {
    Content: [
      {
        name: "测试番茄炒蛋",
        cover: "https://i2.chuimg.com/cover.jpg",
        grade: "8.4",
        materials: [
          { name: "番茄", unit: "2个" },
          { name: "鸡蛋", unit: "" },
        ],
        steps: [
          { desc: "切块。", img: "/photo/1.jpg" },
          { desc: "下锅。", img: null },
        ],
        tip: "别炒老。",
      },
    ],
    diag: { title: "下厨房" },
  };
}

function searchScrape(): Record<string, unknown> {
  return {
    Recipe: [
      {
        name: "虾仁滑蛋",
        url: "/recipe/111/",
        cover: "//i2.chuimg.com/a.jpg",
      },
      { name: "", url: "/recipe/222/" },
      { name: "椒盐虾仁", url: "/recipe/333/" },
    ],
    diag: { list: true, path: "/search/" },
  };
}

function options(server: FakeLexmountServer): LexmountSourceOptions {
  return {
    credentials: () => ({
      apiKey: "test-key",
      projectId: "test-project",
    }),
    baseUrl: server.url,
    timeouts: {
      pollIntervalMs: 10,
      stepTimeoutMs: 2_000,
      httpTimeoutMs: 2_000,
      sessionReadyTimeoutMs: 2_000,
      pageWaitTimeoutMs: 3_000,
      totalTimeoutMs: 8_000,
      cleanupTimeoutMs: 2_000,
    },
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= end) {
      throw new Error("condition did not become true");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function errorOf(
  promise: Promise<unknown>,
): Promise<LexmountRecipeError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof LexmountRecipeError) {
      return error;
    }
    throw error;
  }
  throw new Error("request unexpectedly succeeded");
}

const servers: FakeLexmountServer[] = [];

async function fake(): Promise<FakeLexmountServer> {
  const server = await new FakeLexmountServer().start();
  servers.push(server);
  return server;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("Lexmount recipe source", () => {
  it(
    "waits for the navigated page before scraping",
    { timeout: 10_000 },
    async () => {
      const server = await fake();
      server.detailScrape = detailScrape();
      const source = new LexmountRecipeSource(options(server));

      const recipe = await source.detail(
        "123456",
        new AbortController().signal,
      );

      expect(recipe).toMatchObject({
        id: "123456",
        name: "测试番茄炒蛋",
        imageUrl: "https://i2.chuimg.com/cover.jpg",
        rating: 8.4,
        tips: ["别炒老。"],
        partial: false,
        attribution: {
          sourceUrl: "https://www.xiachufang.com/recipe/123456/",
          provider: "lexmount",
        },
      });
      expect(recipe.ingredients).toHaveLength(2);
      expect(recipe.ingredients[0]).toMatchObject({
        raw: "番茄 2个",
      });
      expect(recipe.ingredients[1]).toMatchObject({
        raw: "鸡蛋",
        amount: "",
      });
      expect(recipe.steps).toHaveLength(2);
      expect(recipe.steps[0]?.imageUrl).toBe(
        "https://www.xiachufang.com/photo/1.jpg",
      );

      const navigate = server.commands.indexOf("Page.navigate");
      const scrape = server.commands.indexOf("Runtime.evaluate:scrape");
      expect(navigate).toBeGreaterThanOrEqual(0);
      expect(scrape).toBeGreaterThan(navigate);
      expect(
        server.commands
          .slice(navigate, scrape)
          .filter((command) => command === "Runtime.evaluate:state"),
      ).toHaveLength(3);
      expect(
        server.commands.filter(
          (command) => command === "Runtime.evaluate:scrape",
        ),
      ).toHaveLength(1);
      await waitFor(() => server.deletes === 1);
    },
  );

  it(
    "deletes the session with the submodules request",
    { timeout: 10_000 },
    async () => {
      const server = await fake();
      server.detailScrape = detailScrape();
      const source = new LexmountRecipeSource(options(server));

      await source.detail("1", new AbortController().signal);
      await waitFor(() => server.deletes === 1);

      for (const record of server.http) {
        expect(record.headers["x-api-key"]).toBe("test-key");
        expect(record.headers["x-project-id"]).toBe("test-project");
      }
      const deleted = server.http.at(-1);
      expect(deleted).toMatchObject({
        method: "DELETE",
        path: "/instance",
      });
      expect(deleted?.headers["content-type"]).toBe("application/json");
      expect(JSON.parse(deleted?.body ?? "{}")).toEqual({
        session_id: "s1",
      });
    },
  );

  it(
    "skips search rows without a name",
    { timeout: 10_000 },
    async () => {
      const server = await fake();
      server.searchScrape = searchScrape();
      const source = new LexmountRecipeSource(options(server));

      const result = await source.search(
        "虾仁",
        1,
        new AbortController().signal,
      );

      expect(result).toMatchObject({
        keyword: "虾仁",
        partial: true,
        warnings: ["skipped_unusable_rows"],
      });
      expect(result.items.map((item) => item.id)).toEqual([
        "111",
        "333",
      ]);
      expect(result.items[0]?.imageUrl).toBe(
        "https://i2.chuimg.com/a.jpg",
      );
      await waitFor(() => server.deletes === 1);
      expect(server.http[0]?.body).toContain("browser_mode");
    },
  );

  it(
    "ignores CDP pings",
    { timeout: 10_000 },
    async () => {
      const server = await fake();
      server.pingBeforeReplies = true;
      server.detailScrape = detailScrape();
      const source = new LexmountRecipeSource(options(server));

      await expect(
        source.detail("1", new AbortController().signal),
      ).resolves.toMatchObject({ id: "1" });
    },
  );

  it(
    "reports a non-recipe page as blocked with its title",
    { timeout: 10_000 },
    async () => {
      const server = await fake();
      server.landedPath = "/auth/verify";
      server.detailScrape = {
        diag: {
          title: "安全验证",
          host: "www.xiachufang.com",
          path: "/auth/verify",
        },
      };
      const source = new LexmountRecipeSource(options(server));

      const error = await errorOf(
        source.detail("1", new AbortController().signal),
      );

      expect(error).toMatchObject({ kind: RecipeErrorKind.Blocked });
      expect(error.detail).toContain("安全验证");
      expect(error.detail).toContain(
        "www.xiachufang.com/auth/verify",
      );
      expect(error.detail).not.toContain("test-key");
      await waitFor(() => server.deletes === 1);
    },
  );

  it(
    "treats a search page without a list as empty",
    { timeout: 10_000 },
    async () => {
      const server = await fake();
      server.searchScrape = {
        Recipe: [],
        diag: {
          list: false,
          path: "/search/",
          title: "没找到 - 下厨房",
        },
      };
      const source = new LexmountRecipeSource(options(server));

      const result = await source.search(
        "zzz",
        1,
        new AbortController().signal,
      );
      expect(result.items).toEqual([]);
    },
  );

  it(
    "deletes the session after an error",
    { timeout: 10_000 },
    async () => {
      const server = await fake();
      server.versionStatus = 500;
      const source = new LexmountRecipeSource(options(server));

      const error = await errorOf(
        source.detail("1", new AbortController().signal),
      );
      expect(error).toMatchObject({
        kind: RecipeErrorKind.Unavailable,
      });
      await waitFor(() => server.deletes === 1);
    },
  );

  it(
    "reports rejected credentials as authentication failures",
    { timeout: 10_000 },
    async () => {
      const server = await fake();
      server.createStatus = 401;
      const source = new LexmountRecipeSource(options(server));

      const error = await errorOf(
        source.detail("1", new AbortController().signal),
      );
      expect(error).toMatchObject({
        kind: RecipeErrorKind.AuthFailed,
      });
      expect(server.deletes).toBe(0);
    },
  );

  it(
    "deletes the session after a timeout",
    { timeout: 10_000 },
    async () => {
      const server = await fake();
      server.stallNavigate = true;
      const sourceOptions = options(server);
      sourceOptions.timeouts = {
        ...sourceOptions.timeouts,
        stepTimeoutMs: 300,
      };
      const source = new LexmountRecipeSource(sourceOptions);

      const error = await errorOf(
        source.detail("1", new AbortController().signal),
      );
      expect(error).toMatchObject({ kind: RecipeErrorKind.Timeout });
      await waitFor(() => server.deletes === 1);
    },
  );

  it(
    "cancels silently and deletes the session",
    { timeout: 10_000 },
    async () => {
      const server = await fake();
      server.stallNavigate = true;
      const source = new LexmountRecipeSource(options(server));
      const controller = new AbortController();
      const pending = source.detail("1", controller.signal);

      await waitFor(() =>
        server.commands.includes("Page.navigate"),
      );
      controller.abort();
      await expect(pending).rejects.toMatchObject({
        name: "AbortError",
      });
      await waitFor(() => server.deletes === 1);
    },
  );

  it(
    "deletes a session created while the request is cancelled",
    { timeout: 10_000 },
    async () => {
      const server = await fake();
      server.createDelayMs = 400;
      server.detailScrape = detailScrape();
      const source = new LexmountRecipeSource(options(server));
      const controller = new AbortController();
      const pending = source.detail("1", controller.signal);

      await waitFor(() => server.created === 1);
      expect(server.deletes).toBe(0);
      controller.abort();
      await expect(pending).rejects.toMatchObject({
        name: "AbortError",
      });
      await waitFor(() => server.deletes === 1);

      const deleted = server.http.at(-1);
      expect(deleted?.method).toBe("DELETE");
      expect(JSON.parse(deleted?.body ?? "{}")).toEqual({
        session_id: "s1",
      });
      expect(server.commands).toEqual([]);
    },
  );

  it(
    "deletes a session that arrives after its creation times out",
    { timeout: 10_000 },
    async () => {
      const server = await fake();
      server.createDelayMs = 600;
      const sourceOptions = options(server);
      sourceOptions.timeouts = {
        ...sourceOptions.timeouts,
        httpTimeoutMs: 200,
      };
      const source = new LexmountRecipeSource(sourceOptions);

      const error = await errorOf(
        source.detail("1", new AbortController().signal),
      );
      expect(error).toMatchObject({ kind: RecipeErrorKind.Timeout });
      await waitFor(() => server.deletes === server.created);
      expect(server.created).toBe(1);
    },
  );

  it(
    "does not leak a cancelled request's late reply into the next one",
    { timeout: 10_000 },
    async () => {
      const server = await fake();
      server.detailScrape = detailScrape();
      server.searchScrape = searchScrape();
      const source = new LexmountRecipeSource(options(server));
      const controller = new AbortController();
      const detail = source.detail("1", controller.signal);

      await waitFor(() => server.created >= 1);
      controller.abort();
      const rejected = expect(detail).rejects.toMatchObject({
        name: "AbortError",
      });
      const search = source.search(
        "虾仁",
        1,
        new AbortController().signal,
      );

      const result = await search;
      await rejected;
      expect(result.keyword).toBe("虾仁");
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
      await waitFor(() => server.deletes === 2);
    },
  );

  it(
    "runs search and detail independently",
    { timeout: 10_000 },
    async () => {
      const server = await fake();
      server.detailScrape = detailScrape();
      server.searchScrape = searchScrape();
      const source = new LexmountRecipeSource(options(server));

      const [search, detail] = await Promise.all([
        source.search("虾仁", 1, new AbortController().signal),
        source.detail("42", new AbortController().signal),
      ]);

      expect(search.keyword).toBe("虾仁");
      expect((detail as WebRecipe).id).toBe("42");
      await waitFor(() => server.deletes === 2);
    },
  );

  it("fails asynchronously for missing credentials and bad input", async () => {
    const none = new LexmountRecipeSource({
      credentials: () => ({ apiKey: "", projectId: "" }),
    });
    let settled = false;
    const missing = none
      .search("x", 1, new AbortController().signal)
      .finally(() => {
        settled = true;
      });
    expect(settled).toBe(false);
    expect(await errorOf(missing)).toMatchObject({
      kind: RecipeErrorKind.NotConfigured,
    });

    const server = await fake();
    const source = new LexmountRecipeSource(options(server));
    const bad = await Promise.allSettled([
      source.detail("abc", new AbortController().signal),
      source.search("  ", 1, new AbortController().signal),
    ]);
    expect(bad[0]).toMatchObject({
      status: "rejected",
      reason: { kind: RecipeErrorKind.InvalidQuery },
    });
    expect(bad[1]).toMatchObject({
      status: "rejected",
      reason: { kind: RecipeErrorKind.InvalidQuery },
    });
    expect(server.created).toBe(0);
  });

  it(
    "reports an unreachable server as a network error",
    { timeout: 10_000 },
    async () => {
      const source = new LexmountRecipeSource({
        credentials: () => ({
          apiKey: "test-key",
          projectId: "test-project",
        }),
        baseUrl: "http://127.0.0.1:1",
        timeouts: { httpTimeoutMs: 2_000 },
      });

      const error = await errorOf(
        source.detail("1", new AbortController().signal),
      );
      expect(error).toMatchObject({
        kind: RecipeErrorKind.NetworkError,
      });
    },
  );
});
