/**
 * Calendar days as Lexware Office users count them: in Berlin. A due date is
 * a day, not a moment — "3 days overdue" must not depend on whether the check
 * runs at 00:30 or 23:30.
 */

/** Today (or `at`) as a day in Berlin, yyyy-MM-dd. */
export function berlinDay(at: Date = new Date()): string {
  return at.toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
}

/** Days from a day (yyyy-MM-dd) to today in Berlin; negative while still ahead. */
export function daysSince(day: string, today: Date = new Date()): number {
  const from = Date.parse(`${day.slice(0, 10)}T00:00:00Z`);
  const to = Date.parse(`${berlinDay(today)}T00:00:00Z`);
  return Math.round((to - from) / 86_400_000);
}

/** A day (yyyy-MM-dd) moved by whole days. */
export function addDays(day: string, days: number): string {
  const date = new Date(`${day.slice(0, 10)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
