export interface StatusState {
  status?: string;
  statusChangedAt?: Date | string | null;
  snoozedUntil?: string | null;
}

function instant(value: Date | string | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const time = (value instanceof Date ? value : new Date(value)).getTime();
  return Number.isNaN(time) ? null : time;
}

export function sameStatusState(a: StatusState, b: StatusState): boolean {
  return (
    a.status === b.status &&
    instant(a.statusChangedAt) === instant(b.statusChangedAt) &&
    (a.snoozedUntil ?? null) === (b.snoozedUntil ?? null)
  );
}
