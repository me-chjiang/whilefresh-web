export interface Amount {
  value: number;
  unit: string;
}

interface Measure {
  unit: string;
  base: "g" | "ml";
  factor: number;
}

interface Token {
  number: number;
  unit: string;
  start: number;
  end: number;
  measure: Measure | null;
}

const measures: readonly Measure[] = [
  { unit: "kg", base: "g", factor: 1000 },
  { unit: "千克", base: "g", factor: 1000 },
  { unit: "公斤", base: "g", factor: 1000 },
  { unit: "g", base: "g", factor: 1 },
  { unit: "克", base: "g", factor: 1 },
  { unit: "斤", base: "g", factor: 500 },
  { unit: "两", base: "g", factor: 50 },
  { unit: "ml", base: "ml", factor: 1 },
  { unit: "毫升", base: "ml", factor: 1 },
  { unit: "l", base: "ml", factor: 1000 },
  { unit: "升", base: "ml", factor: 1000 },
];

const countUnits = [
  "个",
  "件",
  "枚",
  "只",
  "盒",
  "袋",
  "包",
  "瓶",
  "罐",
  "听",
  "桶",
  "箱",
  "把",
  "根",
  "颗",
  "粒",
  "条",
  "块",
  "片",
  "份",
  "支",
  "棵",
  "头",
  "束",
  "扎",
  "板",
  "卷",
  "串",
  "盘",
  "杯",
  "碗",
  "提",
  "筒",
  "节",
  "张",
  "瓣",
] as const;

const chineseNumbers = new Map<string, number>([
  ["半", 0.5],
  ["一", 1],
  ["二", 2],
  ["两", 2],
  ["三", 3],
  ["四", 4],
  ["五", 5],
  ["六", 6],
  ["七", 7],
  ["八", 8],
  ["九", 9],
  ["十", 10],
]);

const units = [
  ...measures.map(({ unit }) => unit),
  ...countUnits,
].sort((left, right) => right.length - left.length);

const tokenPattern = new RegExp(
  `(\\d+(?:\\.\\d+)?|[半一二两三四五六七八九十])\\s*(${units.join("|")})?`,
);

function numberOf(text: string): number {
  return chineseNumbers.get(text) ?? Number(text);
}

function joinedByMultiplier(text: string, from: number, to: number): boolean {
  const gap = text.slice(from, to).trim();
  return gap.length === 1 && "×x*".includes(gap);
}

export function parseAmount(input: string): Amount {
  const text = input.normalize("NFKC").toLowerCase();
  const tokens: Token[] = [];

  for (const match of text.matchAll(new RegExp(tokenPattern, "g"))) {
    const numeral = match[1] ?? "";
    const unit = match[2] ?? "";
    if (unit === "" && chineseNumbers.has(numeral)) {
      continue;
    }
    tokens.push({
      number: numberOf(numeral),
      unit,
      start: match.index,
      end: match.index + match[0].length,
      measure: measures.find((measure) => measure.unit === unit) ?? null,
    });
  }

  let base = tokens.findIndex((token) => token.measure !== null);
  if (base < 0) {
    base = tokens.findIndex((token) => token.unit !== "");
  }
  if (base < 0 || tokens[base].number <= 0) {
    return { value: 0, unit: "" };
  }

  const token = tokens[base];
  let value = token.number;
  let unit = token.unit;
  if (token.measure !== null) {
    value *= token.measure.factor;
    unit = token.measure.base;
    const next = tokens[base + 1];
    const previous = tokens[base - 1];
    if (
      next !== undefined &&
      next.measure === null &&
      next.number > 0 &&
      joinedByMultiplier(text, token.end, next.start)
    ) {
      value *= next.number;
    } else if (
      previous !== undefined &&
      previous.measure === null &&
      previous.number > 0 &&
      joinedByMultiplier(text, previous.end, token.start)
    ) {
      value *= previous.number;
    }
  }

  return { value, unit };
}

export function totalAmount(input: string, count: number): Amount {
  const amount = parseAmount(input);
  if (amount.value > 0 && amount.unit !== "") {
    amount.value *= Math.max(1, count);
  }
  return amount;
}
