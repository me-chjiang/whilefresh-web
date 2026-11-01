import type { FastifyInstance, FastifyReply } from "fastify";

import type {
  ClearPreviewDto,
  ClearRecipesResult,
  ClearRequest,
} from "../../shared/api.js";
import { recipeSummaryDto, type RouteContext } from "./state.js";

const clearBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["selected"],
  properties: {
    selected: {
      type: "array",
      uniqueItems: true,
      maxItems: 100,
      items: { type: "integer", minimum: 1 },
    },
  },
} as const;

function fail(
  reply: FastifyReply,
  status: number,
  error: string,
): FastifyReply {
  return reply.code(status).send({ error });
}

export function registerClearRoutes(
  app: FastifyInstance,
  context: RouteContext,
): void {
  app.post<{ Body: ClearRequest }>(
    "/api/clear/preview",
    { schema: { body: clearBodySchema } },
    async (request): Promise<ClearPreviewDto> =>
      context.state.activeKitchen.clearFridgePreview(
        request.body.selected,
      ),
  );

  app.post<{ Body: ClearRequest }>(
    "/api/clear/search",
    { schema: { body: clearBodySchema } },
    async (request, reply): Promise<ClearRecipesResult | FastifyReply> => {
      const summary =
        context.state.activeKitchen.clearFridgePreview(
          request.body.selected,
        );
      if (summary.selectedCount === 0) {
        return fail(reply, 400, "请选择至少一种非调料食材");
      }
      return {
        recipes: context.state.activeKitchen
          .clearFridge(request.body.selected)
          .map((match) =>
            recipeSummaryDto(match, context.builtin.recipeSource.name),
          ),
        summary,
      };
    },
  );
}
