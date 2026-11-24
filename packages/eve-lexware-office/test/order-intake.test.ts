/**
 * An order from a mail or PDF through `./operations`, as an MCP server runs
 * it: drafts only, the customer's order number, a delivery address, articles
 * read once, the VAT ID's form, the caller's own checks — and a duplicate
 * search that fails stops the write. No harness: nothing here may need eve.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createLexwareClient, memoryStore } from "@kevludwig/lexware-office";

const ops = await import("../dist/extension/lib/operations.mjs");

type Call = { method: string; path: string; query: URLSearchParams; body: unknown };
type Answer = (call: Call) => unknown;

/** A fake API: an answer that is a Response goes out as it is, undefined is a 404, anything else JSON. */
function api(answer: Answer) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const parsed = new URL(String(url));
    const call = {
      method: init.method ?? "GET",
      path: parsed.pathname.replace(/^\/v1/, ""),
      query: parsed.searchParams,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const result = answer(call);
    if (result instanceof Response) return result;
    return result === undefined ? new Response("not found", { status: 404 }) : Response.json(result, { status: call.method === "POST" ? 201 : 200 });
  }) as typeof fetch;
  return { client: createLexwareClient({ apiKey: "test-key", fetch: fetchImpl, minSpacingMs: 0, rateLimitBackoffMs: 1 }), calls };
}

const C1 = "00000000-0000-4000-8000-0000000000c1";
const A1 = "00000000-0000-4000-8000-0000000000a1";
const customer = (extra: Record<string, unknown> = {}) => ({
  id: C1,
  organizationId: "org",
  version: 1,
  roles: { customer: { number: 10001 } },
  company: { name: "Großhandel GmbH" },
  addresses: { billing: [{ street: "Hauptstraße 1", zip: "10115", city: "Berlin", countryCode: "DE" }] },
  ...extra,
});
const items = [{ name: "Schraube M6", quantity: 100, unit: "Stück", net_price: 0.12, tax_rate: 19 }];
const posts = (calls: Call[]) => calls.filter((call) => call.method === "POST");

/** An account with one customer, optional documents in the voucher list, and order confirmations that can be created. */
function account(options: { documents?: Record<string, Record<string, unknown>>; contact?: Record<string, unknown>; extra?: Answer } = {}) {
  const documents = options.documents ?? {};
  let next = 1;
  return (call: Call): unknown => {
    const extra = options.extra?.(call);
    if (extra !== undefined) return extra;
    if (call.method === "GET" && call.path === "/contacts") return { content: [customer(options.contact)] };
    if (call.method === "GET" && call.path === `/contacts/${C1}`) return customer(options.contact);
    if (call.method === "GET" && call.path === "/voucherlist") return { content: Object.keys(documents).map((id) => ({ id, voucherNumber: documents[id]!.voucherNumber })) };
    if (call.method === "GET" && call.path === "/payment-conditions") return [];
    if (call.method === "GET" && call.path === "/countries") return [
      { countryCode: "DE", countryNameDE: "Deutschland", taxClassification: "de" },
      { countryCode: "AT", countryNameDE: "Österreich", taxClassification: "intraCommunity" },
      { countryCode: "CH", countryNameDE: "Schweiz", taxClassification: "thirdPartyCountry" },
    ];
    const kindPath = /^\/(order-confirmations|invoices|quotations)$/.exec(call.path);
    if (call.method === "POST" && kindPath) {
      const id = `doc-${next++}`;
      documents[id] = { id, ...(call.body as Record<string, unknown>) };
      return { id };
    }
    const detail = /^\/(?:order-confirmations|invoices|quotations)\/(.+)$/.exec(call.path);
    if (call.method === "GET" && detail) return documents[detail[1]!] ?? undefined;
    return undefined;
  };
}

const approval = (id: string, warnings: unknown[] = []) => ({
  id,
  shownOnCard: (url: string) => ops.shownDuplicates(warnings).includes(url),
  notes: () => [],
  warnings,
});

