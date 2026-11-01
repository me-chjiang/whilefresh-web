import { describe, expect, it } from "vitest";

import { buildSystemPrompt } from "../../server/ai/system-prompt-builder.js";

describe("system prompt builder", () => {
  it("trims a base-only prompt", () => {
    expect(buildSystemPrompt("你是厨房助手。\n", [])).toBe("你是厨房助手。");
  });

  it("keeps sections in order and puts the preference summary last", () => {
    const sections = [
      { title: "库存", body: "鸡蛋、番茄" },
      { title: "常备调料", body: "盐、生抽" },
    ];
    const prompt = buildSystemPrompt(
      "你是厨房助手。",
      sections,
      "不吃香菜；少油。",
    );
    expect(prompt).toBe(
      "你是厨房助手。\n\n" +
        "【库存】\n鸡蛋、番茄\n\n" +
        "【常备调料】\n盐、生抽\n\n" +
        "【用户偏好】\n不吃香菜；少油。",
    );

    const withSupplement = buildSystemPrompt(
      "你是厨房助手。",
      [...sections, { title: "补充", body: "两人份" }],
      "不吃香菜；少油。",
    );
    expect(withSupplement.endsWith("【用户偏好】\n不吃香菜；少油。")).toBe(true);
    expect(withSupplement.indexOf("【补充】")).toBeLessThan(
      withSupplement.indexOf("【用户偏好】"),
    );
  });

  it("omits empty sections and an empty preference summary", () => {
    const prompt = buildSystemPrompt(
      "基础",
      [
        { title: "空", body: "  \n" },
        { title: "库存", body: " 鸡蛋 " },
      ],
      "  ",
    );
    expect(prompt).toBe("基础\n\n【库存】\n鸡蛋");
    expect(prompt).not.toContain("用户偏好");
  });
});
