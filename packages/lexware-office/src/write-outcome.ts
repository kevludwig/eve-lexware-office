/**
 * Whether a failed write may have reached Lexware Office — for callers that
 * must tell „certainly nothing written, try again" from „unclear, look in
 * Lexware Office first" without reading the (German) message.
 *
 * `mayHaveRun: false` — the write certainly did not run: it stopped before the
 * request, or the API refused it (a 4xx other than 408).
 * `mayHaveRun: true` — it may have run: a timeout, a dropped connection, a 5xx,
 * or an error after the write went through.
 * No field — not classified; treat it as `true`.
 *
 * The field sits on the error as thrown — Error, LexwareApiError,
 * MailNotSentError —, not on a class of its own: names and messages stay as
 * they were. Read it with writeMayHaveRun.
 */

/** An error that says whether the write it reports may have run. */
export interface WriteOutcome {
  readonly mayHaveRun: boolean;
}

/** The outcome an error carries: true or false, or undefined when it was never classified. */
export function writeMayHaveRun(error: unknown): boolean | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const value = (error as { mayHaveRun?: unknown }).mayHaveRun;
  return typeof value === "boolean" ? value : undefined;
}

/**
 * Gives an error its outcome, in place — its class and message stay as they
 * are. One that already carries an outcome keeps it.
 */
export function markWriteOutcome<E>(error: E, mayHaveRun: boolean): E {
  if (typeof error === "object" && error !== null && writeMayHaveRun(error) === undefined && Object.isExtensible(error)) {
    Object.defineProperty(error, "mayHaveRun", { value: mayHaveRun, enumerable: false, configurable: true });
  }
  return error;
}

/** A write stopped before its request: a plain Error, certainly not run. */
export function notRun(message: string, cause?: unknown): Error & WriteOutcome {
  return markWriteOutcome(new Error(message, cause === undefined ? undefined : { cause }), false) as Error & WriteOutcome;
}

/**
 * A plain Error with an outcome — the class and message as without one, so
 * `String(error)` and `instanceof` checks stay the same.
 */
export function withWriteOutcome(message: string, mayHaveRun: boolean, cause?: unknown): Error & WriteOutcome {
  return markWriteOutcome(new Error(message, cause === undefined ? undefined : { cause }), mayHaveRun) as Error & WriteOutcome;
}
