import { describe, expect, it } from "vitest";

import { sameStatusState } from "../../server/domain/undo.js";

describe("sameStatusState", () => {
  it("treats equal states as the same", () => {
    const at = new Date("2026-10-21T12:00:00Z");
    expect(
      sameStatusState(
        { status: "used", statusChangedAt: at, snoozedUntil: "2026-10-22" },
        { status: "used", statusChangedAt: new Date(at), snoozedUntil: "2026-10-22" },
      ),
    ).toBe(true);
  });

  it("detects a different status", () => {
    expect(
      sameStatusState({ status: "in_stock" }, { status: "discarded" }),
    ).toBe(false);
  });

  it("detects a different timestamp", () => {
    expect(
      sameStatusState(
        { status: "used", statusChangedAt: new Date("2026-10-21T12:00:00Z") },
        { status: "used", statusChangedAt: new Date("2026-10-21T12:00:01Z") },
      ),
    ).toBe(false);
  });

  it("treats null and undefined as equal", () => {
    expect(
      sameStatusState(
        { status: "in_stock", statusChangedAt: null, snoozedUntil: null },
        { status: "in_stock" },
      ),
    ).toBe(true);
  });
});
