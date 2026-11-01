import { describe, expect, it } from "vitest";

import {
  parseDateText,
  parseShelfLifeLabel,
} from "../../server/domain/date-text.js";

const baseDate = "2026-10-21";

describe("parseDateText", () => {
  it.each([
    ["今天生产", baseDate, "2026-10-21"],
    ["昨天生产", baseDate, "2026-10-20"],
    ["前天", baseDate, "2026-10-19"],
    ["大前天生产", baseDate, "2026-10-18"],
    ["明天到期", baseDate, "2026-10-22"],
    ["3天前生产", baseDate, "2026-10-18"],
    ["10月18日生产", baseDate, "2026-10-18"],
    ["2026-10-18", baseDate, "2026-10-18"],
    ["10/18 到期", "2026-10-10", "2025-10-18"],
    ["2026年10月18日", baseDate, "2026-10-18"],
    ["生产日期：2026.10.18", baseDate, "2026-10-18"],
    ["20261018", baseDate, "2026-10-18"],
    ["１０月１８日", baseDate, "2026-10-18"],
    ["2026-10-18", null, "2026-10-18"],
    ["12月30日生产", "2027-01-02", "2026-12-30"],
    ["1月2日", "2027-01-02", "2027-01-02"],
    ["1/5到期", "2026-12-28", "2026-01-05"],
    ["昨天生产", "2027-01-01", "2026-12-31"],
    ["2月29日", "2027-03-01", "2024-02-29"],
  ])("parses %s", (text, base, date) => {
    expect(parseDateText(text, base)).toStrictEqual({
      status: "ok",
      date,
    });
  });

  it.each([
    "今天生产",
    "昨天生产",
    "10月18日生产",
    "10/18 到期",
    "2天前",
  ])("needs a base date for %s when the photo date is missing", (text) => {
    expect(parseDateText(text, null)).toStrictEqual({
      status: "needs_base_date",
    });
  });

  it.each(["新鲜直达", "2026-02-30", "13月5日"])(
    "keeps %s unparseable",
    (text) => {
      expect(parseDateText(text, baseDate)).toStrictEqual({
        status: "unparseable",
      });
    },
  );

  it("reports empty text", () => {
    expect(parseDateText("  ", baseDate)).toStrictEqual({ status: "empty" });
  });
});

describe("parseShelfLifeLabel", () => {
  it.each([
    ["保质期180天", 180],
    ["保质期：12个月", 360],
    ["保质期 1 年", 365],
  ])("parses %s", (text, days) => {
    expect(parseShelfLifeLabel(text)).toBe(days);
  });

  it("does not treat an expiry date as a labelled shelf life", () => {
    expect(parseShelfLifeLabel("2026-11-03到期")).toBeNull();
  });
});
