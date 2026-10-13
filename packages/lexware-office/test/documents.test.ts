import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  LexwareApiError,
  createSalesDocument,
  createVoucher,
  findDuplicateSalesDocument,
  findPurchaseInvoiceByNumber,
  findVendorCategoryHistory,
  defaultPaymentCondition,
  getArticle,
  getContact,
  getSalesDocument,
  invoiceExists,
  paymentTermLabel,
  resolvePrintLayout,
  salesDocumentProblems,
  isPursueRejection,
  isReverseChargeCategory,
  listPostingCategories,
  netTotal,
  resolveCategory,
  taxFromGross,
} from "../src/index.ts";
import { fakeApi, on } from "./fake-api.ts";

const categories = [
  { id: "11111111-1111-4111-8111-111111111111", name: "Wareneinkauf", type: "outgo", contactRequired: false, splitAllowed: true },
  { id: "22222222-2222-4222-8222-222222222222", name: "Fremdleistungen §13b", type: "outgo", contactRequired: false, splitAllowed: true },
  { id: "33333333-3333-4333-8333-333333333333", name: "Einnahmen", type: "income", contactRequired: false, splitAllowed: true },
];

describe("money", () => {
  it("rounds totals and taxes to the cent", () => {
    assert.equal(netTotal([{ quantity: 3, netPrice: 1.1 }, { quantity: 1, netPrice: 0.005 }]), 3.31);
    assert.equal(taxFromGross(119, 19), 19);
  });
});

describe("categories", () => {
  it("resolves by name or id, in the right direction, and caches per client", async () => {
    const { client, calls } = fakeApi(on("GET", /^\/posting-categories$/, () => categories));
    assert.equal((await resolveCategory(client, "wareneinkauf", "outgo"))?.id, categories[0]!.id);
    assert.equal((await resolveCategory(client, "13b", "outgo"))?.name, "Fremdleistungen §13b");
    assert.equal(await resolveCategory(client, categories[2]!.id, "outgo"), null);
    await listPostingCategories(client);
    assert.equal(calls.length, 1);
    assert.equal(isReverseChargeCategory("Beratung § 13b Drittland"), true);
    assert.equal(isReverseChargeCategory("Wareneinkauf"), false);
  });
});

describe("vouchers", () => {
  it("creates a voucher with a real contact, without a contact name", async () => {
    const { client, calls } = fakeApi(on("POST", /^\/vouchers$/, () => ({ id: "v1" })));
    const created = await createVoucher(client, {
      type: "purchaseinvoice",
      voucherNumber: "R-1",
      voucherDate: "2026-09-01",
      totalGrossAmount: 119,
      totalTaxAmount: 19,
      taxType: "gross",
      voucherStatus: "unchecked",
      contactId: "c1",
      contactName: "ignored",
      voucherItems: [{ amount: 119, taxAmount: 19, taxRatePercent: 19 }],
    });
    assert.equal(created.url, "https://app.lexware.de/vouchers#!/VoucherDetail/v1");
    const body = calls[0]!.body as Record<string, unknown>;
    assert.equal(body.contactId, "c1");
    assert.equal("contactName" in body, false);
  });

  it("refuses combinations the API would reject", async () => {
    const { client } = fakeApi();
    const base = { type: "purchaseinvoice" as const, voucherNumber: "R", voucherDate: "2026-09-01", totalGrossAmount: 1, totalTaxAmount: 0, voucherItems: [] };
    await assert.rejects(createVoucher(client, { ...base, taxType: "net", voucherStatus: "unchecked", contactId: "c" }), /unchecked/);
    await assert.rejects(createVoucher(client, { ...base, taxType: "gross", voucherStatus: "unchecked" }), /Kontakt/);
  });

  it("finds a captured purchase invoice by number, any status", async () => {
    const { client, calls } = fakeApi(on("GET", /^\/voucherlist$/, () => ({ content: [{ id: "v9", voucherNumber: "R-1", voucherStatus: "paid" }] })));
    assert.equal((await findPurchaseInvoiceByNumber(client, "R-1"))?.url.endsWith("/v9"), true);
    assert.equal(calls[0]!.query.get("voucherStatus"), "any");
    assert.equal(calls[0]!.query.get("voucherType"), "purchaseinvoice,purchasecreditnote");
  });

  it("reads a vendor's category history and notices split vouchers", async () => {
    const { client } = fakeApi(
      on("GET", /^\/voucherlist$/, () => ({ content: [{ id: "a" }, { id: "b" }] })),
      on("GET", /^\/vouchers\/a$/, () => ({ voucherItems: [{ categoryId: categories[0]!.id }] })),
      on("GET", /^\/vouchers\/b$/, () => ({ voucherItems: [{ categoryId: categories[0]!.id }, { categoryId: categories[1]!.id }] })),
      on("GET", /^\/posting-categories$/, () => categories),
    );
    const history = await findVendorCategoryHistory(client, "vendor");
    assert.deepEqual(history.categories.map((category) => category.name), ["Wareneinkauf", "Fremdleistungen §13b"]);
    assert.equal(history.split, true);
    assert.equal(history.scanned, 2);
  });
});

