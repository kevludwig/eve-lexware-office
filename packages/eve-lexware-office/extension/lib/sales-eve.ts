/**
 * The sales tools inside eve: the checks and the approved write of ./sales.ts
 * with the mount's client and journal, findings in eve's session state.
 */

import type { SalesDocumentKind } from "@kevludwig/lexware-office";

import { describeWarning, notesOf, saveWarnings, wasShownOnCard, type Warning } from "./findings";
import { runtimeJournal } from "./journal";
import { client, config } from "./runtime";
import { executeApprovedSalesDocument, prepareSalesDocument, type SalesInput } from "./sales";
import type { SalesCheckCall, SalesTool } from "./sales-tools";
import { settledOf } from "./state";

const TOOL_OF: Record<SalesDocumentKind, SalesTool> = {
  quotation: "create_quotation",
  "order-confirmation": "create_order_confirmation",
  invoice: "create_invoice",
};

/** The finding when the host's own checks failed — the card must not look checked when they did not run. */
export const HOST_CHECK_FAILED: Warning = {
  kind: "note",
  title: "⚠ Zusatzprüfung",
  value: "fehlgeschlagen — ihre Befunde fehlen, selbst prüfen",
};

const renders = (warning: unknown): boolean => {
  try {
    const finding = describeWarning(warning as Warning);
    return typeof finding?.title === "string" && typeof finding.value === "string";
  } catch {
    return false;
  }
};

/**
 * The mount's `checks` for a sales document. A check that throws, or returns
 * something that is not a list of findings, breaks nothing: it is logged and
 * the card says that the check failed.
 */
export async function runHostChecks(kind: SalesDocumentKind, input: SalesInput, ctx: { callId: string; abortSignal?: AbortSignal }): Promise<Warning[]> {
  const checks = config().checks;
  if (!checks) return [];
  try {
    const found: unknown = await checks({ tool: TOOL_OF[kind], input, signal: ctx.abortSignal } as SalesCheckCall);
    if (!Array.isArray(found)) throw new TypeError("checks returned no list");
    const valid = found.filter(renders) as Warning[];
    if (valid.length === found.length) return valid;
    console.warn(`[lexware] checks returned ${found.length - valid.length} unreadable findings for ${ctx.callId}`);
    return [...valid, HOST_CHECK_FAILED];
  } catch (error) {
    console.warn(`[lexware] checks failed for ${ctx.callId}: ${String(error)}`);
    return [HOST_CHECK_FAILED];
  }
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
  return executeApprovedSalesDocument({ client: client(), journal: runtimeJournal }, kind, input, {
    id: ctx.callId,
    shownOnCard: (url) => wasShownOnCard(ctx.callId, url),
    notes: () => notesOf(ctx.callId),
    signal: ctx.abortSignal,
  });
}
