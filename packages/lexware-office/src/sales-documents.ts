/**
 * Sales documents — quotation, order confirmation, invoice. All three share
 * one payload shape; only the endpoint and a few optional fields differ.
 */

import { LexwareApiError, query, type LexwareClient } from "./client.ts";
import { DUPLICATE_TOTAL_TOLERANCE, netTotal, round2 } from "./money.ts";

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
  /**
   * Net unit price in EUR. On a document with tax type `gross` the totals
   * still count in net — derive it from `grossPrice` there.
   */
  netPrice: number;
  /** Gross unit price in EUR — sent instead of `netPrice` when the document's tax type is `gross`. */
  grossPrice?: number;
  /** See VALID_TAX_RATES; 0 on every vat-free tax type. */
  taxRate: number;
  /** Discount on this line in percent, up to 2 decimals. */
  discountPercentage?: number;
  /**
   * A product or service from the account's articles. The line still carries
   * all its fields — they may deviate from the article, which stays as it is.
   */
  article?: { id: string; type: "service" | "material" };
  /** Quotations only: printed as "Optionale Position", not part of the total. */
  optional?: boolean;
  /** Quotations only: alternatives offered instead of this line — printed under it, not part of the total. */
  alternatives?: readonly AlternativeLineItem[];
}

/** An alternative to a priced line of a quotation: priced itself, never optional, without alternatives of its own. */
export type AlternativeLineItem = Omit<PricedLineItem, "optional" | "alternatives">;

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
export const SALES_TEXT_LIMITS = { introduction: 2000, remark: 2000, deliveryTerms: 255, title: 25, lineItemName: 255, lineItemDescription: 2000 } as const;

/**
 * The tax rates Lexware Office accepts on German sales documents (cookbook
 * "Rechnungen"). EU destination rates for distance sales come on top, with a
 * `taxSubType` only.
 */
export const VALID_TAX_RATES = [0, 5, 7, 16, 19] as const;

/** How the document is taxed. Every type but `net` and `gross` needs a referenced contact and 0 % on every line. */
export type SalesTaxType =
  | "net"
  | "gross"
  | "vatfree"
  | "intraCommunitySupply"
  | "constructionService13b"
  | "externalService13b"
  | "thirdPartyCountryService"
  | "thirdPartyCountryDelivery"
  | "photovoltaicEquipment";

export const SALES_TAX_TYPES: readonly SalesTaxType[] = [
  "net",
  "gross",
  "vatfree",
  "intraCommunitySupply",
  "constructionService13b",
  "externalService13b",
  "thirdPartyCountryService",
  "thirdPartyCountryDelivery",
  "photovoltaicEquipment",
];

/** Whether a tax type charges no VAT — then every line must carry 0 %. */
export const isVatFreeTaxType = (type: SalesTaxType): boolean => type !== "net" && type !== "gross";

export interface TaxConditions {
  taxType: SalesTaxType;
  /** B2C in the EU with `net` or `gross` only. */
  taxSubType?: "distanceSales" | "electronicServices";
  /** The printed note on a vat-free type; the account's default when absent. */
  taxTypeNote?: string;
}

export interface PaymentConditions {
  /** The printed text, e.g. „Zahlbar innerhalb von 14 Tagen ohne Abzug". */
  paymentTermLabel?: string;
  /** Days until payment is due. */
  paymentTermDuration?: number;
  /** Cash discount for payment within `discountRange` days. */
  paymentDiscountConditions?: { discountPercentage: number; discountRange: number };
}

/**
 * When the goods or the service are supplied — the date § 14 (4) No. 6 UStG
 * asks of an invoice. `none` prints no date. The tax rates valid at
 * `shippingDate` (a period: `shippingEndDate`) apply.
 */
export type ShippingConditions =
  | { shippingType: "service" | "delivery"; shippingDate: string }
  | { shippingType: "serviceperiod" | "deliveryperiod"; shippingDate: string; shippingEndDate: string }
  | { shippingType: "none" };

export type SalesLanguage = "de" | "en";

/**
 * The text Lexware Office prints for a payment term, in its own wording:
 * „Zahlbar sofort, rein netto", „Zahlbar innerhalb von 14 Tagen ohne Abzug",
 * „10 Tage 2 % Skonto, 30 Tage netto".
 */
export function paymentTermLabel(days: number, discount?: { percentage: number; days: number }): string {
  if (discount) {
    return `${discount.days} Tage ${discount.percentage.toLocaleString("de-DE", { maximumFractionDigits: 2 })} % Skonto, ${days} Tage netto`;
  }
  return days === 0 ? "Zahlbar sofort, rein netto" : `Zahlbar innerhalb von ${days} ${days === 1 ? "Tag" : "Tagen"} ohne Abzug`;
}

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

