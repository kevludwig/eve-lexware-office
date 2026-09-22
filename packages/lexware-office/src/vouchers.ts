/**
 * Vouchers (`/vouchers`) — the bookkeeping side. A voucher carries amounts
 * grouped by tax rate, no articles: a supplier invoice with 48 items at 19 %
 * is one voucher item; the articles live in the attached original.
 */

import { listPostingCategories } from "./categories.ts";
import { query, type FileUpload, type LexwareClient } from "./client.ts";
import { round2 } from "./money.ts";

export type VoucherType = "purchaseinvoice" | "purchasecreditnote" | "salesinvoice" | "salescreditnote";

/**
 * Writable statuses. `unchecked` files the voucher under "Belege zur Prüfung"
 * with several fields optional — the safe state for anything read from a
 * document. `open` demands complete data. Other statuses are Lexware's own.
 */
export type VoucherStatus = "unchecked" | "open";

export type VoucherTaxType = "net" | "gross";

export interface VoucherItem {
  /** Net or gross, per the voucher's taxType. */
  amount: number;
  taxAmount: number;
  taxRatePercent: number;
  categoryId?: string;
}

export interface CreateVoucherOptions {
  type: VoucherType;
  /** For purchase invoices: the supplier's invoice number. */
  voucherNumber: string;
  /** yyyy-MM-dd */
  voucherDate: string;
  /** yyyy-MM-dd */
  dueDate?: string;
  totalGrossAmount: number;
  totalTaxAmount: number;
  taxType: VoucherTaxType;
  voucherStatus: VoucherStatus;
  /** The collective contact ("Sammellieferant") instead of a real one. */
  useCollectiveContact?: boolean;
  /** A real contact; ignored with useCollectiveContact. */
  contactId?: string;
  /**
   * The supplier's name — only with the collective contact, where it is the
   * only mark. With a contactId the API answers 406
   * (`custom_contact_name_for_referenced_contact_not_allowed`).
   */
  contactName?: string;
  /** Free text; feeds Lexware's full-text search. */
  remark?: string;
  voucherItems: readonly VoucherItem[];
}

export interface CreatedVoucher {
  id: string;
  resourceUri?: string;
  url: string;
}

/** Creates a voucher. `shippingDate` stays unset: the API allows it only for sales vouchers. */
export async function createVoucher(client: LexwareClient, options: CreateVoucherOptions, signal?: AbortSignal): Promise<CreatedVoucher> {
  if (options.voucherStatus === "unchecked" && options.taxType === "net") {
    throw new Error(
      "Ein Beleg mit Status 'unchecked' darf nicht taxType 'net' haben — die API verbietet die Kombination. " +
        "Bruttobeträge übergeben (taxType 'gross') oder den Beleg mit Status 'open' vollständig erfassen.",
    );
  }
  if (!options.useCollectiveContact && !options.contactId) {
    throw new Error("Beleg ohne Kontakt: entweder useCollectiveContact setzen oder eine contactId übergeben.");
  }

  const payload: Record<string, unknown> = {
    type: options.type,
    voucherStatus: options.voucherStatus,
    voucherNumber: options.voucherNumber,
    voucherDate: options.voucherDate,
    ...(options.dueDate ? { dueDate: options.dueDate } : {}),
    totalGrossAmount: round2(options.totalGrossAmount),
    totalTaxAmount: round2(options.totalTaxAmount),
    taxType: options.taxType,
    ...(options.useCollectiveContact
      ? { useCollectiveContact: true, ...(options.contactName ? { contactName: options.contactName } : {}) }
      : { useCollectiveContact: false, contactId: options.contactId }),
    ...(options.remark ? { remark: options.remark } : {}),
    voucherItems: options.voucherItems.map((item) => ({
      amount: round2(item.amount),
      taxAmount: round2(item.taxAmount),
      taxRatePercent: item.taxRatePercent,
      ...(item.categoryId ? { categoryId: item.categoryId } : {}),
    })),
    version: 0,
  };

  const result = await client.request<{ id: string; resourceUri?: string }>("/vouchers", { method: "POST", json: payload, signal });
  return { id: result.id, resourceUri: result.resourceUri, url: client.voucherUrl(result.id) };
}

/**
 * Attaches a file (PDF, image, XML) to a voucher. Lexware keeps a checksum:
 * the same file again returns the existing file id, no copy.
 */
