import type { CSSProperties } from "react";

import type { RecipeSummaryDto } from "../../shared/api";
import { Icon } from "./Icon";

export interface RecipeCardProps {
  recipe: RecipeSummaryDto;
  onOpened?: (recipe: RecipeSummaryDto) => void;
  className?: string;
  style?: CSSProperties;
}

export function RecipeCard({
  recipe,
  onOpened,
  className,
  style,
}: RecipeCardProps) {
  return (
    <button
      type="button"
      className={className}
      aria-label={`${recipe.name}，有 ${recipe.haveCount || 0}，缺 ${recipe.missingCount || 0}，难度 ${recipe.difficulty || 1}/5`}
      onClick={() => onOpened?.(recipe)}
      style={{
        position: "relative",
        display: "flex",
        width: "100%",
        minHeight: "var(--recipe-height)",
        alignItems: "center",
        gap: "var(--gap-small)",
        padding: "var(--gap) var(--gap-small) var(--gap) var(--gap)",
        overflow: "hidden",
        borderRadius: "var(--radius-row)",
        color: "var(--ink)",
        background: "var(--card)",
        boxShadow: "var(--shadow-one)",
        textAlign: "left",
        ...style,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          position: "absolute",
          top: 0,
          right: 0,
          left: 0,
          height: 3,
          borderRadius: "var(--radius-tag)",
          background: "var(--tomato)",
        }}
      />

      <span
        style={{
          display: "flex",
          minWidth: 0,
          flex: 1,
          flexDirection: "column",
          gap: 2,
        }}
      >
        <span
          style={{
            fontFamily: "var(--font-serif)",
            fontSize: "var(--text-recipe)",
            fontWeight: "var(--weight-black)",
            lineHeight: 1.25,
          }}
        >
          {recipe.name}
        </span>
        <span
          style={{
            display: "flex",
            minWidth: 0,
            alignItems: "center",
            gap: "var(--gap-small)",
            fontSize: "var(--text-meta)",
            fontWeight: "var(--weight-bold)",
          }}
        >
          <Icon name="book-2" size={15} color="var(--muted)" />
          <span
            style={{
              minWidth: 0,
              flex: 1,
              overflow: "hidden",
              color: "var(--muted)",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {recipe.sourceName || "原菜谱"}
          </span>
          <span style={{ flex: "none", color: "var(--fresh)" }}>
            有{recipe.haveCount || 0}
          </span>
          <span style={{ flex: "none", color: "var(--nearing)" }}>
            · 缺{recipe.missingCount || 0}
          </span>
        </span>
        {recipe.usedSelected.length > 0 && (
          <span
            style={{
              color: "var(--fresh)",
              fontSize: "var(--text-meta)",
            }}
          >
            用到已选：{recipe.usedSelected.join("、")}
          </span>
        )}
        {recipe.unusedSelected.length > 0 && (
          <span
            style={{
              color: "var(--muted)",
              fontSize: "var(--text-meta)",
            }}
          >
            未用到：{recipe.unusedSelected.join("、")}
          </span>
        )}
      </span>

      <span
        style={{
          flex: "none",
          color: "var(--muted)",
          fontSize: "var(--text-meta)",
          whiteSpace: "nowrap",
        }}
      >
        难度 {recipe.difficulty || 1}/5
      </span>
      <Icon name="chevron-right" size={20} color="var(--outline)" />
    </button>
  );
}
