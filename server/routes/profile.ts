import type { FastifyInstance, FastifyReply } from "fastify";

import type {
  ActionResult,
  DeleteAllDataResult,
  DeleteRuleRequest,
  DemoModeRequest,
  ImportRequest,
  SaveRuleRequest,
  StateDto,
} from "../../shared/api.js";
import {
  proposeShelfLifeRule,
  proposeStorageRule,
} from "../domain/shelf-life.js";
import {
  emptyBodySchema,
  stateDto,
  storageFromName,
  type RouteContext,
} from "./state.js";

const locationSchema = {
  type: "string",
  enum: ["冷藏", "冷冻", "常温", "fridge", "freezer", "room"],
} as const;

function fail(
  reply: FastifyReply,
  status: number,
  error: string,
): FastifyReply {
  return reply.code(status).send({ error });
}

export function registerProfileRoutes(
  app: FastifyInstance,
  context: RouteContext,
): void {
  app.post(
    "/api/rules/remembered/confirm",
    { schema: { body: emptyBodySchema } },
    async (_request, reply): Promise<ActionResult | FastifyReply> => {
      if (!context.state.confirmRememberedRules()) {
        return fail(reply, 500, "规则未保存，请重试");
      }
      return { ok: true };
    },
  );

  app.post(
    "/api/rules/remembered/dismiss",
    { schema: { body: emptyBodySchema } },
    async (): Promise<ActionResult> => {
      context.state.dismissRememberedRules();
      return { ok: true };
    },
  );

  app.put<{ Body: SaveRuleRequest }>(
    "/api/rules",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["name", "oldLocation", "location", "days"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 200 },
            oldLocation: {
              type: "string",
              maxLength: 20,
              enum: [
                "",
                "冷藏",
                "冷冻",
                "常温",
                "fridge",
                "freezer",
                "room",
              ],
            },
            location: locationSchema,
            days: {
              type: "string",
              pattern: "^(?:[1-9][0-9]*)?$",
              maxLength: 10,
            },
          },
        },
      },
    },
    async (request, reply) => {
      const storage = storageFromName(request.body.location);
      if (!storage) {
        return fail(reply, 400, "请填写有效的存放位置");
      }
      const oldStorage = storageFromName(request.body.oldLocation);
      const proposal =
        request.body.days.trim().length === 0
          ? proposeStorageRule(request.body.name, storage)
          : proposeShelfLifeRule(
              request.body.name,
              storage,
              Number(request.body.days),
            );
      if (
        !proposal ||
        !context.state.activeKitchen.replaceRule(proposal, oldStorage)
      ) {
        return fail(
          reply,
          400,
          "规则未保存，请重试；原规则已保留",
        );
      }
      return { ok: true } satisfies ActionResult;
    },
  );

  app.delete<{ Body: DeleteRuleRequest }>(
    "/api/rules",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["name", "location", "kind"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 200 },
            location: {
              type: "string",
              maxLength: 20,
              enum: [
                "",
                "冷藏",
                "冷冻",
                "常温",
                "fridge",
                "freezer",
                "room",
              ],
            },
            kind: { type: "string", enum: ["shelf", "storage"] },
          },
        },
      },
    },
    async (request, reply) => {
      if (request.body.kind === "storage") {
        if (
          !context.state.activeKitchen.deleteStorageRule(
            request.body.name,
          )
        ) {
          return fail(reply, 404, "规则不存在");
        }
        return { ok: true } satisfies ActionResult;
      }
      const storage = storageFromName(request.body.location);
      if (
        !storage ||
        !context.state.activeKitchen.deleteShelfRule(
          request.body.name,
          storage,
        )
      ) {
        return fail(reply, 404, "规则不存在");
      }
      return { ok: true } satisfies ActionResult;
    },
  );

  app.delete<{ Params: { id: number }; Body: ImportRequest }>(
    "/api/imports/:id",
    {
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["id"],
          properties: { id: { type: "integer", minimum: 1 } },
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["id"],
          properties: { id: { type: "integer", minimum: 1 } },
        },
      },
    },
    async (request, reply) => {
      if (request.body.id !== request.params.id) {
        return fail(reply, 400, "请求参数不一致");
      }
      if (!context.state.activeStore.importRecord(request.params.id)) {
        return fail(reply, 404, "导入记录不存在");
      }
      const ok = context.state.activeKitchen.deleteImport(
        request.params.id,
      );
      if (
        !ok &&
        context.state.activeStore.importRecord(request.params.id)
      ) {
        return fail(reply, 500, "删除失败，原有数据已保留");
      }
      return {
        ok: true,
        ...(ok
          ? {}
          : { warning: "部分图片暂未清理，稍后会自动重试" }),
      } satisfies ActionResult & { warning?: string };
    },
  );

  app.delete(
    "/api/imports",
    {
      schema: {
        body: emptyBodySchema,
      },
    },
    async (_request, reply) => {
      const ok = context.state.activeKitchen.clearImportHistory();
      if (!ok && context.state.activeKitchen.imports().length > 0) {
        return fail(reply, 500, "删除失败，原有数据已保留，请重试");
      }
      return {
        ok: true,
        ...(ok
          ? {}
          : { warning: "部分图片暂未清理，稍后会自动重试" }),
      } satisfies ActionResult & { warning?: string };
    },
  );

  app.delete(
    "/api/data",
    { schema: { body: emptyBodySchema } },
    async (_request, reply): Promise<DeleteAllDataResult | FastifyReply> => {
      context.state.activeImportService.discard();
      const cleaned = context.state.activeKitchen.deleteAllData();
      const kitchen = context.state.activeKitchen;
      const deleted =
        kitchen.fridge().length === 0 &&
        kitchen.imports().length === 0 &&
        kitchen.shopping().length === 0 &&
        context.state.activeStore.shelfLifeRules().length === 0 &&
        context.state.activeStore.storageRules().length === 0;
      if (!deleted) {
        return fail(
          reply,
          500,
          "删除失败，原有数据已保留，请重试",
        );
      }
      return {
        ok: true,
        ...(cleaned
          ? {}
          : { warning: "部分图片暂未清理，稍后会自动重试" }),
      };
    },
  );

  app.put<{ Body: DemoModeRequest }>(
    "/api/demo",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["enabled"],
          properties: { enabled: { type: "boolean" } },
        },
      },
    },
    async (request, reply): Promise<StateDto | FastifyReply> => {
      if (!context.state.setDemoMode(request.body.enabled)) {
        return fail(reply, 409, "无法切换演示模式");
      }
      return stateDto(context.state, context.builtin);
    },
  );
}
