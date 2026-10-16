/**
 * What the checks found, per tool call — typed, so a tool can ask "did the
 * card show this duplicate?" or "can the model fix this itself?", and
 * described once for cards and results.
 *
 * The checks run in the approval policy, server-side; findings live in
 * session state under the call id. The model can neither set nor skip them.
 */

import { defineState } from "eve/context";

import type { Finding } from "./card-types";
import { describeWarning, type Warning } from "./warnings";

export { describeWarning, isCorrectable, type Warning } from "./warnings";

const warnings = defineState<Record<string, Warning[]>>("warnings", () => ({}));

/** Signatures of calls already sent back for correction once — the model cannot reset them. */
const rejected = defineState<Record<string, true>>("rejected-signatures", () => ({}));

export function saveWarnings(callId: string, list: Warning[]): void {
  try {
    warnings.update((all) => ({ ...all, [callId]: list }));
  } catch (error) {
    console.warn(`[lexware] Cannot store findings: ${String(error)}`);
  }
}

export function warningsOf(callId: string): Warning[] {
  try {
    return warnings.get()[callId] ?? [];
  } catch {
    return [];
  }
}

/** The findings as the card and the result show them. */
export function findingsOf(callId: string): Finding[] {
  return warningsOf(callId).map(describeWarning);
}

/** Findings as lines for a tool result — the chat must not contradict the card. */
export function notesOf(callId: string): string[] {
  return findingsOf(callId).map((finding) => `${finding.title}: ${finding.value}`);
}

/**
 * Whether the card showed this document as a duplicate. Separates a warning
 * the user overrode from a document that only appeared between card and
 * click — only the latter stops the write. Unreadable state counts as "not
 * shown": better to stop than to create an unseen duplicate.
 */
export function wasShownOnCard(callId: string, url: string): boolean {
  return warningsOf(callId).some(
    (warning) => (warning.kind === "sales-duplicate" || warning.kind === "voucher-duplicate") && warning.url === url,
  );
}

export function wasRejected(signature: string): boolean {
  try {
    return rejected.get()[signature] === true;
  } catch {
    return false;
  }
}

export function rememberRejection(signature: string): void {
  try {
    rejected.update((all) => ({ ...all, [signature]: true }));
  } catch {
    // Without state the correction simply runs again — no harm done.
  }
}
