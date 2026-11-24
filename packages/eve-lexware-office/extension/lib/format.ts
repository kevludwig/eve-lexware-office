/** How amounts and dates read on cards and in answers: „1.000,00 EUR", „1.1.2026". */

export function eur(value: number, currency = "EUR"): string {
  return `${value.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

export function shortDate(value: string): string {
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00Z` : value);
  return date.toLocaleDateString("de-DE", { timeZone: "Europe/Berlin" });
}

/** A text as a sentence: with a full stop at its end, so the next one can follow. */
export function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}