describe("sales documents", () => {
  it("creates a finalized quotation with a pursue link in the query, not the body", async () => {
    const { client, calls } = fakeApi(on("POST", /^\/quotations$/, () => ({ id: "q1" })));
    await createSalesDocument(client, {
      kind: "quotation",
      contactId: "c1",
      items: [{ name: "Beratung", quantity: 2, unit: "Stunde", netPrice: 100, taxRate: 19 }],
      expirationDate: "2026-07-01",
      finalize: true,
      precedingSalesVoucherId: "p1",
    });
    const call = calls[0]!;
    assert.equal(call.query.get("finalize"), "true");
    assert.equal(call.query.get("precedingSalesVoucherId"), "p1");
    const body = call.body as { lineItems: Array<{ unitPrice: { netAmount: number } }>; expirationDate: string; precedingSalesVoucherId?: string };
    assert.equal(body.lineItems[0]!.unitPrice.netAmount, 100);
    assert.equal(body.expirationDate, "2026-07-01T00:00:00.000+02:00");
    assert.equal(body.precedingSalesVoucherId, undefined);
  });

  it("keeps an invoice a draft unless told otherwise", async () => {
    const { client, calls } = fakeApi(on("POST", /^\/invoices$/, () => ({ id: "i1" })));
    await createSalesDocument(client, { kind: "invoice", contactId: "c1", items: [] });
    assert.equal(calls[0]!.query.get("finalize"), null);
  });

  it("sends headings, descriptions, optional lines, introduction and remark as a written quotation has them", async () => {
    const { client, calls } = fakeApi(on("POST", /^\/quotations$/, () => ({ id: "q1" })));
    await createSalesDocument(client, {
      kind: "quotation",
      contactId: "c1",
      items: [
        { type: "text", name: "Teil 1: Festpreis", description: "Zwei Korrekturschleifen je Position." },
        { name: "Shop-Grundeinrichtung", description: "Enthalten:\n- Shop\n- Domain", quantity: 1, unit: "Pauschale", netPrice: 400, taxRate: 19 },
        { name: "Wartung", quantity: 1, unit: "Monat", netPrice: 50, taxRate: 19, optional: true },
      ],
      introduction: "Ausgangslage",
      remark: "Bedingungen",
    });
    const body = calls[0]!.body as { lineItems: Record<string, unknown>[]; introduction?: string; remark?: string };
    assert.deepEqual(body.lineItems[0], { type: "text", name: "Teil 1: Festpreis", description: "Zwei Korrekturschleifen je Position." });
    assert.equal(body.lineItems[1]!.description, "Enthalten:\n- Shop\n- Domain");
    assert.equal(body.lineItems[1]!.optional, undefined);
    assert.equal(body.lineItems[2]!.optional, true);
    assert.equal(body.introduction, "Ausgangslage");
    assert.equal(body.remark, "Bedingungen");
    assert.equal(calls[0]!.query.get("finalize"), null);
  });

  it("leaves introduction and remark to the account's defaults when none are given", async () => {
    const { client, calls } = fakeApi(on("POST", /^\/order-confirmations$/, () => ({ id: "o1" })));
    await createSalesDocument(client, { kind: "order-confirmation", contactId: "c1", items: [{ type: "text", name: "Teil 1" }] });
    const body = calls[0]!.body as Record<string, unknown>;
    assert.equal("introduction" in body, false);
    assert.equal("remark" in body, false);
  });

  it("refuses optional lines outside a quotation instead of letting them count", async () => {
    const { client, calls } = fakeApi(on("POST", /./, () => ({ id: "x" })));
    await assert.rejects(
      createSalesDocument(client, {
        kind: "order-confirmation",
        contactId: "c1",
        items: [{ name: "A", quantity: 1, unit: "Stück", netPrice: 1, taxRate: 19, optional: true }],
      }),
      /only on quotations/,
    );
    assert.equal(calls.length, 0);
  });

  it("sends service period, payment term, voucher date, discounts and tax conditions of an invoice", async () => {
    const { client, calls } = fakeApi(on("POST", /^\/invoices$/, () => ({ id: "i1" })));
    await createSalesDocument(client, {
      kind: "invoice",
      contactId: "c1",
      items: [{ name: "Entwicklung", quantity: 10, unit: "Stunde", netPrice: 100, taxRate: 19, discountPercentage: 10 }],
      voucherDate: "2026-10-13",
      shippingConditions: { shippingType: "serviceperiod", shippingDate: "2026-09-16", shippingEndDate: "2026-09-30" },
      paymentConditions: { paymentTermLabel: paymentTermLabel(14), paymentTermDuration: 14 },
      totalDiscountPercentage: 5,
      title: "Beispiel Apps",
      language: "de",
      printLayoutId: "pl-1",
      xRechnung: { buyerReference: "" },
    });
    const body = calls[0]!.body as Record<string, any>;
    assert.equal(body.voucherDate, "2026-10-13T00:00:00.000+02:00");
    assert.deepEqual(body.shippingConditions, {
      shippingType: "serviceperiod",
      shippingDate: "2026-09-16T00:00:00.000+02:00",
      shippingEndDate: "2026-09-30T00:00:00.000+02:00",
    });
    assert.deepEqual(body.paymentConditions, { paymentTermLabel: "Zahlbar innerhalb von 14 Tagen ohne Abzug", paymentTermDuration: 14 });
    assert.deepEqual(body.taxConditions, { taxType: "net" });
    assert.deepEqual(body.totalPrice, { currency: "EUR", totalDiscountPercentage: 5 });
    assert.equal(body.lineItems[0].discountPercentage, 10);
    assert.equal(body.title, "Beispiel Apps");
    assert.equal(body.language, "de");
    assert.equal(body.printLayoutId, "pl-1");
    assert.deepEqual(body.xRechnung, { buyerReference: "" });
  });

  it("keeps the old default — delivery on the voucher date — and leaves payment conditions to Lexware", async () => {
    const { client, calls } = fakeApi(on("POST", /^\/order-confirmations$/, () => ({ id: "o1" })));
    await createSalesDocument(client, { kind: "order-confirmation", contactId: "c1", items: [{ type: "text", name: "Teil 1" }], deliveryTerms: "Lieferung frei Haus" });
    const body = calls[0]!.body as Record<string, any>;
    assert.equal(body.shippingConditions.shippingType, "delivery");
    assert.equal(body.shippingConditions.shippingDate, body.voucherDate);
    assert.equal("paymentConditions" in body, false);
    assert.equal(body.deliveryTerms, "Lieferung frei Haus");
  });

  it("sends a quotation without shipping conditions, with alternatives, article references and gross prices", async () => {
    const { client, calls } = fakeApi(on("POST", /^\/quotations$/, () => ({ id: "q1" })));
    await createSalesDocument(client, {
      kind: "quotation",
      contactId: "c1",
      taxConditions: { taxType: "gross" },
      paymentConditions: { paymentTermLabel: paymentTermLabel(30, { percentage: 2, days: 10 }), paymentTermDuration: 30, paymentDiscountConditions: { discountPercentage: 2, discountRange: 10 } },
      items: [
        {
          name: "Hosting S",
          quantity: 12,
          unit: "Monat",
          netPrice: 25.2101,
          grossPrice: 30,
          taxRate: 19,
          article: { id: "a1", type: "service" },
          alternatives: [{ name: "Hosting M", quantity: 12, unit: "Monat", netPrice: 42.0168, grossPrice: 50, taxRate: 19 }],
        },
      ],
    });
    const body = calls[0]!.body as Record<string, any>;
    assert.equal("shippingConditions" in body, false);
    assert.deepEqual(body.taxConditions, { taxType: "gross" });
    assert.equal(body.paymentConditions.paymentTermLabel, "10 Tage 2 % Skonto, 30 Tage netto");
    assert.deepEqual(body.lineItems[0].unitPrice, { currency: "EUR", grossAmount: 30, taxRatePercentage: 19 });
    assert.equal(body.lineItems[0].id, "a1");
    assert.equal(body.lineItems[0].type, "service");
    assert.equal(body.lineItems[0].subItems[0].alternative, true);
    assert.equal(body.lineItems[0].subItems[0].type, "custom");
    assert.equal(body.lineItems[0].subItems[0].unitPrice.grossAmount, 50);
  });

  it("names every combination the API would drop or reject, before sending", async () => {
    const line = { name: "A", quantity: 1, unit: "Stück", netPrice: 1, taxRate: 19 };
    const problems = (options: Record<string, unknown>) => salesDocumentProblems({ kind: "invoice", contactId: "c1", items: [line], ...options } as never);

    assert.deepEqual(problems({}), []);
    assert.match(problems({ kind: "quotation", shippingConditions: { shippingType: "none" } }).join(), /no shipping conditions/);
    assert.match(problems({ deliveryTerms: "frei Haus" }).join(), /only on order confirmations/);
    assert.match(problems({ kind: "quotation", xRechnung: { buyerReference: "x" } }).join(), /only on invoices/);
    assert.match(problems({ shippingConditions: { shippingType: "serviceperiod", shippingDate: "2026-09-30", shippingEndDate: "2026-09-16" } }).join(), /ends before it starts/);
    assert.match(problems({ taxConditions: { taxType: "intraCommunitySupply" } }).join(), /0 % on every line/);
    assert.deepEqual(problems({ taxConditions: { taxType: "intraCommunitySupply" }, items: [{ ...line, taxRate: 0 }] }), []);
    assert.match(problems({ taxConditions: { taxType: "gross" } }).join(), /gross price/);
    assert.match(problems({ items: [{ ...line, taxRate: 21 }] }).join(), /tax subtype/);
    assert.deepEqual(problems({ items: [{ ...line, taxRate: 21 }], taxConditions: { taxType: "net", taxSubType: "distanceSales" } }), []);
    assert.match(problems({ totalDiscountAbsolute: 10, totalDiscountPercentage: 5 }).join(), /not both/);
    assert.match(problems({ items: [{ ...line, alternatives: [line] }] }).join(), /Alternative line items exist only on quotations/);
    assert.match(problems({ paymentConditions: { paymentTermDuration: 7, paymentDiscountConditions: { discountPercentage: 2, discountRange: 10 } } }).join(), /runs longer/);
  });

  it("reads the account's default payment term, print layouts, articles and a contact's tax data", async () => {
    const { client } = fakeApi(
      on("GET", /^\/payment-conditions$/, () => [
        { id: "p1", paymentTermLabelTemplate: "Zahlbar in {paymentRange} Tagen, rein netto ohne Abzug", paymentTermDuration: 14, organizationDefault: false },
        { id: "p2", paymentTermLabelTemplate: "{discountRange} Tage -{discount}, {paymentRange} Tage netto", paymentTermDuration: 30, paymentDiscountConditions: { discountPercentage: 3, discountRange: 10 }, organizationDefault: true },
      ]),
      on("GET", /^\/print-layouts$/, () => [
        { id: "l1", name: "Standard", default: true },
        { id: "l2", name: "Englisch", default: false },
      ]),
      on("GET", /^\/articles\/a1$/, () => ({ id: "a1", title: "Hosting", type: "PRODUCT", unitName: "Monat", price: { netPrice: 25, taxRate: 19 } })),
      on("GET", /^\/contacts\/c1$/, () => ({
        id: "c1",
        roles: { customer: { number: 10001 } },
        company: { name: "Acme BV", vatRegistrationId: "NL123456789B01", allowTaxFreeInvoices: true },
        addresses: { billing: [{ countryCode: "NL" }] },
      })),
    );
    assert.deepEqual(await defaultPaymentCondition(client), { label: "10 Tage -3 %, 30 Tage netto", duration: 30, discount: { percentage: 3, days: 10 } });
    assert.equal((await resolvePrintLayout(client, "englisch"))?.id, "l2");
    assert.equal(await resolvePrintLayout(client, "Fehlt"), null);
    assert.equal((await getArticle(client, "a1")).lineType, "material");
    const contact = await getContact(client, "c1");
    assert.equal(contact.vatRegistrationId, "NL123456789B01");
    assert.equal(contact.allowTaxFreeInvoices, true);
    assert.equal(contact.countryCode, "NL");
    assert.equal(contact.isCompany, true);
  });

  it("phrases a payment term as Lexware Office does", () => {
    assert.equal(paymentTermLabel(0), "Zahlbar sofort, rein netto");
    assert.equal(paymentTermLabel(14), "Zahlbar innerhalb von 14 Tagen ohne Abzug");
    assert.equal(paymentTermLabel(30, { percentage: 2.5, days: 10 }), "10 Tage 2,5 % Skonto, 30 Tage netto");
  });

  it("recognises a rejected pursue", () => {
    const pursue = new LexwareApiError({ status: 406, statusText: "", method: "POST", path: "/invoices", responseBody: "precedingSalesVoucherId invalid" });
    const payload = new LexwareApiError({ status: 406, statusText: "", method: "POST", path: "/invoices", responseBody: "title too long" });
    assert.equal(isPursueRejection(pursue), true);
    assert.equal(isPursueRejection(payload), false);
  });

  it("reads a document's priced lines, discount, and customer", async () => {
    const { client } = fakeApi(
      on("GET", /^\/quotations\/q1$/, () => ({
        id: "q1",
        voucherNumber: "AG-1",
        address: { contactId: "c1", name: "Kunde GmbH" },
        lineItems: [{ type: "text", name: "Hinweis" }, { name: "A", quantity: 2, unitName: "Stück", unitPrice: { netAmount: 10, taxRatePercentage: 19 } }],
        totalPrice: { totalNetAmount: 18, totalDiscountAbsolute: 2 },
      })),
    );
    const detail = await getSalesDocument(client, "quotation", "q1");
    assert.equal(detail.lineItemsNet, 20);
    assert.equal(detail.lineItems.length, 1);
    assert.equal(detail.discountAbsolute, 2);
    assert.equal(detail.contactName, "Kunde GmbH");
    assert.equal(detail.hasOptionalOrAlternative, false);
  });

  it("keeps optional lines out of the total and notes them for the pursue", async () => {
    const { client } = fakeApi(
      on("GET", /^\/quotations\/q1$/, () => ({
        id: "q1",
        lineItems: [
          { type: "text", name: "Teil 1" },
          { type: "custom", name: "A", quantity: 1, unitName: "Stück", unitPrice: { netAmount: 400, taxRatePercentage: 19 }, optional: false },
          { type: "custom", name: "B", description: "laufend", quantity: 1, unitName: "Monat", unitPrice: { netAmount: 149, taxRatePercentage: 19 }, optional: true },
        ],
      })),
    );
    const detail = await getSalesDocument(client, "quotation", "q1");
    assert.equal(detail.lineItemsNet, 400);
    assert.deepEqual(detail.lineItems.map((item) => item.name), ["A"]);
    assert.deepEqual(detail.optionalItems, [{ name: "B", description: "laufend", quantity: 1, unit: "Monat", netPrice: 149, taxRate: 19, optional: true }]);
    assert.equal(detail.hasOptionalOrAlternative, true);
  });

  it("finds a duplicate by line-item total and says when it could not check all", async () => {
    const list = Array.from({ length: 12 }, (_, index) => ({ id: `d${index}` }));
    const detail = (total: number) => ({ id: "x", lineItems: [{ name: "A", quantity: 1, unitPrice: { netAmount: total } }] });
    const { client } = fakeApi(
      on("GET", /^\/voucherlist$/, () => ({ content: list })),
      on("GET", /^\/invoices\/d3$/, () => detail(99.99)),
      on("GET", /^\/invoices\/d\d+$/, () => detail(1)),
    );
    const match = await findDuplicateSalesDocument(client, { kind: "invoice", contactId: "c1", itemsTotalNet: 100 });
    assert.equal(match.status, "match");
    assert.equal(match.status === "match" && match.match.id, "d3");
    const none = await findDuplicateSalesDocument(client, { kind: "invoice", contactId: "c1", itemsTotalNet: 500 });
    assert.equal(none.status, "incomplete");
  });

  it("treats only a 404 as a deleted invoice", async () => {
    const gone = fakeApi(on("GET", /^\/invoices\/x$/, () => ({}), 404));
    const flaky = fakeApi(on("GET", /^\/invoices\/x$/, () => ({}), 503));
    assert.equal(await invoiceExists(gone.client, "x"), false);
    assert.equal(await invoiceExists(flaky.client, "x"), true);
  });
});
