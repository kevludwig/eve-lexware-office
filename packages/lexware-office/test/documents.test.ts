import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  LexwareApiError,
  createSalesDocument,
  createVoucher,
  findDuplicateSalesDocument,
  findPurchaseInvoiceByNumber,
  findVendorCategoryHistory,
  getSalesDocument,
  invoiceExists,
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
