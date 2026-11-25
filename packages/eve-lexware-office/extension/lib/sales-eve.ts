/**
 * The sales tools inside eve: the checks and the approved write of ./sales.ts
 * with the mount's client and journal, findings in eve's session state.
 */

import type { SalesDocumentKind } from "@kevludwig/lexware-office";

import { notesOf, saveWarnings, warningsOf, wasShownOnCard, type Warning } from "./findings";
import { runSalesChecks } from "./host-checks";
import { runtimeJournal } from "./journal";
import { client, config } from "./runtime";
import { executeApprovedSalesDocument, prepareSalesDocument, type SalesInput } from "./sales";
import { settledOf } from "./state";
import { EVE_RETRY_HINT } from "./write-guard";

export { HOST_CHECK_FAILED } from "./host-checks";

/**
 * The mount's `checks` for a sales document. A check that throws, or returns
 * something that is not a list of findings, breaks nothing: it is logged and
 * the card says that the check failed.
 */
export function runHostChecks(kind: SalesDocumentKind, input: SalesInput, ctx: { callId: string; abortSignal?: AbortSignal }): Promise<Warning[]> {
  return runSalesChecks(config().checks, kind, input, { label: ctx.callId, signal: ctx.abortSignal });
}

/** The checks with the mount's client — for the eve tools. */
export function runSalesPreflight(kind: SalesDocumentKind, input: SalesInput, signal?: AbortSignal): Promise<Warning[]> {
  return prepareSalesDocument(client(), kind, input, signal);
}

/**
 * The approval policy of a sales tool: its own checks and the mount's
 * `checks` to state, then the card decides. The host's checks see the input
 * as the tool parsed it, and run only before the card: on eve's recheck the
 * findings stay those the card showed.
 */
export function salesApproval(kind: SalesDocumentKind, normalize: (input: SalesInput) => SalesInput = (input) => input) {
  return async (ctx: { toolInput?: unknown; callId: string; abortSignal?: AbortSignal }) => {
    const input = ctx.toolInput as SalesInput | undefined;
    if (!input?.items?.length) return "user-approval" as const;
    const recheck = settledOf(ctx.callId) !== null;
    const [own, host] = await Promise.all([runSalesPreflight(kind, normalize(input), ctx.abortSignal), recheck ? [] : runHostChecks(kind, input, ctx)]);
    saveWarnings(ctx.callId, [...own, ...host]);
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
  return executeApprovedSalesDocument({ client: client(), journal: runtimeJournal, retryHint: EVE_RETRY_HINT }, kind, input, {
    id: ctx.callId,
    shownOnCard: (url) => wasShownOnCard(ctx.callId, url),
    notes: () => notesOf(ctx.callId),
    warnings: warningsOf(ctx.callId),
    signal: ctx.abortSignal,
  });
}
