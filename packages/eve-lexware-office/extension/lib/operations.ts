/**
 * The extension's writes without eve — `@kevludwig/eve-lexware-office/operations`.
 *
 * For another agent surface on the same account, e.g. a remote MCP server
 * whose writes wait on an approval page: the same input schemas, the same
 * checks before the card, the same card, and the same approved write with
 * journal and re-check as the eve tools. The caller keeps what eve keeps in
 * the session — the input, the warnings, and what the card showed — until
 * a person approves, then executes with it.
 *
 * `draftOnly` (Operations, PrepareOptions, buildCard) keeps every quotation and
 * order confirmation a draft; `checks` (PrepareOptions) adds the caller's own
 * findings, e.g. a VIES query.
 *
 * A failed execute says whether the write may have run: `mayHaveRun` on the
 * error (writeMayHaveRun) is false when it certainly did not — then try again
 * — and true when it may have: look in Lexware Office first. `retryHint`
 * (Operations, executeApprovedCustomer) words what follows „Nichts angelegt;".
 *
 * Nothing here reads the mount's configuration or eve's session, and nothing
 * it imports loads eve: it runs where eve is not installed (test/operations-isolated.test.ts).
 */

export { buildCard } from "./cards";
export {
  CONTACT_FIELD_LABEL,
  customerChangesOf,
  customerDescription,
  customerInputSchema,
  customerUpdateDescription,
  customerUpdateInputSchema,
  executeApprovedCustomer,
  executeApprovedCustomerUpdate,
  prepareCustomer,
  prepareCustomerUpdate,
  type CustomerInput,
  type CustomerUpdateInput,
  type PreparedCustomer,
  type PreparedCustomerUpdate,
} from "./customer";
export { describeWarning, type Warning } from "./warnings";
export { HOST_CHECK_FAILED } from "./host-checks";
export { DEFAULT_RETRY_HINT } from "./write-guard";
export { writeMayHaveRun, type WriteOutcome } from "@kevludwig/lexware-office";
export { journalIn, type Journal, type JournalEntry } from "./journal-store";
export { readAccount, readDescription, readInputSchema, type ReadInput } from "./read";
export {
  DOCUMENT_LABEL,
  deliveryAddressLine,
  executeApprovedSalesDocument,
  introductionOf,
  orderJournalId,
  prepareSalesDocument,
  type Approved,
  type Operations,
  type PrepareOptions,
  type SalesInput,
} from "./sales";
export {
  invoiceDescription,
  invoiceInputSchema,
  orderConfirmationDescription,
  orderConfirmationInputSchema,
  quotationDescription,
  quotationInputSchema,
  withSource,
  type InvoiceInput,
  type OrderConfirmationInput,
  type QuotationInput,
  type SalesCheckCall,
  type SalesChecks,
  type SalesTool,
} from "./sales-tools";
export type { ApprovalCard, Finding } from "./card-types";

/** The duplicates a card showed — what an approved sales write may meet without stopping. */
export function shownDuplicates(warnings: readonly import("./warnings").Warning[]): string[] {
  return warnings.flatMap((warning) => (warning.kind === "sales-duplicate" || warning.kind === "voucher-duplicate" ? [warning.url] : []));
}
