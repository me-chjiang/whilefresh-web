export type DateParseStatus =
  | "ok"
  | "needs_base_date"
  | "unparseable"
  | "empty";

export interface DateParse {
  status: DateParseStatus;
  date?: string;
}

interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

const FULL_DATE_PATTERN =
  /((?:19|20)\d{2})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})(?!\d)/u;
const COMPACT_DATE_PATTERN =
  /(?<!\d)((?:19|20)\d{2})(\d{2})(\d{2})(?!\d)/u;
const MONTH_DAY_PATTERN =
  /(?<!\d)(\d{1,2})\s*(?:月|[/.-])\s*(\d{1,2})(?!\d)/u;
const DAYS_AGO_PATTERN = /(\d{1,3})\s*天前/u;
const RELATIVE_WORDS = [
  ["大前天", -3],
  ["大后天", 3],
  ["前天", -2],
  ["后天", 2],
  ["昨天", -1],
  ["昨日", -1],
  ["明天", 1],
  ["明日", 1],
  ["今天", 0],
  ["今日", 0],
  ["当天", 0],
] as const;

function createDate(
  year: number,
  month: number,
  day: number,
): Date | null {
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

function formatDate(date: Date): string {
  const year = String(date.getUTCFullYear()).padStart(4, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseCalendarDate(value: string): CalendarDate | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) {
    return null;
  }

  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  return createDate(year, month, day)
    ? { year, month, day }
    : null;
}

function parsedDate(year: number, month: number, day: number): DateParse {
  const date = createDate(year, month, day);
  return date
    ? { status: "ok", date: formatDate(date) }
    : { status: "unparseable" };
}

function resolveMonthDay(
  month: number,
  day: number,
  baseDate: CalendarDate,
): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }

  const currentYearDate = createDate(baseDate.year, month, day);
  if (currentYearDate) {
    const base = createDate(
      baseDate.year,
      baseDate.month,
      baseDate.day,
    );
    if (base && currentYearDate <= base) {
      return formatDate(currentYearDate);
    }
  }

  for (let offset = 1; offset <= 8; offset += 1) {
    const candidate = createDate(baseDate.year - offset, month, day);
    if (candidate) {
      return formatDate(candidate);
    }
  }
  return null;
}

function addDays(baseDate: CalendarDate, days: number): string {
  const date = createDate(baseDate.year, baseDate.month, baseDate.day);
  if (!date) {
    throw new TypeError("Invalid base date");
  }
  date.setUTCDate(date.getUTCDate() + days);
  return formatDate(date);
}

export function parseDateText(
  text: string,
  baseDateText: string | null = null,
): DateParse {
  const original = text.trim();
  if (original.length === 0) {
    return { status: "empty" };
  }

  const normalized = original.normalize("NFKC");
  const baseDate = baseDateText === null
    ? null
    : parseCalendarDate(baseDateText);

  const fullDate = FULL_DATE_PATTERN.exec(normalized);
  if (fullDate) {
    return parsedDate(
      Number(fullDate[1]),
      Number(fullDate[2]),
      Number(fullDate[3]),
    );
  }

  const compactDate = COMPACT_DATE_PATTERN.exec(normalized);
  if (compactDate) {
    return parsedDate(
      Number(compactDate[1]),
      Number(compactDate[2]),
      Number(compactDate[3]),
    );
  }

  const monthDay = MONTH_DAY_PATTERN.exec(normalized);
  if (monthDay) {
    if (!baseDate) {
      return { status: "needs_base_date" };
    }
    const date = resolveMonthDay(
      Number(monthDay[1]),
      Number(monthDay[2]),
      baseDate,
    );
    return date
      ? { status: "ok", date }
      : { status: "unparseable" };
  }

  const daysAgo = DAYS_AGO_PATTERN.exec(normalized);
  if (daysAgo) {
    if (!baseDate) {
      return { status: "needs_base_date" };
    }
    return {
      status: "ok",
      date: addDays(baseDate, -Number(daysAgo[1])),
    };
  }

  for (const [word, offset] of RELATIVE_WORDS) {
    if (normalized.includes(word)) {
      if (!baseDate) {
        return { status: "needs_base_date" };
      }
      return {
        status: "ok",
        date: addDays(baseDate, offset),
      };
    }
  }

  return { status: "unparseable" };
}

export function parseShelfLifeLabel(text: string): number | null {
  const match =
    /保质期\s*[:：]?\s*(\d{1,4})\s*(天|日|个月|月|年)/u.exec(
      text.normalize("NFKC"),
    );
  if (!match) {
    return null;
  }

  const value = Number(match[1]);
  const unit = match[2];
  let days = value;
  if (unit === "年") {
    days = value * 365;
  } else if (unit.endsWith("月")) {
    days = value * 30;
  }
  return days > 0 ? days : null;
}
