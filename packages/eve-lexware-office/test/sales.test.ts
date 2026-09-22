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
