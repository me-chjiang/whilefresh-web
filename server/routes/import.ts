import { join } from "node:path";

import type { FastifyInstance, FastifyReply } from "fastify";

import type {
  ConfirmImportRequest,
  DraftItemRequest,
  EditDraftItemRequest,
  ImportImageUpload,
  ImportImagesRequest,
  ImportStatusDto,
  SetDraftCategoryRequest,
  StartImportRequest,
  TextImportRequest,
} from "../../shared/api.js";
import { saveImportFiles } from "../import/import-files.js";
import { emptyBodySchema, type RouteContext } from "./state.js";

interface DraftParams {
  i: number;
}

interface MultipartField {
  type: "field";
  value: string;
}

interface MultipartFile {
  type: "file";
  filename: string;
  mimetype: string;
  toBuffer(): Promise<Buffer>;
}

interface ImageUploadBody {
  origin: MultipartField;
  images: MultipartFile | MultipartFile[];
  lastModified: MultipartField | MultipartField[];
}

const draftParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["i"],
  properties: {
    i: { type: "integer", minimum: 0, maximum: 1000 },
  },
} as const;

const draftIndexBody = {
  type: "object",
  additionalProperties: false,
  required: ["index"],
  properties: {
    index: { type: "integer", minimum: 0, maximum: 1000 },
  },
} as const;

const draftEditsSchema = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: {
    name: { type: "string", maxLength: 200 },
    quantity: { type: "string", maxLength: 200 },
    location: {
      type: "string",
      enum: ["冷藏", "冷冻", "常温", "fridge", "freezer", "room"],
    },
    shelfDays: { type: "string", maxLength: 10 },
    purchasedAt: { type: "string", maxLength: 10 },
    producedAt: { type: "string", maxLength: 10 },
    packageExpiresAt: { type: "string", maxLength: 10 },
    storedAt: { type: "string", maxLength: 10 },
  },
} as const;

function status(context: RouteContext): ImportStatusDto {
  return context.state.importStatus();
}

function fail(
  reply: FastifyReply,
  statusCode: number,
  error: string,
): FastifyReply {
  return reply.code(statusCode).send({ error });
}

function isOrigin(value: string): value is ImportImagesRequest["origin"] {
  return value === "gallery" || value === "share" || value === "camera";
}

