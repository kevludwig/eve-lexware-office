/**
 * Whether a failed write may have run — `mayHaveRun` on the error, read with
 * writeMayHaveRun — so a host need not match the German message.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  LexwareApiError,
  MailNotSentError,
  createLexwareClient,
  createSalesDocument,
  createVoucher,
  defaultReminderMail,
  findRecentSalesDocuments,
  getSalesDocument,
  markWriteOutcome,
  memoryStore,
  notRun,
  reminderLedger,
  sendReminder,
  updateCustomer,
  writeMayHaveRun,
  type LexwareClient,
  type VoucherLinkKind,
} from "../src/index.ts";

const clientAnswering = (answer: (init: RequestInit) => Response | Promise<Response>, extra: { rateLimitBackoffMs?: number } = {}) =>
  createLexwareClient({ apiKey: "k", minSpacingMs: 0, rateLimitBackoffMs: 1, ...extra, fetch: (async (_url: unknown, init: RequestInit = {}) => answer(init)) as typeof fetch });

const outcomeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => assert.fail("expected a rejection"),
    (error: unknown) => ({ error, mayHaveRun: writeMayHaveRun(error) }),
  );

describe("the client classifies a failed write", () => {
  it("a refusal (4xx other than 408) did not run", async () => {
    for (const status of [400, 403, 406, 409, 429]) {
      const client = clientAnswering(() => new Response("nope", { status }), { rateLimitBackoffMs: 0 });
      const { error, mayHaveRun } = await outcomeOf(client.request("/invoices", { method: "POST", json: {} }));
      assert.ok(error instanceof LexwareApiError, "the class stays LexwareApiError");
      assert.equal(mayHaveRun, false, `status ${status}`);
    }
  });

  it("a timeout, a 5xx or a dropped connection may have run", async () => {
    for (const status of [408, 500, 502, 503]) {
      const client = clientAnswering(() => new Response("", { status }));
      assert.equal((await outcomeOf(client.request("/invoices", { method: "POST", json: {} }))).mayHaveRun, true, `status ${status}`);
    }
    const dropped = clientAnswering(() => Promise.reject(new TypeError("fetch failed")));
    const { error, mayHaveRun } = await outcomeOf(dropped.request("/invoices", { method: "POST", json: {} }));
    assert.equal(mayHaveRun, true);
    assert.equal(String(error), "TypeError: fetch failed", "name and message stay as thrown");
  });

  it("an answer that does not parse came after the write", async () => {
    const client = clientAnswering(() => new Response("{not json", { status: 201 }));
    assert.equal((await outcomeOf(client.request("/invoices", { method: "POST", json: {} }))).mayHaveRun, true);
  });

  it("a caller who aborts before the request fired, or while waiting after a 429, left nothing in flight", async () => {
    const before = new AbortController();
    before.abort(new Error("cancelled"));
    const unsent = clientAnswering(() => assert.fail("no request expected"));
    assert.equal((await outcomeOf(unsent.request("/invoices", { method: "POST", json: {}, signal: before.signal }))).mayHaveRun, false);

    const waiting = new AbortController();
    const limited = clientAnswering(() => new Response("", { status: 429, headers: { "retry-after": "5" } }));
    const pending = outcomeOf(limited.request("/invoices", { method: "POST", json: {}, signal: waiting.signal }));
    setTimeout(() => waiting.abort(new Error("cancelled by the caller")), 30);
    const { error, mayHaveRun } = await pending;
    assert.match(String(error), /cancelled by the caller/);
    assert.equal(mayHaveRun, false);
  });

  it("a file upload is classified like any write", async () => {
    const client = clientAnswering(() => new Response("", { status: 503 }));
    const file = { bytes: new Uint8Array([37, 80, 68, 70]), filename: "R.pdf", mediaType: "application/pdf" };
    assert.equal((await outcomeOf(client.upload("/vouchers/v1/files", file))).mayHaveRun, true);
  });

  it("leaves a read unclassified: it writes nothing anyway", async () => {
    const client = clientAnswering(() => new Response("", { status: 500 }));
    assert.equal((await outcomeOf(client.request("/invoices/i1"))).mayHaveRun, undefined);
  });
});

describe("write helpers stopping before the request", () => {
  const never = clientAnswering(() => assert.fail("no request expected"));

  it("say they did not run — with the message and class as before", async () => {
    const sales = await outcomeOf(createSalesDocument(never, { kind: "quotation", contactId: "c1", items: [], shippingConditions: { shippingType: "delivery" } } as never));
    assert.equal(sales.mayHaveRun, false);
    assert.equal((sales.error as Error).constructor, Error);

    const voucher = await outcomeOf(
      createVoucher(never, { type: "purchaseinvoice", voucherStatus: "unchecked", taxType: "gross", voucherNumber: "R1", voucherDate: "2026-01-01", totalGrossAmount: 1, totalTaxAmount: 0, voucherItems: [] } as never),
    );
    assert.equal(voucher.mayHaveRun, false);
    assert.match(String(voucher.error), /^Error: Beleg ohne Kontakt/);
  });

  it("a contact changed since the card is not written: did not run", async () => {
    const client = clientAnswering((init) => (init.method === undefined || init.method === "GET" ? Response.json({ id: "c1", version: 8, roles: { customer: {} }, company: { name: "Beispiel GmbH" } }) : assert.fail("no PUT")));
    const { error, mayHaveRun } = await outcomeOf(updateCustomer(client, "c1", { note: "neu" }, { expectedVersion: 7 }));
    assert.equal(mayHaveRun, false);
    assert.match(String(error), /^Error: Abgebrochen: Der Kontakt wurde inzwischen/);
  });

  it("a contact that cannot be read before the PUT: did not run", async () => {
    const client = clientAnswering(() => new Response("", { status: 503 }));
    assert.equal((await outcomeOf(updateCustomer(client, "c1", { note: "neu" }))).mayHaveRun, false);
  });
});

describe("a payment reminder", () => {
  const target = { invoiceId: "inv", voucherNumber: "RE1", voucherDate: "2026-09-01", dueDate: "2026-09-01", currency: "EUR", to: "kunde@example.com", test: false };
  const render = defaultReminderMail({ name: "Max Muster" });

  it("did not go out when it failed before the mail call, or with MailNotSentError", async () => {
    const failingPdf = createLexwareClient({
      apiKey: "k",
      minSpacingMs: 0,
      fetch: (async (url: string | URL | Request) =>
        String(url).endsWith("/file")
          ? new Response("gone", { status: 500 })
          : Response.json({ content: [{ id: "inv", voucherNumber: "RE1", voucherDate: "2026-09-01", dueDate: "2026-09-01", openAmount: 10, currency: "EUR" }], last: true })) as typeof fetch,
    });
    const sendMail = async () => assert.fail("no mail expected");
    const early = await outcomeOf(sendReminder(failingPdf, reminderLedger(memoryStore(), "live"), target, { render, sendMail, owner: "r-1" }));
    assert.equal(early.mayHaveRun, false);

    const pdfClient = createLexwareClient({
      apiKey: "k",
      minSpacingMs: 0,
      fetch: (async (url: string | URL | Request) =>
        String(url).endsWith("/file")
          ? new Response(new Uint8Array([37, 80, 68, 70]), { headers: { "content-type": "application/pdf" } })
          : Response.json({ content: [{ id: "inv", voucherNumber: "RE1", voucherDate: "2026-09-01", dueDate: "2026-09-01", openAmount: 10, currency: "EUR" }], last: true })) as typeof fetch,
    });
    const refused = await outcomeOf(
      sendReminder(pdfClient, reminderLedger(memoryStore(), "live"), target, {
        render,
        sendMail: async () => {
          throw new MailNotSentError("Anmeldung abgelehnt");
        },
        owner: "r-2",
      }),
    );
    assert.equal(refused.mayHaveRun, false);

    const dropped = await outcomeOf(
      sendReminder(pdfClient, reminderLedger(memoryStore(), "live"), target, {
        render,
        sendMail: async () => {
          throw new Error("socket hang up");
        },
        owner: "r-3",
      }),
    );
    assert.equal(dropped.mayHaveRun, true);
  });
});

describe("markWriteOutcome and notRun", () => {
  it("keep the first outcome and leave non-objects alone", () => {
    const error = markWriteOutcome(markWriteOutcome(new Error("x"), false), true);
    assert.equal(writeMayHaveRun(error), false);
    assert.equal(Object.keys(error).includes("mayHaveRun"), false, "not enumerable: logs and JSON stay as before");
    assert.equal(markWriteOutcome("text", true), "text");
    assert.equal(writeMayHaveRun("text"), undefined);
    assert.equal(writeMayHaveRun(notRun("y")), false);
    assert.equal(String(notRun("y")), "Error: y");
  });
});

describe("links of a client the host implements itself", () => {
  it("get the document kind for every sales document", async () => {
    const real = clientAnswering((init) =>
      init.method === "POST" ? Response.json({ id: "d1" }, { status: 201 }) : Response.json({ id: "d1", voucherNumber: "AB1", lineItems: [], content: [{ id: "d1", voucherType: "orderconfirmation" }] }),
    );
    const kinds: Array<VoucherLinkKind | undefined> = [];
    // A wrapper as a host writes one: every method delegated, voucherUrl with both arguments.
    const wrapper: LexwareClient = {
      request: (path, init) => real.request(path, init),
      download: (path, init) => real.download(path, init),
      upload: (path, file, init) => real.upload(path, file, init),
      voucherUrl: (id, kind) => {
        kinds.push(kind);
        return real.voucherUrl(id, kind);
      },
    };
    const created = await createSalesDocument(wrapper, { kind: "order-confirmation", contactId: "c1", items: [] });
    const read = await getSalesDocument(wrapper, "invoice", "d1");
    await findRecentSalesDocuments(wrapper, { kind: "quotation" });
    assert.equal(created.url, "https://app.lexware.de/vouchers#!/VoucherView/Order/d1");
    assert.equal(read.url, "https://app.lexware.de/vouchers#!/VoucherView/Invoice/d1");
    assert.deepEqual(kinds.slice(0, 2), ["order-confirmation", "invoice"]);
    assert.ok(kinds.every((kind) => kind !== undefined), "no sales link without its kind");
  });
});
