/**
 * The HTTP layer of the Lexware Office Public API.
 *
 * One client per account: the API allows two requests per second for the
 * whole account, so every call of a client goes through one serial queue with
 * a minimum spacing. A single retry on 429 covers the case that something else
 * uses the same account at the same time. Share one client instead of creating
 * one per call — separate clients do not know about each other's requests.
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
  /** Wait before retrying a request answered with 429, in ms. Default: 1 000. */
  rateLimitBackoffMs?: number;
  /** A fetch implementation, e.g. for tests. Default: the global fetch. */
  fetch?: typeof fetch;
}

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
  /** The link to a voucher or invoice in the web app. */
  voucherUrl(id: string): string;
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
      : error.status === 406
        ? " Ein 406 heißt meist: ein Pflichtfeld fehlt oder ein Betrag passt nicht zur Summe."
        : "";
  return `${error.message}${hint}`;
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

export function createLexwareClient(options: LexwareClientOptions): LexwareClient {
  if (!options.apiKey?.trim()) throw new Error("Lexware Office: apiKey fehlt.");

  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const appUrl = (options.appUrl ?? DEFAULT_APP_URL).replace(/\/+$/, "");
  const minSpacingMs = options.minSpacingMs ?? 550;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const backoffMs = options.rateLimitBackoffMs ?? 1_000;
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
   * One request, queued, with a single retry on 429 — then the API
   * demonstrably did not run it. A transport error after a POST is never
   * retried: the voucher may well exist already.
   */
  async function send(path: string, init: RequestInit): Promise<Response> {
    const method = init.method ?? "GET";
    const fire = () =>
      schedule(() => {
        const timeout = AbortSignal.timeout(timeoutMs);
        return fetchImpl(`${baseUrl}${path}`, {
          ...init,
          headers: { Authorization: `Bearer ${options.apiKey}`, Accept: "application/json", ...init.headers },
          signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
        });
      });

    let response = await fire();
    if (response.status === 429) {
      await sleep(backoffMs);
      response = await fire();
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new LexwareApiError({ status: response.status, statusText: response.statusText, method, path, responseBody: body });
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
      const response = await send(path, {
        ...rest,
        ...(body === undefined
          ? {}
          : { body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...rest.headers } }),
      });
      return json<T>(response);
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
      return json<T>(await send(path, { ...init, method: "POST", body: form }));
    },

    voucherUrl(id: string) {
      return `${appUrl}/vouchers#!/VoucherDetail/${id}`;
    },
  };
}
