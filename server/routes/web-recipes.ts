import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";

import type {
  WebRecipeDetailDto,
  WebRecipeSearchRequest,
  WebRecipeSummaryDto,
} from "../../shared/api.js";
import type { RouteContext } from "./state.js";

interface WebRecipeParams {
  id: string;
}

const searchQuerySchema = {
  type: "object",
  additionalProperties: false,
  required: ["keyword"],
  properties: {
    keyword: { type: "string", minLength: 1, maxLength: 200 },
    page: { type: "integer", minimum: 1 },
  },
} as const;

const recipeParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: {
    id: { type: "string", pattern: "^[0-9]{1,20}$" },
  },
} as const;

function fail(
  reply: FastifyReply,
  status: number,
  error: string,
): FastifyReply {
  return reply.code(status).send({ error });
}

function failureStatus(context: RouteContext): number {
  return context.state.web.isConfigured() ? 502 : 503;
}

function abortOnClose(
  request: FastifyRequest,
  controller: AbortController,
): () => void {
  const abort = (): void => controller.abort();
  request.raw.once("close", abort);
  return () => request.raw.off("close", abort);
}

export function registerWebRecipeRoutes(
  app: FastifyInstance,
  context: RouteContext,
): void {
  app.get<{
    Querystring: WebRecipeSearchRequest;
  }>(
    "/api/web-recipes",
    {
      schema: {
        querystring: searchQuerySchema,
      },
    },
    async (request, reply): Promise<WebRecipeSummaryDto[] | FastifyReply> => {
      const controller = new AbortController();
      const detach = abortOnClose(request, controller);
      try {
        const recipes = await context.state.web.search(
          request.query.keyword,
          request.query.page ?? 1,
          controller.signal,
        );
        if (context.state.web.searchState() === "error") {
          return fail(
            reply,
            failureStatus(context),
            context.state.web.searchError() || "菜谱源不可用",
          );
        }
        return recipes;
      } catch {
        return fail(reply, 502, "菜谱源不可用");
      } finally {
        detach();
      }
    },
  );

  app.get<{
    Params: WebRecipeParams;
  }>(
    "/api/web-recipes/:id",
    {
      schema: {
        params: recipeParamsSchema,
      },
    },
    async (
      request,
      reply,
    ): Promise<WebRecipeDetailDto | FastifyReply> => {
      const controller = new AbortController();
      const detach = abortOnClose(request, controller);
      try {
        const recipe = await context.state.web.detail(
          request.params.id,
          controller.signal,
        );
        if (recipe) {
          return recipe;
        }
        return fail(
          reply,
          failureStatus(context),
          context.state.web.detailError() || "菜谱源不可用",
        );
      } catch {
        return fail(reply, 502, "菜谱源不可用");
      } finally {
        detach();
      }
    },
  );
}
