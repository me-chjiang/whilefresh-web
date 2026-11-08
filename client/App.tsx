import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import { api, ApiError } from "./api";
import { BottomNav } from "./components/BottomNav";
import { DemoBanner } from "./components/DemoBanner";
import { Toast } from "./components/Toast";
import { ClearFridgePage } from "./pages/ClearFridgePage";
import { FridgePage } from "./pages/FridgePage";
import { ImportFlowPage } from "./pages/ImportFlowPage";
import { RecipesPage, useRecipeSearch } from "./pages/RecipesPage";
import {
  createNavigation,
  currentPageStack,
  isTabIndex,
  navigationFromHistory,
  pushPageStack,
  switchTab,
  toHistoryNavigation,
  type AppNavigation,
  type PageStackEntry,
  type TabIndex,
} from "./nav";
import { ProfilePage } from "./pages/ProfilePage";
import { ShoppingPage } from "./pages/ShoppingPage";
import type { StateDto } from "../shared/api";

export interface PageSpec {
  title: string;
  element: ReactNode;
  key?: string;
}

export interface AppShellContextValue {
  state: StateDto;
  refresh: () => Promise<void>;
  currentTab: TabIndex;
  pageStack: readonly PageStackEntry[];
  importOpen: boolean;
  switchTab: (index: TabIndex) => void;
  recipeSearch: ReturnType<typeof useRecipeSearch>;
  openRecipeSearch: (keyword: string) => void;
  pushPage: (page: PageSpec) => void;
  goBack: () => void;
  openImport: () => void;
  closeImport: () => void;
  notify: (message: string, action?: NoticeAction) => void;
  setDemoMode: (enabled: boolean) => Promise<void>;
  clearSelectedIds: readonly number[];
  toggleClearItem: (id: number) => void;
}

const AppShellContext = createContext<AppShellContextValue | null>(null);

export function useAppShell(): AppShellContextValue {
  const value = useContext(AppShellContext);
  if (!value) {
    throw new Error("useAppShell 必须在 App 内使用");
  }
  return value;
}

export interface NoticeAction {
  label: string;
  run: () => void;
}

interface Notice {
  id: number;
  message: string;
  action?: NoticeAction;
}

interface PageContent {
  title: string;
  element: ReactNode;
}

const actionButtonStyle: CSSProperties = {
  width: "auto",
  minWidth: "var(--touch)",
  minHeight: "var(--touch)",
  paddingInline: "var(--gap)",
  border: "1.5px solid var(--outline)",
  borderRadius: "var(--radius-row)",
  color: "var(--ink)",
  background: "var(--selected-paper)",
  fontWeight: "var(--weight-strong)",
};

const primaryButtonStyle: CSSProperties = {
  ...actionButtonStyle,
  borderColor: "var(--tomato)",
  color: "var(--text-on-tomato)",
  background: "var(--tomato)",
};

