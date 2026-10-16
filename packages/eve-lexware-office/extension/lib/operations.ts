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
 * Nothing here reads the mount's configuration or eve's session.
 */

export { buildCard } from "./cards";
export { customerInputSchema, executeApprovedCustomer, prepareCustomer, type CustomerInput, type PreparedCustomer } from "./customer";
export { describeWarning, type Warning } from "./findings";
export { journalIn, type Journal, type JournalEntry } from "./journal-store";
export {
  DOCUMENT_LABEL,
  executeApprovedSalesDocument,
  prepareSalesDocument,
  type Approved,
  type Operations,
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
} from "./sales-tools";
export type { ApprovalCard, Finding } from "./types";

/** The duplicates a card showed — what an approved sales write may meet without stopping. */
export function shownDuplicates(warnings: readonly import("./findings").Warning[]): string[] {
  return warnings.flatMap((warning) => (warning.kind === "sales-duplicate" || warning.kind === "voucher-duplicate" ? [warning.url] : []));
}