export async function uploadVoucherFile(client: LexwareClient, voucherId: string, file: FileUpload, signal?: AbortSignal): Promise<{ id: string }> {
  return client.upload<{ id: string }>(`/vouchers/${encodeURIComponent(voucherId)}/files`, file, { signal });
}

export interface VoucherListEntry {
  id: string;
  voucherType: string;
  voucherStatus: string;
  voucherNumber?: string;
  voucherDate?: string;
  dueDate?: string;
  contactId?: string;
  contactName?: string;
  totalAmount?: number;
  openAmount?: number;
  archived?: boolean;
  /** Link into the web app. */
  url: string;
}

export interface VoucherListFilter {
  /** Comma-separated types, or `any`. Required by the API. */
  voucherType: string;
  /** Comma-separated statuses, or `any`. Required by the API. */
  voucherStatus: string;
  voucherNumber?: string;
  contactId?: string;
  voucherDateFrom?: string;
  voucherDateTo?: string;
  archived?: boolean;
  size?: number;
  sort?: string;
}

/** The voucher list — the one search across all voucher types. Newest first, 50 by default. */
export async function findVouchers(client: LexwareClient, filter: VoucherListFilter, signal?: AbortSignal): Promise<VoucherListEntry[]> {
  const page = await client.request<{ content?: Array<Omit<VoucherListEntry, "url">> }>(
    `/voucherlist${query({ size: 50, sort: "voucherDate,DESC", ...filter })}`,
    { signal },
  );
  return (page.content ?? []).map((entry) => ({ ...entry, url: client.voucherUrl(entry.id) }));
}

/**
 * An already captured purchase invoice or credit note with this number, any
 * status. Account-wide, not per vendor: two vendors with the same number
 * match too, so the caller should compare `contactName` and warn rather than
 * refuse.
 */
export async function findPurchaseInvoiceByNumber(client: LexwareClient, voucherNumber: string, signal?: AbortSignal): Promise<VoucherListEntry | null> {
  const matches = await findVouchers(client, { voucherType: "purchaseinvoice,purchasecreditnote", voucherStatus: "any", voucherNumber }, signal);
  return matches[0] ?? null;
}

export interface CategoryHistory {
  /** Distinct categories of the vendor's booked vouchers, most recent first. */
  categories: Array<{ id: string; name: string }>;
  scanned: number;
  /** More booked vouchers existed than were checked. */
  incomplete: boolean;
  /**
   * A single booked voucher was split across categories. Then the distinct
   * list is no either/or choice: the vendor is categorized per position.
   */
  split: boolean;
}

/**
 * The categories this vendor's booked purchase invoices were filed under —
 * the basis for picking one automatically: always the same category means
 * keep it; several mean the document has to decide. Only `open,paid,paidoff`
 * count: an unchecked voucher may carry a wrong category. The voucher list has
 * no categories, so each is fetched in detail — capped at `maxDetails`.
 */
export async function findVendorCategoryHistory(
  client: LexwareClient,
  contactId: string,
  options: { signal?: AbortSignal; maxDetails?: number; lookbackDays?: number } = {},
): Promise<CategoryHistory> {
  const from = new Date(Date.now() - (options.lookbackDays ?? 400) * 86_400_000).toISOString().slice(0, 10);
  const booked = await findVouchers(
    client,
    { voucherType: "purchaseinvoice", voucherStatus: "open,paid,paidoff", contactId, voucherDateFrom: from, size: 20 },
    options.signal,
  );
  const checked = booked.slice(0, options.maxDetails ?? 5);
  const ids: string[] = [];
  let split = false;
  for (const entry of checked) {
    const detail = await client.request<{ voucherItems?: Array<{ categoryId?: string }> }>(`/vouchers/${entry.id}`, { signal: options.signal });
    const perVoucher = new Set<string>();
    for (const item of detail.voucherItems ?? []) {
      if (!item.categoryId) continue;
      perVoucher.add(item.categoryId);
      if (!ids.includes(item.categoryId)) ids.push(item.categoryId);
    }
    if (perVoucher.size > 1) split = true;
  }
  const known = await listPostingCategories(client, options.signal);
  return {
    // An id the list does not know stays visible as the id.
    categories: ids.map((id) => ({ id, name: known.find((category) => category.id === id)?.name ?? id })),
    scanned: checked.length,
    incomplete: booked.length > checked.length,
    split,
  };
}
