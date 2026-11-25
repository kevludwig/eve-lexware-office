/**
 * An approved write through `./operations` says whether it may have run —
 * `mayHaveRun` on the error, read with writeMayHaveRun — and what to do after
 * „Nichts angelegt;" is neutral or the host's own. The messages otherwise stay.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createLexwareClient, memoryStore } from "@kevludwig/lexware-office";

const ops = await import("../dist/extension/lib/operations.mjs");

type Call = { method: string; path: string };

/** A fake API: an answer that is a Response goes out as it is, undefined is a 404, anything else JSON. */
function api(answer: (call: Call) => unknown) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const call = { method: init.method ?? "GET", path: new URL(String(url)).pathname.replace(/^\/v1/, "") };
    calls.push(call);
    const result = await answer(call);
    if (result instanceof Response) return result;
    return result === undefined ? new Response("not found", { status: 404 }) : Response.json(result, { status: call.method === "POST" ? 201 : 200 });
  }) as typeof fetch;
  return { client: createLexwareClient({ apiKey: "test-key", fetch: fetchImpl, minSpacingMs: 0, rateLimitBackoffMs: 0 }), calls };
}

const C1 = "00000000-0000-4000-8000-0000000000c1";
const customer = { id: C1, version: 1, roles: { customer: { number: 10001 } }, company: { name: "Beispiel Handel GmbH" }, addresses: { billing: [{ countryCode: "DE" }] } };
const items = [{ name: "Schraube M6", quantity: 100, unit: "Stück", net_price: 0.12, tax_rate: 19 }];

/** One customer, no documents yet; `post` answers the order confirmation's POST. */
const account =
  (options: { post?: () => unknown; voucherlist?: () => unknown; documents?: unknown[] } = {}) =>
  (call: Call): unknown => {
    if (call.method === "GET" && call.path === "/contacts") return { content: [customer] };
    if (call.method === "GET" && call.path === `/contacts/${C1}`) return customer;
    if (call.method === "GET" && call.path === "/voucherlist") return options.voucherlist?.() ?? { content: options.documents ?? [] };
    if (call.method === "POST" && call.path === "/order-confirmations") return options.post?.() ?? { id: "doc-1" };
    if (call.method === "GET" && call.path === "/order-confirmations/doc-1") return { id: "doc-1", voucherNumber: "AB0001", lineItems: [] };
    return undefined;
  };

const approval = (id: string) => ({ id, shownOnCard: () => false, notes: () => [], warnings: [] });
const input = () => ops.orderConfirmationInputSchema.parse({ customer_number: 10001, items });
const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => assert.fail("expected a rejection"),
    (error: Error) => error,
  );

describe("an approved sales document", () => {
  it("that stops before the POST did not run — with the neutral hint by default", async () => {
    const { client, calls } = api(account({ voucherlist: () => new Response("", { status: 403 }) }));
    const error = await rejection(ops.executeApprovedSalesDocument({ client, journal: ops.journalIn(memoryStore()) }, "order-confirmation", input(), approval("a-1")));
    assert.equal(ops.writeMayHaveRun(error), false);
    assert.match(error.message, /^Auftragsbestätigung nicht angelegt: Die Dublettenprüfung ist fehlgeschlagen — .* Nichts angelegt; später erneut versuchen\.$/);
    assert.equal(String(error).startsWith("Error: "), true, "a plain Error as before");
    assert.equal(calls.filter((call) => call.method === "POST").length, 0);
  });

  it("takes the host's own hint", async () => {
    const { client } = api(account({ voucherlist: () => new Response("", { status: 403 }) }));
    const error = await rejection(
      ops.executeApprovedSalesDocument({ client, journal: ops.journalIn(memoryStore()), retryHint: "den Vorgang neu anlegen" }, "order-confirmation", input(), approval("a-2")),
    );
    assert.match(error.message, /Nichts angelegt; den Vorgang neu anlegen\.$/);
    assert.equal(ops.DEFAULT_RETRY_HINT, "später erneut versuchen");
  });

  it("stopped by a duplicate the card did not show: did not run", async () => {
    const old = { id: "old", voucherNumber: "AB0000", introduction: "Ihre Bestellung Nr. B-4711", lineItems: [] };
    const answer = account({ documents: [{ id: "old", voucherNumber: "AB0000" }] });
    const { client, calls } = api((call) => (call.method === "GET" && call.path === "/order-confirmations/old" ? old : answer(call)));
    const ordered = ops.orderConfirmationInputSchema.parse({ customer_number: 10001, customer_order_number: "B-4711", items });
    const error = await rejection(ops.executeApprovedSalesDocument({ client, journal: ops.journalIn(memoryStore()) }, "order-confirmation", ordered, approval("a-3")));
    assert.match(String(error), /^Error: Abgebrochen: Inzwischen gibt es bereits eine Auftragsbestätigung zur Bestellung Nr\. B-4711/);
    assert.equal(ops.writeMayHaveRun(error), false);
    assert.equal(calls.filter((call) => call.method === "POST").length, 0);
  });

  it("refused by the API (406): did not run, the message as before", async () => {
    const { client } = api(account({ post: () => new Response('{"message":"invalid"}', { status: 406 }) }));
    const error = await rejection(ops.executeApprovedSalesDocument({ client, journal: ops.journalIn(memoryStore()) }, "order-confirmation", input(), approval("a-4")));
    assert.equal(ops.writeMayHaveRun(error), false);
    assert.match(String(error), /^Error: Auftragsbestätigung nicht angelegt: Lexware API 406/);
  });

  it("whose POST failed with a 5xx or a dropped connection may have run", async () => {
    for (const post of [() => new Response("", { status: 502 }), () => Promise.reject(new TypeError("fetch failed"))]) {
      const { client } = api(account({ post: () => post() }));
      const error = await rejection(ops.executeApprovedSalesDocument({ client, journal: ops.journalIn(memoryStore()) }, "order-confirmation", input(), approval("a-5")));
      assert.equal(ops.writeMayHaveRun(error), true);
      assert.match(error.message, /^Auftragsbestätigung nicht angelegt: /);
    }
  });

  it("that fails after the POST went through ran", async () => {
    const { client } = api(account());
    const store = ops.journalIn(memoryStore());
    const journal = {
      read: store.read,
      write: async (kind: string, id: string, entry: { status: string }) => {
        if (entry.status === "created") throw new Error("database unavailable");
        return store.write(kind, id, entry);
      },
    };
    const error = await rejection(ops.executeApprovedSalesDocument({ client, journal }, "order-confirmation", input(), approval("a-6")));
    assert.equal(error.message, "database unavailable");
    assert.equal(ops.writeMayHaveRun(error), true);
  });
});

