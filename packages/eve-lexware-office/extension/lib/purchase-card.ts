/** The purchase invoice on the approval card — from the tool input; the findings come from the checks. */

import { eur } from "./format";
import { bookedGroupsOf, invoiceCurrencyOf, isForeignCurrency, totalsOf, type PurchaseInput } from "./purchase";
import type { ApprovalCard } from "./types";

const basename = (path: string) => path.split("/").pop() || path;

export function purchaseCard(raw: Record<string, unknown>): Omit<ApprovalCard, "tool" | "findings"> {
  const input = raw as PurchaseInput;
  // Brutto, USt., Netto show what is booked — EUR, for a foreign invoice the debited amount.
  const groups = bookedGroupsOf(input);
  const totals = totalsOf(groups);
  const currency = invoiceCurrencyOf(input);
  const invoiceGross = totalsOf(input.tax_groups).gross;
  const supplier = input.supplier_name?.trim() || "unbekannter Lieferant";
  const number = input.voucher_number?.trim() || "ohne Nummer";

  const facts: ApprovalCard["facts"] = [
    { title: "Lieferant", value: supplier },
    { title: "Rechnungsnummer", value: number },
  ];
  if (input.voucher_date) facts.push({ title: "Belegdatum", value: input.voucher_date });
  if (groups.length > 0) {
    facts.push({ title: "Brutto", value: eur(totals.gross) });
    facts.push({ title: "davon USt.", value: `${eur(totals.tax)} (${groups.map((group) => `${eur(group.gross_amount ?? 0)} zu ${group.tax_rate_percent ?? 0} %`).join(", ")})` });
    facts.push({ title: "Netto", value: eur(totals.net) });
  }
  if (typeof input.total_gross_amount === "number") {
    const difference = Math.round((invoiceGross - input.total_gross_amount) * 100) / 100;
    facts.push({
      title: "Rechnungsendbetrag",
      value: difference === 0 ? `${eur(input.total_gross_amount, currency)} — passt` : `${eur(input.total_gross_amount, currency)} — Abweichung ${eur(difference, currency)}`,
    });
  }
  const groupCategories = groups.map((group) => group.category?.trim()).filter((name): name is string => Boolean(name));
  facts.push({
    title: "Buchungskategorie",
    value:
      groupCategories.length > 0
        ? groupCategories.map((name, index) => `${name} (${eur(groups[index]?.gross_amount ?? 0)})`).join(", ")
        : (input.category?.trim() || "automatisch nach Lieferanten-Historie — siehe Befunde"),
  });
  facts.push({ title: "Original", value: input.attachment_path ? basename(input.attachment_path) : "kein Anhang" });

  return {
    title: "Eingangsrechnung erfassen?",
    subtitle: `${supplier} · Rechnung ${number} · ${eur(totals.gross)} brutto` + (isForeignCurrency(input) ? ` (${eur(invoiceGross, currency)})` : ""),
    facts,
    note: "Wird als Beleg zur Prüfung angelegt und in Lexware Office noch bestätigt.",
  };
}
