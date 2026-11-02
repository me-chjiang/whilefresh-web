import { describe, expect, it } from "vitest";

import {
  parseAmount,
  totalAmount,
  type Amount,
} from "../../server/domain/quantity.js";

const parseRows: readonly [string, string, number, string][] = [
  ["grams", "500g", 500, "g"],
  ["kilograms", "1.5kg", 1500, "g"],
  ["upper case", "500G", 500, "g"],
  ["chinese grams with prefix", "约350克", 350, "g"],
  ["gongjin", "2公斤", 2000, "g"],
  ["jin", "2斤", 1000, "g"],
  ["half a jin", "半斤", 250, "g"],
  ["full width", "５００ｇ", 500, "g"],
  ["label before", "净含量：1kg", 1000, "g"],
  ["ml times count", "500ml×2", 1000, "ml"],
  ["ml star packs", "250ml*6盒", 1500, "ml"],
  ["count times grams", "2袋x500g", 1000, "g"],
  ["litre", "1L", 1000, "ml"],
  ["sheng", "1.5升", 1500, "ml"],
  ["boxes", "2盒", 2, "盒"],
  ["pieces", "3个", 3, "个"],
  ["bunch", "1把", 1, "把"],
  ["eggs", "10枚", 10, "枚"],
  ["chinese numeral", "两盒", 2, "盒"],
  ["measure wins over count", "500g（约3个）", 500, "g"],
  ["unrelated number not a multiplier", "500g 2件起售", 500, "g"],
  ["empty", "", 0, ""],
  ["no number", "适量", 0, ""],
  ["bare number", "500", 0, ""],
  ["unknown unit", "3人份", 0, ""],
];

describe("quantity parsing", () => {
  it.each(parseRows)("parses %s", (_label, text, value, unit) => {
    const amount = parseAmount(text);

    expect(amount.value).toBe(value);
    expect(amount.unit).toBe(unit);
    expect(amount.value > 0).toBe(value > 0);
  });

  it("multiplies totals by packages", () => {
    const cases: readonly [string, number, Amount][] = [
      ["500g", 2, { value: 1000, unit: "g" }],
      ["3个", 2, { value: 6, unit: "个" }],
      ["适量", 2, { value: 0, unit: "" }],
      ["1把", 0, { value: 1, unit: "把" }],
    ];

    for (const [text, count, expected] of cases) {
      expect(totalAmount(text, count)).toEqual(expected);
    }
  });
});
