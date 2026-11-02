import type {
  FastifyInstance,
  FastifyReply,
} from "fastify";
import { DateOrigin } from "../../shared/enums.js";
import type {
  ActionResult,
  AddManualItemRequest,
  ItemEdits,
  RemoveItemsRequest,
  SaveItemResult,
  UpdateItemRequest,
  UseFirstRequest,
} from "../../shared/api.js";
import type { FridgeItem, RecordedDate } from "../data/store.js";
import type { RouteContext } from "./state.js";
import { storageFromName } from "./state.js";

interface ItemParams {
  id: number;
}

const idParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: {
    id: { type: "integer", minimum: 1 },
  },
} as const;

const locationSchema = {
  type: "string",
  enum: ["冷藏", "冷冻", "常温", "fridge", "freezer", "room"],
} as const;

const editsSchema = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: {
    name: { type: "string", maxLength: 200 },
    quantity: { type: "string", maxLength: 200 },
    location: locationSchema,
    shelfDays: { type: "string", maxLength: 10 },
    purchasedAt: { type: "string", maxLength: 10 },
    producedAt: { type: "string", maxLength: 10 },
    packageExpiresAt: { type: "string", maxLength: 10 },
    storedAt: { type: "string", maxLength: 10 },
  },
} as const;

function calendarDate(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value.trim());
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day, 12);
  return date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day
    ? `${match[1]}-${match[2]}-${match[3]}`
    : null;
}

function setDate(
  current: RecordedDate | undefined,
  value: string,
): RecordedDate {
  const before = current ?? {
    date: null,
    origin: DateOrigin.None,
    text: "",
  };
  const text = value.trim();
  if (text.length === 0) {
    return { date: null, origin: DateOrigin.None, text: "" };
  }
  const date = calendarDate(text);
  if (!date || date === before.date) {
    return before;
  }
  return { date, origin: DateOrigin.User, text };
}

function applyEdits(
  item: FridgeItem,
  edits: ItemEdits,
  context: RouteContext,
  editEntry: boolean,
): void {
  if (typeof edits.name === "string") {
    const name = edits.name.trim();
    if (name.length > 0 && name !== item.displayName) {
      const canonical =
        context.builtin.catalog.resolve(name) || "未归类";
      item.displayName = name;
      if (canonical !== item.canonicalName) {
        item.canonicalName = canonical;
        item.aiDays = {};
        item.referenceConditionsConfirmed = false;
      }
      item.category = context.builtin.catalog.categoryOf(canonical);
    }
  }
  if (typeof edits.quantity === "string") {
    item.quantityText = edits.quantity.trim();
  }
  if (typeof edits.location === "string") {
    const storage = storageFromName(edits.location);
    if (storage && storage !== item.storage) {
      item.storage = storage;
      item.manualDays = null;
      item.referenceConditionsConfirmed = false;
    }
  }
  if (typeof edits.shelfDays === "string") {
    const text = edits.shelfDays.trim();
    const days = Number(text);
    if (text.length === 0) {
      item.manualDays = null;
    } else if (
      Number.isInteger(days) &&
      days > 0 &&
      days !== item.shelfLifeDays &&
      days !== item.manualDays
    ) {
      item.manualDays = days;
    }
  }
  if (typeof edits.purchasedAt === "string") {
    item.purchaseDate = setDate(item.purchaseDate, edits.purchasedAt);
  }
  if (typeof edits.producedAt === "string") {
    item.productionDate = setDate(item.productionDate, edits.producedAt);
  }
  if (typeof edits.packageExpiresAt === "string") {
    const before = item.packageExpiry?.date;
    item.packageExpiry = setDate(
      item.packageExpiry,
      edits.packageExpiresAt,
    );
    if (item.packageExpiry.date !== before) {
      item.manualDays = null;
    }
  }
  if (editEntry && typeof edits.storedAt === "string") {
    const stored = calendarDate(edits.storedAt);
    if (stored) {
      item.entryDate = stored;
    }
  }
}

function saveResult(context: RouteContext, item: FridgeItem): SaveItemResult {
  const saved = context.state.activeKitchen.saveItem(item);
  context.state.rememberRules(saved.proposals);
  return {
    ok: saved.ok,
    error: saved.error,
    question: saved.ok ? context.state.pendingRuleQuestion() : "",
  };
}

