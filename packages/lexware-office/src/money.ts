/**
 * Amounts, taxes, and tolerances — one source, so a check and the card that
 * shows it can never disagree about "matches".
 */

/**
 * Tolerance when reconciling line items with a total read off a document.
 * Covers the rounding of the document, nothing more.
 */
export const ITEMS_TOTAL_TOLERANCE = 0.02;

/**
 * Tolerance when comparing two already-rounded line-item totals, as the
 * duplicate searches do. The same size as ITEMS_TOTAL_TOLERANCE, but a
 * different question — hence its own name.
 */
export const DUPLICATE_TOTAL_TOLERANCE = 0.02;

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** A priced line, as far as totals need it. */
export interface PricedLine {
  quantity: number;
  netPrice: number;
}

/** Net total of line items, rounded to the cent. */
export function netTotal(lines: readonly PricedLine[]): number {
  return round2(lines.reduce((sum, line) => sum + line.quantity * line.netPrice, 0));
}

/** Tax contained in a gross amount. */
export function taxFromGross(gross: number, taxRatePercent: number): number {
  return round2(gross - gross / (1 + taxRatePercent / 100));
}

/** Tax on a net amount. */
export function taxFromNet(net: number, taxRatePercent: number): number {
  return round2(net * (taxRatePercent / 100));
}