describe("1 — a duplicate search that fails stops the write", () => {
  for (const [what, failure] of [
    ["403", () => new Response('{"message":"forbidden"}', { status: 403 })],
    ["429", () => new Response("", { status: 429 })],
    ["500 rate limit exceeded", () => new Response('{"message":"Rate limit exceeded"}', { status: 500 })],
  ] as const) {
    it(`on ${what}: no POST, no journal, the reason in the error`, async () => {
      const { client, calls } = api(account({ extra: (call) => (call.path === "/voucherlist" ? failure() : undefined) }));
      const journal = ops.journalIn(memoryStore());
      const input = ops.orderConfirmationInputSchema.parse({ customer_number: 10001, items });
      await assert.rejects(ops.executeApprovedSalesDocument({ client, journal }, "order-confirmation", input, approval("a-1")), (error: Error) => {
        assert.match(error.message, /^Auftragsbestätigung nicht angelegt: Die Dublettenprüfung ist fehlgeschlagen/);
        assert.match(error.message, what === "403" ? /403.*fehlt das Recht/ : /Rate-Limit/);
        assert.match(error.message, /Nichts angelegt/);
        return true;
      });
      assert.equal(posts(calls).length, 0);
      assert.equal(await journal.read("order-confirmation", "a-1"), null);
    });
  }

  it("also when the second search for similar customers fails", async () => {
    const { client, calls } = api((call) => (call.method === "GET" && call.path === "/contacts" ? new Response("", { status: 429 }) : undefined));
    const input = ops.customerInputSchema.parse({ company_name: "Großhandel GmbH", street: "Hauptstraße 1", zip: "10115", city: "Berlin" });
    await assert.rejects(
      ops.executeApprovedCustomer({ client, journal: ops.journalIn(memoryStore()) }, input, { id: "k-1", shownContactIds: [] }),
      /^Error: Kunde nicht angelegt: Die Suche nach ähnlichen Kontakten ist fehlgeschlagen/,
    );
    assert.equal(posts(calls).length, 0);
  });
});

describe("2 — drafts only", () => {
  it("never finalizes, whatever the input says, and the card says „Entwurf“", async () => {
    const { client, calls } = api(account());
    const input = ops.orderConfirmationInputSchema.parse({ customer_number: 10001, items, draft: false });

    const warnings = await ops.prepareSalesDocument(client, "order-confirmation", input, { draftOnly: true });
    assert.ok(warnings.some((warning: { kind: string; title?: string }) => warning.kind === "note" && warning.title === "Entwurf"));
    const card = ops.buildCard("create_order_confirmation", input, warnings, { draftOnly: true });
    assert.equal(card?.title, "Auftragsbestätigung als Entwurf anlegen?");
    assert.match(card?.subtitle ?? "", /Entwurf/);

    const result = await ops.executeApprovedSalesDocument({ client, journal: ops.journalIn(memoryStore()), draftOnly: true }, "order-confirmation", input, approval("d-1", warnings));
    assert.equal(result.status, "Entwurf");
    assert.equal(posts(calls)[0]!.query.get("finalize"), null);

    const fresh = api(account());
    const quotation = ops.quotationInputSchema.parse({ customer_number: 10001, items });
    await ops.executeApprovedSalesDocument({ client: fresh.client, journal: ops.journalIn(memoryStore()), draftOnly: true }, "quotation", quotation, approval("d-2"));
    assert.equal(posts(fresh.calls)[0]!.query.get("finalize"), null);
  });

  it("leaves the default alone without the option: an order confirmation is finalized", async () => {
    const { client, calls } = api(account());
    const input = ops.orderConfirmationInputSchema.parse({ customer_number: 10001, items });
    assert.equal(ops.buildCard("create_order_confirmation", input, [])?.title, "Auftragsbestätigung anlegen?");
    await ops.executeApprovedSalesDocument({ client, journal: ops.journalIn(memoryStore()) }, "order-confirmation", input, approval("d-3"));
    assert.equal(posts(calls)[0]!.query.get("finalize"), "true");
  });
});

