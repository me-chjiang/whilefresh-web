import { useEffect, useState } from "react";

import type { WebRecipeDetailDto } from "../../shared/api";
import { api, ApiError } from "../api";
import { Icon } from "../components/Icon";
import { PageHeader } from "../components/PageHeader";
import { SectionTape } from "../components/SectionTape";

export interface WebRecipeDetailPageProps {
  recipeId: string;
  onBack: () => void;
}

type DetailState = "busy" | "done" | "error";

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message;
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "请稍后重试";
}

function externalRecipeUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

export function WebRecipeDetailPage({
  recipeId,
  onBack,
}: WebRecipeDetailPageProps) {
  const [recipe, setRecipe] = useState<WebRecipeDetailDto | null>(null);
  const [state, setState] = useState<DetailState>("busy");
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setRecipe(null);
    setError("");
    setState("busy");

    void api
      .webRecipeDetail(recipeId, controller.signal)
      .then((next) => {
        if (!active) {
          return;
        }
        setRecipe(next);
        setState("done");
      })
      .catch((loadError: unknown) => {
        if (!active || controller.signal.aborted) {
          return;
        }
        setError(errorMessage(loadError));
        setState("error");
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [recipeId]);

  const sourceUrl = recipe
    ? externalRecipeUrl(recipe.attribution.url)
    : undefined;

  return (
    <section className="page-shell" data-recipe-id={recipeId}>
      <PageHeader
        heading="菜谱卡"
        backVisible
        onBack={onBack}
      />

      {(state === "busy" || state === "error") && (
        <p
          role={state === "error" ? "alert" : "status"}
          aria-live={state === "busy" ? "polite" : undefined}
          style={{
            marginBlock: "var(--gap-large) 0",
            color: state === "error" ? "var(--nearing)" : "var(--muted)",
            fontSize: "var(--text-subtitle)",
          }}
        >
          {state === "busy" ? "读取中…" : error}
        </p>
      )}

      {state === "done" && recipe && (
        <>
          <header className="recipe-card recipe-card--head">
            <h2 className="recipe-card__title recipe-card__title--wrap">
              {recipe.name}
            </h2>
            <div className="recipe-card__meta">
              <span className="src-tag">
                <Icon name="book-2" size={13} />
                {recipe.attribution.source}
              </span>
              {recipe.partial && <span>内容不全</span>}
            </div>
            {sourceUrl && (
              <a
                className="outline-link"
                href={sourceUrl}
                target="_blank"
                rel="noopener"
              >
                查看原菜谱
                <Icon name="chevron-right" size={16} />
              </a>
            )}
          </header>

          <section
            className="page"
            style={{ marginTop: "var(--section-gap)" }}
          >
            <SectionTape
              label="用料"
              count={recipe.ingredients.length}
              tapeColor="sage"
              style={{ position: "absolute", top: -12, left: 14 }}
            />
            <ul className="plain-list">
              {recipe.ingredients.map((ingredient, index) => (
                <li
                  key={`${index}-${ingredient.raw}`}
                  className="ingredient-row recipe-ingredient"
                >
                  {ingredient.raw}
                </li>
              ))}
            </ul>
          </section>

          <section
            className="page"
            style={{ marginTop: "calc(var(--section-gap) + 6px)" }}
          >
            <SectionTape
              label="步骤"
              count={recipe.steps.length}
              tapeColor="sand"
              style={{ position: "absolute", top: -12, left: 14 }}
            />
            <ol className="plain-list">
              {recipe.steps.map((step, index) => (
                <li
                  key={`${index}-${step.order}`}
                  className="recipe-step"
                >
                  <span className="recipe-step__n">{step.order}</span>
                  <span>{step.text}</span>
                </li>
              ))}
            </ol>
          </section>

          {recipe.tips.length > 0 && (
            <aside className="note-paper recipe-tips">
              {recipe.tips.map((tip, index) => (
                <p
                  key={`${index}-${tip}`}
                  style={{ margin: 0, whiteSpace: "pre-wrap" }}
                >
                  <b>小贴士</b> {tip}
                </p>
              ))}
            </aside>
          )}
        </>
      )}
    </section>
  );
}
