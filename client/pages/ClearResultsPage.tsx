import type {
  ClearPreviewDto,
  RecipeSummaryDto,
} from "../../shared/api";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { RecipeCard } from "../components/RecipeCard";
import { useAppShell } from "../App";
import { RecipeDetailPage } from "./RecipeDetailPage";

export interface ClearResultsPageProps {
  recipes: readonly RecipeSummaryDto[];
  summary: ClearPreviewDto;
  selectedIds: readonly number[];
}

export function ClearResultsPage({
  recipes,
  summary,
  selectedIds,
}: ClearResultsPageProps) {
  const { pushPage, goBack } = useAppShell();

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
        heading="清冰箱结果"
        backVisible
        onBack={goBack}
        style={{ marginInline: "calc(-1 * var(--section-padding))" }}
      />

      <header
        style={{
          display: "grid",
          gap: "var(--gap-small)",
          marginTop: "var(--gap-small)",
        }}
      >
        <h2
          style={{
            margin: 0,
            fontSize: "var(--text-panel)",
            fontWeight: "var(--weight-black)",
          }}
        >
          清理目标 {summary.selectedCount} 种食材 · {summary.candidateCount} 道候选菜
        </h2>
        <p
          style={{
            margin: 0,
            color:
              summary.completeCount > 0 ? "var(--fresh)" : "var(--nearing)",
            fontSize: "var(--text-subtitle)",
          }}
        >
          {summary.completeCount > 0
            ? `${summary.completeCount} 道菜用到全部已选食材`
            : summary.candidateCount > 0
              ? "没有菜谱能用到全部已选食材，可从下面的候选菜挑选"
              : "这组食材暂时没有对应菜谱"}
        </p>
        {summary.uncovered.length > 0 && (
          <p
            style={{
              margin: 0,
              color: "var(--muted)",
              fontSize: "var(--text-meta)",
            }}
          >
            暂未覆盖：{summary.uncovered.join("、")}
          </p>
        )}
      </header>

      {recipes.length === 0 ? (
        <EmptyState
          iconName="chef-hat"
          heading="没有找到可用菜谱"
          detail="返回选料页调整食材后再试"
          style={{ paddingBlock: "calc(var(--gap-large) * 2)" }}
        />
      ) : (
        <div
          style={{
            display: "grid",
            gap: "var(--gap-small)",
            marginTop: "var(--gap-large)",
          }}
        >
          {recipes.map((recipe) => (
            <RecipeCard
              key={recipe.id}
              recipe={recipe}
              onOpened={() =>
                pushPage({
                  key: `clear-recipe-detail-${recipe.id}`,
                  title: "菜谱卡",
                  element: (
                    <RecipeDetailPage
                      recipeId={recipe.id}
                      selectedIds={selectedIds}
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
