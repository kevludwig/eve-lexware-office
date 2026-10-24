/**
 * The writes without eve (`./operations`): this file does not load the
 * harness, so the mount's runtime is NOT replaced — anything here that
 * reached for the mount's configuration or eve's session would fail.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createLexwareClient, memoryStore } from "@kevludwig/lexware-office";

const ops = await import("../dist/extension/lib/operations.mjs");

type Answer = (method: string, path: string, body: unknown) => unknown;

function api(answer: Answer) {
  const calls: { method: string; path: string }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const path = new URL(String(url)).pathname.replace(/^\/v1/, "");
    calls.push({ method, path });
    const result = answer(method, path, typeof init.body === "string" ? JSON.parse(init.body) : undefined);
    return result === undefined ? new Response("not found", { status: 404 }) : Response.json(result, { status: method === "POST" ? 201 : 200 });
  }) as typeof fetch;
  return { client: createLexwareClient({ apiKey: "test-key", fetch: fetchImpl, minSpacingMs: 0 }), calls };
}

const customer = { id: "c-1", organizationId: "org", version: 1, roles: { customer: { number: 10001 } }, company: { name: "Beispiel GmbH" }, addresses: {} };
const items = [{ name: "Beratung", quantity: 2, unit: "Stunde", net_price: 150, tax_rate: 19 }];

const account = (duplicates: unknown[] = []): Answer => (method, path) => {
  if (method === "GET" && path === "/contacts") return { content: [customer] };
  if (method === "GET" && path === "/voucherlist") return { content: duplicates };
  if (method === "GET" && path === "/payment-conditions") return [];
  if (method === "POST" && path === "/invoices") return { id: "inv-1" };
  if (method === "GET" && path === "/invoices/inv-1") return { id: "inv-1", voucherNumber: "RE-1001", lineItems: [] };
  return undefined;
};

describe("sales documents without eve", () => {
  it("checks, builds the card, and creates the approved draft once", async () => {
    const { client, calls } = api(account());
    const input = ops.invoiceInputSchema.parse({ customer_number: 10001, items, service_date: "2026-10-01" });

    const warnings = await ops.prepareSalesDocument(client, "invoice", input);
    assert.ok(warnings.some((warning: { kind: string }) => warning.kind === "customer-resolved"));
    const card = ops.buildCard("lexware__create_invoice", input, warnings);
    assert.equal(card?.tool, "create_invoice");
    assert.match(card?.subtitle ?? "", /300,00 EUR netto/);

    const journal = ops.journalIn(memoryStore());
    const approved = { id: "action-1", shownOnCard: () => false, notes: () => [] };
    const result = await ops.executeApprovedSalesDocument({ client, journal }, "invoice", input, approved);
    assert.equal(result.voucherNumber, "RE-1001");
    assert.equal(result.status, "Entwurf");

    const again = await ops.executeApprovedSalesDocument({ client, journal }, "invoice", input, approved);
    assert.match(String(again.note), /Wiederaufnahme/);
    assert.equal(calls.filter((call) => call.method === "POST").length, 1);
  });

  it("stops at a duplicate the card did not show, and goes ahead with one it did", async () => {
    const duplicate = { id: "inv-0", voucherType: "invoice", voucherNumber: "RE-0999", voucherDate: "2026-10-01T00:00:00.000+02:00", voucherStatus: "draft", contactId: "c-1", totalAmount: 357, openAmount: 357, currency: "EUR" };
    const { client } = api((method, path, body) => {
      if (method === "GET" && path === "/invoices/inv-0") return { id: "inv-0", voucherNumber: "RE-0999", lineItems: [{ name: "x", quantity: 1, unitPrice: { netAmount: 300, taxRatePercentage: 19 } }], totalPrice: { totalNetAmount: 300 } };
      return account([duplicate])(method, path, body);
    });
    const input = ops.invoiceInputSchema.parse({ customer_number: 10001, items, service_date: "2026-10-01" });
    const warnings = await ops.prepareSalesDocument(client, "invoice", input);
    const shown = ops.shownDuplicates(warnings);
    assert.equal(shown.length, 1);

    const journal = ops.journalIn(memoryStore());
    await assert.rejects(
      ops.executeApprovedSalesDocument({ client, journal }, "invoice", input, { id: "a-1", shownOnCard: () => false, notes: () => [] }),
      /Abgebrochen/,
    );
    const result = await ops.executeApprovedSalesDocument({ client, journal }, "invoice", input, {
      id: "a-2",
      shownOnCard: (url: string) => shown.includes(url),
      notes: () => [],
    });
    assert.equal(result.documentId, "inv-1");
  });
});

describe("customers without eve", () => {
  it("names similar contacts, and only an unseen one stops the write", async () => {
    let similar = [customer];
    const { client } = api((method, path) => {
      if (method === "GET" && path === "/contacts") return { content: similar };
      if (method === "POST" && path === "/contacts") return { id: "c-2" };
      if (method === "GET" && path === "/contacts/c-2") return { ...customer, id: "c-2", roles: { customer: { number: 10002 } } };
      return undefined;
    });
    const input = ops.customerInputSchema.parse({ company_name: "Beispiel GmbH", street: "Musterstraße 1", zip: "12345", city: "Musterstadt" });
    const prepared = await ops.prepareCustomer(client, input);
    assert.deepEqual(prepared.shownContactIds, ["c-1"]);
    assert.match(prepared.warnings[0]!.title, /Ähnliche Kontakte/);

    const journal = ops.journalIn(memoryStore());
    similar = [customer, { ...customer, id: "c-9", company: { name: "Beispiel GmbH & Co. KG" } }];
    await assert.rejects(
      ops.executeApprovedCustomer({ client, journal }, input, { id: "a-1", shownContactIds: new Set(prepared.shownContactIds) }),
      /Abgebrochen/,
    );
    similar = [customer];
    const created = await ops.executeApprovedCustomer({ client, journal }, input, { id: "a-2", shownContactIds: new Set(prepared.shownContactIds) });
    assert.equal(created.contactId, "c-2");
  });
});

describe("customer fields without eve", () => {
  it("sends a company with its contact person on vouchers", async () => {
    let body: Record<string, unknown> | undefined;
    const { client } = api((method, path, sent) => {
      if (method === "GET" && path === "/contacts") return { content: [] };
      if (method === "POST" && path === "/contacts") {
        body = sent as Record<string, unknown>;
        return { id: "c-3" };
      }
      if (method === "GET" && path === "/contacts/c-3") return { ...customer, id: "c-3", roles: { customer: { number: 10003 } } };
      return undefined;
    });
    const input = ops.customerInputSchema.parse({
      company_name: "Beispiel GmbH",
      vat_id: "DE123456789",
      contact_person: { first_name: "Erika", last_name: "Muster" },
      street: "Musterstraße 1",
      zip: "12345",
      city: "Musterstadt",
      email: "info@example.com",
      phone_mobile: "0151 0000000",
    });
    await ops.executeApprovedCustomer({ client, journal: ops.journalIn(memoryStore()) }, input, { id: "a-3", shownContactIds: [] });

    assert.deepEqual(body!.company, {
      name: "Beispiel GmbH",
      vatRegistrationId: "DE123456789",
      contactPersons: [{ firstName: "Erika", lastName: "Muster", primary: true }],
    });
    assert.deepEqual(body!.emailAddresses, { business: ["info@example.com"] });
    assert.deepEqual(body!.phoneNumbers, { mobile: ["0151 0000000"] });
  });

  it("refuses person fields on a company and company fields on a person", () => {
    const address = { street: "Musterstraße 1", zip: "12345", city: "Musterstadt" };
    assert.equal(ops.customerInputSchema.safeParse({ company_name: "Beispiel GmbH", first_name: "Erika", ...address }).success, false);
    assert.equal(ops.customerInputSchema.safeParse({ last_name: "Muster", vat_id: "DE123456789", ...address }).success, false);
    assert.equal(ops.customerInputSchema.safeParse({ last_name: "Muster", salutation: "Frau", ...address }).success, true);
  });
});

describe("customer changes without eve", () => {
  const stored = {
    ...customer,
    version: 7,
    addresses: { billing: [{ street: "Musterstraße 1", zip: "12345", city: "Musterstadt", countryCode: "DE" }] },
  };

  it("shows each changed field and writes with the version the card showed", async () => {
    let version = 7;
    let put: Record<string, unknown> | undefined;
    const { client } = api((method, path, sent) => {
      if (method === "GET" && path === "/contacts") return { content: [stored] };
      if (method === "GET" && path === "/contacts/c-1") return { ...stored, version };
      if (method === "PUT" && path === "/contacts/c-1") {
        put = sent as Record<string, unknown>;
        version = 8;
        return { id: "c-1", version: 8 };
      }
      return undefined;
    });
    const input = ops.customerUpdateInputSchema.parse({ customer_number: 10001, contact_person: { first_name: "Erika", last_name: "Muster" }, vat_id: "DE123456789" });
    const prepared = await ops.prepareCustomerUpdate(client, input);

    assert.deepEqual(prepared.binding, { contactId: "c-1", version: 7 });
    assert.deepEqual(prepared.warnings[0], { kind: "customer-resolved", name: "Beispiel GmbH", number: 10001 });
    assert.deepEqual(
      prepared.warnings.slice(1).map((warning: { label: string; before: string; after: string }) => `${warning.label}: ${warning.before} → ${warning.after}`),
      ["USt-IdNr.:  → DE123456789", "Ansprechpartner: Vorname:  → Erika", "Ansprechpartner: Nachname:  → Muster", "Ansprechpartner auf Belegen:  → ja"],
    );

    const result = await ops.executeApprovedCustomerUpdate({ client, journal: ops.journalIn(memoryStore()) }, input, { id: "u-1", ...prepared.binding! });
    assert.equal(put!.version, 7);
    assert.deepEqual((put!.company as { contactPersons: unknown }).contactPersons, [{ firstName: "Erika", lastName: "Muster", primary: true }]);
    assert.equal(result.customerNumber, 10001);
  });

  it("stops when the contact was edited after the card", async () => {
    const { client, calls } = api((method, path) => (method === "GET" && path === "/contacts/c-1" ? { ...stored, version: 9 } : undefined));
    const input = ops.customerUpdateInputSchema.parse({ contact_id: "00000000-0000-4000-8000-000000000001", note: "Neu" });
    await assert.rejects(
      ops.executeApprovedCustomerUpdate({ client, journal: ops.journalIn(memoryStore()) }, input, { id: "u-2", contactId: "c-1", version: 7 }),
      /^Error: Abgebrochen/,
    );
    assert.equal(calls.filter((call) => call.method === "PUT").length, 0);
  });

  it("refuses when nothing changes or the contact cannot be found", async () => {
    const { client } = api((method, path) => {
      if (method === "GET" && path === "/contacts") return { content: [] };
      if (method === "GET" && path === "/contacts/c-1") return stored;
      return undefined;
    });
    const unknown = await ops.prepareCustomerUpdate(client, ops.customerUpdateInputSchema.parse({ customer_number: 99999, note: "x" }));
    assert.match(unknown.refusal!, /99999/);
    assert.equal(ops.customerUpdateInputSchema.safeParse({ customer_number: 10001 }).success, false);
  });
});
