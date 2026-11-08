import { describe, expect, it } from "vitest";

import {
  createNavigation,
  navigationFromHistory,
  pushPageStack,
  switchTab,
  toHistoryNavigation,
} from "../../client/nav.js";

describe("tab navigation", () => {
  it("clears the departing tab stack and keeps the tabHistory shape", () => {
    const withPage = pushPageStack(createNavigation(), {
      key: "edit-item-1",
      title: "编辑食材",
    });
    const profile = switchTab(withPage, 4);
    expect(profile.currentTab).toBe(4);
    expect(profile.stacks[0]).toEqual([]);
    expect(profile.tabHistory).toEqual([0]);

    const back = switchTab(profile, 0);
    expect(back.currentTab).toBe(0);
    expect(back.tabHistory).toEqual([]);
  });

  it("pops to the tab root when the current tab is re-selected", () => {
    const recipes = pushPageStack(switchTab(createNavigation(), 1), {
      key: "recipe-9",
      title: "菜谱",
    });
    expect(recipes.stacks[1]).toHaveLength(1);
    const root = switchTab(recipes, 1);
    expect(root.currentTab).toBe(1);
    expect(root.stacks[1]).toEqual([]);
    expect(root.tabHistory).toEqual([0]);
  });

  it("round-trips through history state", () => {
    const navigation = pushPageStack(switchTab(createNavigation(), 3), {
      key: "a",
      title: "A",
    });
    expect(navigationFromHistory(toHistoryNavigation(navigation))).toEqual(
      navigation,
    );
    expect(navigationFromHistory({ currentTab: 1 })).toBeNull();
  });
});
