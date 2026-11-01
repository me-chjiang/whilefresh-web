import type { Catalog } from "../domain/catalog.js";
import {
  INPUT_ORDER_TEXT,
  INPUT_RECEIPT,
  INPUT_SCREENSHOT,
  PROMPT_TEMPLATE,
} from "./prompt.js";
import { InputKind } from "./types.js";

export const DEEPSEEK_MODEL = "deepseek-flash";
export const MAX_ORDER_TEXT_CHARS = 30000;

export interface RequestOptions {
  maxTokens?: number;
  thinking?: boolean;
}

export interface PreparedImage {
  imageIndex: number;
  sliceIndex: number;
  sliceCount: number;
  captureDate?: string | null;
  jpeg: Uint8Array;
}

interface TextContent {
  type: "text";
  text: string;
}

interface ImageContent {
  type: "image_url";
  image_url: {
    url: string;
  };
}

export interface ChatRequest {
  model: typeof DEEPSEEK_MODEL;
  messages: [
    {
      role: "user";
      content: Array<TextContent | ImageContent>;
    },
  ];
  response_format: {
    type: "json_object";
  };
  max_tokens: number;
  temperature: 0;
  thinking?: {
    type: "disabled";
  };
}

function inputParagraph(kind: InputKind): string {
  switch (kind) {
    case InputKind.Screenshot:
      return INPUT_SCREENSHOT;
    case InputKind.Receipt:
      return INPUT_RECEIPT;
    case InputKind.OrderText:
      return INPUT_ORDER_TEXT;
  }
}

function imageLabel(image: PreparedImage): string {
  let label = `第 ${image.imageIndex + 1} 张图`;
  if (image.sliceCount > 1) {
    label += `，切片 ${image.sliceIndex + 1}/${image.sliceCount}`;
  }
  if (image.captureDate) {
    label += `，拍摄日期 ${image.captureDate}`;
  }
  return `[${label}]`;
}

function imageBlock(jpeg: Uint8Array): ImageContent {
  return {
    type: "image_url",
    image_url: {
      url: `data:image/jpeg;base64,${Buffer.from(jpeg).toString("base64")}`,
    },
  };
}

export function buildPrompt(kind: InputKind, catalog: Catalog): string {
  return PROMPT_TEMPLATE.replace("{{INPUT}}", inputParagraph(kind)).replace(
    "{{VOCABULARY}}",
    catalog.hierarchyText(),
  );
}

export function buildChatRequest(
  kind: InputKind,
  catalog: Catalog,
  images: readonly PreparedImage[],
  text: string,
  options: RequestOptions = {},
): ChatRequest {
  const content: Array<TextContent | ImageContent> = [
    { type: "text", text: buildPrompt(kind, catalog) },
  ];

  if (kind === InputKind.OrderText) {
    if (text.length > MAX_ORDER_TEXT_CHARS) {
      throw new RangeError(
        `order text exceeds ${MAX_ORDER_TEXT_CHARS} characters`,
      );
    }
    content.push({
      type: "text",
      text: `<订单文字>\n${text}\n</订单文字>`,
    });
  } else {
    for (const image of images) {
      content.push({ type: "text", text: imageLabel(image) });
      content.push(imageBlock(image.jpeg));
    }
  }

  const body: ChatRequest = {
    model: DEEPSEEK_MODEL,
    messages: [{ role: "user", content }],
    response_format: { type: "json_object" },
    max_tokens: options.maxTokens ?? 131072,
    temperature: 0,
  };
  if (options.thinking === false) {
    body.thinking = { type: "disabled" };
  }
  return body;
}
