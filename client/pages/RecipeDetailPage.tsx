import { useEffect, useState } from "react";

import type { RecipeDetailDto } from "../../shared/api";
import { api, ApiError } from "../api";
import { Icon } from "../components/Icon";
import { InkButton } from "../components/InkButton";
import { PageHeader } from "../components/PageHeader";
import { useAppShell } from "../App";

export interface RecipeDetailPageProps {
  recipeId: string;
  selectedIds?: readonly number[];
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message;
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "请稍后重试";
}

function stepBody(step: string): string {
  return step.replace(/^\s*(?:步骤\s*)?\d+[.、．)]\s*/, "");
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

function Notes({ items }: { items: readonly string[] }) {
  if (items.length === 0) {
    return null;
  }
  return (
    <>
      {items.map((note, index) => (
        <p
          key={`${index}-${note}`}
          style={{
            margin: 0,
            color: "var(--muted)",
            fontSize: "var(--text-control)",
            whiteSpace: "pre-wrap",
          }}
        >
          {note}
        </p>
      ))}
    </>
  );
}

export function RecipeDetailPage({
  recipeId,
  selectedIds,
}: RecipeDetailPageProps) {
  const { state, refresh, switchTab, goBack, notify } = useAppShell();
  const [recipe, setRecipe] = useState<RecipeDetailDto | null>(null);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const selection = selectedIds ?? state.selectedIds;

  useEffect(() => {
    let active = true;
    setRecipe(null);
    setError("");
    void api
      .recipeDetail({ id: recipeId, selected: [...selection] })
      .then((next) => {
        if (active) {
          setRecipe(next);
        }
      })
      .catch((loadError: unknown) => {
        if (active) {
          setError(errorMessage(loadError));
        }
      });
    return () => {
      active = false;
    };
  }, [recipeId, selection]);

  const addMissing = async () => {
    if (adding) {
      return;
    }
    setAdding(true);
    try {
      const result = await api.addMissingIngredients({
        id: recipeId,
        selected: [...selection],
      });
      await refresh();
      notify(
        result.added > 0
          ? `已加入 ${result.added} 项缺料`
          : "缺料已在待买清单中",
      );
      switchTab(3);
    } catch (addError) {
      notify(`加入待买失败：${errorMessage(addError)}`);
    } finally {
      setAdding(false);
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
        heading="菜谱卡"
        backVisible
        onBack={goBack}
        style={{ marginInline: "calc(-1 * var(--section-padding))" }}
      />

      {error ? (
        <div
          role="alert"
          style={{
            display: "grid",
            gap: "var(--gap)",
            marginTop: "var(--gap-large)",
            textAlign: "center",
          }}
        >
          <p style={{ margin: 0 }}>暂时读不到这道菜谱：{error}</p>
          <InkButton
            fullWidth
            outline
            text="返回菜谱"
            onClick={goBack}
          />
        </div>
      ) : !recipe ? (
        <p aria-live="polite" style={{ marginTop: "var(--gap-large)" }}>
          正在翻开菜谱…
        </p>
      ) : (
        <div
          style={{
            display: "grid",
            gap: "var(--gap)",
            marginTop: "var(--gap-small)",
          }}
        >
          <article
            style={{
              position: "relative",
              overflow: "hidden",
              padding:
                "calc(var(--gap-large) + 3px) var(--gap-large) var(--gap-large)",
              borderRadius: "var(--radius-card)",
              background: "var(--card)",
              boxShadow: "var(--shadow-one)",
            }}
          >
            <div
              aria-hidden="true"
              style={{
                position: "absolute",
                top: 0,
                right: 0,
                left: 0,
                height: 3,
                background: "var(--tomato)",
              }}
            />
            <div style={{ display: "grid", gap: "var(--gap-small)" }}>
              <h1
                style={{
                  margin: 0,
                  fontFamily: "var(--font-serif)",
                  fontSize: "var(--text-sheet-title)",
                  fontWeight: "var(--weight-black)",
                  lineHeight: 1.3,
                }}
              >
                {recipe.name}
              </h1>
              <p
                style={{
                  margin: 0,
                  color: "var(--muted)",
                  fontSize: "var(--text-subtitle)",
                }}
              >
                {recipe.sourceName || "原菜谱"} · 有 {recipe.haveCount} · 缺{" "}
                {recipe.missingCount} · 难度 {recipe.difficulty}/5
              </p>
              {recipe.summary && (
                <p
                  style={{
                    margin: 0,
                    fontSize: "var(--text-control)",
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {recipe.summary}
                </p>
              )}
              {recipe.usedSelected.length > 0 && (
                <p
                  style={{
                    margin: 0,
                    color: "var(--fresh)",
                    fontSize: "var(--text-subtitle)",
                  }}
                >
                  用到已选：{recipe.usedSelected.join("、")}
                </p>
              )}
              {recipe.unusedSelected.length > 0 && (
                <p
                  style={{
                    margin: 0,
                    color: "var(--muted)",
                    fontSize: "var(--text-subtitle)",
                  }}
                >
                  未用到：{recipe.unusedSelected.join("、")}
                </p>
              )}
              {externalRecipeUrl(recipe.sourceUrl) && (
                <a
                  href={externalRecipeUrl(recipe.sourceUrl)}
                  target="_blank"
                  rel="noopener"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    minHeight: "var(--touch)",
                    gap: "var(--gap-small)",
                    width: "fit-content",
                    fontWeight: "var(--weight-bold)",
                  }}
                >
                  <Icon name="book-2" size={20} />
                  查看原菜谱
                </a>
              )}
            </div>
          </article>

          <h2
            style={{
              margin: 0,
              fontFamily: "var(--font-serif)",
              fontSize: "var(--text-panel)",
              fontWeight: "var(--weight-black)",
            }}
          >
            原用料
          </h2>
          <article
            style={{
              overflow: "hidden",
              paddingInline: "var(--gap)",
              borderRadius: "var(--radius-card)",
              background: "var(--card)",
              boxShadow: "var(--shadow-one)",
            }}
          >
            {recipe.ingredients.map((ingredient, index) => {
              const label = !ingredient.known
                ? "原文"
                : ingredient.has
                  ? "有"
                  : "缺";
              const color = !ingredient.known
                ? "var(--muted)"
                : ingredient.has
                  ? "var(--fresh)"
                  : "var(--nearing)";
              const background = !ingredient.known
                ? "var(--selected-paper)"
                : ingredient.has
                  ? "var(--tape-sage)"
                  : "var(--note)";

              return (
                <div
                  key={`${index}-${ingredient.raw}`}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    minHeight: "var(--row-height)",
                    gap: "var(--gap-small)",
                    paddingBlock: "var(--gap-small)",
                    borderBottom:
                      index === recipe.ingredients.length - 1
                        ? 0
                        : "1.5px dashed var(--rule)",
                  }}
                >
                  <span
                    aria-label={label}
                    style={{
                      display: "inline-flex",
                      flex: "none",
                      alignItems: "center",
                      justifyContent: "center",
                      width: 38,
                      minHeight: "var(--badge-height)",
                      borderRadius: "var(--radius-tag)",
                      color,
                      background,
                      fontSize: "var(--text-small)",
                      fontWeight: "var(--weight-strong)",
                    }}
                  >
                    {label}
                  </span>
                  <span
                    style={{
                      minWidth: 0,
                      fontSize: "var(--text-control)",
                      whiteSpace: "pre-wrap",
                    }}
                  >
                    {ingredient.raw}
                    {ingredient.optional ? " · 可选" : ""}
                  </span>
                </div>
              );
            })}
          </article>

          <Notes items={recipe.ingredientNotes} />

          {recipe.quantities.length > 0 && (
            <>
              <h2
                style={{
                  margin: 0,
                  fontFamily: "var(--font-serif)",
                  fontSize: "var(--text-panel)",
                  fontWeight: "var(--weight-black)",
                }}
              >
                参考用量
              </h2>
              <article
                style={{
                  display: "grid",
                  gap: "var(--gap-small)",
                  padding: "var(--gap)",
                  borderRadius: "var(--radius-card)",
                  background: "var(--card)",
                  boxShadow: "var(--shadow-one)",
                }}
              >
                {recipe.quantities.map((quantity, index) => (
                  <p
                    key={`${index}-${quantity.name}`}
                    style={{
                      margin: 0,
                      fontSize: "var(--text-control)",
                      whiteSpace: "pre-wrap",
                    }}
                  >
                    {quantity.name}
                    {quantity.expr ? `：${quantity.expr}` : ""}
                  </p>
                ))}
              </article>
            </>
          )}

          <Notes items={recipe.quantityNotes} />

          {recipe.missingCount > 0 && (
            <InkButton
              fullWidth
              text="缺料加入待买"
              accent="var(--green)"
              disabled={adding}
              onClick={() => void addMissing()}
            />
          )}

          <h2
            style={{
              margin: 0,
              fontFamily: "var(--font-serif)",
              fontSize: "var(--text-panel)",
              fontWeight: "var(--weight-black)",
            }}
          >
            原步骤
          </h2>
          <ol style={{ display: "grid", gap: "var(--gap-small)" }}>
            {recipe.steps.map((step, index) => (
              <li
                key={`${index}-${step}`}
                style={{
                  display: "flex",
                  gap: "var(--gap-small)",
                  padding: "var(--gap)",
                  borderRadius: "var(--radius-row)",
                  background: "var(--card)",
                  boxShadow: "var(--shadow-one)",
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    flex: "none",
                    color: "var(--tomato)",
                    fontWeight: "var(--weight-bold)",
                  }}
                >
                  {index + 1}.
                </span>
                <span
                  style={{
                    fontSize: "var(--text-control)",
                    lineHeight: 1.5,
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {stepBody(step)}
                </span>
              </li>
            ))}
          </ol>

          {recipe.notes && (
            <>
              <h2
                style={{
                  margin: 0,
                  fontFamily: "var(--font-serif)",
                  fontSize: "var(--text-panel)",
                  fontWeight: "var(--weight-black)",
                }}
              >
                补充说明
              </h2>
              <p
                style={{
                  margin: 0,
                  color: "var(--muted)",
                  fontSize: "var(--text-control)",
                  whiteSpace: "pre-wrap",
                }}
              >
                {recipe.notes}
              </p>
            </>
          )}
        </div>
      )}
    </section>
  );
}
