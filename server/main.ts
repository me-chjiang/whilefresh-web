import fastifyMultipart from "@fastify/multipart";
import { resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import type { FastifyError } from "fastify";
import { config } from "./config.js";
import { EnvCredentialProvider } from "./ai/credentials.js";
import { DeepSeekChatClient } from "./ai/deepseek-chat-client.js";
import { loadBuiltin } from "./data/builtin.js";
import { systemClock } from "./domain/clock.js";
import { registerClearRoutes } from "./routes/clear.js";
import { registerImportRoutes } from "./routes/import.js";
import { registerItemRoutes } from "./routes/items.js";
import { registerProfileRoutes } from "./routes/profile.js";
import { registerRecipeRoutes } from "./routes/recipes.js";
import { registerShoppingRoutes } from "./routes/shopping.js";
import { registerStateRoutes, type RouteContext } from "./routes/state.js";
import { AppState } from "./services/app-state.js";

const app = Fastify({ logger: true });

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

const builtin = loadBuiltin();
const chatClient = new DeepSeekChatClient({
  credentials: new EnvCredentialProvider(),
});
const state = new AppState({
  dataDir: config.dataDir,
  builtin,
  clock: systemClock,
  chatClient,
});
const context: RouteContext = {
  state,
  builtin,
  dataDir: config.dataDir,
  clock: systemClock,
};

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

app.setErrorHandler((error: FastifyError, _request, reply) => {
  if (error.validation) {
    return reply.code(400).send({ error: "请求参数不正确" });
  }
  if (error.statusCode === 413) {
    return reply.code(413).send({ error: "上传文件过大" });
  }
  if (error.statusCode === 415) {
    return reply.code(415).send({ error: "请求格式不支持" });
  }
  if (error.statusCode === 400) {
    return reply.code(400).send({ error: "请求参数不正确" });
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
});

if (process.env.NODE_ENV === "production") {
  for (const assetType of ["fonts", "textures", "icons"]) {
    await app.register(fastifyStatic, {
      root: resolve(config.assetsDir, assetType),
      prefix: `/assets/${assetType}/`,
      decorateReply: assetType === "fonts",
    });
  }

  await app.register(fastifyStatic, {
    root: resolve(import.meta.dirname, "../dist"),
    decorateReply: false,
  });
}

if (config.host !== "127.0.0.1") {
  app.log.warn(
    `服务监听在 ${config.host}，且当前没有鉴权；请勿暴露到不可信网络。`,
  );
}

app.addHook("onClose", async () => {
  state.close();
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void app.close().finally(() => {
      process.exitCode = 0;
    });
  });
}

await app.listen({ host: config.host, port: config.port });
