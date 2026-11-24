/**
 * What an order from a mail or PDF needs: the contact behind a sender's
 * address, articles by number or GTIN, a VAT ID's form, a deviating address,
 * and the customer's order number as the certain duplicate key.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createSalesDocument,
  customerOrderLine,
  customerOrderNumbersIn,
  escapeContactSearch,
  findArticles,
  findContactsByEmail,
  findDuplicateSalesDocument,
  getSalesDocument,
  paymentTermLabel,
  salesDocumentProblems,
  vatIdCountry,
  vatIdProblem,
  type NewSalesDocument,
} from "../src/index.ts";
import { fakeApi, on } from "./fake-api.ts";

const line = { name: "Schraube M6", quantity: 100, unit: "Stück", netPrice: 0.12, taxRate: 19 };

describe("contacts by email", () => {
  it("searches the exact address, escapes _ and %, and always returns candidates with all addresses", async () => {
    const { client, calls } = fakeApi(
      on("GET", /^\/contacts$/, () => ({
        content: [
          {
            id: "c1",
            roles: { customer: { number: 10001 } },
            company: { name: "Großhandel Zentrale GmbH" },
            addresses: {
              billing: [{ street: "Hauptstraße 1", zip: "10115", city: "Berlin", countryCode: "DE" }],
              shipping: [
                { supplement: "Filiale Nord", street: "Hafenweg 2", zip: "20457", city: "Hamburg", countryCode: "DE" },
                { supplement: "Filiale Süd", street: "Isarstraße 3", zip: "80331", city: "München", countryCode: "DE" },
              ],
            },
          },
          { id: "c2", roles: { customer: { number: 10002 } }, company: { name: "Großhandel Filiale Nord" }, addresses: {} },
        ],
      })),
    );
    const found = await findContactsByEmail(client, " einkauf_nord%1@example.com ", { customer: true });
    assert.equal(calls[0]!.query.get("email"), "einkauf\\_nord\\%1@example.com");
    assert.equal(calls[0]!.query.get("customer"), "true");
    assert.deepEqual(
      found.map((contact) => contact.id),
      ["c1", "c2"],
    );
    assert.equal(found[0]!.billingAddresses?.[0]?.city, "Berlin");
    assert.deepEqual(
      found[0]!.shippingAddresses?.map((address) => address.supplement),
      ["Filiale Nord", "Filiale Süd"],
    );
    assert.deepEqual(found[1]!.shippingAddresses, []);
  });

  it("does not ask Lexware for less than three characters", async () => {
    const { client, calls } = fakeApi();
    assert.deepEqual(await findContactsByEmail(client, "a@"), []);
    assert.equal(calls.length, 0);
    assert.equal(escapeContactSearch("a\\b"), "a\\\\b");
  });
});

describe("articles by number or GTIN", () => {
  it("filters with AND and maps like getArticle", async () => {
    const { client, calls } = fakeApi(
      on("GET", /^\/articles$/, ({ query }) =>
        query.get("gtin") === "4006381333931"
          ? { content: [{ id: "a1", title: "Schraube M6", type: "PRODUCT", articleNumber: "SCH-6", gtin: "4006381333931", unitName: "Stück", price: { netPrice: 0.14, grossPrice: 0.17, taxRate: 19 } }] }
          : { content: [] },
      ),
    );
    const [article] = await findArticles(client, { gtin: "4006381333931", type: "PRODUCT" }, { size: 999 });
    await findArticles(client, { gtin: "x" }, { size: 5 });
    assert.equal(calls[1]!.query.get("size"), "25", "the API refuses pages under 25 (406)");
    calls.splice(1, 1);
    assert.deepEqual(article, { id: "a1", title: "Schraube M6", lineType: "material", articleNumber: "SCH-6", gtin: "4006381333931", unitName: "Stück", netPrice: 0.14, grossPrice: 0.17, taxRate: 19 });
    assert.equal(calls[0]!.query.get("type"), "PRODUCT");
    assert.equal(calls[0]!.query.get("size"), "250");
    assert.deepEqual(await findArticles(client, { articleNumber: " SCH-7 " }), []);
    assert.equal(calls[1]!.query.get("articleNumber"), "SCH-7");
  });
});

describe("VAT ID form", () => {
  it("knows each member state's form, Greece as EL, and nothing about assignment", () => {
    assert.equal(vatIdProblem("ATU12345678"), null);
    assert.equal(vatIdProblem("nl 123456789 b01"), null);
    assert.equal(vatIdProblem("FR 12 345678901"), null);
    assert.match(vatIdProblem("ATU1234567")!, /Form einer USt-IdNr\. aus AT/);
    assert.match(vatIdProblem("GR123456789")!, /EL, nicht GR/);
    assert.match(vatIdProblem("CH123456789")!, /kein EU-Länderkürzel/);
    assert.equal(vatIdCountry("EL123456789"), "GR");
    assert.equal(vatIdCountry("DE123456789"), "DE");
  });
});

describe("a deviating recipient address", () => {
  it("sends the override next to the contact, trimmed, and refuses a non-ISO country", async () => {
    let body: Record<string, unknown> | undefined;
    const { client } = fakeApi(
      on("POST", /^\/order-confirmations$/, ({ body: sent }) => {
        body = sent as Record<string, unknown>;
        return { id: "ab1" };
      }),
    );
    const document: NewSalesDocument = {
      kind: "order-confirmation",
      contactId: "c1",
      address: { name: " Großhandel GmbH ", supplement: "Buchhaltung", street: "Hauptstraße 1", zip: "10115", city: "Berlin", countryCode: "de" },
      items: [line],
    };
    await createSalesDocument(client, document);
    assert.deepEqual(body!.address, { contactId: "c1", name: "Großhandel GmbH", supplement: "Buchhaltung", street: "Hauptstraße 1", zip: "10115", city: "Berlin", countryCode: "DE" });

    await createSalesDocument(client, { ...document, address: undefined });
    assert.deepEqual(body!.address, { contactId: "c1" });

    assert.deepEqual(salesDocumentProblems({ ...document, address: { name: "Großhandel GmbH", countryCode: "Deutschland" } }), ["Address country DEUTSCHLAND is no ISO 3166-1 alpha-2 code"]);
    // Lexware (live, 2026-11-24): 406 "Name and countryCode are required address fields."
    assert.match(salesDocumentProblems({ ...document, address: { street: "Abweichende Straße 5", city: "Potsdam" } })[0]!, /needs name and countryCode/);
    assert.deepEqual(salesDocumentProblems({ ...document, address: { name: "Großhandel GmbH", countryCode: "DE" } }), []);
    assert.deepEqual(salesDocumentProblems({ ...document, address: { name: " " } }), [], "empty fields are no override");
    assert.deepEqual(salesDocumentProblems({ ...document, introduction: "x".repeat(2001) }), ["Introduction longer than 2000 characters"]);
  });
});

describe("the customer's order number", () => {
  it("is written in one fixed line, in either language, and found again", () => {
    assert.equal(customerOrderLine(" 4711-A "), "Ihre Bestellung Nr. 4711-A");
    assert.equal(customerOrderLine("4711-A", "en"), "Your order no. 4711-A");
    assert.deepEqual(customerOrderNumbersIn("Your order no. 4711-A\nLieferadresse: x\n\nDanke"), ["4711-A"]);
    assert.deepEqual(customerOrderNumbersIn("Bezug: Ihre Bestellung Nr. 4711-A"), []);
    assert.deepEqual(customerOrderNumbersIn(undefined), []);
  });

  it("finds an order confirmation of the same contact with the same number, before any total match", async () => {
    const detail = (introduction: string, total: number) => ({ id: "x", introduction, lineItems: [{ name: "A", quantity: 1, unitPrice: { netAmount: total } }] });
    const { client, calls } = fakeApi(
      on("GET", /^\/voucherlist$/, () => ({ content: [{ id: "ab1" }, { id: "ab2" }, { id: "ab3" }] })),
      on("GET", /^\/order-confirmations\/ab1$/, () => detail("Ihre Bestellung Nr. 4700", 12)),
      on("GET", /^\/order-confirmations\/ab2$/, () => detail("Ihre Bestellung Nr. 4711\nDanke für Ihren Auftrag", 99)),
      on("GET", /^\/order-confirmations\/ab3$/, () => detail("", 12)),
    );
    const byNumber = await findDuplicateSalesDocument(client, { kind: "order-confirmation", contactId: "c1", itemsTotalNet: 12, customerOrderNumber: "4711" });
    assert.equal(byNumber.status === "match" && byNumber.by, "order-number");
    assert.equal(byNumber.status === "match" && byNumber.match.id, "ab2");
    assert.equal(calls[0]!.query.get("contactId"), "c1");

    const byTotal = await findDuplicateSalesDocument(client, { kind: "order-confirmation", contactId: "c1", itemsTotalNet: 12, customerOrderNumber: "9999" });
    assert.equal(byTotal.status === "match" && byTotal.by, "total");
    assert.equal(byTotal.status === "match" && byTotal.match.id, "ab1");

    const before = calls.length;
    const plain = await findDuplicateSalesDocument(client, { kind: "order-confirmation", contactId: "c1", itemsTotalNet: 12 });
    assert.equal(plain.status === "match" && plain.by, "total");
    assert.equal(calls.length - before, 2, "without an order number the first total match ends the search");
  });

  it("reads at most maxCandidates documents, also with an order number", async () => {
    const list = Array.from({ length: 12 }, (_, index) => ({ id: `ab${index}` }));
    const { client, calls } = fakeApi(
      on("GET", /^\/voucherlist$/, () => ({ content: list })),
      on("GET", /^\/order-confirmations\/ab\d+$/, () => ({ id: "x", introduction: "Ihre Bestellung Nr. 1", lineItems: [] })),
    );
    const result = await findDuplicateSalesDocument(client, { kind: "order-confirmation", contactId: "c1", itemsTotalNet: 5, customerOrderNumber: "2" });
    assert.equal(result.status, "incomplete");
    assert.equal(calls.filter((call) => call.path.startsWith("/order-confirmations/")).length, 10);
  });

  it("is read back with the document's title and introduction", async () => {
    const { client } = fakeApi(on("GET", /^\/order-confirmations\/ab1$/, () => ({ id: "ab1", title: "Projekt X", introduction: "Ihre Bestellung Nr. 4711", lineItems: [] })));
    const detail = await getSalesDocument(client, "order-confirmation", "ab1");
    assert.equal(detail.title, "Projekt X");
    assert.equal(detail.introduction, "Ihre Bestellung Nr. 4711");
  });
});

describe("links and printed texts as Lexware Office has them", () => {
  it("links a sales document with its own view, anything else generically", async () => {
    const { client } = fakeApi(
      on("POST", /^\/order-confirmations$/, () => ({ id: "ab1" })),
      on("GET", /^\/voucherlist$/, () => ({ content: [{ id: "q1" }] })),
    );
    assert.equal(client.voucherUrl("ab1", "order-confirmation"), "https://app.lexware.de/vouchers#!/VoucherView/Order/ab1");
    assert.equal(client.voucherUrl("re1", "invoice"), "https://app.lexware.de/vouchers#!/VoucherView/Invoice/re1");
    assert.equal(client.voucherUrl("ag1", "quotation"), "https://app.lexware.de/vouchers#!/VoucherView/Quotation/ag1");
    assert.equal(client.voucherUrl("v1"), "https://app.lexware.de/vouchers#!/VoucherDetail/v1");
    assert.equal((await createSalesDocument(client, { kind: "order-confirmation", contactId: "c1", items: [line] })).url, "https://app.lexware.de/vouchers#!/VoucherView/Order/ab1");
  });

  it("phrases a payment term in English for an English document — Lexware prints the account's default in German", () => {
    assert.equal(paymentTermLabel(0, undefined, "en"), "Payable immediately, net");
    assert.equal(paymentTermLabel(14, undefined, "en"), "Payable within 14 days without deduction");
    assert.equal(paymentTermLabel(30, { percentage: 2.5, days: 10 }, "en"), "10 days 2.5 % discount, 30 days net");
    assert.equal(paymentTermLabel(14), "Zahlbar innerhalb von 14 Tagen ohne Abzug");
    assert.equal(paymentTermLabel(1, { percentage: 2, days: 1 }, "en"), "1 day 2 % discount, 1 day net");
    assert.equal(paymentTermLabel(30, { percentage: 2, days: 1 }), "1 Tag 2 % Skonto, 30 Tage netto");
  });
});
