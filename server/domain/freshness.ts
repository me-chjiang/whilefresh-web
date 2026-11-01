import type { Freshness } from "../../shared/enums.js";
import { daysBetween } from "./clock.js";

export interface FreshnessState {
  freshness: Freshness;
  remainingDays: number | null;
}

const NEAR_FRACTION = 0.25;
const NEAR_MINIMUM_DAYS = 1;

export function evaluateFreshness(
  expiryDate: string | null | undefined,
  totalDays: number | null | undefined,
  today: string,
): FreshnessState {
  if (!expiryDate) {
    return { freshness: "unknown", remainingDays: null };
  }

  let remainingDays: number;
  try {
    remainingDays = daysBetween(today, expiryDate);
  } catch {
    return { freshness: "unknown", remainingDays: null };
  }

  const nearLimit = Math.max(
    NEAR_MINIMUM_DAYS,
    Math.floor((totalDays ?? 0) * NEAR_FRACTION),
  );

  if (remainingDays <= 0) {
    return { freshness: "beyond_estimate", remainingDays };
  }
  if (remainingDays <= nearLimit) {
    return { freshness: "near_expiry", remainingDays };
  }
  return { freshness: "fresh", remainingDays };
}
