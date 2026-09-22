/**
 * Idempotency journal, per tool call. Tools run as durable steps and may run
 * again after a crash — even after a successful write, if the step's commit
 * was lost. `pending` before the write, `created` after it: a replay finds
 * the entry and does not write twice.
 *
 * Never throws: an unwritable journal must not block an approved action.
 */

import { key, store } from "./runtime";

export interface JournalEntry {
  status: "pending" | "created" | "attached";
  resourceId?: string;
  at: string;
}

export async function readJournal(kind: string, callId: string): Promise<JournalEntry | null> {
  try {
    const entry = await store().read<JournalEntry>(key("journal", kind, callId));
    return entry && typeof entry.status === "string" ? entry : null;
  } catch (error) {
    console.warn(`[lexware] Cannot read journal ${kind}/${callId}: ${String(error)}`);
    return null;
  }
}

export async function writeJournal(kind: string, callId: string, entry: Omit<JournalEntry, "at">): Promise<void> {
  try {
    await store().write(key("journal", kind, callId), { ...entry, at: new Date().toISOString() });
  } catch (error) {
    console.warn(`[lexware] Cannot write journal ${kind}/${callId}: ${String(error)}`);
  }
}
