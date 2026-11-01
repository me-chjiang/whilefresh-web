export interface Clock {
  now(): Date;
  today(): string;
}

function localDate(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDate(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    throw new TypeError(`Invalid local date: ${value}`);
  }

  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    throw new TypeError(`Invalid local date: ${value}`);
  }
  return date;
}

export const systemClock: Clock = {
  now: () => new Date(),
  today: () => localDate(new Date()),
};

export function fixedClock(date: Date): Clock {
  const instant = new Date(date);
  return {
    now: () => new Date(instant),
    today: () => localDate(instant),
  };
}

export function addDays(date: string, days: number): string {
  const parsed = parseDate(date);
  parsed.setDate(parsed.getDate() + days);
  return localDate(parsed);
}

export function daysBetween(from: string, to: string): number {
  const start = parseDate(from);
  const end = parseDate(to);
  return Math.round((end.getTime() - start.getTime()) / 86_400_000);
}
