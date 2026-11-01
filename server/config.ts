import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("../", import.meta.url));

export const config = {
  dataDir: resolve(process.env.WHILEFRESH_DATA_DIR ?? resolve(rootDir, "data")),
  assetsDir: resolve(rootDir, "assets"),
  host: process.env.WHILEFRESH_HOST || "127.0.0.1",
  port: 5174,
  apiKey: process.env.WHILEFRESH_DEEPSEEK_API_KEY ?? "",
} as const;
