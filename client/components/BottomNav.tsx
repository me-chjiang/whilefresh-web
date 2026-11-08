import type { CSSProperties } from "react";

import { tabs, type TabIndex } from "../nav";

interface BottomNavProps {
  currentTab: TabIndex;
  nearCount: number;
  onSelect: (index: TabIndex) => void;
}

const iconStyle: CSSProperties = {
  display: "block",
  width: 25,
  height: 25,
  backgroundColor: "currentColor",
  maskPosition: "center",
  maskRepeat: "no-repeat",
  maskSize: "contain",
  WebkitMaskPosition: "center",
  WebkitMaskRepeat: "no-repeat",
  WebkitMaskSize: "contain",
};

function NavIcon({ name }: { name: string }) {
  const url = `url("/assets/icons/${name}.svg")`;
  return (
    <span
      aria-hidden="true"
      style={{
        ...iconStyle,
        maskImage: url,
        WebkitMaskImage: url,
      }}
    />
  );
}

export function BottomNav({
  currentTab,
  nearCount,
  onSelect,
}: BottomNavProps) {
  return (
    <nav
      className="bottom-nav"
      aria-label="主导航"
      style={{ position: "fixed", right: 0, bottom: 0, left: 0, margin: "auto" }}
    >
      {tabs.map((tab) => {
        if (tab.index === 2) {
          const active = currentTab === 2;
          const label =
            nearCount > 0 ? `清冰箱，${nearCount} 种食材临期` : "清冰箱";
          return (
            <div
              key={tab.id}
              style={{
                position: "relative",
                display: "flex",
                alignSelf: "stretch",
                justifyContent: "center",
              }}
            >
              <button
                type="button"
                className={`stamp${active ? " stamp--active" : ""}`}
                aria-current={active ? "page" : undefined}
                aria-label={label}
                onClick={() => onSelect(2)}
                style={{
                  position: "absolute",
                  top: "calc(-1 * (var(--stamp-rise) + var(--gap-small)))",
                  width: "var(--stamp-diameter)",
                  height: "var(--stamp-diameter)",
                  minWidth: "var(--stamp-diameter)",
                  minHeight: "var(--stamp-diameter)",
                  padding: "var(--gap-small)",
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: 1,
                  }}
                >
                  <NavIcon name={tab.icon} />
                  <span>{tab.label}</span>
                </span>
                {nearCount > 0 && (
                  <span
                    className="badge"
                    style={{
                      position: "absolute",
                      top: -7,
                      right: -8,
                      minWidth: 28,
                      height: 28,
                      paddingInline: 4,
                      border: "2px solid white",
                      fontFamily: "var(--font-sans)",
                      fontSize: 13,
                      fontWeight: "var(--weight-strong)",
                      letterSpacing: 0,
                      transform: "rotate(-8deg)",
                    }}
                  >
                    {nearCount}
                  </span>
                )}
              </button>
            </div>
          );
        }

        const active = currentTab === tab.index;
        return (
          <button
            key={tab.id}
            type="button"
            className="bottom-nav__item"
            aria-current={active ? "page" : undefined}
            onClick={() => onSelect(tab.index)}
          >
            <NavIcon name={tab.icon} />
            <span>{tab.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
