/**
 * Everything is stored in UTC. A workspace timezone exists only so the agent
 * proposes sensible local slots ("Tuesday 9am") and the calendar renders them
 * the way the operator thinks about their day.
 */

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock parts of `instant` as seen in `timeZone`. */
export function partsInZone(
  instant: Date,
  timeZone: string,
): { year: number; month: number; day: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(instant);

  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.find((p) => p.type === type)?.value;
    return Number(value ?? 0);
  };

  // Intl renders midnight as hour 24 in some locales/zones; normalize to 0.
  const hour = get("hour");
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: hour === 24 ? 0 : hour,
    minute: get("minute"),
  };
}

/** Offset of `timeZone` from UTC at `instant`, in minutes (east positive). */
export function zoneOffsetMinutes(instant: Date, timeZone: string): number {
  const p = partsInZone(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  // Drop sub-minute precision on both sides so the difference is a clean offset.
  const actual = Math.floor(instant.getTime() / 60_000) * 60_000;
  return (asUtc - actual) / 60_000;
}

/**
 * Resolve a local wall-clock time in `timeZone` to the UTC instant it names.
 * Two passes settle DST: the first offset guess can be wrong when the naive
 * instant lands on the other side of a transition.
 */
export function zonedTimeToUtc(
  local: { year: number; month: number; day: number; hour: number; minute: number },
  timeZone: string,
): Date {
  const naive = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
  );
  let instant = new Date(naive - zoneOffsetMinutes(new Date(naive), timeZone) * 60_000);
  instant = new Date(naive - zoneOffsetMinutes(instant, timeZone) * 60_000);
  return instant;
}

export function formatInZone(
  instant: Date,
  timeZone: string,
  options: Intl.DateTimeFormatOptions = {
    dateStyle: "medium",
    timeStyle: "short",
  },
): string {
  return new Intl.DateTimeFormat("en-US", { ...options, timeZone }).format(
    instant,
  );
}
