import type { FastifyInstance, FastifyReply } from "fastify";

import type {
  RecipeDetailDto,
  RecipeRequest,
  RecipeSummaryDto,
} from "../../shared/api.js";
import type { RecipeMatch } from "../domain/recipe.js";
import {
  recipeSummaryDto,
  selectedFromQuery,
  type RouteContext,
} from "./state.js";

interface RecipeParams {
  id: string;
}

const recipeParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: {
    id: { type: "string", minLength: 1, maxLength: 200 },
  },
} as const;

const selectedQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    selected: {
      anyOf: [
        {
          type: "string",
          pattern: "^[0-9]+(?:,[0-9]+)*$",
          maxLength: 1000,
        },
        {
          type: "array",
          maxItems: 100,
          items: { type: "string", pattern: "^[0-9]+$" },
        },
      ],
    },
  },
} as const;

function groupsEqual(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((name, index) => name === right[index])
  );
}

function recipeDetailDto(
  match: RecipeMatch,
  sourceName: string,
): RecipeDetailDto {
  const summary = recipeSummaryDto(match, sourceName);
  const ingredientNotes = [...match.recipe.ingredientNotes];
  const ingredients = [];
  for (const ingredient of match.recipe.ingredients) {
    if (ingredient.kind === "tool") {
      ingredientNotes.push(`工具：${ingredient.raw}`);
      continue;
    }
    let has = ingredient.groups.length > 0;
    for (const need of ingredient.groups) {
      const group = match.groups.find((candidate) =>
        groupsEqual(candidate.group, need),
      );
      has = has && group?.satisfied() === true;
    }
    ingredients.push({
      raw: ingredient.raw,
      has,
      known: ingredient.groups.length > 0,
      optional: ingredient.optional,
    });
  }

  return {
    ...summary,
    summary: match.recipe.summary,
    ingredients,
    ingredientNotes,
    quantities: match.recipe.quantities.map((quantity) => ({
      name: quantity.name,
      expr: quantity.expr,
    })),
    quantityNotes: [...match.recipe.quantityNotes],
    steps: [...match.recipe.steps],
    notes: match.recipe.notes,
  };
}

function fail(
  reply: FastifyReply,
  status: number,
  error: string,
): FastifyReply {
  return reply.code(status).send({ error });
}

export function registerRecipeRoutes(
  app: FastifyInstance,
  context: RouteContext,
): void {
  app.get("/api/recipes", async (): Promise<RecipeSummaryDto[]> => {
    return context.state.activeKitchen
      .recipes()
      .map((match) =>
        recipeSummaryDto(match, context.builtin.recipeSource.name),
      );
  });

  app.get<{
    Params: RecipeParams;
    Querystring: RecipeRequest;
  }>(
    "/api/recipes/:id",
    {
      schema: {
        params: recipeParamsSchema,
        querystring: selectedQuerySchema,
      },
    },
    async (request, reply) => {
      const match = context.state.activeKitchen.recipe(
        request.params.id,
        selectedFromQuery(request.query.selected),
      );
      if (!match) {
        return fail(reply, 404, "菜谱不存在");
      }
      return recipeDetailDto(match, context.builtin.recipeSource.name);
    },
  );

  app.post<{ Params: RecipeParams; Body: RecipeRequest }>(
    "/api/recipes/:id/add-missing",
    {
      schema: {
        params: recipeParamsSchema,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["id"],
          properties: {
            id: { type: "string", minLength: 1, maxLength: 200 },
            selected: {
              type: "array",
              uniqueItems: true,
              maxItems: 100,
              items: { type: "integer", minimum: 1 },
            },
          },
        },
      },
    },
    async (request, reply) => {
      if (request.body.id !== request.params.id) {
        return fail(reply, 400, "请求参数不一致");
      }
      const match = context.state.activeKitchen.recipe(
        request.params.id,
        request.body.selected ?? [],
      );
      if (!match) {
        return fail(reply, 404, "菜谱不存在");
      }
      return {
        added: context.state.activeKitchen.addMissing(
          request.params.id,
          request.body.selected ?? [],
        ),
      };
    },
  );
}
