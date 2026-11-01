import { fileURLToPath } from "node:url";

import { defineConfig } from "@playwright/test";

process.env.PLAYWRIGHT_BROWSERS_PATH ??= fileURLToPath(
  new URL("./.cache/ms-playwright", import.meta.url),
);
process.env.NO_PROXY = [
  process.env.NO_PROXY ?? process.env.no_proxy,
  "127.0.0.1",
  "localhost",
]
  .filter(Boolean)
  .join(",");
process.env.no_proxy = process.env.NO_PROXY;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  use: {
    baseURL: "http://127.0.0.1:5174",
    viewport: { width: 412, height: 915 },
    permissions: ["clipboard-read", "clipboard-write"],
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command:
      "pnpm build && WHILEFRESH_DATA_DIR=$(mktemp -d) pnpm start",
    url: "http://127.0.0.1:5174/api/health",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
