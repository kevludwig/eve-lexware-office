/**
 * The purchase invoice: foreign currency, supplier, posting category, and the
 * checks before the card.
 *
 * Lexware Office books in EUR. For an invoice in another currency the right
 * amount is the one actually debited — fees and the bank's rate included —
 * so the user supplies it from the bank statement and the conversion happens
 * here, deterministically; the totals check stays in the invoice currency.
 */

import {
  ITEMS_TOTAL_TOLERANCE,
  REVERSE_CHARGE_TAX_RATE,
  describeError,
  findPurchaseInvoiceByNumber,
  findVendorCategoryHistory,
  getContact,
  isReverseChargeCategory,
  resolveCategory,
  resolveContactByName,
  round2,
  taxFromGross,
  type PostingCategory,
} from "@kevinludwig/lexware-office";
import { defineState } from "eve/context";

import type { Warning } from "./findings";
import { client } from "./runtime";

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
 * Where eve stages uploaded files: /workspace/attachments/<hash>/<name>. The
 * path comes from the model, so this is an allowlist — any other sandbox file
 * must never end up attached to a voucher.
 */
const ATTACHMENT_PATH = /^\/workspace\/attachments\/[0-9a-f]{8,64}\/[\w.-]+$/;

export const isAllowedAttachmentPath = (path: string) => ATTACHMENT_PATH.test(path);

export interface SupplierTarget {
  contactId?: string;
  /** The name on the voucher — also for the collective vendor. */
  contactName: string;
  warnings: Warning[];
}

/**
 * The vendor contact for the name on the invoice. The collective vendor is
 * the fallback — and always a finding, so a voucher never lands there
 * silently. A passed contact_id is verified, and the card carries the
 * contact's real name.
 */
export async function resolveSupplier(input: PurchaseInput, signal?: AbortSignal): Promise<SupplierTarget> {
  const name = input.supplier_name?.trim() || "unbekannter Lieferant";
  const fallback = (reason: string): SupplierTarget => ({ contactName: name, warnings: [{ kind: "voucher-contact-fallback", reason }] });

  if (input.contact_id) {
    try {
      const contact = await getContact(client(), input.contact_id, signal);
      if (!contact.isVendor) return fallback(`contact_id ${input.contact_id} („${contact.name}") ist kein Lieferantenkontakt — der Beleg geht an den Sammellieferanten`);
      return {
        contactId: contact.id,
        contactName: contact.name,
        warnings:
          contact.name.toLowerCase() === name.toLowerCase()
            ? []
            : [{ kind: "voucher-contact-explicit", contactName: contact.name, contactId: contact.id, extractedName: name }],
      };
    } catch (error) {
      return fallback(`contact_id ${input.contact_id} ließ sich nicht verifizieren (${describeError(error)}) — der Beleg geht an den Sammellieferanten`);
    }
  }

  try {
    const { match, candidates } = await resolveContactByName(client(), name, { vendor: true, signal });
    if (match) return { contactId: match.id, contactName: match.name, warnings: [] };
    if (candidates.length > 1) {
      return fallback(
        `„${name}" passt auf ${candidates.length} Lieferantenkontakte (${candidates.map((contact) => contact.name).join(", ")}) — der ` +
          "Beleg geht an den Sammellieferanten. Mit contact_id lässt sich einer davon festlegen.",
      );
    }
    return fallback(`kein Lieferantenkontakt „${name}" — der Beleg geht an den Sammellieferanten`);
  } catch (error) {
    return fallback(`Kontaktsuche fehlgeschlagen (${describeError(error)}) — der Beleg geht an den Sammellieferanten`);
  }
}

/** Supplier and categories the card showed, bound to the call — execute writes exactly that. */
export interface ApprovedPurchaseTarget {
  contactId?: string;
  contactName: string;
  categoryId?: string;
  categoryName?: string;
  /** Per-group categories of a split voucher, aligned with tax_groups. */
  groupCategories?: Array<{ id?: string; name?: string }>;
}

const approvedTargets = defineState<Record<string, ApprovedPurchaseTarget>>("purchase-targets", () => ({}));

export function rememberPurchaseTarget(callId: string, target: ApprovedPurchaseTarget): void {
  try {
    approvedTargets.update((all) => ({ ...all, [callId]: target }));
  } catch (error) {
    console.warn(`[lexware] Cannot bind purchase target: ${String(error)}`);
  }
}

export function approvedPurchaseTarget(callId: string): ApprovedPurchaseTarget | null {
  try {
    return approvedTargets.get()[callId] ?? null;
  } catch {
    return null;
  }
}

