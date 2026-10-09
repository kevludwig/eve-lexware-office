/**
 * Sales documents — quotation, order confirmation, invoice. All three share
 * one payload shape; only the endpoint and a few optional fields differ.
 */

import { LexwareApiError, query, type LexwareClient } from "./client.ts";
import { DUPLICATE_TOTAL_TOLERANCE, round2 } from "./money.ts";

export type SalesDocumentKind = "quotation" | "order-confirmation" | "invoice";

/** A line with a price — counts towards the total unless it is optional. */
export interface PricedLineItem {
  type?: "custom";
  name: string;
  /** Free text under the name; Markdown (bold, italic, lists). Max. 2000 characters. */
  description?: string;
  quantity: number;
  /** e.g. "Stück", "Stunde". */
  unit: string;
  /** Net unit price in EUR. */
  netPrice: number;
  /** 0, 7, or 19. */
  taxRate: number;
  /** Quotations only: printed as "Optionale Position", not part of the total. */
  optional?: boolean;
}

/** A line without a price: a heading or a paragraph between positions. */
export interface TextLineItem {
  type: "text";
  name: string;
  description?: string;
}

/** One line of a sales document. */
export type LineItem = PricedLineItem | TextLineItem;

export const isPricedLine = (item: LineItem): item is PricedLineItem => item.type !== "text";

/** Whether a line adds to the document's total: priced and not optional. */
export const countsToTotal = (item: LineItem): item is PricedLineItem => isPricedLine(item) && !item.optional;

/** Lexware's limits for the texts of a sales document (FAQ "Texts in Sales Vouchers"). */
export const SALES_TEXT_LIMITS = { introduction: 2000, remark: 2000, title: 25, lineItemName: 255, lineItemDescription: 2000 } as const;

const ENDPOINTS: Record<SalesDocumentKind, string> = {
  quotation: "/quotations",
  "order-confirmation": "/order-confirmations",
  invoice: "/invoices",
};

/** The type as the voucher list spells it. */
export const VOUCHERLIST_TYPE: Record<SalesDocumentKind, string> = {
  quotation: "quotation",
  "order-confirmation": "orderconfirmation",
  invoice: "invoice",
};

/**
 * The live statuses of each kind in the voucher list. `voided` is left out: a
 * cancelled document is neither a duplicate nor a source to derive from.
 */
export const SALES_DOCUMENT_STATUSES: Record<SalesDocumentKind, string> = {
  quotation: "draft,open,accepted,rejected",
  "order-confirmation": "draft,open",
  invoice: "draft,open,paid,paidoff",
};

export interface CreatedSalesDocument {
  id: string;
  resourceUri?: string;
  url: string;
}

/**
 * Creates a sales document. `finalize` gives it a number right away — it can
 * then no longer be deleted like a draft. `introduction` and `remark` replace
 * the default texts of the account's settings — left out, the defaults stay.
 * Only quotations know optional lines; on other kinds this throws instead of
 * the API dropping the flag and counting the line.
 *
 * `precedingSalesVoucherId` links the document to its predecessor (a pursued
 * quotation becomes accepted) — only as a query parameter; in the body the API
 * drops it silently. The content is not copied: this payload alone decides
 * the new document. An invalid pursue answers 406, see isPursueRejection.
 */
export async function createSalesDocument(
  client: LexwareClient,
  options: {
    kind: SalesDocumentKind;
    contactId: string;
    items: readonly LineItem[];
    /** Replaces the printed heading; Lexware's default when absent. Max. 25 characters. */
    title?: string;
    /** Quotations: valid until, yyyy-MM-dd or a timestamp. */
    expirationDate?: string;
    finalize?: boolean;
    /** Total discount in EUR on the net amount. */
    totalDiscountAbsolute?: number;
    precedingSalesVoucherId?: string;
    /** Opening text; Markdown. Max. 2000 characters. */
    introduction?: string;
    /** Closing text; Markdown. Max. 2000 characters. */
    remark?: string;
  },
  signal?: AbortSignal,
): Promise<CreatedSalesDocument> {
  if (options.kind !== "quotation" && options.items.some((item) => isPricedLine(item) && item.optional)) {
    throw new Error(`Optional line items exist only on quotations, not on ${options.kind}`);
  }
  const voucherDate = new Date().toISOString().replace("Z", "+00:00");
  const discount = options.totalDiscountAbsolute ?? 0;
  const payload: Record<string, unknown> = {
    voucherDate,
    address: { contactId: options.contactId },
    lineItems: options.items.map(toApiLine),
    totalPrice: { currency: "EUR", ...(discount > 0 ? { totalDiscountAbsolute: round2(discount) } : {}) },
    taxConditions: { taxType: "net" },
    shippingConditions: { shippingType: "delivery", shippingDate: voucherDate },
    ...(options.title ? { title: options.title } : {}),
    ...(options.expirationDate ? { expirationDate: toIsoDateTime(options.expirationDate) } : {}),
    ...(options.introduction ? { introduction: options.introduction } : {}),
    ...(options.remark ? { remark: options.remark } : {}),
  };
  const params = query({ finalize: options.finalize ? true : undefined, precedingSalesVoucherId: options.precedingSalesVoucherId });
  const result = await client.request<{ id: string; resourceUri?: string }>(`${ENDPOINTS[options.kind]}${params}`, {
    method: "POST",
    json: payload,
    signal,
  });
  return { id: result.id, resourceUri: result.resourceUri, url: client.voucherUrl(result.id) };
}

