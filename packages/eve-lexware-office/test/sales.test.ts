/** Quotation, order confirmation, invoice: the checks before the card and the write after it. */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { contact, on, useApi, type Route } from "./harness.ts";

const { executeSalesDocument, isCalendarDate, isDocumentTypeLabel, runSalesPreflight, toLineItems } = await import("../dist/extension/lib/sales.mjs");

const items = [{ name: "Workshop-Tag", quantity: 2, unit: "Tag", net_price: 1200, tax_rate: 19 }];

const customer = on("GET", /^\/contacts$/, () => ({ content: [contact("c-1", "Nordlicht Consulting GmbH", { customer: { number: 10001 } })] }));
const noDocuments = on("GET", /^\/voucherlist$/, () => ({ content: [] }));

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
    useApi(customer, noDocuments);
    const warnings = await runSalesPreflight("quotation", { customer_number: 10001, items });

    assert.deepEqual(warnings, [{ kind: "customer-resolved", name: "Nordlicht Consulting GmbH", number: 10001 }]);
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
  { name: "Aufwandskontingent", quantity: 6, unit: "Stunde", net_price: 160, tax_rate: 19 },
  { type: "text", name: "Teil 3: Laufender Betrieb (optional)" },
  { name: "Übersetzung auf Autopilot", quantity: 1, unit: "Monat", net_price: 149, tax_rate: 19, optional: true },
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