export function registerImportRoutes(
  app: FastifyInstance,
  context: RouteContext,
): void {
  app.get(
    "/api/import",
    async (): Promise<ImportStatusDto> => status(context),
  );

  app.post<{ Body: TextImportRequest }>(
    "/api/import/text",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["text"],
          properties: {
            text: { type: "string", minLength: 1, maxLength: 200_000 },
          },
        },
      },
    },
    async (request) => {
      await context.state.activeImportService.receive({
        kind: "text",
        origin: "paste",
        text: request.body.text,
      });
      return status(context);
    },
  );

  app.post(
    "/api/import/images",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: true,
          required: ["origin", "images", "lastModified"],
          properties: {
            origin: {
              type: "object",
              required: ["type", "value"],
              properties: {
                type: { const: "field" },
                value: {
                  type: "string",
                  enum: ["gallery", "share", "camera"],
                },
              },
            },
            images: {
              anyOf: [
                {
                  type: "object",
                  required: ["type", "filename", "mimetype"],
                  properties: {
                    type: { const: "file" },
                    filename: { type: "string" },
                    mimetype: { type: "string" },
                  },
                },
                {
                  type: "array",
                  minItems: 1,
                  maxItems: 30,
                  items: {
                    type: "object",
                    required: ["type", "filename", "mimetype"],
                    properties: {
                      type: { const: "file" },
                      filename: { type: "string" },
                      mimetype: { type: "string" },
                    },
                  },
                },
              ],
            },
            lastModified: {
              anyOf: [
                {
                  type: "object",
                  required: ["type", "value"],
                  properties: {
                    type: { const: "field" },
                    value: { type: "string", pattern: "^[0-9]+$" },
                  },
                },
                {
                  type: "array",
                  minItems: 1,
                  maxItems: 30,
                  items: {
                    type: "object",
                    required: ["type", "value"],
                    properties: {
                      type: { const: "field" },
                      value: { type: "string", pattern: "^[0-9]+$" },
                    },
                  },
                },
              ],
            },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as unknown as ImageUploadBody;
      const originValue = body.origin.value;
      if (!isOrigin(originValue)) {
        return fail(reply, 400, "请选择有效的导入来源");
      }
      const files = Array.isArray(body.images)
        ? body.images
        : [body.images];
      const timestamps = (
        Array.isArray(body.lastModified)
          ? body.lastModified
          : [body.lastModified]
      ).map((field) => Number(field.value));
      const uploads: ImportImageUpload[] = [];
      for (const [index, part] of files.entries()) {
        const buffer = await part.toBuffer();
        uploads.push({
          filename: part.filename,
          mimeType: part.mimetype,
          data: Uint8Array.from(buffer).buffer,
          lastModified: timestamps[index] ?? timestamps.at(-1) ?? 0,
        });
      }

      const saved = await saveImportFiles(
        join(context.dataDir, "imports"),
        uploads,
        { origin: originValue, now: context.clock.now() },
      );
      if (saved.failures.length > 0 || saved.files.length === 0) {
        context.state.activeStore.discardImportFiles(
          saved.files.map((file) => file.path),
        );
        return fail(
          reply,
          400,
          saved.failures[0] ?? "无法保存导入的图片",
        );
      }

      await context.state.activeImportService.receive({
        kind: "images",
        origin: originValue,
        images: saved.files,
      });
      return status(context);
    },
  );

  app.post<{ Body: StartImportRequest }>(
    "/api/import/start",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["privacyConfirmed", "allowDuplicate"],
          properties: {
            privacyConfirmed: { const: true },
            allowDuplicate: { type: "boolean" },
          },
        },
      },
    },
    async (request) => {
      await context.state.activeImportService.start(
        request.body.privacyConfirmed,
        request.body.allowDuplicate,
      );
      return status(context);
    },
  );

  app.post(
    "/api/import/cancel",
    { schema: { body: emptyBodySchema } },
    async (): Promise<ImportStatusDto> => {
      context.state.activeImportService.discard();
      return status(context);
    },
  );

  app.post(
    "/api/import/skip",
    {
      schema: {
        body: emptyBodySchema,
      },
    },
    async (_request, reply) => {
      if (!context.state.activeImportService.skipDuplicate()) {
        return fail(reply, 409, "没有可跳过的重复导入");
      }
      return status(context);
    },
  );

  app.post(
    "/api/import/resume",
    {
      schema: {
        body: emptyBodySchema,
      },
    },
    async (_request, reply) => {
      if (!(await context.state.activeImportService.resume())) {
        return fail(
          reply,
          409,
          context.state.importStatus().importError || "没有可继续的导入",
        );
      }
      return status(context);
    },
  );

  app.post(
    "/api/import/discard-unfinished",
    {
      schema: {
        body: emptyBodySchema,
      },
    },
    async (_request, reply) => {
      const hadJobs = context.state.activeStore.importJobRows().length > 0;
      const ok = context.state.activeImportService.discardUnfinishedJob();
      if (
        !ok &&
        hadJobs &&
        context.state.activeStore.importJobRows().length === 0
      ) {
        return {
          ...status(context),
          warning: "部分图片暂未清理，稍后会自动重试",
        } satisfies ImportStatusDto & { warning: string };
      }
      if (!ok) {
        return fail(reply, 409, "当前不能放弃未完成的导入");
      }
      return status(context);
    },
  );

  app.patch<{ Params: DraftParams; Body: EditDraftItemRequest }>(
    "/api/import/draft/:i",
    {
      schema: {
        params: draftParamsSchema,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["index", "edits"],
          properties: {
            index: { type: "integer", minimum: 0, maximum: 1000 },
            edits: draftEditsSchema,
          },
        },
      },
    },
    async (request, reply) => {
      if (request.body.index !== request.params.i) {
        return fail(reply, 400, "请求参数不一致");
      }
      if (
        !context.state.activeImportService.updateDraft(
          request.params.i,
          request.body.edits,
        )
      ) {
        return fail(reply, 409, "草稿不可编辑");
      }
      return status(context);
    },
  );

  app.post<{
    Params: DraftParams;
    Body: SetDraftCategoryRequest;
  }>(
    "/api/import/draft/:i/category",
    {
      schema: {
        params: draftParamsSchema,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["index", "category"],
          properties: {
            index: { type: "integer", minimum: 0, maximum: 1000 },
            category: {
              type: "string",
              enum: ["food", "seasoning"],
            },
          },
        },
      },
    },
    async (request, reply) => {
      if (request.body.index !== request.params.i) {
        return fail(reply, 400, "请求参数不一致");
      }
      if (
        !context.state.activeImportService.setCategory(
          request.params.i,
          request.body.category,
        )
      ) {
        return fail(reply, 409, "草稿不可修改");
      }
      return status(context);
    },
  );

  app.post<{ Params: DraftParams; Body: DraftItemRequest }>(
    "/api/import/draft/:i/drop",
    {
      schema: {
        params: draftParamsSchema,
        body: draftIndexBody,
      },
    },
    async (request, reply) => {
      if (request.body.index !== request.params.i) {
        return fail(reply, 400, "请求参数不一致");
      }
      if (!context.state.activeImportService.drop(request.params.i)) {
        return fail(reply, 409, "草稿不可修改");
      }
      return status(context);
    },
  );

  app.post<{ Params: DraftParams; Body: DraftItemRequest }>(
    "/api/import/draft/:i/retrieve",
    {
      schema: {
        params: draftParamsSchema,
        body: draftIndexBody,
      },
    },
    async (request, reply) => {
      if (request.body.index !== request.params.i) {
        return fail(reply, 400, "请求参数不一致");
      }
      if (!context.state.activeImportService.retrieve(request.params.i)) {
        return fail(reply, 409, "草稿不可修改");
      }
      return status(context);
    },
  );

  app.post<{ Body: ConfirmImportRequest }>(
    "/api/import/confirm",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["allowDuplicate"],
          properties: {
            allowDuplicate: { type: "boolean" },
          },
        },
      },
    },
    async (request): Promise<ImportStatusDto> => {
      context.state.activeImportService.confirm(
        request.body.allowDuplicate,
      );
      return status(context);
    },
  );
}