function toApiLine(item: LineItem): Record<string, unknown> {
  const description = item.description ? { description: item.description } : {};
  if (!isPricedLine(item)) return { type: "text", name: item.name, ...description };
  return {
    type: "custom",
    name: item.name,
    ...description,
    quantity: item.quantity,
    unitName: item.unit,
    unitPrice: { currency: "EUR", netAmount: item.netPrice, taxRatePercentage: item.taxRate },
    ...(item.optional ? { optional: true } : {}),
  };
}

/** Whether a 406 rejects the pursue, not the payload — then a retry without the link makes sense. */
export function isPursueRejection(error: unknown): boolean {
  return error instanceof LexwareApiError && error.status === 406 && /preceding|pursue/i.test(error.responseBody);
}

/** yyyy-MM-dd as a timestamp at midnight in Berlin — the API expects datetimes. */
function toIsoDateTime(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  const offset =
    /GMT([+-]\d{2}:\d{2})/.exec(
      new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Berlin", timeZoneName: "longOffset" }).format(new Date(`${date}T12:00:00Z`)),
    )?.[1] ?? "+01:00";
  return `${date}T00:00:00.000${offset}`;
}

export interface SalesDocumentDetail {
  id: string;
  url: string;
  voucherNumber?: string;
  voucherStatus?: string;
  contactId?: string;
  contactName?: string;
  /** Net total over the lines that count (priced, not optional) — NaN for a document without any. */
  lineItemsNet: number;
  /** The lines that count towards the total. */
  lineItems: PricedLineItem[];
  /** Optional lines (quotations) — not in the total. */
  optionalItems: PricedLineItem[];
  /**
   * Optional or alternative lines — an order confirmation cannot be pursued
   * from such a quotation (the API answers 406).
   */
  hasOptionalOrAlternative: boolean;
  /** The final net total — after a total discount. */
  totalNet?: number;
  /** A total discount is invisible in the lines. */
  discountAbsolute?: number;
  discountPercentage?: number;
}

/** A document reduced to the fields a comparison needs. Text lines (no price) are left out, optional ones kept apart. */
export async function getSalesDocument(client: LexwareClient, kind: SalesDocumentKind, id: string, signal?: AbortSignal): Promise<SalesDocumentDetail> {
  const raw = await client.request<{
    id: string;
    voucherNumber?: string;
    voucherStatus?: string;
    address?: { contactId?: string; name?: string };
    lineItems?: Array<{
      type?: string;
      name?: string;
      description?: string;
      quantity?: number;
      unitName?: string;
      unitPrice?: { netAmount?: number; taxRatePercentage?: number };
      optional?: boolean;
      subItems?: unknown[];
    }>;
    totalPrice?: { totalNetAmount?: number; totalDiscountAbsolute?: number; totalDiscountPercentage?: number };
  }>(`${ENDPOINTS[kind]}/${encodeURIComponent(id)}`, { signal });

  const lines = raw.lineItems ?? [];
  const priced = lines
    .filter((item) => item.type !== "text" && item.unitPrice !== undefined)
    .map(
      (item): PricedLineItem => ({
        name: item.name ?? "",
        ...(item.description ? { description: item.description } : {}),
        quantity: item.quantity ?? 0,
        unit: item.unitName ?? "Stück",
        netPrice: item.unitPrice?.netAmount ?? 0,
        taxRate: item.unitPrice?.taxRatePercentage ?? 19,
        ...(item.optional ? { optional: true } : {}),
      }),
    );
  const items = priced.filter((item) => !item.optional);
  return {
    id: raw.id,
    url: client.voucherUrl(raw.id),
    voucherNumber: raw.voucherNumber,
    voucherStatus: raw.voucherStatus,
    contactId: raw.address?.contactId,
    contactName: raw.address?.name,
    lineItemsNet: items.length === 0 ? Number.NaN : round2(items.reduce((sum, item) => sum + item.quantity * item.netPrice, 0)),
    lineItems: items,
    optionalItems: priced.filter((item) => item.optional),
    hasOptionalOrAlternative: lines.some((item) => item.optional === true || (item.subItems?.length ?? 0) > 0),
    totalNet: raw.totalPrice?.totalNetAmount,
    discountAbsolute: raw.totalPrice?.totalDiscountAbsolute,
    discountPercentage: raw.totalPrice?.totalDiscountPercentage,
  };
}