/** One concrete capture — same numbers and same category choice: each new choice runs the correction cycle once. */
export function purchaseSignatureOf(input: PurchaseInput): string {
  const groups = input.tax_groups ?? [];
  return [
    "voucher",
    input.voucher_number?.trim() ?? "-",
    input.voucher_date ?? "-",
    invoiceCurrencyOf(input),
    (input.bank_statement_eur_amount ?? 0).toFixed(2),
    (input.total_gross_amount ?? 0).toFixed(2),
    groups.length,
    totalsOf(groups).gross.toFixed(2),
    input.category?.trim().toLowerCase() ?? "-",
    groups.map((group) => group.category?.trim().toLowerCase() ?? "").join(","),
  ].join("|");
}

/**
 * Totals, currency, supplier, category, reverse charge, duplicate, and
 * attachment. Network errors become findings. Returns supplier and category
 * too, so the approval can bind them to the call.
 */
export async function runPurchasePreflight(
  input: PurchaseInput,
  options: { signal?: AbortSignal; readFileSize?: (path: string) => Promise<number | null> } = {},
): Promise<{ warnings: Warning[]; supplier: SupplierTarget; category: PostingCategory | null; groupCategories: Array<PostingCategory | null> | null }> {
  const warnings: Warning[] = [];
  const groups = input.tax_groups ?? [];

  if (groups.length > 0 && typeof input.total_gross_amount === "number") {
    const computed = totalsOf(groups).gross;
    const difference = round2(computed - input.total_gross_amount);
    if (Math.abs(difference) > ITEMS_TOTAL_TOLERANCE) {
      warnings.push({ kind: "voucher-total-mismatch", computed, expected: input.total_gross_amount, difference, currency: invoiceCurrencyOf(input) });
    }
  }

  const rate = impliedRateOf(input);
  if (rate !== null) {
    warnings.push({ kind: "voucher-foreign-currency", currency: invoiceCurrencyOf(input), original: totalsOf(groups).gross, booked: round2(input.bank_statement_eur_amount!), rate });
  }

  // The supplier first: the category pick builds on his booked vouchers.
  const supplier = await resolveSupplier(input, options.signal);
  warnings.push(...supplier.warnings);
  const picked = await resolveCategories(input, supplier.contactId, options.signal);
  warnings.push(...picked.warnings);
  warnings.push(...reverseChargeFindings(groups, picked));
  warnings.push(...(await checkDuplicate(input, options.signal)));
  warnings.push(...(await checkAttachment(input, options.readFileSize)));
  return { warnings, supplier, category: picked.category, groupCategories: picked.groupCategories };
}

/** Says when a category books as reverse charge; an invoice that charges VAT under one contradicts itself. */
function reverseChargeFindings(
  groups: readonly TaxGroupInput[],
  picked: { category: PostingCategory | null; groupCategories: Array<PostingCategory | null> | null },
): Warning[] {
  const nameOf = (index: number) => (picked.groupCategories ? picked.groupCategories[index]?.name : picked.category?.name);
  const affected = groups.map((group, index) => ({ group, name: nameOf(index) })).filter((entry) => isReverseChargeCategory(entry.name));
  if (affected.length === 0) return [];
  return [
    {
      kind: "voucher-reverse-charge",
      categories: [...new Set(affected.map((entry) => entry.name!))],
      rate: REVERSE_CHARGE_TAX_RATE,
      invoiceChargesTax: affected.some((entry) => (entry.group.tax_rate_percent ?? 0) > 0),
    },
  ];
}

/** Per-group categories when a group names one, otherwise the single pick. */
export async function resolveCategories(
  input: PurchaseInput,
  contactId: string | undefined,
  signal?: AbortSignal,
): Promise<{ category: PostingCategory | null; groupCategories: Array<PostingCategory | null> | null; warnings: Warning[] }> {
  const groups = input.tax_groups ?? [];
  if (!groups.some((group) => group.category?.trim())) return { ...(await pickCategory(input, contactId, signal)), groupCategories: null };

  const warnings: Warning[] = [];
  const resolved: Array<PostingCategory | null> = [];
  for (const [index, group] of groups.entries()) {
    const name = group.category?.trim();
    if (!name) {
      resolved.push(null);
      continue;
    }
    try {
      const match = await resolveCategory(client(), name, "outgo", signal);
      if (!match) {
        warnings.push({
          kind: "voucher-category-missing",
          reason: `„${name}" (Gruppe ${index + 1}) ist keine Ausgabenkategorie dieses Kontos — Name wörtlich aus /posting-categories übernehmen; die Gruppe wird sonst ohne Kategorie erfasst`,
        });
      }
      resolved.push(match);
    } catch (error) {
      warnings.push({ kind: "voucher-category-missing", reason: `Kategorien nicht abrufbar (${describeError(error)}) — Gruppe ${index + 1} wird ohne Kategorie erfasst` });
      resolved.push(null);
    }
  }
  return { category: null, groupCategories: resolved, warnings };
}