/** What a sales document is created with. Everything optional falls back to Lexware Office's defaults. */
export interface NewSalesDocument {
  kind: SalesDocumentKind;
  contactId: string;
  items: readonly LineItem[];
  /** yyyy-MM-dd or a timestamp. Default: now. */
  voucherDate?: string;
  /** Replaces the printed heading; Lexware's default when absent. Max. 25 characters. */
  title?: string;
  /** Quotations: valid until, yyyy-MM-dd or a timestamp. */
  expirationDate?: string;
  finalize?: boolean;
  /** Total discount in EUR. Not together with `totalDiscountPercentage`. */
  totalDiscountAbsolute?: number;
  /** Total discount in percent of the net (or, on `gross`, the gross) total. Without either, a contact's default discount applies. */
  totalDiscountPercentage?: number;
  /** Default: `{ taxType: "net" }`. */
  taxConditions?: TaxConditions;
  /** Without them, Lexware takes the contact's payment term, else the account's default. */
  paymentConditions?: PaymentConditions;
  /**
   * Order confirmations and invoices only — quotations have none. Default:
   * delivery on the voucher date, which is what Lexware prints then.
   */
  shippingConditions?: ShippingConditions;
  /** Print language and language of the default texts. Default: de. */
  language?: SalesLanguage;
  /** A print layout from listPrintLayouts; the account's default when absent. */
  printLayoutId?: string;
  /** Order confirmations only. Max. 255 characters; the contact's or account's default when absent. */
  deliveryTerms?: string;
  /** Invoices to an XRechnung contact: the Leitweg-ID, overriding the contact's. An empty string makes a standard invoice. */
  xRechnung?: { buyerReference: string };
  precedingSalesVoucherId?: string;
  /** Opening text; Markdown. Max. 2000 characters. */
  introduction?: string;
  /** Closing text; Markdown. Max. 2000 characters. */
  remark?: string;
}

/**
 * Creates a sales document. `finalize` gives it a number right away — it can
 * then no longer be deleted like a draft. Texts, payment conditions, delivery
 * terms, print layout and total discount left out take the account's (or the
 * contact's) defaults. Combinations the API documents for another kind only —
 * optional lines outside a quotation, shipping conditions on one, … — throw
 * instead of reaching the API, which would drop or reject them.
 *
 * `precedingSalesVoucherId` links the document to its predecessor (a pursued
 * quotation becomes accepted) — only as a query parameter; in the body the API
 * drops it silently. The content is not copied: this payload alone decides
 * the new document. An invalid pursue answers 406, see isPursueRejection.
 */
