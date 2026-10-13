/** Quotation, order confirmation, invoice: the checks before the card and the write after it. */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { contact, on, useApi, type Route } from "./harness.ts";

const { executeSalesDocument, isCalendarDate, isDocumentTypeLabel, runSalesPreflight, toLineItems } = await import("../dist/extension/lib/sales.mjs");

const items = [{ name: "Workshop-Tag", quantity: 2, unit: "Tag", net_price: 1200, tax_rate: 19 }];

const customer = on("GET", /^\/contacts$/, () => ({ content: [contact("c-1", "Nordlicht Consulting GmbH", { customer: { number: 10001 } })] }));
const noDocuments = on("GET", /^\/voucherlist$/, () => ({ content: [] }));

/** The account's default payment condition, as /payment-conditions lists it. */
const paymentDefault = (days: number) =>
  on("GET", /^\/payment-conditions$/, () => [
    {
      id: "p-1",
      paymentTermLabelTemplate: days === 0 ? "Zahlbar sofort, rein netto" : "Zahlbar in {paymentRange} Tagen, rein netto ohne Abzug",
      paymentTermDuration: days,
      organizationDefault: true,
    },
  ]);

/** A quotation as the API returns it. */
const quotation = (lines: { net: number; quantity?: number }[], extra: Record<string, unknown> = {}): Route =>
  on("GET", /^\/quotations\//, () => ({
    id: "q-1",
    voucherNumber: "AG2026001",
    address: { contactId: "c-1", name: "Nordlicht Consulting GmbH" },
    lineItems: lines.map((line, index) => ({
      name: `Position ${index}`,
      quantity: line.quantity ?? 1,
      unitName: "Stück",
      unitPrice: { netAmount: line.net, taxRatePercentage: 19 },
    })),
    totalPrice: { totalNetAmount: lines.reduce((sum, line) => sum + line.net * (line.quantity ?? 1), 0), ...extra },
  }));

describe("line items", () => {
  it("maps the tool's fields to the API's", () => {
    assert.deepEqual(toLineItems(items), [{ name: "Workshop-Tag", quantity: 2, unit: "Tag", netPrice: 1200, taxRate: 19 }]);
  });

  it("recognises a date and a title that only repeats the document type", () => {
    assert.equal(isCalendarDate("2026-10-31"), true);
    assert.equal(isCalendarDate("31.10.2026"), false);
    assert.equal(isCalendarDate("2026-13-01"), false);
    assert.equal(isDocumentTypeLabel("Angebot"), true);
    assert.equal(isDocumentTypeLabel("Angebot Website-Relaunch"), false);
  });
});

