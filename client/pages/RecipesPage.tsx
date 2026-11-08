import { useCallback, useRef, useState } from "react";

import type { WebRecipeSummaryDto } from "../../shared/api";
import { useAppShell } from "../App";
import { api } from "../api";
import { EmptyState } from "../components/EmptyState";
import { Icon } from "../components/Icon";
import { InkButton } from "../components/InkButton";
import { PageHeader } from "../components/PageHeader";
import { WebRecipeDetailPage } from "./WebRecipeDetailPage";

export type RecipeSearchState = "idle" | "busy" | "done" | "error";

export interface RecipeSearch {
  query: string;
  results: WebRecipeSummaryDto[];
  state: RecipeSearchState;
  error: string;
}

const idleSearch: RecipeSearch = {
  query: "",
  results: [],
  state: "idle",
  error: "",
};

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "请稍后重试";
}

export function useRecipeSearch() {
  const [search, setSearch] = useState<RecipeSearch>(idleSearch);
  const active = useRef<AbortController | null>(null);

  const setQuery = useCallback((query: string) => {
    setSearch((current) => ({ ...current, query }));
  }, []);

  const run = useCallback(async (keyword: string) => {
    const trimmed = keyword.trim();
    if (!trimmed) {
      return;
    }

    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setSearch({ query: keyword, results: [], state: "busy", error: "" });

    try {
      const results = await api.webRecipes(trimmed, 1, controller.signal);
      if (active.current !== controller) {
        return;
      }
      setSearch((current) => ({ ...current, results, state: "done" }));
    } catch (error) {
      if (active.current !== controller) {
        return;
      }
      setSearch((current) => ({
        ...current,
        error: errorMessage(error),
        state: "error",
      }));
    } finally {
      if (active.current === controller) {
        active.current = null;
      }
    }
  }, []);

  const cancel = useCallback(() => {
    const controller = active.current;
    active.current = null;
    controller?.abort();
    setSearch((current) => ({ ...current, error: "", state: "idle" }));
  }, []);

  const reset = useCallback(() => {
    const controller = active.current;
    active.current = null;
    controller?.abort();
    setSearch(idleSearch);
  }, []);

  return { search, setQuery, run, cancel, reset };
}

export function RecipesPage() {
  const {
    goBack,
    pushPage,
    recipeSearch: { search, setQuery, run, cancel },
  } = useAppShell();
  const [needKeyword, setNeedKeyword] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const busy = search.state === "busy";

  const submitSearch = () => {
    if (busy) {
      cancel();
      return;
    }
    if (!search.query.trim()) {
      setNeedKeyword(true);
      inputRef.current?.focus();
      return;
    }
    void run(search.query);
  };

  return (
    <section className="page-shell">
      <PageHeader
        heading="菜谱"
        subtitle="下厨房"
      />

      <form
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) {
            submitSearch();
          }
        }}
        style={{
          display: "flex",
          alignItems: "center",
          minHeight: "var(--touch)",
          gap: "var(--gap-small)",
          marginTop: "var(--gap-small)",
          paddingInline: "var(--gap)",
          border: "1px solid var(--outline)",
          borderRadius: "var(--radius-row)",
          background: "var(--card)",
        }}
      >
        <Icon name="search" size={22} color="var(--muted)" />
        <input
          ref={inputRef}
          type="search"
          aria-label="搜索菜名"
          aria-invalid={needKeyword}
          placeholder="搜索菜名"
          value={search.query}
          onChange={(event) => {
            setNeedKeyword(false);
            setQuery(event.target.value);
          }}
          style={{
            width: "100%",
            minWidth: 0,
            minHeight: "calc(var(--touch) - 2px)",
            padding: 0,
            border: 0,
            outline: 0,
            color: "var(--ink)",
            background: "transparent",
            fontSize: "var(--text-quantity)",
          }}
        />
      </form>
      {needKeyword && (
        <p role="status" className="field-hint">
          请输入菜名或食材
        </p>
      )}

      <InkButton
        fullWidth
        text={busy ? "取消搜索" : "搜下厨房"}
        iconName={busy ? "x" : "search"}
        outline={busy}
        onClick={submitSearch}
        style={{ marginTop: "var(--gap)" }}
      />

      {(search.state === "busy" || search.state === "error") && (
        <p
          role={search.state === "error" ? "alert" : "status"}
          aria-live="polite"
          style={{
            margin: "var(--gap) 0 0",
            color:
              search.state === "error" ? "var(--nearing)" : "var(--muted)",
            fontSize: "var(--text-subtitle)",
          }}
        >
          {busy ? "搜索中…" : search.error}
        </p>
      )}

      {search.state === "done" && search.results.length === 0 && (
        <EmptyState
          iconName="book-2"
          heading="没有找到菜谱"
          detail=""
          style={{
            marginTop: "var(--gap)",
            paddingBlock: "calc(var(--gap-large) * 2)",
          }}
        />
      )}

      {search.results.length > 0 && (
        <ul className="recipe-list">
          {search.results.map((recipe) => (
            <li key={recipe.id}>
              <button
                type="button"
                className="recipe-card"
                onClick={() =>
                  pushPage({
                    key: `web-recipe-detail-${recipe.id}`,
                    title: "菜谱卡",
                    element: (
                      <WebRecipeDetailPage
                        recipeId={recipe.id}
                        onBack={goBack}
                      />
                    ),
                  })
                }
              >
                <span className="recipe-card__main">
                  <span className="recipe-card__title">{recipe.name}</span>
                  <span className="recipe-card__meta">
                    <span className="src-tag">
                      <Icon name="book-2" size={13} />
                      下厨房
                    </span>
                  </span>
                </span>
                <Icon name="chevron-right" size={20} color="var(--outline)" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