describe("3 — the customer's order number", () => {
  it("is the first line of the introduction, in the document's language, and only on order confirmations and invoices", () => {
    const de = ops.orderConfirmationInputSchema.parse({ customer_number: 10001, items, customer_order_number: " 4711-A ", introduction: "Vielen Dank für Ihren Auftrag." });
    assert.equal(ops.introductionOf(de), "Ihre Bestellung Nr. 4711-A\n\nVielen Dank für Ihren Auftrag.");
    const en = ops.invoiceInputSchema.parse({ customer_number: 10001, items, customer_order_number: "PO-99", language: "en" });
    assert.equal(ops.introductionOf(en), "Your order no. PO-99");
    assert.equal(ops.quotationInputSchema.safeParse({ customer_number: 10001, items, customer_order_number: "1" }).success, false);
    assert.equal(ops.orderConfirmationInputSchema.safeParse({ customer_number: 10001, items, customer_order_number: "1\n2" }).success, false);

    const long = ops.orderConfirmationInputSchema.safeParse({ customer_number: 10001, items, customer_order_number: "4711", introduction: "x".repeat(1990) });
    assert.equal(long.success, false);
    assert.match(JSON.stringify(long.error?.issues), /Einleitung mit Bestellnummer und Lieferadresse ergibt 2016 Zeichen/);

    const card = ops.buildCard("create_order_confirmation", ops.orderConfirmationInputSchema.parse({ customer_number: 10001, items, customer_order_number: "4711" }), []);
    assert.ok(card?.facts.some((fact: { title: string; value: string }) => fact.title === "Bestellnummer" && fact.value === "4711"));
    assert.ok(card?.facts.some((fact: { title: string; value: string }) => fact.title === "Einleitung" && /ersetzt den Standardtext/.test(fact.value)));
  });

  it("finds an order confirmation of the same contact with the same number, whatever its total", async () => {
    const documents = { "ab-1": { id: "ab-1", voucherNumber: "AB-0001", introduction: "Ihre Bestellung Nr. 4711", lineItems: [{ name: "x", quantity: 1, unitPrice: { netAmount: 999 } }] } };
    const { client } = api(account({ documents }));
    const input = ops.orderConfirmationInputSchema.parse({ customer_number: 10001, items, customer_order_number: "4711" });
    const warnings = await ops.prepareSalesDocument(client, "order-confirmation", input);
    const duplicate = warnings.find((warning: { kind: string }) => warning.kind === "sales-duplicate");
    assert.equal(duplicate?.orderNumber, "4711");
    assert.match(ops.describeWarning(duplicate).value, /zur Bestellung Nr\. 4711 existiert bereits \(AB-0001/);
  });

  it("creates one order confirmation per contact and order, also when a run timed out and another approval follows", async () => {
    // The first run: Lexware creates the document, but the answer is lost (a gateway timeout after the write).
    const store = memoryStore();
    const shared: Record<string, Record<string, unknown>> = {};
    const journal = ops.journalIn(store);
    const input = ops.orderConfirmationInputSchema.parse({ customer_number: 10001, items, customer_order_number: "4711" });
    const first = api((call) => {
      const answer = account({ documents: shared })(call);
      return call.method === "POST" ? new Response("gateway timeout", { status: 504 }) : answer;
    });
    await assert.rejects(ops.executeApprovedSalesDocument({ client: first.client, journal }, "order-confirmation", input, approval("run-1")), /nicht angelegt/);
    assert.equal(Object.keys(shared).length, 1, "the fake created the document before failing");
    assert.equal((await journal.read("order-confirmation", ops.orderJournalId(C1, "4711")))?.status, "pending");

    const second = api(account({ documents: shared }));
    const result = await ops.executeApprovedSalesDocument({ client: second.client, journal }, "order-confirmation", input, approval("run-2"));
    assert.match(String(result.note), /Wiederaufnahme: Auftragsbestätigung zur Bestellung Nr\. 4711/);
    assert.equal(posts(second.calls).length, 0);

    const third = await ops.executeApprovedSalesDocument({ client: second.client, journal }, "order-confirmation", input, approval("run-3"));
    assert.equal(third.documentId, result.documentId);
    assert.equal(posts(second.calls).length, 0);
  });

  it("creates again when the journaled draft was deleted in Lexware Office", async () => {
    const documents: Record<string, Record<string, unknown>> = {};
    const journal = ops.journalIn(memoryStore());
    const input = ops.orderConfirmationInputSchema.parse({ customer_number: 10001, items, customer_order_number: "4711", draft: true });
    const { client, calls } = api(account({ documents }));
    const created = await ops.executeApprovedSalesDocument({ client, journal }, "order-confirmation", input, approval("x-1"));
    delete documents[String(created.documentId)];
    const again = await ops.executeApprovedSalesDocument({ client, journal }, "order-confirmation", input, approval("x-2"));
    assert.notEqual(again.documentId, created.documentId);
    assert.equal(posts(calls).length, 2);
    assert.equal(again.customerOrderNumber, "4711");
  });
});

describe("4 — articles", () => {
  const article = { id: A1, title: "Schraube M6", type: "PRODUCT", articleNumber: "SCH-6", price: { netPrice: 0.14, grossPrice: 0.17, taxRate: 19 } };
  const withArticle = [{ ...items[0]!, article_id: A1, discount_percent: 5 }];

  it("are read once, before the card; a line priced off its article is a finding", async () => {
    const { client, calls } = api(account({ extra: (call) => (call.path === `/articles/${A1}` ? article : undefined) }));
    const input = ops.orderConfirmationInputSchema.parse({ customer_number: 10001, items: withArticle });
    const warnings = await ops.prepareSalesDocument(client, "order-confirmation", input);
    assert.deepEqual(
      warnings.filter((warning: { kind: string }) => warning.kind.startsWith("article")).map((warning: unknown) => ops.describeWarning(warning)),
      [
        { title: "Artikel", value: "Schraube M6 (SCH-6) — Produkt" },
        { title: "⚠ Artikelpreis", value: "„Schraube M6“: 0,12 EUR statt 0,14 EUR laut Artikel „Schraube M6“ — Lexware übernimmt den Positionspreis" },
      ],
    );

    await ops.executeApprovedSalesDocument({ client, journal: ops.journalIn(memoryStore()) }, "order-confirmation", input, approval("art-1", warnings));
    assert.equal(calls.filter((call) => call.path === `/articles/${A1}`).length, 1);
    const line = (posts(calls)[0]!.body as { lineItems: Record<string, unknown>[] }).lineItems[0]!;
    assert.deepEqual([line.id, line.type, (line.unitPrice as { netAmount: number }).netAmount, line.discountPercentage], [A1, "material", 0.12, 5]);
  });

  it("are read by the write when the caller kept no findings", async () => {
    const { client, calls } = api(account({ extra: (call) => (call.path === `/articles/${A1}` ? article : undefined) }));
    const input = ops.orderConfirmationInputSchema.parse({ customer_number: 10001, items: withArticle });
    await ops.executeApprovedSalesDocument({ client, journal: ops.journalIn(memoryStore()) }, "order-confirmation", input, { id: "art-2", shownOnCard: () => false, notes: () => [] });
    assert.equal(calls.filter((call) => call.path === `/articles/${A1}`).length, 1);
  });

  it("raise no finding at the article's own price", async () => {
    const { client } = api(account({ extra: (call) => (call.path === `/articles/${A1}` ? article : undefined) }));
    const input = ops.orderConfirmationInputSchema.parse({ customer_number: 10001, items: [{ ...withArticle[0]!, net_price: 0.14 }] });
    const warnings = await ops.prepareSalesDocument(client, "order-confirmation", input);
    assert.equal(warnings.some((warning: { kind: string }) => warning.kind === "article-price-deviation"), false);
  });
});

describe("6 — a delivery address other than the billing one", () => {
  it("goes into the introduction as a fixed line, after the order number, and onto the card", async () => {
    const { client, calls } = api(account());
    const input = ops.orderConfirmationInputSchema.parse({
      customer_number: 10001,
      items,
      customer_order_number: "4711",
      delivery_address: { name: "Großhandel GmbH Filiale Nord", street: "Hafenweg 2", zip: "20457", city: "Hamburg", country_code: "de" },
      introduction: "Vielen Dank.",
    });
    await ops.executeApprovedSalesDocument({ client, journal: ops.journalIn(memoryStore()) }, "order-confirmation", input, approval("del-1"));
    const body = posts(calls)[0]!.body as Record<string, unknown>;
    assert.equal(body.introduction, "Ihre Bestellung Nr. 4711\nLieferadresse: Großhandel GmbH Filiale Nord, Hafenweg 2, 20457 Hamburg\n\nVielen Dank.");
    assert.deepEqual(body.address, { contactId: C1 });
    const card = ops.buildCard("create_order_confirmation", input, []);
    assert.ok(card?.facts.some((fact: { title: string; value: string }) => fact.title === "Lieferadresse" && fact.value === "Großhandel GmbH Filiale Nord, Hafenweg 2, 20457 Hamburg"));
    assert.equal(
      ops.deliveryAddressLine({ street: "Ring 1", zip: "1010", city: "Wien", country_code: "AT" }, "en"),
      "Delivery address: Ring 1, 1010 Wien, AT",
    );
  });
});

describe("7 — VAT ID and the caller's own checks", () => {
  const eu = (extra: Record<string, unknown>) =>
    ops.orderConfirmationInputSchema.parse({ customer_number: 10001, items: [{ ...items[0]!, tax_rate: 0 }], tax_type: "intraCommunitySupply", ...extra });
  const taxNotes = (warnings: { kind: string; title?: string; value?: string }[]) =>
    warnings.filter((warning) => warning.title === "⚠ Steuerart").map((warning) => warning.value);

  it("checks the VAT ID's form and that it is not German", async () => {
    const bad = api(account({ contact: { company: { name: "Wiener Handel GmbH", vatRegistrationId: "ATU1234567" }, addresses: { billing: [{ countryCode: "AT" }] } } }));
    assert.deepEqual(taxNotes(await ops.prepareSalesDocument(bad.client, "order-confirmation", eu({}))), [
      "Innergemeinschaftliche Lieferung: USt-IdNr. „ATU1234567“ hat nicht die Form einer USt-IdNr. aus AT — nur die Form geprüft, nicht bei VIES",
    ]);
    const german = api(account({ contact: { company: { name: "Großhandel GmbH", vatRegistrationId: "DE123456789" }, addresses: { billing: [{ countryCode: "AT" }] } } }));
    assert.match(taxNotes(await ops.prepareSalesDocument(german.client, "order-confirmation", eu({}))).join(), /ist deutsch/);
    const fine = api(account({ contact: { company: { name: "Wiener Handel GmbH", vatRegistrationId: "ATU12345678" }, addresses: { billing: [{ countryCode: "AT" }] } } }));
    assert.deepEqual(taxNotes(await ops.prepareSalesDocument(fine.client, "order-confirmation", eu({}))), []);
  });

  it("checks the delivery country when one is named, else the billing country", async () => {
    const contact = { company: { name: "Großhandel GmbH", vatRegistrationId: "ATU12345678" }, addresses: { billing: [{ countryCode: "DE" }] } };
    const { client } = api(account({ contact }));
    const toVienna = eu({ delivery_address: { street: "Ring 1", zip: "1010", city: "Wien", country_code: "AT" } });
    assert.deepEqual(taxNotes(await ops.prepareSalesDocument(client, "order-confirmation", toVienna)), []);
    const toZurich = eu({ delivery_address: { street: "Bahnhofstrasse 1", zip: "8001", city: "Zürich", country_code: "CH" } });
    assert.deepEqual(taxNotes(await ops.prepareSalesDocument(client, "order-confirmation", toZurich)), [
      "Innergemeinschaftliche Lieferung: Lieferadresse in Schweiz — passt nicht (EU-Ausland erwartet)",
    ]);
    assert.deepEqual(taxNotes(await ops.prepareSalesDocument(client, "order-confirmation", eu({}))), [
      "Innergemeinschaftliche Lieferung: Rechnungsadresse in Deutschland — passt nicht (EU-Ausland erwartet)",
    ]);
  });

  it("adds the caller's findings after the package's, with the tool and input, and survives a failing check", async () => {
    const { client } = api(account());
    const input = ops.orderConfirmationInputSchema.parse({ customer_number: 10001, items });
    const seen: { tool: string; input: unknown }[] = [];
    const vies = { kind: "note", title: "⚠ VIES", value: "USt-IdNr. nicht gültig" };
    const warnings = await ops.prepareSalesDocument(client, "order-confirmation", input, {
      checks: (call: { tool: string; input: unknown }) => {
        seen.push(call);
        return [vies];
      },
    });
    assert.deepEqual(warnings.at(-1), vies);
    assert.equal(seen[0]!.tool, "create_order_confirmation");
    assert.equal(seen[0]!.input, input);

    const failed = await ops.prepareSalesDocument(client, "order-confirmation", input, {
      checks: () => {
        throw new Error("VIES down");
      },
    });
    assert.deepEqual(failed.at(-1), ops.HOST_CHECK_FAILED);

    const old = await ops.prepareSalesDocument(client, "order-confirmation", input, new AbortController().signal);
    assert.ok(old.some((warning: { kind: string }) => warning.kind === "customer-resolved"));
  });
});

describe("live findings of 2026-11-24 — what Lexware Office prints", () => {
  const notes = (warnings: { kind: string; title?: string; value?: string }[], title: string) =>
    warnings.filter((warning) => warning.title === title).map((warning) => warning.value);
  const withShipping = {
    addresses: {
      billing: [{ street: "Teststraße 1", zip: "10115", city: "Berlin", countryCode: "DE" }],
      shipping: [{ supplement: "Lager", street: "Hafenweg 2", zip: "20457", city: "Hamburg", countryCode: "DE" }],
    },
  };

  it("names the contact's delivery address, which Lexware does not print, unless one is given", async () => {
    const { client } = api(account({ contact: withShipping }));
    const without = await ops.prepareSalesDocument(client, "order-confirmation", ops.orderConfirmationInputSchema.parse({ customer_number: 10001, items }));
    assert.deepEqual(notes(without, "⚠ Lieferadresse"), [
      "der Kontakt hat eine Lieferadresse (Lager, Hafenweg 2, 20457 Hamburg) — Lexware Office druckt sie nicht auf AB oder Rechnung. Geht die Ware dorthin, als delivery_address angeben",
    ]);
    const given = ops.orderConfirmationInputSchema.parse({ customer_number: 10001, items, delivery_address: { street: "Hafenweg 2", zip: "20457", city: "Hamburg" } });
    assert.deepEqual(notes(await ops.prepareSalesDocument(client, "order-confirmation", given), "⚠ Lieferadresse"), []);
    const quotation = ops.quotationInputSchema.parse({ customer_number: 10001, items });
    assert.deepEqual(notes(await ops.prepareSalesDocument(client, "quotation", quotation), "⚠ Lieferadresse"), []);
  });

  it("warns that the default payment term stays German on an English document, and writes an own term in English", async () => {
    const { client, calls } = api(account());
    const english = ops.orderConfirmationInputSchema.parse({ customer_number: 10001, items, language: "en" });
    assert.match(notes(await ops.prepareSalesDocument(client, "order-confirmation", english), "⚠ Zahlungsziel auf Deutsch").join(), /payment_term_days angeben/);

    const withTerm = ops.orderConfirmationInputSchema.parse({ customer_number: 10001, items, language: "en", payment_term_days: 14 });
    assert.deepEqual(notes(await ops.prepareSalesDocument(client, "order-confirmation", withTerm), "⚠ Zahlungsziel auf Deutsch"), []);
    await ops.executeApprovedSalesDocument({ client, journal: ops.journalIn(memoryStore()), draftOnly: true }, "order-confirmation", withTerm, approval("en-1"));
    assert.equal((posts(calls)[0]!.body as { paymentConditions: { paymentTermLabel: string } }).paymentConditions.paymentTermLabel, "Payable within 14 days without deduction");
  });

  it("links the created document as Lexware Office does", async () => {
    const { client } = api(account());
    const result = await ops.executeApprovedSalesDocument(
      { client, journal: ops.journalIn(memoryStore()), draftOnly: true },
      "order-confirmation",
      ops.orderConfirmationInputSchema.parse({ customer_number: 10001, items }),
      approval("link-1"),
    );
    assert.equal(result.url, `https://app.lexware.de/vouchers#!/VoucherView/Order/${result.documentId}`);
  });
});

describe("review fixes", () => {
  const input = () => ops.orderConfirmationInputSchema.parse({ customer_number: 10001, items, customer_order_number: "4711", draft: true });

  it("creates a second document for the same order when the card showed the first one", async () => {
    const documents: Record<string, Record<string, unknown>> = {};
    const journal = ops.journalIn(memoryStore());
    const { client, calls } = api(account({ documents }));
    const first = await ops.executeApprovedSalesDocument({ client, journal }, "order-confirmation", input(), approval("o-1"));
    const warnings = await ops.prepareSalesDocument(client, "order-confirmation", input());
    assert.ok(ops.shownDuplicates(warnings).includes(first.url), "the card shows the first one");
    const second = await ops.executeApprovedSalesDocument({ client, journal }, "order-confirmation", input(), approval("o-2", warnings));
    assert.notEqual(second.documentId, first.documentId);
    assert.equal(posts(calls).length, 2);
  });

  it("does not adopt a known duplicate after a refused write, and frees the order again", async () => {
    const documents: Record<string, Record<string, unknown>> = {};
    const journal = ops.journalIn(memoryStore());
    let refuse = true;
    const { client, calls } = api(
      account({
        documents,
        extra: (call) => (call.method === "POST" && refuse ? new Response('{"message":"invalid"}', { status: 406 }) : undefined),
      }),
    );
    await assert.rejects(ops.executeApprovedSalesDocument({ client, journal }, "order-confirmation", input(), approval("r-1")), /nicht angelegt: .*406/);
    assert.equal((await journal.read("order-confirmation", ops.orderJournalId(C1, "4711")))?.status, "failed");

    refuse = false;
    documents["ab-0"] = { id: "ab-0", introduction: "Ihre Bestellung Nr. 4711", lineItems: [] };
    const warnings = await ops.prepareSalesDocument(client, "order-confirmation", input());
    const result = await ops.executeApprovedSalesDocument({ client, journal }, "order-confirmation", input(), approval("r-2", warnings));
    assert.notEqual(result.documentId, "ab-0");
    assert.equal(posts(calls).length, 2);
  });

  it("stops with an order number when the check could not read every candidate and the card did not say so", async () => {
    const documents = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`ab-${index}`, { id: `ab-${index}`, lineItems: [] }]));
    const { client, calls } = api(account({ documents }));
    await assert.rejects(
      ops.executeApprovedSalesDocument({ client, journal: ops.journalIn(memoryStore()) }, "order-confirmation", input(), approval("i-1")),
      /Dublettenprüfung zur Bestellung Nr\. 4711 ist unvollständig/,
    );
    assert.equal(posts(calls).length, 0);
    const warnings = await ops.prepareSalesDocument(client, "order-confirmation", input());
    await ops.executeApprovedSalesDocument({ client, journal: ops.journalIn(memoryStore()) }, "order-confirmation", input(), approval("i-2", warnings));
    assert.equal(posts(calls).length, 1);
  });

  it("describes a document resumed by order number as it is, not with the new input", async () => {
    const documents: Record<string, Record<string, unknown>> = {};
    const journal = ops.journalIn(memoryStore());
    const { client } = api(account({ documents }));
    const first = await ops.executeApprovedSalesDocument({ client, journal }, "order-confirmation", input(), approval("d-a"));
    const bigger = ops.orderConfirmationInputSchema.parse({ customer_number: 10001, items: [items[0]!, { ...items[0]!, name: "Mutter M6" }], customer_order_number: "4711" });
    documents[String(first.documentId)]!.lineItems = [{ name: "Schraube M6", quantity: 100, unitName: "Stück", unitPrice: { netAmount: 0.12, taxRatePercentage: 19 } }];
    const again = await ops.executeApprovedSalesDocument({ client, journal }, "order-confirmation", bigger, approval("d-b"));
    assert.equal(again.documentId, first.documentId);
    assert.equal(again.positions, 1);
    assert.equal(again.netTotal, 12);
  });

  it("accepts a duplicate the card showed with its pre-0.10 link", async () => {
    const documents = { "ab-9": { id: "ab-9", lineItems: [{ name: "x", quantity: 100, unitPrice: { netAmount: 0.12 } }] } };
    const { client, calls } = api(account({ documents }));
    const legacy = client.voucherUrl("ab-9");
    const approved = { id: "l-1", shownOnCard: (url: string) => url === legacy, notes: () => [] };
    await ops.executeApprovedSalesDocument({ client, journal: ops.journalIn(memoryStore()) }, "order-confirmation", ops.orderConfirmationInputSchema.parse({ customer_number: 10001, items }), approved);
    assert.equal(posts(calls).length, 1);
  });

  it("does not ask for a delivery address the contact keeps as its billing address", async () => {
    const same = { addresses: { billing: [{ street: "Hauptstraße 1", zip: "10115", city: "Berlin", countryCode: "DE" }], shipping: [{ street: "hauptstraße 1", zip: "10115", city: "Berlin", countryCode: "DE" }] } };
    const { client } = api(account({ contact: same }));
    const warnings = await ops.prepareSalesDocument(client, "order-confirmation", ops.orderConfirmationInputSchema.parse({ customer_number: 10001, items }));
    assert.equal(warnings.some((warning: { title?: string }) => warning.title === "⚠ Lieferadresse"), false);
  });

  it("reads any signal-shaped fourth argument as the signal, not as options", async () => {
    const { client, calls } = api(account());
    // Not this realm's AbortSignal: before the fix it was taken for PrepareOptions and dropped.
    const foreign = { aborted: false, reason: undefined, addEventListener: () => {}, removeEventListener: () => {}, throwIfAborted: () => {} } as unknown as AbortSignal;
    const warnings = await ops.prepareSalesDocument(client, "order-confirmation", ops.orderConfirmationInputSchema.parse({ customer_number: 10001, items }), foreign);
    // The fetch layer then sees it (and, being no real AbortSignal, refuses it) — proof it was passed on.
    assert.equal(calls.length, 0);
    assert.equal(warnings[0]?.kind, "sales-contact");
  });
});