export async function createSalesDocument(client: LexwareClient, options: NewSalesDocument, signal?: AbortSignal): Promise<CreatedSalesDocument> {
  assertValidSalesDocument(options);
  const voucherDate = options.voucherDate ? toIsoDateTime(options.voucherDate) : new Date().toISOString().replace("Z", "+00:00");
  const taxConditions = options.taxConditions ?? { taxType: "net" as const };
  const gross = taxConditions.taxType === "gross";
  const totalPrice = {
    currency: "EUR",
    ...((options.totalDiscountAbsolute ?? 0) > 0 ? { totalDiscountAbsolute: round2(options.totalDiscountAbsolute!) } : {}),
    ...((options.totalDiscountPercentage ?? 0) > 0 ? { totalDiscountPercentage: round2(options.totalDiscountPercentage!) } : {}),
  };
  const payload: Record<string, unknown> = {
    voucherDate,
    address: { contactId: options.contactId },
    lineItems: options.items.map((item) => toApiLine(item, gross)),
    totalPrice,
    taxConditions,
    ...(options.kind === "quotation" ? {} : { shippingConditions: toApiShipping(options.shippingConditions, voucherDate) }),
    ...(options.paymentConditions ? { paymentConditions: options.paymentConditions } : {}),
    ...(options.language ? { language: options.language } : {}),
    ...(options.printLayoutId ? { printLayoutId: options.printLayoutId } : {}),
    ...(options.deliveryTerms ? { deliveryTerms: options.deliveryTerms } : {}),
    ...(options.xRechnung ? { xRechnung: options.xRechnung } : {}),
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

/** The checks createSalesDocument runs before sending — exported so a caller can run them before an approval. */
export function salesDocumentProblems(options: NewSalesDocument): string[] {
  const problems: string[] = [];
  const { kind } = options;
  const priced = options.items.filter(isPricedLine);
  const lines = priced.flatMap((item) => [item, ...(item.alternatives ?? [])]);
  const taxType = options.taxConditions?.taxType ?? "net";

  if (kind !== "quotation" && priced.some((item) => item.optional)) problems.push(`Optional line items exist only on quotations, not on ${kind}`);
  if (kind !== "quotation" && priced.some((item) => (item.alternatives?.length ?? 0) > 0)) problems.push(`Alternative line items exist only on quotations, not on ${kind}`);
  if (priced.some((item) => item.optional && (item.alternatives?.length ?? 0) > 0)) problems.push("An optional line item cannot have alternatives");
  if (kind === "quotation" && options.shippingConditions) problems.push("Quotations have no shipping conditions");
  if (kind !== "order-confirmation" && options.deliveryTerms) problems.push(`Delivery terms exist only on order confirmations, not on ${kind}`);
  if (kind !== "invoice" && options.xRechnung) problems.push(`XRechnung properties exist only on invoices, not on ${kind}`);
  if (kind !== "quotation" && options.expirationDate) problems.push(`An expiration date exists only on quotations, not on ${kind}`);
  if ((options.deliveryTerms?.length ?? 0) > SALES_TEXT_LIMITS.deliveryTerms) problems.push(`Delivery terms longer than ${SALES_TEXT_LIMITS.deliveryTerms} characters`);
  if ((options.totalDiscountAbsolute ?? 0) > 0 && (options.totalDiscountPercentage ?? 0) > 0) problems.push("Either an absolute or a percentage total discount, not both");
  if ((options.totalDiscountPercentage ?? 0) > 100) problems.push("A total discount above 100 %");

  if (isVatFreeTaxType(taxType) && lines.some((item) => item.taxRate !== 0)) problems.push(`Tax type ${taxType} needs 0 % on every line`);
  if (options.taxConditions?.taxSubType && isVatFreeTaxType(taxType)) problems.push("A tax subtype goes with net or gross only");
  if (!options.taxConditions?.taxSubType && lines.some((item) => !(VALID_TAX_RATES as readonly number[]).includes(item.taxRate))) {
    problems.push(`Tax rates other than ${VALID_TAX_RATES.join(", ")} % need a tax subtype (EU distance sales)`);
  }
  if (taxType === "gross" && lines.some((item) => item.grossPrice === undefined)) problems.push("Tax type gross needs a gross price on every priced line");
  if (lines.some((item) => (item.discountPercentage ?? 0) < 0 || (item.discountPercentage ?? 0) > 100)) problems.push("A line discount outside 0–100 %");

  const shipping = options.shippingConditions;
  if (shipping && shipping.shippingType !== "none") {
    if (!isDate(shipping.shippingDate)) problems.push(`Shipping date ${shipping.shippingDate} is no date`);
    if ("shippingEndDate" in shipping) {
      if (!isDate(shipping.shippingEndDate)) problems.push(`Shipping end date ${shipping.shippingEndDate} is no date`);
      else if (dayOf(shipping.shippingEndDate) < dayOf(shipping.shippingDate)) problems.push("The shipping period ends before it starts");
    }
  }
  const payment = options.paymentConditions;
  if (payment?.paymentDiscountConditions && payment.paymentTermDuration !== undefined && payment.paymentDiscountConditions.discountRange > payment.paymentTermDuration) {
    problems.push("The cash discount runs longer than the payment term");
  }
  return problems;
}

function assertValidSalesDocument(options: NewSalesDocument): void {
  const problems = salesDocumentProblems(options);
  if (problems.length > 0) throw new Error(problems.join("; "));
}

const isDate = (value: string) => !Number.isNaN(new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00Z` : value).getTime());
const dayOf = (value: string) => value.slice(0, 10);

function toApiShipping(shipping: ShippingConditions | undefined, voucherDate: string): Record<string, unknown> {
  if (!shipping) return { shippingType: "delivery", shippingDate: voucherDate };
  if (shipping.shippingType === "none") return { shippingType: "none" };
  return {
    shippingType: shipping.shippingType,
    shippingDate: toIsoDateTime(shipping.shippingDate),
    ...("shippingEndDate" in shipping ? { shippingEndDate: toIsoDateTime(shipping.shippingEndDate) } : {}),
  };
}

function toApiLine(item: LineItem, gross: boolean): Record<string, unknown> {
  const description = item.description ? { description: item.description } : {};
  if (!isPricedLine(item)) return { type: "text", name: item.name, ...description };
  return {
    ...(item.article ? { id: item.article.id, type: item.article.type } : { type: "custom" }),
    name: item.name,
    ...description,
    quantity: item.quantity,
    unitName: item.unit,
    unitPrice: gross
      ? { currency: "EUR", grossAmount: item.grossPrice, taxRatePercentage: item.taxRate }
      : { currency: "EUR", netAmount: item.netPrice, taxRatePercentage: item.taxRate },
    ...((item.discountPercentage ?? 0) > 0 ? { discountPercentage: item.discountPercentage } : {}),
    ...(item.optional ? { optional: true } : {}),
    ...(item.alternatives?.length ? { subItems: item.alternatives.map((alternative) => ({ ...toApiLine(alternative, gross), alternative: true })) } : {}),
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
      discountPercentage?: number;
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
        ...(item.discountPercentage ? { discountPercentage: item.discountPercentage } : {}),
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
    lineItemsNet: items.length === 0 ? Number.NaN : netTotal(items),
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
