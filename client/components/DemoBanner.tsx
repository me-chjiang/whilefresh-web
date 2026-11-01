interface DemoBannerProps {
  visible: boolean;
}

export function DemoBanner({ visible }: DemoBannerProps) {
  if (!visible) {
    return null;
  }
  return (
    <div
      role="status"
      style={{
        minHeight: 26,
        padding: "3px var(--gap-small)",
        color: "var(--ink)",
        background: "var(--tape-sage)",
        fontSize: "var(--text-meta)",
        fontWeight: "var(--weight-bold)",
        lineHeight: 1.35,
        textAlign: "center",
      }}
    >
      演示模式 · 示例数据，识别为预设结果，不联网
    </div>
  );
}
