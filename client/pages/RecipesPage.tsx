import { useState } from "react";

import { EmptyState } from "../components/EmptyState";
import { Icon } from "../components/Icon";
import { PageHeader } from "../components/PageHeader";
import { RecipeCard } from "../components/RecipeCard";
import { useAppShell } from "../App";
import { RecipeDetailPage } from "./RecipeDetailPage";

export function RecipesPage() {
  const { state, pushPage } = useAppShell();
  const [query, setQuery] = useState("");
  const trimmedQuery = query.trim();
  const filteredRecipes = state.recipes.filter((recipe) =>
    recipe.name.includes(trimmedQuery),
  );

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
        subtitle="按匹配度浏览"
        style={{ marginInline: "calc(-1 * var(--section-padding))" }}
      />

      <div
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
      </div>

      {filteredRecipes.length === 0 ? (
        <EmptyState
          iconName="book-2"
          heading="没有找到菜谱"
          detail="试试别的菜名，或改选食材"
          actionText={trimmedQuery ? "清除搜索" : ""}
          onAction={() => setQuery("")}
          style={{ paddingBlock: "calc(var(--gap-large) * 2)" }}
        />
      ) : (
        <div
          style={{
            display: "grid",
            gap: "var(--gap-small)",
            marginTop: "var(--gap)",
          }}
        >
          {filteredRecipes.map((recipe) => (
            <RecipeCard
              key={recipe.id}
              recipe={recipe}
              onOpened={() =>
                pushPage({
                  key: `recipe-detail-${recipe.id}`,
                  title: "菜谱卡",
                  element: (
                    <RecipeDetailPage
                      recipeId={recipe.id}
                      selectedIds={state.selectedIds}
                    />
                  ),
                })
              }
            />
          ))}
        </div>
      )}
    </section>
  );
}
