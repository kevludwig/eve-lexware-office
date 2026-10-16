/**
 * The figures of a purchase invoice — currency, tax groups, totals — and the
 * attachment allowlist. Pure: the approval card (./purchase-card.ts) reads
 * them without the checks' API calls or eve's session.
 */

import { round2, taxFromGross } from "@kevludwig/lexware-office";

export const BOOKING_CURRENCY = "EUR";

export interface TaxGroupInput {
  gross_amount?: number;
  tax_rate_percent?: number;
  /** Category of this group — only for a voucher split across categories. */
  category?: string;
}

export interface PurchaseInput {
  supplier_name?: string;
  voucher_number?: string;
  voucher_date?: string;
  due_date?: string;
  currency?: string;
  bank_statement_eur_amount?: number;
  total_gross_amount?: number;
  tax_groups?: readonly TaxGroupInput[];
  category?: string;
  contact_id?: string;
  remark?: string;
  attachment_path?: string;
}

export const MISSING_EUR_AMOUNT_INSTRUCTION =
  "Die Rechnung ist nicht in EUR. Lexware Office bucht in EUR, maßgeblich ist der tatsächlich abgebuchte Betrag. Frage " +
  "den Nutzer (Freitext) nach dem EUR-Betrag laut Kontoauszug — nicht selbst umrechnen, keinen Kurs schätzen — und rufe " +
  "das Tool dann mit bank_statement_eur_amount erneut auf. Beträge und tax_groups bleiben in Rechnungswährung.";

export const invoiceCurrencyOf = (input: PurchaseInput) => input.currency?.trim().toUpperCase() || BOOKING_CURRENCY;
export const isForeignCurrency = (input: PurchaseInput) => invoiceCurrencyOf(input) !== BOOKING_CURRENCY;
export const lacksEurAmount = (input: PurchaseInput) =>
  isForeignCurrency(input) && !(typeof input.bank_statement_eur_amount === "number" && input.bank_statement_eur_amount > 0);

/**
 * The tax groups as they are booked: in EUR. A foreign invoice's groups are
 * scaled to the debited amount; the last group takes the rounding remainder,
 * so the groups meet the bank line to the cent.
 */
export function bookedGroupsOf<G extends TaxGroupInput>(input: PurchaseInput & { tax_groups?: readonly G[] }): G[] {
  const groups = [...(input.tax_groups ?? [])];
  if (!isForeignCurrency(input) || lacksEurAmount(input)) return groups;
  const target = round2(input.bank_statement_eur_amount!);
  const original = groups.reduce((sum, group) => sum + (group.gross_amount ?? 0), 0);
  if (original <= 0) return groups;
  let assigned = 0;
  return groups.map((group, index) => {
    const amount = index === groups.length - 1 ? round2(target - assigned) : round2(((group.gross_amount ?? 0) * target) / original);
    assigned = round2(assigned + amount);
    return { ...group, gross_amount: amount };
  });
}

/** EUR per unit of the invoice currency, implied by the debit — shown on the card. Null for EUR. */
export function impliedRateOf(input: PurchaseInput): number | null {
  if (!isForeignCurrency(input) || lacksEurAmount(input)) return null;
  const original = (input.tax_groups ?? []).reduce((sum, group) => sum + (group.gross_amount ?? 0), 0);
  return original > 0 ? input.bank_statement_eur_amount! / original : null;
}

export function totalsOf(groups: readonly TaxGroupInput[] = []): { gross: number; tax: number; net: number } {
  let gross = 0;
  let tax = 0;
  for (const group of groups) {
    gross += group.gross_amount ?? 0;
    tax += taxFromGross(group.gross_amount ?? 0, group.tax_rate_percent ?? 0);
  }
  return { gross: round2(gross), tax: round2(tax), net: round2(gross - tax) };
}

/**
 * Where eve stages uploaded files: /workspace/.eve/attachments/<hash>/<name>
 * since eve 0.70.2, /workspace/attachments/… before. The path comes from the
 * model, so this is an allowlist — any other sandbox file must never end up
 * attached to a voucher.
 */
const ATTACHMENT_PATH = /^\/workspace\/(?:\.eve\/)?attachments\/[0-9a-f]{8,64}\/[\w.-]+$/;

export const isAllowedAttachmentPath = (path: string) => ATTACHMENT_PATH.test(path);