/** Whether an invoice still exists. Only a 404 counts as gone — any other error answers true. */
export async function invoiceExists(client: LexwareClient, id: string, signal?: AbortSignal): Promise<boolean> {
  try {
    await client.request(`/invoices/${encodeURIComponent(id)}`, { signal });
    return true;
  } catch (error) {
    return !(error instanceof LexwareApiError && error.status === 404);
  }
}

export interface SalesListEntry {
  id: string;
  url: string;
  voucherNumber?: string;
  voucherDate?: string;
  voucherStatus?: string;
  contactId?: string;
  contactName?: string;
  totalAmount?: number;
}

/** The most recent documents of a kind, newest first — how "the current quotation for X" is found. */
export async function findRecentSalesDocuments(
  client: LexwareClient,
  options: { kind: SalesDocumentKind; contactId?: string; statuses?: string; lookbackDays?: number; size?: number; signal?: AbortSignal },
): Promise<SalesListEntry[]> {
  const from = new Date(Date.now() - (options.lookbackDays ?? 180) * 86_400_000).toISOString().slice(0, 10);
  const list = await client.request<{ content?: Array<Omit<SalesListEntry, "url">> }>(
    `/voucherlist${query({
      voucherType: VOUCHERLIST_TYPE[options.kind],
      voucherStatus: options.statuses ?? SALES_DOCUMENT_STATUSES[options.kind],
      contactId: options.contactId,
      voucherDateFrom: from,
      sort: "voucherDate,DESC",
      size: options.size ?? 25,
    })}`,
    { signal: options.signal },
  );
  return (list.content ?? []).map((entry) => ({ ...entry, url: client.voucherUrl(entry.id) }));
}

/** A search that could not check everything must not read as "nothing found". */
export type DuplicateSearchResult<T> =
  | { status: "match"; match: T; scanned: number }
  | { status: "clear"; scanned: number }
  | { status: "incomplete"; scanned: number; reason: string };

/**
 * A same-kind document for this contact with the same line-item net total —
 * heuristic (sales documents carry no external reference), so a finding for
 * the approval, never an automatic refusal. Each candidate is fetched in
 * detail, capped at `maxCandidates`.
 */
export async function findDuplicateSalesDocument(
  client: LexwareClient,
  options: { kind: SalesDocumentKind; contactId: string; itemsTotalNet: number; lookbackDays?: number; maxCandidates?: number; signal?: AbortSignal },
): Promise<DuplicateSearchResult<SalesListEntry>> {
  const candidates = await findRecentSalesDocuments(client, {
    kind: options.kind,
    contactId: options.contactId,
    lookbackDays: options.lookbackDays ?? 90,
    size: 50,
    signal: options.signal,
  });
  const checked = candidates.slice(0, options.maxCandidates ?? 10);
  for (const [index, candidate] of checked.entries()) {
    const detail = await getSalesDocument(client, options.kind, candidate.id, options.signal);
    if (Math.abs(detail.lineItemsNet - round2(options.itemsTotalNet)) <= DUPLICATE_TOTAL_TOLERANCE) {
      return { status: "match", match: candidate, scanned: index + 1 };
    }
  }
  if (candidates.length > checked.length) {
    return { status: "incomplete", scanned: checked.length, reason: `${candidates.length} Belege im Zeitfenster, nur die ${checked.length} neuesten geprüft` };
  }
  return { status: "clear", scanned: checked.length };
}