describe("runSalesPreflight", () => {
  it("puts the customer's real name on the card", async () => {
    useApi(customer, noDocuments, paymentDefault(0));
    const warnings = await runSalesPreflight("quotation", { customer_number: 10001, items });

    assert.deepEqual(warnings[0], { kind: "customer-resolved", name: "Nordlicht Consulting GmbH", number: 10001 });
    assert.equal(warnings.length, 2);
  });

  it("says when the customer number belongs to nobody", async () => {
    useApi(on("GET", /^\/contacts$/, () => ({ content: [] })));
    const warnings = await runSalesPreflight("quotation", { customer_number: 99999, items });

    assert.equal(warnings[0]?.kind, "sales-contact");
    assert.match(String(warnings[0]?.reason), /99999/);
  });

  it("refuses a contact that is not a customer", async () => {
    useApi(on("GET", /^\/contacts\//, () => contact("v-1", "Musterlieferant GmbH", { vendor: {} })));
    const warnings = await runSalesPreflight("invoice", { contact_id: "v-1", items });

    assert.match(String(warnings[0]?.reason), /kein Kundenkontakt/);
  });

  it("finds a document with the same net total for this customer", async () => {
    useApi(
      customer,
      on("GET", /^\/voucherlist$/, () => ({ content: [{ id: "q-1", voucherNumber: "AG2026001", voucherDate: "2026-08-10", voucherStatus: "open" }] })),
      quotation([{ net: 1200, quantity: 2 }]),
    );
    const warnings = await runSalesPreflight("quotation", { customer_number: 10001, items });

    const duplicate = warnings.find((warning) => warning.kind === "sales-duplicate");
    assert.equal(duplicate?.voucherNumber, "AG2026001");
    assert.equal(duplicate?.documentLabel, "Angebot");
  });

  it("names the source document and its customer", async () => {
    useApi(customer, noDocuments, quotation([{ net: 1200, quantity: 2 }]));
    const warnings = await runSalesPreflight("order-confirmation", {
      customer_number: 10001,
      items,
      source_document_id: "3f0ef2e1-5f2b-4b44-9f0f-3b4bd7f0f0aa",
      source_document_type: "quotation",
    });

    const source = warnings.find((warning) => warning.kind === "source-resolved");
    assert.equal(source?.sourceLabel, "Angebot AG2026001");
    assert.ok(!warnings.some((warning) => warning.kind === "source-mismatch"));
  });

  it("flags a total that no longer matches the source", async () => {
    useApi(customer, noDocuments, quotation([{ net: 1000, quantity: 2 }]));
    const warnings = await runSalesPreflight("order-confirmation", {
      customer_number: 10001,
      items,
      source_document_id: "3f0ef2e1-5f2b-4b44-9f0f-3b4bd7f0f0aa",
      source_document_type: "quotation",
    });

    const mismatch = warnings.find((warning) => warning.kind === "source-mismatch");
    assert.equal(mismatch?.difference, 400);
  });

  it("flags a discount on the source, which copied lines would lose", async () => {
    useApi(customer, noDocuments, quotation([{ net: 1200, quantity: 2 }], { totalDiscountAbsolute: 240 }));
    const warnings = await runSalesPreflight("invoice", {
      customer_number: 10001,
      items,
      source_document_id: "3f0ef2e1-5f2b-4b44-9f0f-3b4bd7f0f0aa",
      source_document_type: "quotation",
    });

    assert.equal(warnings.find((warning) => warning.kind === "source-discount")?.discountAbsolute, 240);
  });

  it("turns a failed source lookup into a finding, not an error", async () => {
    useApi(customer, noDocuments, on("GET", /^\/quotations\//, () => ({ message: "Not found" }), 404));
    const warnings = await runSalesPreflight("invoice", {
      customer_number: 10001,
      items,
      source_document_id: "3f0ef2e1-5f2b-4b44-9f0f-3b4bd7f0f0aa",
      source_document_type: "quotation",
    });

    assert.match(String(warnings.find((warning) => warning.kind === "source-check-failed")?.reason), /404/);
  });
});

describe("executeSalesDocument", () => {
  const created = (kind: string) => on("POST", new RegExp(`^/${kind}$`), () => ({ id: "new-1" }), 201);

  it("finalizes a quotation and reports number, customer and total", async () => {
    const api = useApi(
      customer,
      noDocuments,
      created("quotations"),
      on("GET", /^\/quotations\//, () => ({ id: "new-1", voucherNumber: "AG2026099", address: { contactId: "c-1", name: "Nordlicht Consulting GmbH" }, lineItems: [] })),
    );
    const result = await executeSalesDocument("quotation", { customer_number: 10001, items }, { callId: "call-1" });

    assert.equal(result.documentName, "Angebot AG2026099");
    assert.equal(result.contactName, "Nordlicht Consulting GmbH");
    assert.equal(result.netTotal, 2400);
    assert.equal(api.calls.find((call) => call.method === "POST")?.query.get("finalize"), "true");
  });

  it("leaves an invoice as a draft", async () => {
    const api = useApi(
      customer,
      noDocuments,
      created("invoices"),
      on("GET", /^\/invoices\//, () => ({ id: "new-1", address: { contactId: "c-1", name: "Nordlicht Consulting GmbH" }, lineItems: [] })),
    );
    await executeSalesDocument("invoice", { customer_number: 10001, items }, { callId: "call-2" });

    assert.equal(api.calls.find((call) => call.method === "POST")?.query.get("finalize"), null);
  });

  it("creates without the chain when the source rejects it", async () => {
    let attempts = 0;
    const api = useApi(
      customer,
      noDocuments,
      quotation([{ net: 1200, quantity: 2 }]),
      (call) => {
        if (call.method !== "POST" || call.path !== "/invoices") return undefined;
        attempts += 1;
        return attempts === 1
          ? Response.json({ message: "precedingSalesVoucherId is not pursuable" }, { status: 406 })
          : Response.json({ id: "new-1" }, { status: 201 });
      },
      on("GET", /^\/invoices\//, () => ({ id: "new-1", address: { contactId: "c-1", name: "Nordlicht Consulting GmbH" }, lineItems: [] })),
    );

    const result = await executeSalesDocument(
      "invoice",
      { customer_number: 10001, items, source_document_id: "3f0ef2e1-5f2b-4b44-9f0f-3b4bd7f0f0aa", source_document_type: "quotation" },
      { callId: "call-3" },
    );

    assert.equal(attempts, 2);
    assert.match(String(result.sourceDocument), /KEINE Verknüpfung|ohne/i);
    assert.equal(api.calls.filter((call) => call.method === "POST").length, 2);
  });

  it("stops when a document appeared between card and click", async () => {
    useApi(
      customer,
      on("GET", /^\/voucherlist$/, () => ({ content: [{ id: "q-9", voucherNumber: "AG2026050", voucherDate: "2026-09-01", voucherStatus: "open" }] })),
      quotation([{ net: 1200, quantity: 2 }]),
      created("quotations"),
    );

    await assert.rejects(
      () => executeSalesDocument("quotation", { customer_number: 10001, items }, { callId: "call-4" }),
      /Abgebrochen/,
    );
  });

  it("does not create twice when the step runs again", async () => {
    const api = useApi(
      customer,
      noDocuments,
      created("quotations"),
      on("GET", /^\/quotations\//, () => ({ id: "new-1", voucherNumber: "AG2026099", address: { contactId: "c-1", name: "Nordlicht Consulting GmbH" }, lineItems: [] })),
    );
    const input = { customer_number: 10001, items };

    await executeSalesDocument("quotation", input, { callId: "same-call" });
    const replay = await executeSalesDocument("quotation", input, { callId: "same-call" });

    assert.match(String(replay.note), /Wiederaufnahme/);
    assert.equal(api.calls.filter((call) => call.method === "POST").length, 1);
  });
});

/** Lines as a written quotation has them: heading, described positions, an optional one. */
const written = [
  { type: "text", name: "Teil 1: Festpreis", description: "Je Position zwei Korrekturschleifen." },
  { name: "Shop-Grundeinrichtung", description: "Enthalten:\n- Shop, Märkte, Zahlungsarten", quantity: 1, unit: "Pauschale", net_price: 400, tax_rate: 19 },
  { name: "Stundenkontingent", quantity: 6, unit: "Stunde", net_price: 100, tax_rate: 19 },
  { type: "text", name: "Teil 3: Laufender Betrieb (optional)" },
  { name: "Wartung", quantity: 1, unit: "Monat", net_price: 50, tax_rate: 19, optional: true },
];

const { default: createQuotation } = await import("../dist/extension/tools/create_quotation.mjs");
const { default: createOrderConfirmation } = await import("../dist/extension/tools/create_order_confirmation.mjs");
const { default: createInvoice } = await import("../dist/extension/tools/create_invoice.mjs");

describe("tool schemas", () => {
  const parse = (tool: { inputSchema: { safeParse(value: unknown): { success: boolean } } }, input: Record<string, unknown>) =>
    tool.inputSchema.safeParse({ customer_number: 10001, ...input }).success;

  it("takes a written quotation with headings, descriptions, optional lines, texts and draft", () => {
    assert.equal(parse(createQuotation, { items: written, introduction: "Ausgangslage", remark: "Bedingungen", draft: true }), true);
  });

  it("asks no quantity or price of a heading, and accepts none on it", () => {
    assert.equal(parse(createInvoice, { items: [{ type: "text", name: "Teil 1" }, items[0]] }), true);
    assert.equal(parse(createInvoice, { items: [{ type: "text", name: "Teil 1", quantity: 1 }, items[0]] }), false);
    assert.equal(parse(createInvoice, { items: [{ type: "text" }, items[0]] }), false);
  });

  it("keeps optional lines to quotations, as the API documents them", () => {
    const optional = [items[0], { ...items[0], optional: true }];
    assert.equal(parse(createQuotation, { items: optional }), true);
    assert.equal(parse(createOrderConfirmation, { items: optional }), false);
    assert.equal(parse(createInvoice, { items: optional }), false);
  });

  it("keeps draft to quotations and order confirmations — an invoice is always one", () => {
    assert.equal(parse(createOrderConfirmation, { items, draft: true }), true);
    assert.equal(parse(createInvoice, { items, draft: true }), false);
  });

  it("holds the API's text limits", () => {
    const long = "x".repeat(2001);
    assert.equal(parse(createQuotation, { items: [{ ...items[0], description: "x".repeat(2000) }] }), true);
    assert.equal(parse(createQuotation, { items: [{ ...items[0], description: long }] }), false);
    assert.equal(parse(createQuotation, { items, introduction: long }), false);
    assert.equal(parse(createOrderConfirmation, { items, remark: long }), false);
    assert.equal(parse(createInvoice, { items: [{ ...items[0], name: "x".repeat(256) }] }), false);
  });

  it("needs one line that carries the total", () => {
    assert.equal(parse(createQuotation, { items: [{ type: "text", name: "Teil 1" }] }), false);
    assert.equal(parse(createQuotation, { items: [{ ...items[0], optional: true }] }), false);
  });
});

describe("written documents", () => {
  const createdQuotation = () => [
    on("POST", /^\/quotations$/, () => ({ id: "new-1" }), 201),
    on("GET", /^\/quotations\/new-1$/, () => ({ id: "new-1", voucherNumber: "AG2026100", lineItems: [] })),
  ];

  it("sends every line as written and counts neither headings nor optional lines", async () => {
    const api = useApi(customer, noDocuments, ...createdQuotation());
    const result = await executeSalesDocument(
      "quotation",
      { customer_number: 10001, items: written, introduction: "Ausgangslage", remark: "Bedingungen" },
      { callId: "written-1" },
    );

    const body = api.calls.find((call) => call.method === "POST")!.body as { lineItems: Record<string, unknown>[]; introduction: string; remark: string };
    assert.deepEqual(body.lineItems.map((line) => line.type), ["text", "custom", "custom", "text", "custom"]);
    assert.equal(body.lineItems[1]!.description, "Enthalten:\n- Shop, Märkte, Zahlungsarten");
    assert.equal(body.lineItems[4]!.optional, true);
    assert.equal(body.introduction, "Ausgangslage");
    assert.equal(body.remark, "Bedingungen");
    assert.equal(result.netTotal, 1360);
    assert.equal(result.positions, 2);
    assert.equal(result.optionalPositions, 1);
    assert.equal(result.optionalNetTotal, 149);
  });

  it("creates a quotation as a draft on request", async () => {
    const api = useApi(customer, noDocuments, ...createdQuotation());
    const result = await executeSalesDocument("quotation", { customer_number: 10001, items: written, draft: true }, { callId: "written-2" });

    assert.equal(api.calls.find((call) => call.method === "POST")!.query.get("finalize"), null);
    assert.equal(result.status, "Entwurf");
    assert.match(String(result.note), /Entwurf/);
  });

  it("leaves the default texts alone when none are given", async () => {
    const api = useApi(customer, noDocuments, ...createdQuotation());
    await executeSalesDocument("quotation", { customer_number: 10001, items }, { callId: "written-3" });

    const body = api.calls.find((call) => call.method === "POST")!.body as Record<string, unknown>;
    assert.equal("introduction" in body, false);
    assert.equal("remark" in body, false);
  });

  it("checks duplicates on the total that counts", async () => {
    useApi(
      customer,
      on("GET", /^\/voucherlist$/, () => ({ content: [{ id: "q-1", voucherNumber: "AG2026001", voucherDate: "2026-10-01", voucherStatus: "draft" }] })),
      quotation([{ net: 400 }, { net: 160, quantity: 6 }]),
    );
    const warnings = await runSalesPreflight("quotation", { customer_number: 10001, items: written });

    assert.equal(warnings.find((warning) => warning.kind === "sales-duplicate")?.voucherNumber, "AG2026001");
  });

  it("compares with the source without its optional lines", async () => {
    useApi(
      customer,
      noDocuments,
      on("GET", /^\/quotations\//, () => ({
        id: "q-1",
        voucherNumber: "AG2026001",
        address: { contactId: "c-1", name: "Nordlicht Consulting GmbH" },
        lineItems: [
          { type: "text", name: "Teil 1" },
          { type: "custom", name: "A", quantity: 2, unitName: "Tag", unitPrice: { netAmount: 1200, taxRatePercentage: 19 } },
          { type: "custom", name: "B", quantity: 1, unitName: "Monat", unitPrice: { netAmount: 149, taxRatePercentage: 19 }, optional: true },
        ],
      })),
    );
    const warnings = await runSalesPreflight("invoice", {
      customer_number: 10001,
      items,
      source_document_id: "3f0ef2e1-5f2b-4b44-9f0f-3b4bd7f0f0aa",
      source_document_type: "quotation",
    });

    assert.ok(!warnings.some((warning) => warning.kind === "source-mismatch"));
    assert.ok(!warnings.some((warning) => warning.kind === "source-chain-impossible"));
  });

  it("creates an order confirmation from a quotation with optional lines without the chain the API refuses", async () => {
    const source = on("GET", /^\/quotations\//, () => ({
      id: "q-1",
      voucherNumber: "AG2026001",
      address: { contactId: "c-1", name: "Nordlicht Consulting GmbH" },
      lineItems: [
        { type: "custom", name: "A", quantity: 2, unitName: "Tag", unitPrice: { netAmount: 1200, taxRatePercentage: 19 } },
        { type: "custom", name: "B", quantity: 1, unitName: "Monat", unitPrice: { netAmount: 149, taxRatePercentage: 19 }, optional: true },
      ],
    }));
    const input = { customer_number: 10001, items, source_document_id: "3f0ef2e1-5f2b-4b44-9f0f-3b4bd7f0f0aa", source_document_type: "quotation" as const };

    useApi(customer, noDocuments, source);
    const warnings = await runSalesPreflight("order-confirmation", input);
    assert.equal(warnings.find((warning) => warning.kind === "source-chain-impossible")?.sourceLabel, "Angebot AG2026001");

    const api = useApi(
      customer,
      noDocuments,
      source,
      on("POST", /^\/order-confirmations$/, () => ({ id: "new-1" }), 201),
      on("GET", /^\/order-confirmations\//, () => ({ id: "new-1", lineItems: [] })),
    );
    const result = await executeSalesDocument("order-confirmation", input, { callId: "written-4" });

    const posts = api.calls.filter((call) => call.method === "POST");
    assert.equal(posts.length, 1);
    assert.equal(posts[0]!.query.get("precedingSalesVoucherId"), null);
    assert.equal(posts[0]!.query.get("finalize"), "true");
    assert.match(String(result.sourceDocument), /optionale Positionen/);
  });
});

describe("document fields", () => {
  const posted = (api: { calls: { method: string; body: unknown }[] }) => api.calls.find((call) => call.method === "POST")!.body as Record<string, any>;
  const createdAs = (path: string) => [
    on("POST", new RegExp(`^/${path}$`), () => ({ id: "new-1" }), 201),
    on("GET", new RegExp(`^/${path}/new-1$`), () => ({ id: "new-1", voucherNumber: "X1", lineItems: [] })),
  ];

  it("puts service period and payment term of an invoice into the fields — a service period", async () => {
    const api = useApi(customer, noDocuments, ...createdAs("invoices"));
    const result = await executeSalesDocument(
      "invoice",
      { customer_number: 10001, items, service_period: { from: "2026-09-16", to: "2026-09-30" }, payment_term_days: 14, voucher_date: "2026-10-13" },
      { callId: "fields-1" },
    );

    const body = posted(api);
    assert.deepEqual(body.shippingConditions, {
      shippingType: "serviceperiod",
      shippingDate: "2026-09-16T00:00:00.000+02:00",
      shippingEndDate: "2026-09-30T00:00:00.000+02:00",
    });
    assert.deepEqual(body.paymentConditions, { paymentTermLabel: "Zahlbar innerhalb von 14 Tagen ohne Abzug", paymentTermDuration: 14 });
    assert.equal(body.voucherDate, "2026-10-13T00:00:00.000+02:00");
    assert.equal(result.paymentTerm, "Zahlbar innerhalb von 14 Tagen ohne Abzug");
    assert.equal(result.shipping, "serviceperiod 2026-09-16 – 2026-09-30");
  });

  it("maps every field of an order confirmation: delivery date, terms, skonto, discounts, tax, language, layout", async () => {
    const api = useApi(
      customer,
      noDocuments,
      on("GET", /^\/print-layouts$/, () => [{ id: "layout-en", name: "Englisch", default: false }]),
      ...createdAs("order-confirmations"),
    );
    await executeSalesDocument(
      "order-confirmation",
      {
        customer_number: 10001,
        items: [{ ...items[0]!, discount_percent: 10 }],
        delivery_date: "2026-11-02",
        delivery_terms: "Lieferung frei Haus",
        payment_term_days: 30,
        cash_discount: { percent: 2, days: 10 },
        total_discount_percent: 5,
        language: "en",
        print_layout: "englisch",
        title: "Projekt Nordlicht",
      },
      { callId: "fields-2" },
    );

    const body = posted(api);
    assert.deepEqual(body.shippingConditions, { shippingType: "delivery", shippingDate: "2026-11-02T00:00:00.000+01:00" });
    assert.equal(body.deliveryTerms, "Lieferung frei Haus");
    assert.deepEqual(body.paymentConditions, {
      paymentTermLabel: "10 Tage 2 % Skonto, 30 Tage netto",
      paymentTermDuration: 30,
      paymentDiscountConditions: { discountPercentage: 2, discountRange: 10 },
    });
    assert.deepEqual(body.totalPrice, { currency: "EUR", totalDiscountPercentage: 5 });
    assert.equal(body.lineItems[0].discountPercentage, 10);
    assert.deepEqual(body.taxConditions, { taxType: "net" });
    assert.equal(body.language, "en");
    assert.equal(body.printLayoutId, "layout-en");
    assert.equal(body.title, "Projekt Nordlicht");
  });

  it("sends a quotation without shipping conditions, with gross prices, alternatives, an article and its validity", async () => {
    const api = useApi(
      customer,
      noDocuments,
      on("GET", /^\/articles\/a0000000-0000-4000-8000-000000000001$/, () => ({ id: "a0000000-0000-4000-8000-000000000001", title: "Hosting S", type: "SERVICE" })),
      ...createdAs("quotations"),
    );
    const result = await executeSalesDocument(
      "quotation",
      {
        customer_number: 10001,
        tax_type: "gross",
        voucher_date: "2026-10-13",
        items: [
          {
            name: "Hosting S",
            quantity: 12,
            unit: "Monat",
            gross_price: 29.75,
            tax_rate: 19,
            article_id: "a0000000-0000-4000-8000-000000000001",
            alternatives: [{ name: "Hosting M", quantity: 12, unit: "Monat", gross_price: 59.5, tax_rate: 19 }],
          },
        ],
        total_discount_amount: 10,
      },
      { callId: "fields-3" },
    );

    const body = posted(api);
    assert.equal("shippingConditions" in body, false);
    assert.deepEqual(body.taxConditions, { taxType: "gross" });
    assert.deepEqual(body.lineItems[0].unitPrice, { currency: "EUR", grossAmount: 29.75, taxRatePercentage: 19 });
    assert.equal(body.lineItems[0].id, "a0000000-0000-4000-8000-000000000001");
    assert.equal(body.lineItems[0].type, "service");
    assert.equal(body.lineItems[0].subItems[0].alternative, true);
    assert.deepEqual(body.totalPrice, { currency: "EUR", totalDiscountAbsolute: 10 });
    assert.equal(body.expirationDate, "2026-11-12T00:00:00.000+01:00");
    assert.equal(result.validUntil, "2026-11-12");
    assert.equal(result.netTotal, 300);
  });

  it("sends § 13b with 0 % and its note, and a Leitweg-ID override", async () => {
    const api = useApi(customer, noDocuments, ...createdAs("invoices"));
    await executeSalesDocument(
      "invoice",
      {
        customer_number: 10001,
        items: [{ ...items[0]!, tax_rate: 0 }],
        service_date: "2026-10-01",
        tax_type: "externalService13b",
        tax_note: "Steuerschuldnerschaft des Leistungsempfängers",
        buyer_reference: "04011000-1234512345-06",
      },
      { callId: "fields-4" },
    );

    const body = posted(api);
    assert.deepEqual(body.taxConditions, { taxType: "externalService13b", taxTypeNote: "Steuerschuldnerschaft des Leistungsempfängers" });
    assert.deepEqual(body.shippingConditions, { shippingType: "service", shippingDate: "2026-10-01T00:00:00.000+02:00" });
    assert.deepEqual(body.xRechnung, { buyerReference: "04011000-1234512345-06" });
  });

  it("stops before writing when the print layout is gone", async () => {
    const api = useApi(customer, noDocuments, on("GET", /^\/print-layouts$/, () => []), ...createdAs("invoices"));
    await assert.rejects(
      () => executeSalesDocument("invoice", { customer_number: 10001, items, print_layout: "Englisch" }, { callId: "fields-5" }),
      /Druckvorlage/,
    );
    assert.equal(api.calls.filter((call) => call.method === "POST").length, 0);
  });
});

describe("document field validation", () => {
  const parse = (tool: { inputSchema: { safeParse(value: unknown): { success: boolean; error?: { issues: { message: string }[] } } } }, input: Record<string, unknown>) =>
    tool.inputSchema.safeParse({ customer_number: 10001, items, ...input });
  const ok = (tool: Parameters<typeof parse>[0], input: Record<string, unknown>) => parse(tool, input).success;
  const message = (tool: Parameters<typeof parse>[0], input: Record<string, unknown>) => (parse(tool, input).error?.issues ?? []).map((issue) => issue.message).join(" | ");

  it("takes a service period and a payment term", () => {
    assert.equal(ok(createInvoice, { service_period: { from: "2026-09-16", to: "2026-09-30" }, payment_term_days: 14 }), true);
  });

  it("refuses a period that ends before it starts, and a day that does not exist", () => {
    assert.equal(ok(createInvoice, { service_period: { from: "2026-09-30", to: "2026-09-16" } }), false);
    assert.equal(ok(createInvoice, { service_date: "2026-02-30" }), false);
    assert.equal(ok(createInvoice, { voucher_date: "13.10.2026" }), false);
  });

  it("takes one kind of service date only", () => {
    assert.match(message(createInvoice, { service_date: "2026-09-30", service_period: { from: "2026-09-16", to: "2026-09-30" } }), /Nur eines von/);
  });

  it("keeps fields to the kinds the API knows them for", () => {
    assert.equal(ok(createQuotation, { service_date: "2026-09-30" }), false);
    assert.equal(ok(createInvoice, { delivery_terms: "frei Haus" }), false);
    assert.equal(ok(createOrderConfirmation, { delivery_terms: "frei Haus" }), true);
    assert.equal(ok(createOrderConfirmation, { buyer_reference: "x" }), false);
    assert.equal(ok(createInvoice, { items: [{ ...items[0], alternatives: [items[0]] }] }), false);
    assert.equal(ok(createQuotation, { items: [{ ...items[0], alternatives: [items[0]] }] }), true);
  });

  it("needs a payment term for its label and skonto, and skonto within it", () => {
    assert.equal(ok(createInvoice, { cash_discount: { percent: 2, days: 10 } }), false);
    assert.equal(ok(createInvoice, { payment_term_label: "sofort" }), false);
    assert.match(message(createInvoice, { payment_term_days: 7, cash_discount: { percent: 2, days: 10 } }), /Skontofrist/);
    assert.equal(ok(createInvoice, { payment_term_days: 30, cash_discount: { percent: 2, days: 10 } }), true);
  });

  it("takes one total discount", () => {
    assert.equal(ok(createQuotation, { total_discount_percent: 5 }), true);
    assert.equal(ok(createQuotation, { total_discount_percent: 5, total_discount_amount: 10 }), false);
  });

  it("holds tax types to their rates and prices", () => {
    assert.match(message(createInvoice, { tax_type: "intraCommunitySupply" }), /tax_rate 0/);
    assert.equal(ok(createInvoice, { tax_type: "intraCommunitySupply", items: [{ ...items[0], tax_rate: 0 }] }), true);
    assert.match(message(createInvoice, { tax_type: "gross" }), /gross_price/);
    assert.equal(ok(createInvoice, { tax_type: "gross", items: [{ name: "A", quantity: 1, unit: "Stück", gross_price: 119, tax_rate: 19 }] }), true);
    assert.equal(ok(createInvoice, { items: [{ name: "A", quantity: 1, unit: "Stück", gross_price: 119, tax_rate: 19 }] }), false);
    assert.equal(ok(createInvoice, { items: [{ ...items[0], gross_price: 119 }] }), false);
    assert.equal(ok(createInvoice, { items: [{ ...items[0], tax_rate: 21 }] }), false);
    assert.equal(ok(createInvoice, { items: [{ ...items[0], tax_rate: 21 }], tax_sub_type: "distanceSales" }), true);
    assert.equal(ok(createInvoice, { tax_note: "Hinweis" }), false);
  });

  it("refuses a quotation valid before its own date", () => {
    assert.equal(ok(createQuotation, { voucher_date: "2026-10-13", valid_until: "2026-10-01" }), false);
  });
});

describe("document field checks before the card", () => {
  const titles = (warnings: { kind: string; title?: string; value?: string }[]) => warnings.filter((warning) => warning.kind === "note").map((warning) => `${warning.title}: ${warning.value}`);

  it("warns when an invoice says nothing about when the service was supplied", async () => {
    useApi(customer, noDocuments, paymentDefault(14));
    const notes = titles(await runSalesPreflight("invoice", { customer_number: 10001, items, payment_term_days: 14 }));
    assert.ok(notes.some((note) => /^⚠ Leistungsdatum fehlt: .*§ 14 Abs. 4 Nr. 6 UStG/.test(note)), notes.join("\n"));
  });

  it("does not warn on an order confirmation or with a service period", async () => {
    useApi(customer, noDocuments, paymentDefault(14));
    assert.ok(!titles(await runSalesPreflight("order-confirmation", { customer_number: 10001, items })).some((note) => /Leistungsdatum/.test(note)));
    assert.ok(!titles(await runSalesPreflight("invoice", { customer_number: 10001, items, service_date: "2026-10-01" })).some((note) => /Leistungsdatum/.test(note)));
  });

  it("names the payment term that applies without one, and warns on „sofort“", async () => {
    useApi(customer, noDocuments, paymentDefault(0));
    const notes = titles(await runSalesPreflight("invoice", { customer_number: 10001, items, service_date: "2026-10-01" }));
    assert.ok(notes.includes("⚠ Zahlungsziel-Vorgabe: nicht angegeben — es gilt die Zahlungsbedingung des Kontakts, falls dort eine hinterlegt ist, sonst der Konto-Standard „Zahlbar sofort, rein netto“"), notes.join("\n"));
  });

  it("asks nothing about the payment term when one is given", async () => {
    const api = useApi(customer, noDocuments, paymentDefault(0));
    await runSalesPreflight("invoice", { customer_number: 10001, items, service_date: "2026-10-01", payment_term_days: 14 });
    assert.ok(!api.calls.some((call) => call.path === "/payment-conditions"));
  });

  it("checks a reverse-charge customer for VAT ID and country", async () => {
    useApi(
      on("GET", /^\/contacts$/, () => ({ content: [{ ...contact("c-1", "Acme BV", { customer: { number: 10001 } }), addresses: { billing: [{ countryCode: "CH" }] } }] })),
      noDocuments,
      paymentDefault(14),
      on("GET", /^\/countries$/, () => [{ countryCode: "CH", countryNameDE: "Schweiz", taxClassification: "thirdPartyCountry" }]),
    );
    const notes = titles(await runSalesPreflight("invoice", { customer_number: 10001, items: [{ ...items[0]!, tax_rate: 0 }], tax_type: "externalService13b", service_date: "2026-10-01" }));
    assert.ok(notes.some((note) => /USt-IdNr/.test(note)), notes.join("\n"));
    assert.ok(notes.some((note) => /Schweiz/.test(note)), notes.join("\n"));
  });

  it("says when a print layout does not exist", async () => {
    useApi(customer, noDocuments, paymentDefault(14), on("GET", /^\/print-layouts$/, () => [{ id: "l-1", name: "Standard", default: true }]));
    const notes = titles(await runSalesPreflight("quotation", { customer_number: 10001, items, print_layout: "Englisch" }));
    assert.ok(notes.some((note) => /^⚠ Druckvorlage: „Englisch“ nicht eindeutig gefunden/.test(note)), notes.join("\n"));
  });
});