function localDateKey(date = new Date()): string {
  return [
    String(date.getFullYear()).padStart(4, "0"),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message;
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "请稍后重试";
}

export default function App() {
  const initialNavigation = useRef<AppNavigation>(createNavigation());
  const [navigation, setNavigation] = useState(initialNavigation.current);
  const navigationRef = useRef(navigation);
  const [state, setState] = useState<StateDto | null>(null);
  const stateRef = useRef<StateDto | null>(null);
  const [clearSelectionOverride, setClearSelectionOverride] = useState<
    number[] | null
  >(null);
  const recipeSearch = useRecipeSearch();
  const resetRecipeSearch = recipeSearch.reset;
  const runRecipeSearch = recipeSearch.run;
  const [stateError, setStateError] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const noticeSequence = useRef(0);
  const pageSequence = useRef(0);
  const pageContents = useRef(new Map<string, PageContent>());
  const stateRequestSequence = useRef(0);
  const startupNoticeShown = useRef(false);
  const lastDate = useRef(localDateKey());
  const dateRefreshPending = useRef(false);

  const notify = useCallback((message: string, action?: NoticeAction) => {
    setNotice({ id: ++noticeSequence.current, message, action });
  }, []);

  const dismissNotice = useCallback((noticeId: number) => {
    setNotice((current) =>
      current?.id === noticeId ? null : current,
    );
  }, []);

  const loadState = useCallback(async (): Promise<void> => {
    const requestSequence = ++stateRequestSequence.current;
    try {
      const next = await api.state();
      if (requestSequence !== stateRequestSequence.current) {
        return;
      }
      stateRef.current = next;
      setState(next);
      setStateError("");
      lastDate.current = localDateKey();

      if (!startupNoticeShown.current) {
        startupNoticeShown.current = true;
        if (next.startupNotice) {
          notify(next.startupNotice);
        } else if (!next.recognitionConfigured && !next.demoMode) {
          notify("未配置识别服务密钥，可在「我的」开启演示模式");
        }
      }
    } catch (error) {
      if (requestSequence !== stateRequestSequence.current) {
        return;
      }
      const message = errorText(error);
      if (stateRef.current) {
        notify(`刷新失败：${message}`);
      } else {
        setStateError(message);
      }
    }
  }, [notify]);

  const installNavigation = useCallback(
    (next: AppNavigation, method: "push" | "replace") => {
      navigationRef.current = next;
      setNavigation(next);
      const historyState = toHistoryNavigation(next);
      if (method === "push") {
        window.history.pushState(historyState, "");
      } else {
        window.history.replaceState(historyState, "");
      }
    },
    [],
  );

  useEffect(() => {
    void loadState();
  }, [loadState]);

  useEffect(() => {
    window.history.replaceState(
      toHistoryNavigation(navigationRef.current),
      "",
    );
    const handlePopState = (event: PopStateEvent) => {
      const next = navigationFromHistory(event.state);
      if (!next) {
        return;
      }
      const missingContent = next.stacks.some((stack) =>
        stack.some((entry) => !pageContents.current.has(entry.key)),
      );
      if (missingContent) {
        const root = createNavigation();
        navigationRef.current = root;
        setNavigation(root);
        window.history.replaceState(toHistoryNavigation(root), "");
        return;
      }
      navigationRef.current = next;
      setNavigation(next);
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const checkDate = useCallback(() => {
    if (document.visibilityState !== "visible") {
      return;
    }
    const today = localDateKey();
    if (today === lastDate.current || dateRefreshPending.current) {
      return;
    }
    dateRefreshPending.current = true;
    void loadState().finally(() => {
      dateRefreshPending.current = false;
    });
  }, [loadState]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        checkDate();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    const timer = window.setInterval(checkDate, 30_000);
    return () => {
      document.removeEventListener(
        "visibilitychange",
        handleVisibilityChange,
      );
      window.clearInterval(timer);
    };
  }, [checkDate]);

  const selectTab = useCallback(
    (index: TabIndex) => {
      const current = navigationRef.current;
      if (index === current.currentTab) {
        if (current.importOpen) {
          window.history.back();
        } else if (currentPageStack(current).length > 0) {
          installNavigation(switchTab(current, index), "push");
        }
        return;
      }
      const leavingFridge = current.currentTab === 0;
      const next = switchTab(current, index);
      if (current.importOpen) {
        installNavigation(next, "replace");
      } else {
        installNavigation(next, leavingFridge ? "push" : "replace");
      }
    },
    [installNavigation],
  );

  const openRecipeSearch = useCallback(
    (keyword: string) => {
      void runRecipeSearch(keyword);
      const current = navigationRef.current;
      const next = {
        ...switchTab(current, 1),
        stacks: current.stacks.map((stack, i) => (i === 1 ? [] : stack)),
      };
      installNavigation(next, current.importOpen ? "replace" : "push");
    },
    [installNavigation, runRecipeSearch],
  );

  const openImport = useCallback(() => {
    const current = navigationRef.current;
    if (current.importOpen) {
      return;
    }
    installNavigation({ ...current, importOpen: true }, "push");
  }, [installNavigation]);

  const goBack = useCallback(() => {
    const current = navigationRef.current;
    if (
      current.importOpen ||
      currentPageStack(current).length > 0 ||
      current.tabHistory.length > 0
    ) {
      window.history.back();
    }
  }, []);

  const closeImport = useCallback(() => {
    if (navigationRef.current.importOpen) {
      window.history.back();
    }
  }, []);

  const pushPage = useCallback(
    (page: PageSpec) => {
      const current = navigationRef.current;
      const key =
        page.key ??
        `${current.currentTab}:${++pageSequence.current}`;
      pageContents.current.set(key, {
        title: page.title,
        element: page.element,
      });
      const next = pushPageStack(current, { key, title: page.title });
      installNavigation(next, current.importOpen ? "replace" : "push");
    },
    [installNavigation],
  );

  const setDemoMode = useCallback(
    async (enabled: boolean): Promise<void> => {
      try {
        const next = await api.setDemoMode(enabled);
        ++stateRequestSequence.current;
        stateRef.current = next;
        setState(next);
        setClearSelectionOverride(null);
        resetRecipeSearch();
        setStateError("");
        pageContents.current.clear();
        const before = navigationRef.current;
        installNavigation(
          {
            ...createNavigation(),
            currentTab: before.currentTab,
            tabHistory: before.currentTab === 0 ? [] : [0],
            importOpen: before.importOpen,
          },
          "replace",
        );
        notify(enabled ? "已开启演示模式" : "已退出演示模式");
      } catch (error) {
        notify(`切换失败：${errorText(error)}`);
      }
    },
    [installNavigation, notify, resetRecipeSearch],
  );

  const currentStack = currentPageStack(navigation);
  const currentEntry = currentStack.at(-1);
  const currentPage = currentEntry
    ? pageContents.current.get(currentEntry.key)
    : undefined;
  const clearSelectedIds =
    clearSelectionOverride === null
      ? (state?.selectedIds ?? [])
      : clearSelectionOverride.filter((id) =>
          state?.items.some((item) => item.id === id),
        );

  const toggleClearItem = useCallback((id: number) => {
    setClearSelectionOverride((current) => {
      const selected = current ?? stateRef.current?.selectedIds ?? [];
      return selected.includes(id)
        ? selected.filter((selectedId) => selectedId !== id)
        : [...selected, id];
    });
  }, []);

  const shellContext: AppShellContextValue | null = state
    ? {
        state,
        refresh: loadState,
        currentTab: navigation.currentTab,
        pageStack: currentStack,
        importOpen: navigation.importOpen,
        switchTab: selectTab,
        recipeSearch,
        openRecipeSearch,
        pushPage,
        goBack,
        openImport,
        closeImport,
        notify,
        setDemoMode,
        clearSelectedIds,
        toggleClearItem,
      }
    : null;

  let content: ReactNode;
  if (!state) {
    content = (
      <section
        className="page"
        aria-live="polite"
        style={{ margin: "var(--gap-large) var(--gap)" }}
      >
        <h1 style={{ fontSize: "var(--text-title)" }}>趁鲜</h1>
        {stateError ? (
          <>
            <p>暂时读不到冰箱数据：{stateError}</p>
            <button
              type="button"
              style={primaryButtonStyle}
              onClick={() => void loadState()}
            >
              重试
            </button>
          </>
        ) : (
          <p>正在整理你的冰箱…</p>
        )}
      </section>
    );
  } else if (currentEntry) {
    content =
      currentPage?.element ?? (
        <section className="page" style={{ margin: "var(--gap)" }}>
          <header className="top-bar" style={{ paddingInline: 0 }}>
            <button
              type="button"
              style={actionButtonStyle}
              onClick={goBack}
              aria-label="返回"
            >
              ←
            </button>
            <h1>{currentEntry.title}</h1>
            <span aria-hidden="true" style={{ width: "var(--touch)" }} />
          </header>
          <p>这个页面已保留在导航栈中。</p>
        </section>
      );
  } else if (navigation.currentTab === 0) {
    content = <FridgePage />;
  } else if (navigation.currentTab === 1) {
    content = <RecipesPage />;
  } else if (navigation.currentTab === 2) {
    content = <ClearFridgePage />;
  } else if (navigation.currentTab === 3) {
    content = <ShoppingPage />;
  } else {
    content = <ProfilePage />;
  }

  return (
    <AppShellContext.Provider value={shellContext}>
      <div
        style={{
          minHeight: "100dvh",
          paddingBottom:
            "calc(var(--nav-height) + var(--stamp-rise) + var(--gap-small) + env(safe-area-inset-bottom))",
        }}
      >
        <DemoBanner visible={state?.demoMode ?? false} />
        <main aria-busy={!state}>{content}</main>
        <BottomNav
          currentTab={navigation.currentTab}
          nearCount={state?.nearCount ?? 0}
          onSelect={(index) => {
            if (isTabIndex(index)) {
              selectTab(index);
            }
          }}
        />
        <Toast
          noticeId={notice?.id ?? 0}
          message={notice?.message ?? ""}
          action={notice?.action}
          onDismiss={dismissNotice}
        />

        {shellContext && (
          <ImportFlowPage open={navigation.importOpen} />
        )}
      </div>
    </AppShellContext.Provider>
  );
}
