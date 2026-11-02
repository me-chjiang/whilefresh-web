import fastifyMultipart from "@fastify/multipart";
import Fastify, {
  type FastifyError,
  type FastifyInstance,
} from "fastify";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  ClearPreviewDto,
  ClearRecipesResult,
  ImportStatusDto,
  RecipeDetailDto,
  RecipeSummaryDto,
  ShoppingDto,
  ShoppingTextDto,
  StateDto,
} from "../../shared/api.js";
import { ImportStatus, SuggestionKind } from "../../shared/enums.js";
import { loadBuiltin } from "../../server/data/builtin.js";
import { fixedClock } from "../../server/domain/clock.js";
import { ResumableJob } from "../../server/domain/resumable-job.js";
import { DemoRecognizer } from "../../server/recognition/replay.js";
import { registerClearRoutes } from "../../server/routes/clear.js";
import { registerImportRoutes } from "../../server/routes/import.js";
import { registerItemRoutes } from "../../server/routes/items.js";
import { registerProfileRoutes } from "../../server/routes/profile.js";
import { registerRecipeRoutes } from "../../server/routes/recipes.js";
import { registerShoppingRoutes } from "../../server/routes/shopping.js";
import {
  registerStateRoutes,
  type RouteContext,
} from "../../server/routes/state.js";
import {
  AppState,
  type AppStateOptions,
} from "../../server/services/app-state.js";

interface Harness {
  app: FastifyInstance;
  state: AppState;
  context: RouteContext;
  dataDir: string;
}

interface HarnessOptions {
  dataDir?: string;
  realRecognizer?: AppStateOptions["realRecognizer"];
}

const builtin = loadBuiltin();
const clock = fixedClock(new Date(2026, 9, 21, 12, 0));
const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const dataDir =
    options.dataDir ?? mkdtempSync(join(tmpdir(), "whilefresh-routes-"));
  const state = new AppState({
    dataDir,
    builtin,
    clock,
    apiKey: "",
    realRecognizer: options.realRecognizer,
  });
  const context: RouteContext = {
    state,
    builtin,
    dataDir,
    clock,
  };
  const app = Fastify({ logger: false });

  await app.register(fastifyMultipart, {
    attachFieldsToBody: true,
    limits: {
      fieldSize: 200_000,
      fields: 100,
      fileSize: 50 * 1024 * 1024,
      files: 30,
      parts: 160,
    },
  });

  registerStateRoutes(app, context);
  registerRecipeRoutes(app, context);
  registerClearRoutes(app, context);
  registerItemRoutes(app, context);
  registerShoppingRoutes(app, context);
  registerProfileRoutes(app, context);
  registerImportRoutes(app, context);

  app.get("/api/health", async () => ({ status: "ok" }));
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) {
      return reply.code(404).send({ error: "接口不存在" });
    }
    return reply.code(404).send({ error: "页面不存在" });
  });
  app.setErrorHandler(
    (error: FastifyError, _request, reply) => {
      if (error.validation || error.statusCode === 400) {
        return reply.code(400).send({ error: "请求参数不正确" });
      }
      if (error.statusCode === 413) {
        return reply.code(413).send({ error: "上传文件过大" });
      }
      if (error.statusCode === 415) {
        return reply.code(415).send({ error: "请求格式不支持" });
      }
      if (
        error.statusCode != null &&
        error.statusCode >= 400 &&
        error.statusCode < 500
      ) {
        return reply
          .code(error.statusCode)
          .send({ error: "请求参数不正确" });
      }
      return reply.code(500).send({ error: "服务暂时不可用，请重试" });
    },
  );
  app.addHook("onClose", async () => {
    state.close();
  });

  return { app, state, context, dataDir };
}

function multipartBody(fields: readonly [string, string][], files: readonly {
  name: string;
  filename: string;
  mimeType: string;
  data: Buffer;
}[]): { body: Buffer; contentType: string } {
  const boundary = "----whilefresh-route-test";
  const chunks: Buffer[] = [];
  for (const [name, value] of fields) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
          `${value}\r\n`,
      ),
    );
  }
  for (const file of files) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${file.name}"; ` +
          `filename="${file.filename}"\r\n` +
          `Content-Type: ${file.mimeType}\r\n\r\n`,
      ),
      file.data,
      Buffer.from("\r\n"),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

