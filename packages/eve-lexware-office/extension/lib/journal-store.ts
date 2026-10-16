/**
 * Idempotency journal on any JsonStore — no eve. Writes run as durable steps
 * (eve) or after a click (an approval page) and may run again; `pending`
 * before the write, `created` after it: a replay finds the entry and does not
 * write twice.
 *
 * Never throws: an unwritable journal must not block an approved action.
 */

import { keySegment, type JsonStore, type PaymentReminderEffect } from "@kevludwig/lexware-office";

export interface JournalEntry {
  status: "pending" | "created" | "attached";
  resourceId?: string;
  /** What a sent payment reminder did, kept so a replay returns the same proof. */
  effect?: PaymentReminderEffect;
  at: string;
}

export interface Journal {
  read(kind: string, id: string): Promise<JournalEntry | null>;
  write(kind: string, id: string, entry: Omit<JournalEntry, "at">): Promise<void>;
}

const keyOf = (kind: string, id: string) => ["journal", kind, id].map(keySegment).join("/");

/** The journal in `store`, under `journal/<kind>/<id>` — the same keys the eve tools use. */
export function journalIn(store: JsonStore | (() => JsonStore)): Journal {
  const resolve = typeof store === "function" ? store : () => store;
  return {
    async read(kind, id) {
      try {
        const entry = await resolve().read<JournalEntry>(keyOf(kind, id));
        return entry && typeof entry.status === "string" ? entry : null;
      } catch (error) {
        console.warn(`[lexware] Cannot read journal ${kind}/${id}: ${String(error)}`);
        return null;
      }
    },
    async write(kind, id, entry) {
      try {
        await resolve().write(keyOf(kind, id), { ...entry, at: new Date().toISOString() });
      } catch (error) {
        console.warn(`[lexware] Cannot write journal ${kind}/${id}: ${String(error)}`);
      }
    },
  };
}
