import { useEffect, useState } from "react";

import type { WebRecipeDetailDto } from "../../shared/api";
import { api, ApiError } from "../api";
import { Icon } from "../components/Icon";
import { PageHeader } from "../components/PageHeader";

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
        <div
          style={{
            display: "grid",
            gap: "var(--gap)",
            marginTop: "var(--gap-small)",
          }}
        >
          <h2
            style={{
              margin: 0,
              fontFamily: "var(--font-serif)",
              fontSize: "var(--text-sheet-title)",
              fontWeight: "var(--weight-black)",
              lineHeight: 1.3,
            }}
          >
            {recipe.name}
          </h2>

          <p
            style={{
              margin: 0,
              color: "var(--muted)",
              fontSize: "var(--text-subtitle)",
            }}
          >
            来源：{recipe.attribution.source}
            {recipe.partial ? " · 内容不全" : ""}
          </p>

          {sourceUrl && (
            <a
              href={sourceUrl}
              target="_blank"
              rel="noopener"
              style={{
                display: "inline-flex",
                alignItems: "center",
                minHeight: "var(--touch)",
                gap: "var(--gap-small)",
                fontWeight: "var(--weight-bold)",
              }}
            >
              <Icon name="book-2" size={20} />
              查看原菜谱
            </a>
          )}

          <h3
            style={{
              margin: 0,
              fontFamily: "var(--font-serif)",
              fontSize: "var(--text-panel)",
              fontWeight: "var(--weight-black)",
            }}
          >
            用料
          </h3>
          <ul style={{ display: "grid", gap: "var(--gap-small)" }}>
            {recipe.ingredients.map((ingredient, index) => (
              <li
                key={`${index}-${ingredient.raw}`}
                style={{
                  fontSize: "var(--text-control)",
                  whiteSpace: "pre-wrap",
                }}
              >
                {ingredient.raw}
              </li>
            ))}
          </ul>

          <h3
            style={{
              margin: 0,
              fontFamily: "var(--font-serif)",
              fontSize: "var(--text-panel)",
              fontWeight: "var(--weight-black)",
            }}
          >
            步骤
          </h3>
          <ol style={{ display: "grid", gap: "var(--gap-small)" }}>
            {recipe.steps.map((step, index) => (
              <li
                key={`${index}-${step.order}`}
                style={{
                  fontSize: "var(--text-control)",
                  lineHeight: 1.35,
                  whiteSpace: "pre-wrap",
                }}
              >
                {step.order}. {step.text}
              </li>
            ))}
          </ol>

          {recipe.tips.map((tip, index) => (
            <p
              key={`${index}-${tip}`}
              style={{
                margin: 0,
                color: "var(--muted)",
                fontSize: "var(--text-control)",
                whiteSpace: "pre-wrap",
              }}
            >
              小贴士：{tip}
            </p>
          ))}
        </div>
      )}
    </section>
  );
}
