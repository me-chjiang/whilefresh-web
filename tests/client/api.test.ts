import { describe, expect, it } from "vitest";

import { ApiClient, ApiError } from "../../client/api.js";
import { apiRoutes } from "../../shared/api.js";

function clientWith(fetchImpl: typeof globalThis.fetch): ApiClient {
  return new ApiClient({ fetch: fetchImpl });
}

describe("ApiClient errors", () => {
  it("turns a network failure into a Chinese ApiError", async () => {
    const client = clientWith(() =>
      Promise.reject(new TypeError("Failed to fetch")),
    );
    await expect(client.request(apiRoutes.health)).rejects.toMatchObject({
      name: "ApiError",
      status: 0,
      message: "无法连接到服务，请检查网络后重试",
    });
  });

  it("lets an abort through untouched", async () => {
    const abort = new DOMException("aborted", "AbortError");
    const client = clientWith(() => Promise.reject(abort));
    await expect(client.request(apiRoutes.health)).rejects.toBe(abort);
  });

  it("maps a gateway error page to a stable message", async () => {
    const client = clientWith(() =>
      Promise.resolve(
        new Response("<html>Bad Gateway</html>", { status: 502 }),
      ),
    );
    const error = await client.request(apiRoutes.health).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toBe("服务暂时不可用，请稍后重试");
  });

  it("maps 413 and keeps JSON error text", async () => {
    const tooLarge = clientWith(() =>
      Promise.resolve(new Response("nope", { status: 413 })),
    );
    await expect(tooLarge.request(apiRoutes.health)).rejects.toMatchObject({
      message: "文件太大，请减少图片后重试",
    });
    const json = clientWith(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "食材不存在" }), { status: 404 }),
      ),
    );
    await expect(json.request(apiRoutes.health)).rejects.toMatchObject({
      message: "食材不存在",
      status: 404,
    });
  });
});
