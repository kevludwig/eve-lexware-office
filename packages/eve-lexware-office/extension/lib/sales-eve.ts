/**
 * The sales tools inside eve: the checks and the approved write of ./sales.ts
 * with the mount's client and journal, findings in eve's session state.
 */

import type { SalesDocumentKind } from "@kevludwig/lexware-office";

import { notesOf, saveWarnings, wasShownOnCard, type Warning } from "./findings";
import { runtimeJournal } from "./journal";
import { client } from "./runtime";
import { executeApprovedSalesDocument, prepareSalesDocument, type SalesInput } from "./sales";

/** The checks with the mount's client — for the eve tools. */
export function runSalesPreflight(kind: SalesDocumentKind, input: SalesInput, signal?: AbortSignal): Promise<Warning[]> {
  return prepareSalesDocument(client(), kind, input, signal);
}

/** The approval policy of a sales tool: checks to state, then the card decides. */
export function salesApproval(kind: SalesDocumentKind, normalize: (input: SalesInput) => SalesInput = (input) => input) {
  return async (ctx: { toolInput?: unknown; callId: string; abortSignal?: AbortSignal }) => {
    const input = ctx.toolInput as SalesInput | undefined;
    if (!input?.items?.length) return "user-approval" as const;
    saveWarnings(ctx.callId, await runSalesPreflight(kind, normalize(input), ctx.abortSignal));
    return "user-approval" as const;
  };
}

/**
 * Creates the document: quotations and order confirmations finalized (they
 * get their number now) unless `draft` asks otherwise, invoices always as
 * drafts — finalized and sent in Lexware Office. A replay of the same call does not create twice; a document that
 * appeared between card and click stops the write.
 */
export function executeSalesDocument(
  kind: SalesDocumentKind,
  input: SalesInput,
  ctx: { callId: string; abortSignal?: AbortSignal },
): Promise<Record<string, unknown>> {
  return executeApprovedSalesDocument({ client: client(), journal: runtimeJournal }, kind, input, {
    id: ctx.callId,
    shownOnCard: (url) => wasShownOnCard(ctx.callId, url),
    notes: () => notesOf(ctx.callId),
    signal: ctx.abortSignal,
  });
}
