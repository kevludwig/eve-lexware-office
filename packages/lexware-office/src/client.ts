import { markWriteOutcome } from "./write-outcome.ts";

/**
 * The HTTP layer of the Lexware Office Public API.
 *
 * One client per account: the API allows two requests per second for the
 * whole account, so every call of a client goes through one serial queue with
 * a minimum spacing. Retries on 429 — honouring Retry-After — cover other
 * clients on the same account: serverless instances, a second app. Share one
 * client per process; separate clients do not know about each other's
 * requests, the retries only soften that. A 500 with "rate limit exceeded"
 * counts as a 429 for reads; a write answered so is not sent again.
 */

export const DEFAULT_BASE_URL = "https://api.lexware.io/v1";

/** Where a voucher opens in the Lexware Office web app. */
export const DEFAULT_APP_URL = "https://app.lexware.de";

export interface LexwareClientOptions {
  /** A Public API key, created in Lexware Office under "Erweiterungen → Public API". */
  apiKey: string;
  /** API base URL. Default: https://api.lexware.io/v1 (the former api.lexoffice.io/v1 still works). */
  baseUrl?: string;
  /** Web app URL for links to vouchers. Default: https://app.lexware.de */
  appUrl?: string;
  /** Minimum spacing between two requests in ms. Default: 550 (the API allows 2 per second). */
  minSpacingMs?: number;
  /** Time limit per request in ms, counted from when it actually fires. Default: 20 000. */
  timeoutMs?: number;
  /**
   * Time limit for file uploads in ms. A scan of a few MB can take Lexware
   * longer than a JSON call to accept — an early abort reports a failure for
   * a file that arrives anyway. Default: 120 000.
   */
  uploadTimeoutMs?: number;
  /** Wait before retrying a request answered with 429 without Retry-After, in ms; grows with each retry. Default: 1 000. */
  rateLimitBackoffMs?: number;
  /** How often a request answered with 429 is sent again. Default: 3. */
  rateLimitRetries?: number;
  /** A fetch implementation, e.g. for tests. Default: the global fetch. */
  fetch?: typeof fetch;
}

/** The sales documents whose own link Lexware Office knows. */
export type VoucherLinkKind = "quotation" | "order-confirmation" | "invoice";

const VIEW_OF: Record<VoucherLinkKind, string> = { quotation: "Quotation", "order-confirmation": "Order", invoice: "Invoice" };

export interface FileUpload {
  bytes: Uint8Array;
  filename: string;
  mediaType: string;
}

export interface LexwareClient {
  /** A JSON request. `json` sets the body and content type. */
  request<T = unknown>(path: string, init?: RequestInit & { json?: unknown }): Promise<T>;
  /** A binary download, e.g. a document's PDF. */
  download(path: string, init: RequestInit & { accept: string }): Promise<{ bytes: Uint8Array; mediaType: string }>;
  /** A multipart file upload; the API calls the field `file`. */
  upload<T = unknown>(path: string, file: FileUpload, init?: RequestInit): Promise<T>;
  /**
   * The link to a voucher in the web app. With the kind of a sales document
   * it is the link Lexware Office itself shows (`VoucherView/Order|Invoice|Quotation/<id>`);
   * without, the generic `VoucherDetail/<id>`, which opens any voucher.
   */
  voucherUrl(id: string, kind?: VoucherLinkKind): string;
}

/**
 * An error answer of the API, with status and body.
 *
 * The status matters most: 403 nearly always means "the key lacks a
 * permission for this endpoint", not "the request was wrong".
 */
export class LexwareApiError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;
  readonly responseBody: string;

  constructor(options: { status: number; statusText: string; method: string; path: string; responseBody: string }) {
    super(
      `Lexware API ${options.status} ${options.statusText} bei ${options.method} ${options.path}` +
        (options.responseBody ? `: ${options.responseBody.slice(0, 500)}` : ""),
    );
    this.name = "LexwareApiError";
    this.status = options.status;
    this.method = options.method;
    this.path = options.path;
    this.responseBody = options.responseBody;
  }
}

