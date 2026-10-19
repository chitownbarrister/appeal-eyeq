// "Today" for deadline and window logic, as a YYYY-MM-DD date in Chicago,
// where every county this app serves sits. Tests can pin it with APP_TODAY;
// production always uses the real date.

export function todayIso(): string {
  const pinned = process.env.APP_TODAY;
  if (pinned && process.env.NODE_ENV !== "production" && /^\d{4}-\d{2}-\d{2}$/.test(pinned)) return pinned;
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
