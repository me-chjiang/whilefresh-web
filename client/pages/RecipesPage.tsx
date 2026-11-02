import { useCallback, useEffect, useRef, useState } from "react";

import type { WebRecipeSummaryDto } from "../../shared/api";
import { useAppShell } from "../App";
import { api } from "../api";
import { EmptyState } from "../components/EmptyState";
import { Icon } from "../components/Icon";
import { InkButton } from "../components/InkButton";
import { PageHeader } from "../components/PageHeader";

export interface RecipesPageProps {
  initialKeyword?: string;
}

type SearchState = "idle" | "busy" | "done" | "error";

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "请稍后重试";
}

function WebRecipeDetailPage({
  recipeId,
  onBack,
}: {
  recipeId: string;
  onBack: () => void;
}) {
  return (
    <section
      className="page"
      data-recipe-id={recipeId}
      style={{
        minHeight: "calc(100dvh - var(--nav-height) - var(--gap-large))",
        margin: "var(--gap-small) var(--gap) var(--gap-large)",
        paddingInline: "var(--section-padding)",
      }}
    >
      <PageHeader
        heading="菜谱卡"
        backVisible
        onBack={onBack}
        style={{ marginInline: "calc(-1 * var(--section-padding))" }}
      />
      <p style={{ marginTop: "var(--gap-large)", color: "var(--muted)" }}>
        菜谱详情将在后续步骤提供。
      </p>
    </section>
  );
}

export function RecipesPage({ initialKeyword = "" }: RecipesPageProps) {
  const { goBack, pushPage } = useAppShell();
  const [query, setQuery] = useState(initialKeyword);
  const [results, setResults] = useState<WebRecipeSummaryDto[]>([]);
  const [searchState, setSearchState] = useState<SearchState>("idle");
  const [searchError, setSearchError] = useState("");
  const activeSearch = useRef<AbortController | null>(null);
  const trimmedQuery = query.trim();

  const searchRecipes = useCallback(async (keyword: string) => {
    const trimmed = keyword.trim();
    if (!trimmed) {
      return;
    }

    activeSearch.current?.abort();
    const controller = new AbortController();
    activeSearch.current = controller;
    setResults([]);
    setSearchError("");
    setSearchState("busy");

    try {
      const next = await api.webRecipes(trimmed, 1, controller.signal);
      if (activeSearch.current !== controller) {
        return;
      }
      setResults(next);
      setSearchState("done");
    } catch (error) {
      if (activeSearch.current !== controller) {
        return;
      }
      setSearchError(errorMessage(error));
      setSearchState("error");
    } finally {
      if (activeSearch.current === controller) {
        activeSearch.current = null;
      }
    }
  }, []);

  const cancelSearch = useCallback(() => {
    const controller = activeSearch.current;
    activeSearch.current = null;
    controller?.abort();
    setSearchError("");
    setSearchState("idle");
  }, []);

  useEffect(() => {
    if (initialKeyword.trim()) {
      setQuery(initialKeyword);
      void searchRecipes(initialKeyword);
    }
  }, [initialKeyword, searchRecipes]);

  useEffect(
    () => () => {
      activeSearch.current?.abort();
      activeSearch.current = null;
    },
    [],
  );

  const submitSearch = () => {
    if (searchState === "busy") {
      cancelSearch();
    } else {
      void searchRecipes(query);
    }
  };

  return (
    <section
      className="page"
      style={{
        minHeight: "calc(100dvh - var(--nav-height) - var(--gap-large))",
        margin: "var(--gap-small) var(--gap) var(--gap-large)",
        paddingInline: "var(--section-padding)",
      }}
    >
      <PageHeader
        heading="菜谱"
        subtitle="下厨房"
        style={{ marginInline: "calc(-1 * var(--section-padding))" }}
      />

      <form
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          if (searchState !== "busy") {
            void searchRecipes(query);
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
        <Icon name="notes" size={22} color="var(--muted)" />
        <input
          type="search"
          aria-label="搜索菜名"
          placeholder="搜索菜名"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
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

      <InkButton
        fullWidth
        text={searchState === "busy" ? "取消搜索" : "搜下厨房"}
        iconName="notes"
        outline={searchState === "busy"}
        disabled={searchState !== "busy" && !trimmedQuery}
        onClick={submitSearch}
        style={{ marginTop: "var(--gap)" }}
      />

      <div
        style={{
          display: "grid",
          gap: "var(--gap-small)",
          marginTop: "var(--gap)",
        }}
      >
        {(searchState === "busy" || searchState === "error") && (
          <p
            role={searchState === "error" ? "alert" : "status"}
            aria-live="polite"
            style={{
              margin: 0,
              color:
                searchState === "error"
                  ? "var(--nearing)"
                  : "var(--muted)",
              fontSize: "var(--text-subtitle)",
            }}
          >
            {searchState === "busy" ? "搜索中…" : searchError}
          </p>
        )}

        {searchState === "done" && results.length === 0 && (
          <EmptyState
            iconName="book-2"
            heading="没有找到菜谱"
            detail=""
            style={{ paddingBlock: "calc(var(--gap-large) * 2)" }}
          />
        )}

        {results.map((recipe) => (
          <button
            key={recipe.id}
            type="button"
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
            style={{
              display: "flex",
              alignItems: "center",
              width: "100%",
              minHeight: "calc(var(--touch) + var(--gap-small))",
              gap: "var(--gap-small)",
              paddingInline: "var(--gap)",
              border: "1px solid var(--outline)",
              borderRadius: "var(--radius-row)",
              color: "var(--ink)",
              background: "var(--card)",
              textAlign: "left",
            }}
          >
            <span
              style={{
                flex: 1,
                minWidth: 0,
                overflow: "hidden",
                fontSize: "var(--text-recipe)",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {recipe.name}
            </span>
            <span
              style={{
                flex: "none",
                color: "var(--muted)",
                fontSize: "var(--text-meta)",
              }}
            >
              下厨房
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