/** An error as a sentence, with the hint that is nearly always right for its status. */
export function describeError(error: unknown): string {
  if (!(error instanceof LexwareApiError)) return error instanceof Error ? error.message : String(error);
  const hint =
    error.status === 403
      ? " Ein 403 heißt: dem API-Schlüssel fehlt das Recht für diesen Endpunkt."
      : isRateLimitError(error)
        ? error.status === 500 && error.method !== "GET"
          ? // A write answered 500 may have run (the client does not resend it) — retrying blindly can create twice.
            " Rate-Limit der API (500) — der Schreibzugriff ist womöglich trotzdem ausgeführt: erst in Lexware Office prüfen, dann erneut versuchen."
          : " Rate-Limit der API (2 Anfragen pro Sekunde je Konto) — später erneut versuchen."
        : error.status === 406
          ? " Ein 406 heißt meist: ein Pflichtfeld fehlt oder ein Betrag passt nicht zur Summe."
          : "";
  return `${error.message}${hint}`;
}

/** Whether an answer proves the API did not run a write: a 4xx other than 408 (a 429 is not processed). */
export function isWriteRefusal(error: unknown): boolean {
  return error instanceof LexwareApiError && error.status >= 400 && error.status < 500 && error.status !== 408;
}

/** Whether an error body is Lexware's "rate limit exceeded" — it comes with a 500 as well as with a 429. */
export function isRateLimitBody(body: string): boolean {
  return /rate[ _-]?limit/i.test(body);
}

/** Whether an error is the API's rate limit: a 429, or a 500 saying "rate limit exceeded". */
export function isRateLimitError(error: unknown): boolean {
  return error instanceof LexwareApiError && (error.status === 429 || (error.status === 500 && isRateLimitBody(error.responseBody)));
}

/** A query string from an object; empty values drop out. */
export function query(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    search.set(key, String(value));
  }
  const rendered = search.toString();
  return rendered ? `?${rendered}` : "";
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits `ms`, or rejects with the signal's reason as soon as it aborts. */
function abortableSleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  if (!signal) return sleep(ms).then(() => undefined);
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** The server's Retry-After in ms (seconds or an HTTP date), capped at 10 s; null without one. */
function retryAfterMs(response: Response): number | null {
  const header = response.headers.get("retry-after")?.trim();
  if (!header) return null;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(header) - Date.now();
  return Number.isFinite(ms) ? Math.min(Math.max(ms, 0), 10_000) : null;
}

