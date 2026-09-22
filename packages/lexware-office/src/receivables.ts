/**
 * Open receivables: overdue invoices and their PDF.
 *
 * The voucher list carries what a reminder needs — due date, open amount,
 * customer — so choosing which invoice to remind is a list call and date
 * arithmetic, not a model decision.
 */

import { query, type LexwareClient } from "./client.ts";

export interface OverdueInvoice {
  id: string;
  voucherNumber: string;
  /** yyyy-MM-dd */
  voucherDate: string;
  /** yyyy-MM-dd. Equal to the voucher date for an invoice due immediately. */
  dueDate: string;
  contactId?: string;
  contactName: string;
  totalAmount: number;
  openAmount: number;
  currency: string;
}

interface VoucherListPage {
  content?: Array<{
    id: string;
    voucherNumber?: string;
    voucherDate?: string;
    dueDate?: string;
    contactId?: string;
    contactName?: string;
    totalAmount?: number;
    openAmount?: number;
    currency?: string;
  }>;
  last?: boolean;
}

/**
 * Every invoice Lexware Office counts as overdue. `overdue` has to stand alone
 * in the status filter — the API rejects it combined with other statuses.
 */
export async function findOverdueInvoices(
  client: LexwareClient,
  options: { signal?: AbortSignal; maxPages?: number } = {},
): Promise<OverdueInvoice[]> {
  const invoices: OverdueInvoice[] = [];
  for (let page = 0; page < (options.maxPages ?? 20); page++) {
    const result = await client.request<VoucherListPage>(
      `/voucherlist${query({ voucherType: "invoice", voucherStatus: "overdue", size: 100, page, sort: "voucherDate,ASC" })}`,
      { signal: options.signal },
    );
    for (const entry of result.content ?? []) {
      if (!entry.voucherNumber || !entry.dueDate) continue;
      invoices.push({
        id: entry.id,
        voucherNumber: entry.voucherNumber,
        voucherDate: entry.voucherDate?.slice(0, 10) ?? "",
        dueDate: entry.dueDate.slice(0, 10),
        contactId: entry.contactId,
        contactName: entry.contactName?.trim() || "unbekannter Kunde",
        totalAmount: entry.totalAmount ?? 0,
        openAmount: entry.openAmount ?? entry.totalAmount ?? 0,
        currency: entry.currency ?? "EUR",
      });
    }
    if (result.last !== false || (result.content ?? []).length === 0) break;
  }
  return invoices;
}

/** One overdue invoice, or null once it no longer is (paid, voided). */
export async function findOverdueInvoice(
  client: LexwareClient,
  id: string,
  signal?: AbortSignal,
): Promise<OverdueInvoice | null> {
  return (await findOverdueInvoices(client, { signal })).find((invoice) => invoice.id === id) ?? null;
}

/** An invoice as Lexware Office renders it — the PDF the customer received. */
export async function downloadInvoicePdf(
  client: LexwareClient,
  invoice: { id: string; voucherNumber: string },
  signal?: AbortSignal,
): Promise<{ bytes: Uint8Array; filename: string; mediaType: "application/pdf" }> {
  const file = await client.download(`/invoices/${encodeURIComponent(invoice.id)}/file`, { accept: "application/pdf", signal });
  return { bytes: file.bytes, filename: `${invoice.voucherNumber}.pdf`, mediaType: "application/pdf" };
}