function fail(
  reply: FastifyReply,
  status: number,
  error: string,
): FastifyReply {
  return reply.code(status).send({ error });
}

export function registerItemRoutes(
  app: FastifyInstance,
  context: RouteContext,
): void {
  app.post<{ Body: AddManualItemRequest }>(
    "/api/items",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["name", "quantity", "location"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 200 },
            quantity: { type: "string", maxLength: 200 },
            location: locationSchema,
          },
        },
      },
    },
    async (request) => {
      const item: FridgeItem = {
        rawName: request.body.name.trim(),
        canonicalName: "未归类",
      };
      applyEdits(
        item,
        {
          name: request.body.name,
          quantity: request.body.quantity,
          location: request.body.location,
        },
        context,
        false,
      );
      return saveResult(context, item);
    },
  );

  app.patch<{ Params: ItemParams; Body: UpdateItemRequest }>(
    "/api/items/:id",
    {
      schema: {
        params: idParamsSchema,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["id", "edits"],
          properties: {
            id: { type: "integer", minimum: 1 },
            edits: editsSchema,
          },
        },
      },
    },
    async (request, reply) => {
      if (request.body.id !== request.params.id) {
        return fail(reply, 400, "请求参数不一致");
      }
      const item = context.state.activeStore.item(request.params.id);
      if (!item) {
        return fail(reply, 404, "食材不存在");
      }
      applyEdits(item, request.body.edits, context, true);
      return saveResult(context, item);
    },
  );

  app.post<{ Params: ItemParams; Body: { id: number } }>(
    "/api/items/:id/use",
    {
      schema: {
        params: idParamsSchema,
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
      if (!context.state.activeKitchen.useItem(request.params.id)) {
        return fail(reply, 404, "食材不存在或已处理");
      }
      return { ok: true } satisfies ActionResult;
    },
  );

  app.post<{ Params: ItemParams; Body: { id: number } }>(
    "/api/items/:id/absent",
    {
      schema: {
        params: idParamsSchema,
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
      if (!context.state.activeKitchen.markAbsent(request.params.id)) {
        return fail(reply, 404, "食材不存在");
      }
      return { ok: true } satisfies ActionResult;
    },
  );

  app.post<{ Params: ItemParams; Body: { id: number } }>(
    "/api/items/:id/discard",
    {
      schema: {
        params: idParamsSchema,
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
      if (!context.state.activeStore.item(request.params.id)) {
        return fail(reply, 404, "食材不存在");
      }
      if (!context.state.activeKitchen.discardItem(request.params.id)) {
        return fail(reply, 409, "食材已处理");
      }
      return { ok: true } satisfies ActionResult;
    },
  );

  app.post<{ Params: ItemParams; Body: { id: number } }>(
    "/api/items/:id/snooze",
    {
      schema: {
        params: idParamsSchema,
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
      if (!context.state.activeStore.item(request.params.id)) {
        return fail(reply, 404, "食材不存在");
      }
      if (!context.state.activeKitchen.snoozeItem(request.params.id)) {
        return fail(reply, 409, "只能忽略临期食材");
      }
      return { ok: true } satisfies ActionResult;
    },
  );

  app.post<{ Params: ItemParams; Body: UseFirstRequest }>(
    "/api/items/:id/first",
    {
      schema: {
        params: idParamsSchema,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["id", "enabled"],
          properties: {
            id: { type: "integer", minimum: 1 },
            enabled: { type: "boolean" },
          },
        },
      },
    },
    async (request, reply) => {
      if (request.body.id !== request.params.id) {
        return fail(reply, 400, "请求参数不一致");
      }
      if (
        !context.state.activeKitchen.setUseFirst(
          request.params.id,
          request.body.enabled,
        )
      ) {
        return fail(reply, 404, "食材不存在");
      }
      return { ok: true } satisfies ActionResult;
    },
  );

  app.post<{ Body: RemoveItemsRequest }>(
    "/api/items/remove",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["ids"],
          properties: {
            ids: {
              type: "array",
              minItems: 1,
              uniqueItems: true,
              items: { type: "integer", minimum: 1 },
            },
          },
        },
      },
    },
    async (request, reply) => {
      for (const id of request.body.ids) {
        if (!context.state.activeKitchen.markAbsent(id)) {
          return fail(reply, 404, "部分食材不存在");
        }
      }
      return { ok: true } satisfies ActionResult;
    },
  );
}