export function createLexwareClient(options: LexwareClientOptions): LexwareClient {
  if (!options.apiKey?.trim()) throw new Error("Lexware Office: apiKey fehlt.");

  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const appUrl = (options.appUrl ?? DEFAULT_APP_URL).replace(/\/+$/, "");
  const minSpacingMs = options.minSpacingMs ?? 550;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const uploadTimeoutMs = options.uploadTimeoutMs ?? 120_000;
  const backoffMs = options.rateLimitBackoffMs ?? 1_000;
  const retries = options.rateLimitRetries ?? 3;
  const fetchImpl = options.fetch ?? fetch;

  // The queue: each request waits for the previous one to start plus the
  // spacing. The time limit starts when the request fires, not when queued.
  let chain: Promise<unknown> = Promise.resolve();
  let lastStart = 0;

  function schedule<T>(task: () => Promise<T>): Promise<T> {
    const run = chain.then(async () => {
      const wait = minSpacingMs - (Date.now() - lastStart);
      if (wait > 0) await sleep(wait);
      lastStart = Date.now();
      return task();
    });
    // An error belongs to its caller, not to the queue.
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * One request, queued, retried on 429 — then the API demonstrably did not
   * run it — and, for a GET only, on a 500 "rate limit exceeded". A transport
   * error after a POST is never retried: the voucher may well exist already.
   */
  async function send(path: string, init: RequestInit, limitMs = timeoutMs, flight: { fired?: boolean } = {}): Promise<Response> {
    const method = init.method ?? "GET";
    return attempt(path, init, method, limitMs, flight);
  }

  /**
   * A call whose error says, for a write, whether it may have run
   * (write-outcome.ts): not before the request fired, nor after a refusal (a
   * 4xx other than 408) — a wait after a 429 that the caller aborts left
   * nothing in flight either. An error reading the answer comes after the write.
   */
  async function call<T>(method: string, run: (flight: { fired?: boolean }) => Promise<T>): Promise<T> {
    const flight = { fired: false };
    try {
      return await run(flight);
    } catch (error) {
      throw method === "GET" ? error : markWriteOutcome(error, flight.fired && !isWriteRefusal(error));
    }
  }

  async function attempt(path: string, init: RequestInit, method: string, limitMs: number, flight: { fired?: boolean }): Promise<Response> {
    const fire = () =>
      schedule(() => {
        // Cancelled while queued: nothing goes out.
        if (init.signal?.aborted) return Promise.reject(init.signal.reason);
        flight.fired = true;
        const timeout = AbortSignal.timeout(limitMs);
        return fetchImpl(`${baseUrl}${path}`, {
          ...init,
          headers: { Authorization: `Bearer ${options.apiKey}`, Accept: "application/json", ...init.headers },
          signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
        });
      });

    // A 500 the API marks as "rate limit exceeded" (documented next to 429) is
    // one too — but only a GET is sent again: the docs do not promise that a
    // write answered 500 did not run. Its body is read here and kept for the error.
    const bodies = new WeakMap<Response, string>();
    const rateLimited = async (answer: Response): Promise<boolean> => {
      if (answer.status === 429) return true;
      if (answer.status !== 500 || method !== "GET") return false;
      const text = await answer.text().catch(() => "");
      bodies.set(answer, text);
      return isRateLimitBody(text);
    };

    let response = await fire();
    for (let attempt = 1; attempt <= retries && (await rateLimited(response)); attempt++) {
      if (!response.bodyUsed) await response.body?.cancel().catch(() => undefined);
      flight.fired = false;
      // The caller's cancellation also ends the wait between retries.
      await abortableSleep(retryAfterMs(response) ?? backoffMs * attempt, init.signal);
      response = await fire();
    }
    if (!response.ok) {
      const text = bodies.get(response) ?? (await response.text().catch(() => ""));
      throw new LexwareApiError({ status: response.status, statusText: response.statusText, method, path, responseBody: text });
    }
    return response;
  }

  async function json<T>(response: Response): Promise<T> {
    // Not every endpoint answers with a body (204).
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  return {
    async request<T>(path: string, init: RequestInit & { json?: unknown } = {}) {
      const { json: body, ...rest } = init;
      return call(rest.method ?? "GET", async (flight) => {
        const response = await send(
          path,
          {
            ...rest,
            ...(body === undefined
              ? {}
              : { body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...rest.headers } }),
          },
          timeoutMs,
          flight,
        );
        return json<T>(response);
      });
    },

    async download(path, init) {
      const { accept, ...rest } = init;
      const response = await send(path, { ...rest, headers: { ...rest.headers, Accept: accept } });
      return {
        bytes: new Uint8Array(await response.arrayBuffer()),
        mediaType: response.headers.get("content-type") ?? accept,
      };
    },

    async upload<T>(path: string, file: FileUpload, init: RequestInit = {}) {
      const form = new FormData();
      // An own ArrayBuffer: Blob refuses shared buffers.
      form.set("file", new Blob([Uint8Array.from(file.bytes)], { type: file.mediaType }), file.filename);
      // No Content-Type: fetch sets the multipart boundary.
      return call("POST", async (flight) => json<T>(await send(path, { ...init, method: "POST", body: form }, uploadTimeoutMs, flight)));
    },

    voucherUrl(id: string, kind?: VoucherLinkKind) {
      return kind ? `${appUrl}/vouchers#!/VoucherView/${VIEW_OF[kind]}/${id}` : `${appUrl}/vouchers#!/VoucherDetail/${id}`;
    },
  };
}
