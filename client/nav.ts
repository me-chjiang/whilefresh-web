export const tabs = [
  { index: 0, id: "fridge", label: "冰箱", icon: "fridge" },
  { index: 1, id: "recipes", label: "菜谱", icon: "book-2" },
  { index: 2, id: "clear", label: "清冰箱", icon: "chef-hat" },
  { index: 3, id: "shopping", label: "待买", icon: "list-check" },
  { index: 4, id: "profile", label: "我的", icon: "user" },
] as const;

export type TabIndex = (typeof tabs)[number]["index"];

export interface PageStackEntry {
  key: string;
  title: string;
}

export interface AppNavigation {
  currentTab: TabIndex;
  stacks: PageStackEntry[][];
  tabHistory: TabIndex[];
  importOpen: boolean;
}

export interface HistoryNavigation extends AppNavigation {
  whileFreshNavigation: 1;
}

export function isTabIndex(value: unknown): value is TabIndex {
  return (
    Number.isInteger(value) &&
    Number(value) >= 0 &&
    Number(value) < tabs.length
  );
}

export function createNavigation(): AppNavigation {
  return {
    currentTab: 0,
    stacks: tabs.map(() => []),
    tabHistory: [],
    importOpen: false,
  };
}

export function currentPageStack(
  navigation: AppNavigation,
): PageStackEntry[] {
  return navigation.stacks[navigation.currentTab];
}

export function switchTab(
  navigation: AppNavigation,
  index: TabIndex,
): AppNavigation {
  if (index === navigation.currentTab) {
    return popToRoot(navigation);
  }
  return {
    ...navigation,
    currentTab: index,
    stacks: navigation.stacks.map((stack, i) =>
      i === navigation.currentTab ? [] : stack,
    ),
    tabHistory: index === 0 ? [] : [0],
    importOpen: false,
  };
}

export function popToRoot(navigation: AppNavigation): AppNavigation {
  return {
    ...navigation,
    stacks: navigation.stacks.map((stack, i) =>
      i === navigation.currentTab ? [] : stack,
    ),
    importOpen: false,
  };
}

export function pushPageStack(
  navigation: AppNavigation,
  entry: PageStackEntry,
): AppNavigation {
  return {
    ...navigation,
    stacks: navigation.stacks.map((stack, index) =>
      index === navigation.currentTab ? [...stack, entry] : stack,
    ),
    importOpen: false,
  };
}

export function toHistoryNavigation(
  navigation: AppNavigation,
): HistoryNavigation {
  return { ...navigation, whileFreshNavigation: 1 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readPageStack(value: unknown): PageStackEntry[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const entries: PageStackEntry[] = [];
  for (const item of value) {
    if (
      !isRecord(item) ||
      typeof item.key !== "string" ||
      typeof item.title !== "string"
    ) {
      return null;
    }
    entries.push({ key: item.key, title: item.title });
  }
  return entries;
}

export function navigationFromHistory(value: unknown): AppNavigation | null {
  if (!isRecord(value) || value.whileFreshNavigation !== 1) {
    return null;
  }
  if (!isTabIndex(value.currentTab) || !Array.isArray(value.stacks)) {
    return null;
  }
  if (value.stacks.length !== tabs.length) {
    return null;
  }
  const stacks: PageStackEntry[][] = [];
  for (const stack of value.stacks) {
    const parsed = readPageStack(stack);
    if (!parsed) {
      return null;
    }
    stacks.push(parsed);
  }
  if (
    !Array.isArray(value.tabHistory) ||
    !value.tabHistory.every(isTabIndex) ||
    typeof value.importOpen !== "boolean"
  ) {
    return null;
  }
  return {
    currentTab: value.currentTab,
    stacks,
    tabHistory: [...value.tabHistory],
    importOpen: value.importOpen,
  };
}
