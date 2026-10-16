/**
 * The mount's journal, per tool call (./journal-store.ts on the mount's store).
 */

import { journalIn, type JournalEntry } from "./journal-store";
import { store } from "./runtime";

export type { JournalEntry } from "./journal-store";

export const runtimeJournal = journalIn(store);

export function readJournal(kind: string, callId: string): Promise<JournalEntry | null> {
  return runtimeJournal.read(kind, callId);
}

export function writeJournal(kind: string, callId: string, entry: Omit<JournalEntry, "at">): Promise<void> {
  return runtimeJournal.write(kind, callId, entry);
}
