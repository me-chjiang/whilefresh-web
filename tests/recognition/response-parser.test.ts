import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { Catalog } from "../../server/domain/catalog.js";
import {
  mergeResults,
  parseChatCompletion,
  parseModelContent,
  type ParseOutcome,
} from "../../server/recognition/response-parser.js";
import {
  ErrorKind,
  InputKind,
  ItemCategory,
  SourceType,
  StorageKind,
  type RecognitionResult,
  userMessageFor,
} from "../../server/recognition/types.js";

const vocabulary = Catalog.fromJson(
  readFileSync(
    new URL(
      "../../test-data/vocabulary/synthetic-vocabulary.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const UNCATEGORIZED_NAME = "未归类";

function chatCompletion(
  content: string,
  promptTokens = 100,
  completionTokens = 50,
  finishReason = "stop",
): string {
  return JSON.stringify({
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  });
}

function itemJson(
  rawName: string,
  canonicalName: string,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    raw_name: rawName,
    canonical_name: canonicalName,
    ...extra,
  });
}

function modelJson(items: readonly string[], ignoredSummary?: string): string {
  return JSON.stringify({
    source_type: "cart",
    items: items.map((item) => JSON.parse(item) as unknown),
    ...(ignoredSummary === undefined
      ? {}
      : { ignored_summary: ignoredSummary }),
  });
}

function parseContent(
  content: string,
  kind: InputKind = InputKind.Screenshot,
): ParseOutcome {
  return parseChatCompletion(chatCompletion(content), vocabulary, kind);
}

function resultOf(outcome: ParseOutcome): RecognitionResult {
  if (!outcome.result) {
    throw new Error(`expected a result: ${outcome.error.detail}`);
  }
  return outcome.result;
}

describe("response parser", () => {
  it("parses a full item", () => {
    const item = JSON.stringify({
      raw_name: "【爆款】川香麻辣香肠 200g",
      canonical_name: "香肠",
      quantity_text: "200g",
      count: 2,
      category: "food",
      selected: true,
      is_gift: false,
      production_date_text: "今天生产",
      expiry_date_text: "2026-11-03到期",
      purchase_date_text: "2026-10-18 19:42",
      storage: "freezer",
      shelf_life_days: { fridge: 30, freezer: 180, room: null },
      image_index: 2,
    });
    const outcome = parseChatCompletion(
      chatCompletion(modelJson([item], "换购推荐"), 1200, 340),
      vocabulary,
      InputKind.Screenshot,
    );
    const result = resultOf(outcome);

    expect(result.sourceType).toBe(SourceType.Cart);
    expect(result.ignoredSummary).toBe("换购推荐");
    expect(result.usage.promptTokens).toBe(1200);
    expect(result.usage.completionTokens).toBe(340);
    expect(result.usage.totalTokens).toBe(1540);
    expect(result.rawResponses).toHaveLength(1);
    expect(result.items).toHaveLength(1);

    expect(result.items[0]).toMatchObject({
      rawName: "【爆款】川香麻辣香肠 200g",
      canonicalName: "香肠",
      quantityText: "200g",
      count: 2,
      category: ItemCategory.Food,
      selected: true,
      isGift: false,
      productionDateText: "今天生产",
      expiryDateText: "2026-11-03到期",
      purchaseDateText: "2026-10-18 19:42",
      storage: StorageKind.Freezer,
      shelfLifeDays: { fridge: 30, freezer: 180, room: null },
      imageIndex: 1,
    });
  });

  it("tolerates code fences and surrounding prose", () => {
    const json = modelJson([itemJson("鸡蛋 10枚", "鸡蛋")]);
    const wrappedValues = [
      `\`\`\`json\n${json}\n\`\`\``,
      `\`\`\`\n${json}\n\`\`\``,
      `  \`\`\`JSON\n${json}\`\`\`  `,
      `好的，结果如下：\n${json}\n希望有帮助`,
    ];

    for (const wrapped of wrappedValues) {
      expect(resultOf(parseContent(wrapped)).items, wrapped).toHaveLength(1);
    }
  });

  it("defaults missing fields", () => {
    const result = resultOf(
      parseContent(modelJson([JSON.stringify({ raw_name: "鸡蛋" })])),
    );
    const item = result.items[0];

    expect(item.canonicalName).toBe(UNCATEGORIZED_NAME);
    expect(item.count).toBe(1);
    expect(item.category).toBe(ItemCategory.Food);
    expect(item.selected).toBe(true);
    expect(item.isGift).toBe(false);
    expect(item.quantityText).toBe("");
    expect(item.productionDateText).toBe("");
    expect(item.expiryDateText).toBe("");
    expect(item.purchaseDateText).toBe("");
    expect(item.storage).toBe(StorageKind.Unknown);
    expect(item.shelfLifeDays).toEqual({
      fridge: null,
      freezer: null,
      room: null,
    });
    expect(item.imageIndex).toBe(-1);
    expect(result.ignoredSummary).toBe("");
  });

  it("tolerates wrong field types", () => {
    const item = JSON.stringify({
      raw_name: "西红柿",
      canonical_name: "西红柿",
      count: "3件",
      selected: "false",
      is_gift: "是",
      quantity_text: 500,
      production_date_text: "null",
      expiry_date_text: "无",
      purchase_date_text: "",
      category: "mystery",
      storage: "cellar",
      shelf_life_days: { fridge: "7", freezer: -3, room: 0 },
      image_index: "第2张",
    });
    const result = resultOf(
      parseContent(
        modelJson([item, JSON.stringify("not an object"), JSON.stringify(42)]),
      ),
    );

    expect(result.items).toHaveLength(1);
    const parsed = result.items[0];
    expect(parsed.count).toBe(3);
    expect(parsed.selected).toBe(false);
    expect(parsed.isGift).toBe(true);
    expect(parsed.quantityText).toBe("500");
    expect(parsed.productionDateText).toBe("");
    expect(parsed.expiryDateText).toBe("");
    expect(parsed.category).toBe(ItemCategory.Food);
    expect(parsed.storage).toBe(StorageKind.Unknown);
    expect(parsed.shelfLifeDays).toEqual({
      fridge: 7,
      freezer: null,
      room: null,
    });
    expect(parsed.imageIndex).toBe(1);
  });

  it("clamps counts", () => {
    const result = resultOf(
      parseContent(
        modelJson([
          JSON.stringify({ raw_name: "a", count: 0 }),
          JSON.stringify({ raw_name: "b", count: -4 }),
          JSON.stringify({ raw_name: "c", count: 100000 }),
        ]),
      ),
    );

    expect(result.items.map((item) => item.count)).toEqual([1, 1, 999]);
  });

  it("only accepts vocabulary names", () => {
    const result = resultOf(
      parseContent(
        modelJson([
          itemJson("a", "五花肉"),
          itemJson("b", "川味香肠"),
          itemJson("c", "麻婆豆腐料理包"),
          itemJson("d", "未归类"),
          itemJson("e", ""),
          JSON.stringify({ raw_name: "f" }),
        ]),
      ),
    );

    expect(result.items.map((item) => item.canonicalName)).toEqual([
      "五花肉",
      "香肠",
      UNCATEGORIZED_NAME,
      UNCATEGORIZED_NAME,
      UNCATEGORIZED_NAME,
      UNCATEGORIZED_NAME,
    ]);
    expect(result.items[2].rawName).toBe("c");
  });

  it("keeps model names without a vocabulary", () => {
    const outcome = parseChatCompletion(
      chatCompletion(modelJson([itemJson("a", "随便")])),
      null,
      InputKind.Screenshot,
    );

    expect(resultOf(outcome).items[0].canonicalName).toBe("随便");
  });

  it("drops items without either name", () => {
    const result = resultOf(
      parseContent(
        modelJson([
          JSON.stringify({}),
          JSON.stringify({ count: 2 }),
        ]),
      ),
    );

    expect(result.items).toEqual([]);
  });

  it("accepts a bare array", () => {
    const result = resultOf(
      parseContent(`[${itemJson("鸡蛋", "鸡蛋")}]`),
    );

    expect(result.items).toHaveLength(1);
  });

  it("falls back to the input kind for the source type", () => {
    const noType = JSON.stringify({ items: [] });
    expect(resultOf(parseContent(noType, InputKind.Receipt)).sourceType).toBe(
      SourceType.Receipt,
    );
    expect(resultOf(parseContent(noType, InputKind.OrderText)).sourceType).toBe(
      SourceType.Text,
    );
    expect(resultOf(parseContent(noType, InputKind.Screenshot)).sourceType).toBe(
      SourceType.Other,
    );
    expect(
      resultOf(
        parseContent(JSON.stringify({ source_type: "order", items: [] })),
      ).sourceType,
    ).toBe(SourceType.Order);
    expect(
      resultOf(
        parseContent(
          JSON.stringify({ source_type: "bogus", items: [] }),
          InputKind.Receipt,
        ),
      ).sourceType,
    ).toBe(SourceType.Receipt);
  });

  it.each([
    ["not JSON at all", "<html>502</html>"],
    ["no choices", JSON.stringify({ usage: {} })],
    [
      "model text is prose",
      chatCompletion("抱歉，我无法识别这张图片。"),
    ],
    [
      "truncated JSON",
      chatCompletion('{"items":[{"raw_name":"鸡'),
    ],
    ["empty content", chatCompletion("")],
    [
      "object without items",
      chatCompletion(JSON.stringify({ error: "x" })),
    ],
    [
      "items not an array",
      chatCompletion(JSON.stringify({ items: "none" })),
    ],
    ["no choices at all", JSON.stringify({ choices: [] })],
    [
      "empty and cut off",
      chatCompletion("", 10, 8000, "length"),
    ],
    [
      "cut off before the first item completes",
      chatCompletion(
        '{"source_type":"cart","items":[{"raw_name":"鸡蛋","count',
        10,
        8000,
        "length",
      ),
    ],
    [
      "cut off without items key",
      chatCompletion('{"source_ty', 10, 8000, "length"),
    ],
  ])("rejects unusable responses: %s", (_name, body) => {
    const outcome = parseChatCompletion(
      body,
      vocabulary,
      InputKind.Screenshot,
    );

    expect(outcome.result).toBeNull();
    expect(outcome.error.kind).toBe(ErrorKind.BadResponse);
    expect(outcome.error.userMessage.length).toBeGreaterThan(0);
    expect(outcome.error.detail.length).toBeGreaterThan(0);
  });

  it("keeps complete items from a cut-off reply", () => {
    const whole1 = itemJson("鲜鸡蛋", "鸡蛋", { count: 2 });
    const whole2 = itemJson('a}{b "x"', "洋葱");
    const cut =
      `{"source_type":"order","items":[${whole1},\n ` +
      `${whole2},\n {"raw_name":"牛奶","canonical_na`;

    for (const content of [cut, `\`\`\`json\n${cut}`]) {
      const result = resultOf(
        parseChatCompletion(
          chatCompletion(content, 700, 8000, "length"),
          vocabulary,
          InputKind.Screenshot,
        ),
      );

      expect(result.truncated).toBe(true);
      expect(result.items).toHaveLength(2);
      expect(result.items[0].count).toBe(2);
      expect(result.items[1].canonicalName).toBe("洋葱");
      expect(result.sourceType).toBe(SourceType.Order);
      expect(result.usage.totalTokens).toBe(8700);
      expect(result.rawResponses).toHaveLength(1);
    }
  });

  it("flags a complete reply that ended on the limit", () => {
    const result = resultOf(
      parseChatCompletion(
        chatCompletion(
          modelJson([itemJson("a", "鸡蛋")]),
          10,
          4096,
          "length",
        ),
        vocabulary,
        InputKind.Screenshot,
      ),
    );

    expect(result.truncated).toBe(true);
    expect(result.items).toHaveLength(1);
  });

  it("does not flag normal replies and rejects empty ones", () => {
    expect(
      resultOf(
        parseContent(modelJson([itemJson("a", "鸡蛋")])),
      ).truncated,
    ).toBe(false);
    expect(
      parseChatCompletion(
        chatCompletion(""),
        null,
        InputKind.Screenshot,
      ).result,
    ).toBeNull();
  });

  it("saturates huge numbers instead of turning them into zero", () => {
    const result = resultOf(
      parseContent(
        modelJson([
          JSON.stringify({
            raw_name: "a",
            count: "99999999999999999999",
          }),
          JSON.stringify({ raw_name: "b", count: 1e300 }),
          JSON.stringify({
            raw_name: "c",
            count: 3.6,
            shelf_life_days: { fridge: "99999999999" },
          }),
        ]),
      ),
    );

    expect(result.items[0].count).toBe(999);
    expect(result.items[1].count).toBe(999);
    expect(result.items[2].count).toBe(4);
    expect(result.items[2].shelfLifeDays.fridge).toBeNull();
  });

  it("uses concise Chinese user messages", () => {
    for (const kind of [
      ErrorKind.NotConfigured,
      ErrorKind.NoNetwork,
      ErrorKind.Timeout,
      ErrorKind.AuthFailed,
      ErrorKind.QuotaOrRateLimit,
      ErrorKind.ServerError,
      ErrorKind.RequestRejected,
      ErrorKind.BadResponse,
      ErrorKind.InvalidInput,
      ErrorKind.Internal,
    ]) {
      const message = userMessageFor(kind);
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toContain("HTTP");
      expect(message).not.toContain("JSON");
      expect(message).not.toContain("401");
    }
  });

  it("only drops overlap duplicates from an image split across requests", () => {
    const part = (
      items: readonly string[],
      firstImage: number,
      lastImage: number,
    ): RecognitionResult => {
      const result = resultOf(
        parseChatCompletion(
          chatCompletion(modelJson(items), 100, 10),
          vocabulary,
          InputKind.Screenshot,
        ),
      );
      result.batchSpans = [{ firstImage, lastImage }];
      return result;
    };
    const egg = (
      extra: Record<string, unknown> = {},
    ): string =>
      itemJson("鲜鸡蛋", "鸡蛋", {
        quantity_text: "10枚",
        ...extra,
      });
    const onion = itemJson("洋葱", "洋葱");

    const first = part(
      [egg({ image_index: 4 }), onion],
      0,
      3,
    );
    first.ignoredSummary = "热卖推荐";
    const second = part(
      [
        egg({ image_index: 4 }),
        egg({ image_index: 6 }),
        egg({ image_index: 6, is_gift: true }),
        onion,
      ],
      3,
      6,
    );
    second.ignoredSummary = "热卖推荐";
    const third = part([egg({ image_index: 6 })], 7, 8);
    third.ignoredSummary = "优惠横幅";

    const merged = mergeResults([first, second, third]);

    expect(merged.items).toHaveLength(5);
    expect(merged.items[2].imageIndex).toBe(5);
    expect(merged.items[3].isGift).toBe(true);
    expect(merged.rawResponses).toHaveLength(3);
    expect(merged.batchSpans).toHaveLength(3);
    expect(merged.usage.totalTokens).toBe(330);
    expect(merged.ignoredSummary).toBe("热卖推荐；优惠横幅");
    expect(merged.sourceType).toBe(SourceType.Cart);
  });

  it("drops nothing for results without spans", () => {
    const egg = itemJson("鲜鸡蛋", "鸡蛋");
    const one = resultOf(
      parseChatCompletion(
        chatCompletion(modelJson([egg])),
        null,
        InputKind.Screenshot,
      ),
    );

    expect(mergeResults([one, one]).items).toHaveLength(2);
  });

  it("keeps the truncated flag when merging", () => {
    const a = resultOf(
      parseChatCompletion(
        chatCompletion(modelJson([itemJson("a", "鸡蛋")])),
        null,
        InputKind.Screenshot,
      ),
    );
    const b = resultOf(
      parseChatCompletion(
        chatCompletion(modelJson([itemJson("b", "鸡蛋")])),
        null,
        InputKind.Screenshot,
      ),
    );
    b.truncated = true;

    expect(mergeResults([a, b]).truncated).toBe(true);
    expect(mergeResults([a, a]).truncated).toBe(false);
  });

  it("merges no results into an empty result", () => {
    const merged = mergeResults([]);

    expect(merged.items).toEqual([]);
    expect(merged.sourceType).toBe(SourceType.Other);
  });
});
