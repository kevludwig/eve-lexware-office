/**
 * Running a caller's own checks of a sales document — the mount's `checks`
 * in eve, or the `checks` an MCP server hands prepareSalesDocument (e.g. a
 * VIES query). Pure: no eve, no mount configuration.
 */

import type { SalesDocumentKind } from "@kevludwig/lexware-office";

import type { SalesInput } from "./sales";
import type { SalesCheckCall, SalesChecks, SalesTool } from "./sales-tools";
import { describeWarning, type Warning } from "./warnings";

export const TOOL_OF: Record<SalesDocumentKind, SalesTool> = {
  quotation: "create_quotation",
  "order-confirmation": "create_order_confirmation",
  invoice: "create_invoice",
};

/** The finding when the caller's own checks failed — the card must not look checked when they did not run. */
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
 * The caller's checks for one document. A check that throws, or returns
 * something that is not a list of findings, breaks nothing: it is logged
 * and the card says that the check failed.
 */
export async function runSalesChecks(
  checks: SalesChecks | undefined,
  kind: SalesDocumentKind,
  input: SalesInput,
  options: { label: string; signal?: AbortSignal },
): Promise<Warning[]> {
  if (!checks) return [];
  try {
    const found: unknown = await checks({ tool: TOOL_OF[kind], input, signal: options.signal } as SalesCheckCall);
    if (!Array.isArray(found)) throw new TypeError("checks returned no list");
    const valid = found.filter(renders) as Warning[];
    if (valid.length === found.length) return valid;
    console.warn(`[lexware] checks returned ${found.length - valid.length} unreadable findings for ${options.label}`);
    return [...valid, HOST_CHECK_FAILED];
  } catch (error) {
    console.warn(`[lexware] checks failed for ${options.label}: ${String(error)}`);
    return [HOST_CHECK_FAILED];
  }
}
