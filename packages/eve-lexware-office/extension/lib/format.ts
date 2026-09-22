/** How amounts and dates read on cards and in answers: „761,60 EUR", „1.9.2026". */

export function eur(value: number, currency = "EUR"): string {
  return `${value.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

export function shortDate(value: string): string {
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00Z` : value);
  return date.toLocaleDateString("de-DE", { timeZone: "Europe/Berlin" });
}