describe("an approved customer", () => {
  const customerInput = () => ops.customerInputSchema.parse({ company_name: "Beispiel Handel GmbH", street: "Musterstraße 1", zip: "10115", city: "Berlin" });

  it("whose similarity search fails did not run — neutral hint, or the host's", async () => {
    const { client } = api(() => new Response("", { status: 403 }));
    const neutral = await rejection(ops.executeApprovedCustomer({ client, journal: ops.journalIn(memoryStore()) }, customerInput(), { id: "k-1", shownContactIds: [] }));
    assert.equal(ops.writeMayHaveRun(neutral), false);
    assert.match(neutral.message, /^Kunde nicht angelegt: Die Suche nach ähnlichen Kontakten ist fehlgeschlagen — .* Nichts angelegt; später erneut versuchen\.$/);

    const own = await rejection(ops.executeApprovedCustomer({ client, journal: ops.journalIn(memoryStore()), retryHint: "neu einreichen" }, customerInput(), { id: "k-2", shownContactIds: [] }));
    assert.match(own.message, /Nichts angelegt; neu einreichen\.$/);
  });

  it("whose POST timed out may have run", async () => {
    const { client } = api((call) => (call.method === "GET" ? { content: [] } : new Response("", { status: 504 })));
    const error = await rejection(ops.executeApprovedCustomer({ client, journal: ops.journalIn(memoryStore()) }, customerInput(), { id: "k-3", shownContactIds: [] }));
    assert.equal(ops.writeMayHaveRun(error), true);
    assert.match(String(error), /^Error: Kunde nicht angelegt: Lexware API 504/);
  });
});

describe("an approved customer change", () => {
  const changeInput = () => ops.customerUpdateInputSchema.parse({ contact_id: C1, note: "Neu" });

  it("stopped because the contact changed since the card did not run", async () => {
    const { client } = api((call) => (call.method === "GET" ? { ...customer, version: 9 } : undefined));
    const error = await rejection(ops.executeApprovedCustomerUpdate({ client, journal: ops.journalIn(memoryStore()) }, changeInput(), { id: "u-1", contactId: C1, version: 7 }));
    assert.match(String(error), /^Error: Abgebrochen: Der Kontakt wurde inzwischen/);
    assert.equal(ops.writeMayHaveRun(error), false);
  });

  it("whose PUT failed with a 5xx may have run", async () => {
    const { client } = api((call) => (call.method === "GET" ? customer : new Response("", { status: 500 })));
    const error = await rejection(ops.executeApprovedCustomerUpdate({ client, journal: ops.journalIn(memoryStore()) }, changeInput(), { id: "u-2", contactId: C1, version: 1 }));
    assert.match(String(error), /^Error: Kunde nicht geändert: Lexware API 500/);
    assert.equal(ops.writeMayHaveRun(error), true);
  });
});