describe("HTTP API routes", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.app.close();
    rmSync(harness.dataDir, { recursive: true, force: true });
  });

  async function readState(): Promise<StateDto> {
    const response = await harness.app.inject({
      method: "GET",
      url: "/api/state",
    });
    expect(response.statusCode).toBe(200);
    return response.json<StateDto>();
  }

  async function createItem(name: string): Promise<number> {
    const before = await readState();
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/items",
      payload: {
        name,
        quantity: "1份",
        location: "冷藏",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true });
    const after = await readState();
    const knownIds = new Set(before.items.map((item) => item.id));
    const created = after.items.filter((item) => !knownIds.has(item.id));
    expect(created).toHaveLength(1);
    return created[0]!.id;
  }

  async function uploadOneImage(): Promise<ImportStatusDto> {
    const multipart = multipartBody(
      [
        ["origin", "gallery"],
        ["lastModified", "1792540800000"],
      ],
      [
        {
          name: "images",
          filename: "first.png",
          mimeType: "image/png",
          data: onePixelPng,
        },
      ],
    );
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/import/images",
      headers: { "content-type": multipart.contentType },
      payload: multipart.body,
    });
    expect(response.statusCode).toBe(200);
    return response.json<ImportStatusDto>();
  }

  it("serves health, state, recipes, shopping and import reads", async () => {
    const health = await harness.app.inject({
      method: "GET",
      url: "/api/health",
    });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: "ok" });

    const state = await readState();
    expect(state.items).toEqual([]);
    expect(state.importState).toBe("idle");

    const recipes = await harness.app.inject({
      method: "GET",
      url: "/api/recipes",
    });
    expect(recipes.statusCode).toBe(200);
    const recipeList = recipes.json<RecipeSummaryDto[]>();
    expect(recipeList.length).toBeGreaterThan(0);

    const detail = await harness.app.inject({
      method: "GET",
      url: `/api/recipes/${encodeURIComponent(recipeList[0]!.id)}`,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json<RecipeDetailDto>().id).toBe(recipeList[0]!.id);

    const shopping = await harness.app.inject({
      method: "GET",
      url: "/api/shopping",
    });
    expect(shopping.statusCode).toBe(200);
    expect(shopping.json<ShoppingDto[]>()).toEqual([]);

    const shoppingText = await harness.app.inject({
      method: "GET",
      url: "/api/shopping/text",
    });
    expect(shoppingText.statusCode).toBe(200);
    expect(shoppingText.json<ShoppingTextDto>().text).toContain("待买清单");

    const importStatus = await harness.app.inject({
      method: "GET",
      url: "/api/import",
    });
    expect(importStatus.statusCode).toBe(200);
    expect(importStatus.json<ImportStatusDto>().importState).toBe("idle");
  });

  it("switches demo mode and exposes exactly eight demo items", async () => {
    const enabled = await harness.app.inject({
      method: "PUT",
      url: "/api/demo",
      payload: { enabled: true },
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json<StateDto>().demoMode).toBe(true);

    const state = await readState();
    expect(state.demoMode).toBe(true);
    expect(state.items).toHaveLength(8);

    const disabled = await harness.app.inject({
      method: "PUT",
      url: "/api/demo",
      payload: { enabled: false },
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json<StateDto>().demoMode).toBe(false);
  });

  it("creates, edits and resolves fridge items", async () => {
    const id = await createItem("西红柿");

    const updated = await harness.app.inject({
      method: "PATCH",
      url: `/api/items/${id}`,
      payload: {
        id,
        edits: {
          name: "番茄",
          quantity: "2个",
          location: "冷藏",
        },
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ ok: true });

    const first = await harness.app.inject({
      method: "POST",
      url: `/api/items/${id}/first`,
      payload: { id, enabled: true },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ ok: true });

    const usedId = await createItem("黄瓜");
    const used = await harness.app.inject({
      method: "POST",
      url: `/api/items/${usedId}/use`,
      payload: { id: usedId },
    });
    expect(used.statusCode).toBe(200);
    expect(used.json()).toEqual({ ok: true });

    const absent = await harness.app.inject({
      method: "POST",
      url: `/api/items/${id}/absent`,
      payload: { id },
    });
    expect(absent.statusCode).toBe(200);
    expect(absent.json()).toEqual({ ok: true });

    const firstRemoveId = await createItem("生菜");
    const secondRemoveId = await createItem("油菜");
    const removed = await harness.app.inject({
      method: "POST",
      url: "/api/items/remove",
      payload: { ids: [firstRemoveId, secondRemoveId] },
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toEqual({ ok: true });
  });

  it("discards an item and rejects an item that was already processed", async () => {
    const id = await createItem("土豆");

    const discarded = await harness.app.inject({
      method: "POST",
      url: `/api/items/${id}/discard`,
      payload: { id },
    });
    expect(discarded.statusCode).toBe(200);
    expect(discarded.json()).toEqual({ ok: true });
    expect((await readState()).items.some((item) => item.id === id)).toBe(
      false,
    );

    const again = await harness.app.inject({
      method: "POST",
      url: `/api/items/${id}/discard`,
      payload: { id },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: "食材已处理" });
  });

  it("snoozes a near-expiry item and rejects an item that is not near expiry", async () => {
    const nearId = await createItem("牛奶");
    const edited = await harness.app.inject({
      method: "PATCH",
      url: `/api/items/${nearId}`,
      payload: {
        id: nearId,
        edits: { shelfDays: "8", storedAt: "2026-10-15" },
      },
    });
    expect(edited.statusCode).toBe(200);

    const snoozed = await harness.app.inject({
      method: "POST",
      url: `/api/items/${nearId}/snooze`,
      payload: { id: nearId },
    });
    expect(snoozed.statusCode).toBe(200);
    expect(snoozed.json()).toEqual({ ok: true });
    expect(
      (await readState()).items.find((item) => item.id === nearId)?.snoozed,
    ).toBe(true);

    const freshId = await createItem("大米");
    const rejected = await harness.app.inject({
      method: "POST",
      url: `/api/items/${freshId}/snooze`,
      payload: { id: freshId },
    });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json()).toEqual({ error: "只能忽略临期食材" });
  });

  it("previews and searches clear-fridge recipes", async () => {
    const id = await createItem("西红柿");
    const preview = await harness.app.inject({
      method: "POST",
      url: "/api/clear/preview",
      payload: { selected: [id] },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json<ClearPreviewDto>().selectedCount).toBe(1);

    const search = await harness.app.inject({
      method: "POST",
      url: "/api/clear/search",
      payload: { selected: [id] },
    });
    expect(search.statusCode).toBe(200);
    const result = search.json<ClearRecipesResult>();
    expect(result.summary.selectedCount).toBe(1);
    expect(result.recipes.length).toBeGreaterThan(0);
  });

  it("saves and deletes shelf and storage rules with separate consent routes", async () => {
    const confirm = await harness.app.inject({
      method: "POST",
      url: "/api/rules/remembered/confirm",
    });
    expect(confirm.statusCode).toBe(200);
    expect(confirm.json()).toEqual({ ok: true });

    const dismiss = await harness.app.inject({
      method: "POST",
      url: "/api/rules/remembered/dismiss",
    });
    expect(dismiss.statusCode).toBe(200);
    expect(dismiss.json()).toEqual({ ok: true });

    const shelf = await harness.app.inject({
      method: "PUT",
      url: "/api/rules",
      payload: {
        name: "鸡蛋",
        oldLocation: "",
        location: "冷藏",
        days: "7",
      },
    });
    expect(shelf.statusCode).toBe(200);

    const deleteShelf = await harness.app.inject({
      method: "DELETE",
      url: "/api/rules",
      payload: {
        name: "鸡蛋",
        location: "冷藏",
        kind: "shelf",
      },
    });
    expect(deleteShelf.statusCode).toBe(200);

    const storage = await harness.app.inject({
      method: "PUT",
      url: "/api/rules",
      payload: {
        name: "鸡蛋",
        oldLocation: "",
        location: "常温",
        days: "",
      },
    });
    expect(storage.statusCode).toBe(200);

    const deleteStorage = await harness.app.inject({
      method: "DELETE",
      url: "/api/rules",
      payload: {
        name: "鸡蛋",
        location: "",
        kind: "storage",
      },
    });
    expect(deleteStorage.statusCode).toBe(200);
  });

  it("manages pantry items, suggestions, missing ingredients and shopping", async () => {
    const addPantry = await harness.app.inject({
      method: "POST",
      url: "/api/pantry",
      payload: { name: "鸡蛋" },
    });
    expect(addPantry.statusCode).toBe(200);
    expect(addPantry.json()).toEqual({ ok: true });

    const removePantry = await harness.app.inject({
      method: "DELETE",
      url: `/api/pantry/${encodeURIComponent("鸡蛋")}`,
      payload: { name: "鸡蛋" },
    });
    expect(removePantry.statusCode).toBe(200);
    expect(removePantry.json()).toEqual({ ok: true });

    const suggestionId = harness.state.activeStore.addSuggestion({
      kind: SuggestionKind.AddToShopping,
      name: "鸡蛋",
      message: "鸡蛋用完了，加入待买清单吗？",
    });
    expect(suggestionId).toBeGreaterThan(0);
    const decide = await harness.app.inject({
      method: "POST",
      url: `/api/suggestions/${suggestionId}`,
      payload: { id: suggestionId, accept: true },
    });
    expect(decide.statusCode).toBe(200);

    const shopping = await harness.app.inject({
      method: "GET",
      url: "/api/shopping",
    });
    expect(shopping.statusCode).toBe(200);
    const shoppingItems = shopping.json<ShoppingDto[]>();
    expect(shoppingItems.length).toBeGreaterThan(0);

    const recipe = builtin.recipes[0]!;
    const addMissing = await harness.app.inject({
      method: "POST",
      url: `/api/recipes/${encodeURIComponent(recipe.id)}/add-missing`,
      payload: { id: recipe.id, selected: [] },
    });
    expect(addMissing.statusCode).toBe(200);
    expect(addMissing.json()).toHaveProperty("added");

    const removeShopping = await harness.app.inject({
      method: "DELETE",
      url: `/api/shopping/${shoppingItems[0]!.id}`,
      payload: { id: shoppingItems[0]!.id },
    });
    expect(removeShopping.statusCode).toBe(200);
    expect(removeShopping.json()).toEqual({ ok: true });
  });

  it("runs a demo text import through draft editing and confirmation", async () => {
    const prepared = await harness.app.inject({
      method: "POST",
      url: "/api/import/text",
      payload: { text: "演示 火锅肥牛片 200g，演示 西兰花 1颗" },
    });
    expect(prepared.statusCode).toBe(200);
    expect(prepared.json<ImportStatusDto>().importState).toBe("prepared");

    await harness.app.inject({
      method: "PUT",
      url: "/api/demo",
      payload: { enabled: true },
    });
    const demoPrepared = await harness.app.inject({
      method: "POST",
      url: "/api/import/text",
      payload: { text: "演示 火锅肥牛片 200g，演示 西兰花 1颗" },
    });
    expect(demoPrepared.statusCode).toBe(200);

    const started = await harness.app.inject({
      method: "POST",
      url: "/api/import/start",
      payload: { privacyConfirmed: true, allowDuplicate: true },
    });
    expect(started.statusCode).toBe(200);
    expect(started.json<ImportStatusDto>().importState).toBe("draft");

    const edited = await harness.app.inject({
      method: "PATCH",
      url: "/api/import/draft/0",
      payload: {
        index: 0,
        edits: { quantity: "250g", location: "冷冻" },
      },
    });
    expect(edited.statusCode).toBe(200);

    const categorized = await harness.app.inject({
      method: "POST",
      url: "/api/import/draft/0/category",
      payload: { index: 0, category: "food" },
    });
    expect(categorized.statusCode).toBe(200);

    const dropped = await harness.app.inject({
      method: "POST",
      url: "/api/import/draft/0/drop",
      payload: { index: 0 },
    });
    expect(dropped.statusCode).toBe(200);

    const retrieved = await harness.app.inject({
      method: "POST",
      url: "/api/import/draft/0/retrieve",
      payload: { index: 0 },
    });
    expect(retrieved.statusCode).toBe(200);

    const confirmed = await harness.app.inject({
      method: "POST",
      url: "/api/import/confirm",
      payload: { allowDuplicate: true },
    });
    expect(confirmed.statusCode).toBe(200);

    const imports = harness.state.activeKitchen.imports();
    expect(imports.length).toBeGreaterThan(0);
    const importId = Math.max(...imports.map((record) => record.id ?? 0));
    const deleted = await harness.app.inject({
      method: "DELETE",
      url: `/api/imports/${importId}`,
      payload: { id: importId },
    });
    expect(deleted.statusCode).toBe(200);

    await harness.app.inject({
      method: "POST",
      url: "/api/import/text",
      payload: { text: "待取消导入" },
    });
    const cancelled = await harness.app.inject({
      method: "POST",
      url: "/api/import/cancel",
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json<ImportStatusDto>().importState).toBe("idle");
  });

  it("skips a same-image duplicate import", async () => {
    const originalId = harness.state.activeStore.insertImport({
      inputKind: "screenshot",
      images: [
        {
          path: join(harness.dataDir, "original.png"),
          sha256: createHash("sha256")
            .update(onePixelPng)
            .digest("hex"),
          mimeType: "image/png",
        },
      ],
    });
    expect(originalId).toBeGreaterThan(0);

    const duplicate = await uploadOneImage();
    expect(duplicate.importState).toBe("duplicate");

    const skipped = await harness.app.inject({
      method: "POST",
      url: "/api/import/skip",
      payload: {},
    });
    expect(skipped.statusCode).toBe(200);
    expect(skipped.json<ImportStatusDto>().importState).toBe("idle");

    const records = harness.state.activeKitchen.imports();
    expect(records).toHaveLength(2);
    const record = records.find((item) => item.status === ImportStatus.SkippedDuplicate);
    expect(record?.duplicateOf).toBe(originalId);
    expect(record?.images).toEqual([]);
  });

  it("resumes a persisted image import", async () => {
    expect((await uploadOneImage()).importState).toBe("prepared");
    const started = await harness.app.inject({
      method: "POST",
      url: "/api/import/start",
      payload: { privacyConfirmed: true, allowDuplicate: true },
    });
    expect(started.statusCode).toBe(200);
    expect(started.json<ImportStatusDto>().importState).toBe("failed");
    expect(harness.state.activeStore.importJobRows()).toHaveLength(1);

    const original = harness;
    const restarted = await createHarness({
      dataDir: original.dataDir,
      realRecognizer: new DemoRecognizer(),
    });
    harness = restarted;
    try {
      const resumed = await restarted.app.inject({
        method: "POST",
        url: "/api/import/resume",
        payload: {},
      });
      expect(resumed.statusCode).toBe(200);
      const status = resumed.json<ImportStatusDto>();
      expect(status.importState).toBe("draft");
      expect(status.draftItems.length).toBeGreaterThan(0);
    } finally {
      await original.app.close();
    }
  });

  it("discards unfinished import jobs and clears import history", async () => {
    expect(
      harness.state.activeStore.insertImportJob(
        "{}",
        new ResumableJob(),
      ),
    ).toBeGreaterThan(0);
    const discarded = await harness.app.inject({
      method: "POST",
      url: "/api/import/discard-unfinished",
      payload: {},
    });
    expect(discarded.statusCode).toBe(200);
    expect(discarded.json<ImportStatusDto>().importState).toBe("idle");
    expect(harness.state.activeStore.importJobRows()).toEqual([]);

    expect(
      harness.state.activeStore.insertImport({ inputKind: "screenshot" }),
    ).toBeGreaterThan(0);
    expect(
      harness.state.activeStore.insertImport({ inputKind: "screenshot" }),
    ).toBeGreaterThan(0);
    const cleared = await harness.app.inject({
      method: "DELETE",
      url: "/api/imports",
      payload: {},
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toEqual({ ok: true });
    expect(harness.state.activeKitchen.imports()).toEqual([]);
  });

  it("rejects import continuation actions when their required state is missing", async () => {
    const prepared = await harness.app.inject({
      method: "POST",
      url: "/api/import/text",
      payload: { text: "当前草稿不能继续" },
    });
    expect(prepared.statusCode).toBe(200);
    const cases = [
      ["/api/import/skip", "没有可跳过的重复导入"],
      ["/api/import/resume", "没有可继续的导入"],
      ["/api/import/discard-unfinished", "当前不能放弃未完成的导入"],
    ] as const;

    for (const [url, error] of cases) {
      const response = await harness.app.inject({
        method: "POST",
        url,
        payload: {},
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ error });
    }
  });

  it("accepts two multipart images and reaches the prepared state", async () => {
    const multipart = multipartBody(
      [
        ["origin", "gallery"],
        ["lastModified", "1792540800000"],
        ["lastModified", "1792540800001"],
      ],
      [
        {
          name: "images",
          filename: "first.png",
          mimeType: "image/png",
          data: onePixelPng,
        },
        {
          name: "images",
          filename: "second.png",
          mimeType: "image/png",
          data: onePixelPng,
        },
      ],
    );
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/import/images",
      headers: { "content-type": multipart.contentType },
      payload: multipart.body,
    });
    expect(response.statusCode).toBe(200);
    const status = response.json<ImportStatusDto>();
    expect(status.importState).toBe("prepared");
    expect(status.importError).toBe("");
  });

  it("deletes all active data", async () => {
    await createItem("土豆");
    const response = await harness.app.inject({
      method: "DELETE",
      url: "/api/data",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true });
    const state = await readState();
    expect(state.items).toEqual([]);
    expect(state.imports).toEqual([]);
    expect(state.rules).toEqual([]);
  });

  it.each([
    ["PATCH", "/api/items/not-an-id", { id: 1, edits: { name: "菜" } }],
    ["POST", "/api/items/0/use", { id: 1 }],
    ["POST", "/api/items/-1/absent", { id: 1 }],
    ["POST", "/api/items/nope/first", { id: 1, enabled: true }],
    ["POST", "/api/items/nope/discard", { id: 1 }],
    ["POST", "/api/items/nope/snooze", { id: 1 }],
    ["POST", "/api/suggestions/nope", { id: 1, accept: true }],
    ["DELETE", "/api/shopping/nope", { id: 1 }],
    ["DELETE", "/api/imports/nope", { id: 1 }],
    ["POST", "/api/import/draft/nope/drop", { index: 0 }],
    ["POST", "/api/import/draft/1001/retrieve", { index: 1001 }],
  ])("rejects an illegal numeric id for %s %s", async (method, url, payload) => {
    const response = await harness.app.inject({
      method: method as "PATCH" | "POST" | "DELETE",
      url,
      payload,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "请求参数不正确" });
  });

  it.each([
    ["POST", "/api/items", { name: "长".repeat(201), quantity: "", location: "冷藏" }],
    ["PATCH", "/api/items/1", { id: 1, edits: { name: "长".repeat(201) } }],
    ["POST", "/api/pantry", { name: "长".repeat(201) }],
    ["PUT", "/api/rules", { name: "长".repeat(201), oldLocation: "", location: "冷藏", days: "7" }],
    ["POST", "/api/import/text", { text: "长".repeat(200_001) }],
    ["POST", "/api/recipes/valid/add-missing", { id: "a".repeat(201) }],
  ])("rejects overlong text for %s %s", async (method, url, payload) => {
    const response = await harness.app.inject({
      method: method as "POST" | "PATCH" | "PUT",
      url,
      payload,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "请求参数不正确" });
  });

  it.each([
    ["POST", "/api/items", { name: "菜", quantity: "", location: "阳台" }],
    ["PATCH", "/api/items/1", { id: 1, edits: { location: "阳台" } }],
    ["PATCH", "/api/import/draft/0", { index: 0, edits: { location: "阳台" } }],
    ["POST", "/api/import/draft/0/category", { index: 0, category: "ignored" }],
    ["PUT", "/api/rules", { name: "鸡蛋", oldLocation: "", location: "阳台", days: "7" }],
    ["DELETE", "/api/rules", { name: "鸡蛋", location: "", kind: "unknown" }],
  ])("rejects an incorrect enum for %s %s", async (method, url, payload) => {
    const response = await harness.app.inject({
      method: method as "POST" | "PATCH" | "PUT" | "DELETE",
      url,
      payload,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "请求参数不正确" });
  });

  it.each([
    ["POST", "/api/clear/preview", { selected: [0] }],
    ["POST", "/api/clear/search", { selected: [-1] }],
    ["POST", "/api/items/remove", { ids: [] }],
    ["POST", "/api/import/start", { privacyConfirmed: false, allowDuplicate: false }],
    ["POST", "/api/import/confirm", { allowDuplicate: "yes" }],
    ["DELETE", "/api/imports", { force: true }],
    ["POST", "/api/import/skip", { force: true }],
    ["POST", "/api/import/resume", { force: true }],
    ["POST", "/api/import/discard-unfinished", { force: true }],
    ["PUT", "/api/demo", { enabled: "yes" }],
  ])("rejects malformed input for %s %s", async (method, url, payload) => {
    const response = await harness.app.inject({
      method: method as "POST" | "PUT" | "DELETE",
      url,
      payload,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "请求参数不正确" });
  });

  it("rejects invalid recipe query and multipart enum values", async () => {
    const query = await harness.app.inject({
      method: "GET",
      url: `/api/recipes/${encodeURIComponent(builtin.recipes[0]!.id)}?selected=abc`,
    });
    expect(query.statusCode).toBe(400);

    const multipart = multipartBody(
      [
        ["origin", "unsupported"],
        ["lastModified", "1792540800000"],
      ],
      [
        {
          name: "images",
          filename: "first.png",
          mimeType: "image/png",
          data: onePixelPng,
        },
      ],
    );
    const upload = await harness.app.inject({
      method: "POST",
      url: "/api/import/images",
      headers: { "content-type": multipart.contentType },
      payload: multipart.body,
    });
    expect(upload.statusCode).toBe(400);
    expect(upload.json()).toEqual({ error: "请求参数不正确" });
  });
});
