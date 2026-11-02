import type { FastifyInstance, FastifyReply } from "fastify";

import type {
  ActionResult,
  AddPreferenceRequest,
  NameMappingDto,
  PreferencesDto,
  ServiceSourcesDto,
  SetServiceRequest,
} from "../../shared/api.js";
import type { RouteContext } from "./state.js";

type ServiceField = keyof ServiceSourcesDto;

interface ServiceParams {
  field: ServiceField;
}

interface PreferenceParams {
  id: number;
}

interface NameMappingParams {
  raw: string;
}

const serviceFieldSchema = {
  type: "string",
  enum: ["deepseek", "lexmount", "lexmountProject"],
} as const;

const serviceParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["field"],
  properties: {
    field: serviceFieldSchema,
  },
} as const;

const serviceResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["deepseek", "lexmount", "lexmountProject"],
  properties: {
    deepseek: { type: "string", enum: ["user", "builtin", "none"] },
    lexmount: { type: "string", enum: ["user", "builtin", "none"] },
    lexmountProject: {
      type: "string",
      enum: ["user", "builtin", "none"],
    },
  },
} as const;

const actionResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["ok"],
  properties: {
    ok: { type: "boolean" },
  },
} as const;

const preferencesResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["items", "summary", "stale", "summarizing"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "text", "source"],
        properties: {
          id: { type: "integer", minimum: 1 },
          text: { type: "string", maxLength: 100 },
          source: { type: "string", enum: ["user", "ai"] },
        },
      },
    },
    summary: { type: "string" },
    stale: { type: "boolean" },
    summarizing: { type: "boolean" },
  },
} as const;

const nameMappingsResponseSchema = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["raw", "canonical"],
    properties: {
      raw: { type: "string" },
      canonical: { type: "string" },
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

function preferencesDto(context: RouteContext): PreferencesDto {
  const { items, summary, stale, summarizing } =
    context.state.settings.preferencesState();
  return { items, summary, stale, summarizing };
}

export function registerSettingsRoutes(
  app: FastifyInstance,
  context: RouteContext,
): void {
  app.get(
    "/api/services",
    {
      schema: {
        response: {
          200: serviceResponseSchema,
        },
      },
    },
    async (): Promise<ServiceSourcesDto> =>
      context.state.settings.services(),
  );

  app.put<{ Params: ServiceParams; Body: SetServiceRequest }>(
    "/api/services/:field",
    {
      schema: {
        params: serviceParamsSchema,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["value"],
          properties: {
            value: { type: "string", minLength: 1 },
          },
        },
        response: {
          200: actionResponseSchema,
        },
      },
    },
    async (request, reply): Promise<ActionResult | FastifyReply> => {
      if (
        !context.state.settings.saveSecret(
          request.params.field,
          request.body.value,
        )
      ) {
        return fail(reply, 400, "保存失败");
      }
      return { ok: true };
    },
  );

  app.delete<{ Params: ServiceParams }>(
    "/api/services/:field",
    {
      schema: {
        params: serviceParamsSchema,
        response: {
          200: actionResponseSchema,
        },
      },
    },
    async (request, reply): Promise<ActionResult | FastifyReply> => {
      if (!context.state.settings.clearSecret(request.params.field)) {
        return fail(reply, 500, "清除失败");
      }
      return { ok: true };
    },
  );

  app.get(
    "/api/preferences",
    {
      schema: {
        response: {
          200: preferencesResponseSchema,
        },
      },
    },
    async (): Promise<PreferencesDto> => preferencesDto(context),
  );

  app.post<{ Body: AddPreferenceRequest }>(
    "/api/preferences",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["text"],
          properties: {
            text: {
              type: "string",
              minLength: 1,
              maxLength: 100,
            },
          },
        },
        response: {
          200: actionResponseSchema,
        },
      },
    },
    async (request, reply): Promise<ActionResult | FastifyReply> => {
      if (!context.state.settings.addPreference(request.body.text)) {
        return fail(reply, 400, "添加失败");
      }
      return { ok: true };
    },
  );

  app.delete<{ Params: PreferenceParams }>(
    "/api/preferences/:id",
    {
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["id"],
          properties: {
            id: { type: "integer", minimum: 1 },
          },
        },
        response: {
          200: actionResponseSchema,
        },
      },
    },
    async (request, reply): Promise<ActionResult | FastifyReply> => {
      if (
        !context.state.settings.deletePreference(request.params.id)
      ) {
        return fail(reply, 404, "偏好不存在");
      }
      return { ok: true };
    },
  );

  app.post(
    "/api/preferences/summarize",
    {
      schema: {
        response: {
          200: preferencesResponseSchema,
        },
      },
    },
    async (): Promise<PreferencesDto> => {
      await context.state.settings.summarize();
      return preferencesDto(context);
    },
  );

  app.get(
    "/api/name-mappings",
    {
      schema: {
        response: {
          200: nameMappingsResponseSchema,
        },
      },
    },
    async (): Promise<NameMappingDto[]> =>
      context.state.settings.nameMappings(),
  );

  app.delete<{ Params: NameMappingParams }>(
    "/api/name-mappings/:raw",
    {
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["raw"],
          properties: {
            raw: { type: "string", minLength: 1, maxLength: 200 },
          },
        },
        response: {
          200: actionResponseSchema,
        },
      },
    },
    async (request, reply): Promise<ActionResult | FastifyReply> => {
      if (
        !context.state.settings.forgetNameMapping(
          request.params.raw,
        )
      ) {
        return fail(reply, 404, "名称映射不存在");
      }
      return { ok: true };
    },
  );

  app.delete(
    "/api/name-mappings",
    {
      schema: {
        response: {
          200: actionResponseSchema,
        },
      },
    },
    async (_request, reply): Promise<ActionResult | FastifyReply> => {
      if (!context.state.settings.clearNameMappings()) {
        return fail(reply, 500, "清除失败");
      }
      return { ok: true };
    },
  );
}