/**
 * The posting category, in this order: the one the call names (checked
 * against the account, a deviation from the vendor's usual one is a finding);
 * the vendor's history — one category is taken over, several are for the
 * model to choose from; no history — the model looks one up or asks. A
 * vendor whose vouchers are split within one voucher gets no single pick.
 */
export async function pickCategory(
  input: PurchaseInput,
  contactId: string | undefined,
  signal?: AbortSignal,
): Promise<{ category: PostingCategory | null; warnings: Warning[] }> {
  const requested = input.category?.trim();
  const warnings: Warning[] = [];

  let history: Awaited<ReturnType<typeof findVendorCategoryHistory>> | null = null;
  let historyError: string | null = null;
  if (contactId) {
    try {
      history = await findVendorCategoryHistory(client(), contactId, { signal });
    } catch (error) {
      historyError = describeError(error);
    }
  }

  try {
    if (requested) {
      const match = await resolveCategory(client(), requested, "outgo", signal);
      if (match) {
        if (history?.split) warnings.push({ kind: "category-split", candidates: history.categories.map((category) => category.name) });
        const usual = history?.categories ?? [];
        if (usual.length > 0 && !usual.some((category) => category.id === match.id)) {
          warnings.push({ kind: "category-deviation", chosen: match.name, usual: usual.map((category) => category.name).join(", ") });
        }
        return { category: match, warnings };
      }
      warnings.push({ kind: "voucher-category-missing", reason: `„${requested}" ist keine Ausgabenkategorie dieses Kontos — Name wörtlich aus /posting-categories übernehmen` });
    }

    if (history) {
      if (history.split) {
        warnings.push({ kind: "category-split", candidates: history.categories.map((category) => category.name) });
        return { category: null, warnings };
      }
      if (history.categories.length === 1) {
        const match = await resolveCategory(client(), history.categories[0]!.id, "outgo", signal);
        if (match) {
          warnings.push({
            kind: "category-history",
            name: match.name,
            basis:
              `wie die ${history.scanned === 1 ? "letzte gebuchte Rechnung" : `letzten ${history.scanned} gebuchten Rechnungen`} dieses Lieferanten` +
              (history.incomplete ? " (ältere ungeprüft)" : ""),
          });
          return { category: match, warnings };
        }
      }
      if (history.categories.length > 1) {
        warnings.push({ kind: "category-ambiguous", candidates: history.categories.map((category) => category.name) });
        return { category: null, warnings };
      }
    }

    if (historyError) {
      warnings.push({ kind: "voucher-category-missing", reason: `Lieferanten-Historie nicht abrufbar (${historyError}) — der Beleg wird ohne Kategorie erfasst` });
      return { category: null, warnings };
    }
    warnings.push({ kind: "category-no-history" });
    return { category: null, warnings };
  } catch (error) {
    warnings.push({ kind: "voucher-category-missing", reason: `Kategorien nicht abrufbar (${describeError(error)}) — der Beleg wird ohne Kategorie erfasst` });
    return { category: null, warnings };
  }
}

async function checkDuplicate(input: PurchaseInput, signal?: AbortSignal): Promise<Warning[]> {
  const number = input.voucher_number?.trim();
  if (!number) return [];
  try {
    const existing = await findPurchaseInvoiceByNumber(client(), number, signal);
    return existing
      ? [
          {
            kind: "voucher-duplicate",
            url: existing.url,
            voucherNumber: existing.voucherNumber ?? number,
            voucherDate: existing.voucherDate,
            voucherStatus: existing.voucherStatus,
            contactName: existing.contactName,
          },
        ]
      : [];
  } catch (error) {
    return [{ kind: "voucher-duplicate-check-failed", reason: describeError(error) }];
  }
}

async function checkAttachment(input: PurchaseInput, readFileSize?: (path: string) => Promise<number | null>): Promise<Warning[]> {
  const path = input.attachment_path?.trim();
  if (!path) return [];
  if (!isAllowedAttachmentPath(path)) {
    return [{ kind: "voucher-attachment-missing", reason: `„${path}" liegt nicht unter /workspace/attachments/ — es wird kein Original angehängt` }];
  }
  if (!readFileSize) return [];
  try {
    return (await readFileSize(path)) === null ? [{ kind: "voucher-attachment-missing", reason: `${path} existiert nicht — es wird kein Original angehängt` }] : [];
  } catch (error) {
    return [{ kind: "voucher-attachment-missing", reason: `${path} nicht lesbar (${describeError(error)})` }];
  }
}
