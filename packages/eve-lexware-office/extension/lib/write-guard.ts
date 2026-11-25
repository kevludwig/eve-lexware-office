/**
 * Approved writes report whether they may have run (`mayHaveRun` on the
 * error, see @kevludwig/lexware-office's write-outcome): every error before
 * the write request carries `false`, one from the request carries what its
 * answer proves, one after it `true`. The messages stay as they are.
 */

import { markWriteOutcome, withWriteOutcome, writeMayHaveRun, type WriteOutcome } from "@kevludwig/lexware-office";

/** What a stopped write tells the caller to do by default: neutral, for hosts with or without approval cards. */
export const DEFAULT_RETRY_HINT = "später erneut versuchen";
/** The eve tools' hint: their approval can be run again. */
export const EVE_RETRY_HINT = "die Freigabe später erneut ausführen";

/** Runs an approved write. `sending()` marks the moment the write request goes out. */
export async function guardedWrite<T>(body: (sending: () => void) => Promise<T>): Promise<T> {
  let sent = false;
  try {
    return await body(() => {
      sent = true;
    });
  } catch (error) {
    throw markWriteOutcome(error, sent);
  }
}

/** The write request failed: the message as before, the outcome from the request's error (unclear when it has none). */
export function failedWrite(message: string, cause: unknown): Error & WriteOutcome {
  return withWriteOutcome(message, writeMayHaveRun(cause) ?? true, cause);
}
