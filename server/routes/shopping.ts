import type { FastifyInstance, FastifyReply } from "fastify";

import type {
  ActionResult,
  PantryItemRequest,
  ShoppingDto,
  ShoppingItemRequest,
  ShoppingTextDto,
  SuggestionDecisionRequest,
} from "../../shared/api.js";
import { displayName } from "../domain/shopping-list.js";
import { categoryCode, type RouteContext } from "./state.js";

interface SuggestionParams {
  id: number;
}

interface PantryParams {
  name: string;
}

function fail(
  reply: FastifyReply,
  status: number,
  error: string,
): FastifyReply {
  return reply.code(status).send({ error });
}

export function registerShoppingRoutes(
  app: FastifyInstance,
  context: RouteContext,
): void {
  app.post<{ Body: PantryItemRequest }>(
    "/api/pantry",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["name"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 200 },
          },
        },
      },
    },
    async (request, reply) => {
      const requested = request.body.name.trim();
      const resolved =
        context.builtin.catalog.resolve(requested) || requested;
      const override =
        context.state.activeKitchen.pantryRules().overrideFor(resolved);
      override.name = resolved;
      override.pantry = true;
      override.out = false;
      if (!context.state.activeKitchen.setPantryOverride(override)) {
        return fail(reply, 400, "无法添加为常备食材");
      }
      return { ok: true } satisfies ActionResult;
    },
  );

  app.delete<{ Params: PantryParams; Body: PantryItemRequest }>(
    "/api/pantry/:name",
    {
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["name"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 200 },
          },
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["name"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 200 },
          },
        },
      },
    },
    async (request, reply) => {
      if (request.body.name !== request.params.name) {
        return fail(reply, 400, "请求参数不一致");
      }
      const name = request.params.name;
      const override =
        context.state.activeKitchen.pantryRules().overrideFor(name);
      override.name = name;
      override.pantry = false;
      if (!context.state.activeKitchen.setPantryOverride(override)) {
        return fail(reply, 404, "常备食材不存在");
      }
      return { ok: true } satisfies ActionResult;
    },
  );

  app.post<{ Params: SuggestionParams; Body: SuggestionDecisionRequest }>(
    "/api/suggestions/:id",
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
          required: ["id", "accept"],
          properties: {
            id: { type: "integer", minimum: 1 },
            accept: { type: "boolean" },
          },
        },
      },
    },
    async (request, reply) => {
      if (request.body.id !== request.params.id) {
        return fail(reply, 400, "请求参数不一致");
      }
      if (
        !context.state.activeKitchen.decideSuggestion(
          request.params.id,
          request.body.accept,
        )
      ) {
        return fail(reply, 404, "建议不存在或已处理");
      }
      return { ok: true } satisfies ActionResult;
    },
  );

  app.get("/api/shopping", async (): Promise<ShoppingDto[]> =>
    context.state.activeKitchen.shopping().map((entry) => ({
      id: entry.id,
      name: displayName(entry),
      category: categoryCode(entry.category),
    })),
  );

  app.get(
    "/api/shopping/text",
    async (): Promise<ShoppingTextDto> => ({
      text: context.state.activeKitchen.shoppingText(),
    }),
  );

  app.delete<{ Params: { id: number }; Body: ShoppingItemRequest }>(
    "/api/shopping/:id",
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
      if (
        !context.state.activeKitchen.removeShopping(request.params.id)
      ) {
        return fail(reply, 404, "待买项不存在");
      }
      return { ok: true } satisfies ActionResult;
    },
  );
}
