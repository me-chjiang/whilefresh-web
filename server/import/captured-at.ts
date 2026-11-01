export const CapturedAtSource = {
  None: "None",
  Camera: "Camera",
  Exif: "Exif",
  FileModified: "FileModified",
} as const;

export type CapturedAtSource =
  (typeof CapturedAtSource)[keyof typeof CapturedAtSource];

export interface ImageDateHints {
  camera?: boolean;
  exifDateTimeOriginal?: string | null;
  exifOffsetTimeOriginal?: string | null;
  lastModified?: number | null;
}

export interface CapturedAt {
  when: Date | null;
  source: CapturedAtSource;
}

const EXIF_DATE_TIME =
  /^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/;
const EXIF_OFFSET = /^([+-])(\d{2}):(\d{2})$/;
const EARLIEST_CAPTURED_AT = Date.UTC(2000, 0, 1);

function dateParts(dateTime: string):
  | {
      year: number;
      month: number;
      day: number;
      hour: number;
      minute: number;
      second: number;
    }
  | null {
  const match = EXIF_DATE_TIME.exec(dateTime.trim());
  if (!match) {
    return null;
  }
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6]),
  };
}

function validDate(
  value: Date,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  utc: boolean,
): Date | null {
  const actual = {
    year: utc ? value.getUTCFullYear() : value.getFullYear(),
    month: utc ? value.getUTCMonth() : value.getMonth(),
    day: utc ? value.getUTCDate() : value.getDate(),
    hour: utc ? value.getUTCHours() : value.getHours(),
    minute: utc ? value.getUTCMinutes() : value.getMinutes(),
    second: utc ? value.getUTCSeconds() : value.getSeconds(),
  };
  return actual.year === year &&
    actual.month === month - 1 &&
    actual.day === day &&
    actual.hour === hour &&
    actual.minute === minute &&
    actual.second === second
    ? value
    : null;
}

export function parseExifDateTime(
  dateTime: string,
  offset = "",
): Date | null {
  const parts = dateParts(dateTime);
  if (!parts) {
    return null;
  }

  const offsetMatch = EXIF_OFFSET.exec(offset.trim());
  if (!offsetMatch) {
    const value = new Date(0);
    value.setFullYear(parts.year, parts.month - 1, parts.day);
    value.setHours(parts.hour, parts.minute, parts.second, 0);
    return validDate(
      value,
      parts.year,
      parts.month,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
      false,
    );
  }

  const value = new Date(0);
  value.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  value.setUTCHours(parts.hour, parts.minute, parts.second, 0);
  if (
    !validDate(
      value,
      parts.year,
      parts.month,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
      true,
    )
  ) {
    return null;
  }

  const sign = offsetMatch[1] === "-" ? -1 : 1;
  const offsetMs =
    sign * (Number(offsetMatch[2]) * 60 + Number(offsetMatch[3])) * 60_000;
  return new Date(value.getTime() - offsetMs);
}

function fromMilliseconds(value: number | null | undefined): Date | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? new Date(value)
    : null;
}

function isPlausible(when: Date | null, now: Date): when is Date {
  if (!when || !Number.isFinite(now.getTime())) {
    return false;
  }
  const timestamp = when.getTime();
  return (
    Number.isFinite(timestamp) &&
    timestamp >= EARLIEST_CAPTURED_AT &&
    timestamp <= now.getTime() + 86_400_000
  );
}

export function resolveCapturedAt(
  hints: ImageDateHints,
  now: Date,
): CapturedAt {
  const candidates: readonly [Date | null, CapturedAtSource][] = [
    [
      hints.camera ? new Date(now) : null,
      CapturedAtSource.Camera,
    ],
    [
      hints.exifDateTimeOriginal
        ? parseExifDateTime(
            hints.exifDateTimeOriginal,
            hints.exifOffsetTimeOriginal ?? "",
          )
        : null,
      CapturedAtSource.Exif,
    ],
    [fromMilliseconds(hints.lastModified), CapturedAtSource.FileModified],
  ];

  for (const [when, source] of candidates) {
    if (isPlausible(when, now)) {
      return { when, source };
    }
  }
  return { when: null, source: CapturedAtSource.None };
}
