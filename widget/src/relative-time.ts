// Client-side relative time formatting for "Last Sync: {relative time}"
// (UI Design Contract, D-08 status block line 1). Pure function — no
// external date library needed for a handful of coarse buckets.

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Format an ISO 8601 timestamp as a coarse relative-time string
 * (e.g. "2 minutes ago", "just now", "3 hours ago", "5 days ago").
 *
 * Returns "unknown" if `isoTimestamp` cannot be parsed.
 */
export function formatRelativeTime(isoTimestamp: string, now: Date = new Date()): string {
  const then = new Date(isoTimestamp);
  if (Number.isNaN(then.getTime())) {
    return "unknown";
  }

  const diffMs = now.getTime() - then.getTime();
  if (diffMs < SECOND_MS) {
    return "just now";
  }

  if (diffMs < MINUTE_MS) {
    const seconds = Math.floor(diffMs / SECOND_MS);
    return pluralize(seconds, "second");
  }

  if (diffMs < HOUR_MS) {
    const minutes = Math.floor(diffMs / MINUTE_MS);
    return pluralize(minutes, "minute");
  }

  if (diffMs < DAY_MS) {
    const hours = Math.floor(diffMs / HOUR_MS);
    return pluralize(hours, "hour");
  }

  const days = Math.floor(diffMs / DAY_MS);
  return pluralize(days, "day");
}

function pluralize(value: number, unit: string): string {
  const plural = value === 1 ? unit : `${unit}s`;
  return `${value} ${plural} ago`;
}
