import { describe, expect, it } from "vitest";

import { addDays, fixedClock } from "../../server/domain/clock.js";
import { evaluateFreshness } from "../../server/domain/freshness.js";
import {
  freshnessBeyond,
  freshnessBeyondHint,
  freshnessFresh,
  freshnessNearExpiry,
  freshnessUnknown,
} from "../../server/domain/texts.js";

describe("evaluateFreshness", () => {
  const today = "2026-10-21";

  it.each([
    [20, 6, "fresh"],
    [20, 5, "near_expiry"],
    [20, 1, "near_expiry"],
    [20, 0, "beyond_estimate"],
    [20, -3, "beyond_estimate"],
    [3, 2, "fresh"],
    [3, 1, "near_expiry"],
    [10, 3, "fresh"],
    [10, 2, "near_expiry"],
  ])(
    "evaluates %i total days with %i remaining",
    (totalDays, remainingDays, freshness) => {
      expect(
        evaluateFreshness(addDays(today, remainingDays), totalDays, today),
      ).toStrictEqual({ freshness, remainingDays });
    },
  );

  it("is unknown without an expiry date", () => {
    expect(evaluateFreshness(null, 5, today)).toStrictEqual({
      freshness: "unknown",
      remainingDays: null,
    });
  });

  it("changes state as the clock advances", () => {
    const clock = fixedClock(new Date(2026, 9, 21, 9, 0));
    const entryDate = clock.today();
    const expiryDate = addDays(entryDate, 8);

    expect(evaluateFreshness(expiryDate, 8, clock.today())).toStrictEqual({
      freshness: "fresh",
      remainingDays: 8,
    });
    expect(
      evaluateFreshness(expiryDate, 8, addDays(clock.today(), 5)),
    ).toStrictEqual({
      freshness: "fresh",
      remainingDays: 3,
    });
    expect(
      evaluateFreshness(expiryDate, 8, addDays(clock.today(), 6)),
    ).toStrictEqual({
      freshness: "near_expiry",
      remainingDays: 2,
    });
    expect(
      evaluateFreshness(expiryDate, 8, addDays(clock.today(), 8)),
    ).toStrictEqual({
      freshness: "beyond_estimate",
      remainingDays: 0,
    });
  });
});

describe("freshness wording", () => {
  it("avoids safety claims", () => {
    const labels = [
      freshnessFresh(),
      freshnessNearExpiry(),
      freshnessBeyond(),
      freshnessUnknown(),
      freshnessBeyondHint(),
    ];

    for (const label of labels) {
      expect(label).not.toContain("安全");
      expect(label).not.toContain("变质");
    }
    expect(freshnessBeyondHint()).toBe("超出估计期限，请查看后决定");
  });
});
