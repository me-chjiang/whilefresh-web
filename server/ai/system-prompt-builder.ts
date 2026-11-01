export interface PromptSection {
  title: string;
  body: string;
}

export function buildSystemPrompt(
  base: string,
  sections: readonly PromptSection[],
  preferenceSummary?: string,
): string {
  const parts: string[] = [];
  const trimmedBase = base.trim();
  if (trimmedBase.length > 0) {
    parts.push(trimmedBase);
  }

  for (const section of sections) {
    const body = section.body.trim();
    if (body.length > 0) {
      parts.push(`【${section.title}】\n${body}`);
    }
  }

  const summary = preferenceSummary?.trim() ?? "";
  if (summary.length > 0) {
    parts.push(`【用户偏好】\n${summary}`);
  }

  return parts.join("\n\n");
}
