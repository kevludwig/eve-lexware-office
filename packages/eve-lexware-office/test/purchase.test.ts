/** The purchase invoice: foreign currency, supplier, category, and the checks before the card. */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { category, contact, on, useApi } from "./harness.ts";

const {
  bookedGroupsOf,
  impliedRateOf,
  isAllowedAttachmentPath,
  lacksEurAmount,
  purchaseSignatureOf,
  resolveSupplier,
  runPurchasePreflight,
  totalsOf,
} = await import("../dist/extension/lib/purchase.mjs");

// Ids are UUIDs, as the API hands them out — a category is resolved by id.
const WARENEINKAUF = category("8f8bb3b1-1d5e-4a6f-9b5d-0d2f9f2f1a01", "Wareneinkauf");
const LIZENZEN = category("8f8bb3b1-1d5e-4a6f-9b5d-0d2f9f2f1a02", "Fremdleistungen §13b Drittland");

/** The vendor's booked vouchers, each with the categories of its items. */
const vendorHistory = (...vouchers: { id: string; categories: string[] }[]) => [
  on("GET", /^\/voucherlist$/, (call) =>
    call.query.get("voucherType") === "purchaseinvoice"
      ? { content: vouchers.map((voucher) => ({ id: voucher.id, voucherNumber: voucher.id, voucherDate: "2026-01-01", voucherStatus: "paid" })) }
      : { content: [] },
  ),
  on("GET", /^\/vouchers\//, (call) => {
    const id = call.path.split("/").pop();
    const found = vouchers.find((voucher) => voucher.id === id);
    return { voucherItems: (found?.categories ?? []).map((categoryId) => ({ categoryId })) };
  }),
  on("GET", /^\/posting-categories$/, () => [WARENEINKAUF, LIZENZEN]),
];

const vendor = (...names: string[]) => on("GET", /^\/contacts$/, () => ({ content: names.map((name, index) => contact(`v${index}`, name)) }));

describe("amounts", () => {
  it("sums gross, tax and net over the tax groups", () => {
    const totals = totalsOf([
      { gross_amount: 119, tax_rate_percent: 19 },
      { gross_amount: 107, tax_rate_percent: 7 },
    ]);
    assert.deepEqual(totals, { gross: 226, tax: 26, net: 200 });
  });

  it("books a foreign invoice with the debited amount, to the cent", () => {
    const input = {
      currency: "USD",
      bank_statement_eur_amount: 44.12,
      tax_groups: [
        { gross_amount: 25.75, tax_rate_percent: 0 },
        { gross_amount: 26, tax_rate_percent: 0 },
      ],
    };
    const booked = bookedGroupsOf(input);

    assert.equal(totalsOf(booked).gross, 44.12);
    assert.equal(booked.length, 2);
    assert.ok(impliedRateOf(input)! < 1);
  });

  it("leaves a EUR invoice and an invoice without the bank amount untouched", () => {
    const groups = [{ gross_amount: 100, tax_rate_percent: 19 }];
    assert.deepEqual(bookedGroupsOf({ tax_groups: groups }), groups);
    assert.deepEqual(bookedGroupsOf({ currency: "USD", tax_groups: groups }), groups);
    assert.equal(lacksEurAmount({ currency: "USD", tax_groups: groups }), true);
    assert.equal(lacksEurAmount({ currency: "EUR", tax_groups: groups }), false);
    assert.equal(impliedRateOf({ tax_groups: groups }), null);
  });

  it("allows only eve's staging paths as an attachment", () => {
    assert.equal(isAllowedAttachmentPath("/workspace/attachments/0123456789abcdef/R-2026-0042.pdf"), true);
    assert.equal(isAllowedAttachmentPath("/workspace/secrets.pdf"), false);
    assert.equal(isAllowedAttachmentPath("/workspace/attachments/../../etc/passwd"), false);
    assert.equal(isAllowedAttachmentPath("/etc/passwd"), false);
  });

  it("changes the signature with the numbers and with the category choice", () => {
    const input = { voucher_number: "R-1", voucher_date: "2026-01-01", total_gross_amount: 119, tax_groups: [{ gross_amount: 119, tax_rate_percent: 19 }] };

    assert.equal(purchaseSignatureOf(input), purchaseSignatureOf({ ...input }));
    assert.notEqual(purchaseSignatureOf(input), purchaseSignatureOf({ ...input, total_gross_amount: 120 }));
    assert.notEqual(purchaseSignatureOf(input), purchaseSignatureOf({ ...input, category: "Wareneinkauf" }));
  });
});

describe("resolveSupplier", () => {
  it("takes the vendor contact with that name", async () => {
    useApi(vendor("Musterlieferant GmbH"));
    const supplier = await resolveSupplier({ supplier_name: "Musterlieferant GmbH" });

    assert.equal(supplier.contactId, "v0");
    assert.deepEqual(supplier.warnings, []);
  });

  it("falls back to the collective vendor — and says so — when nobody matches", async () => {
    useApi(on("GET", /^\/contacts$/, () => ({ content: [] })));
    const supplier = await resolveSupplier({ supplier_name: "Unbekannt GmbH" });

    assert.equal(supplier.contactId, undefined);
    assert.equal(supplier.contactName, "Unbekannt GmbH");
    assert.equal(supplier.warnings[0]?.kind, "voucher-contact-fallback");
  });

  it("does not pick one of several matching vendors", async () => {
    useApi(vendor("Müller Bau GmbH", "Müller Service GmbH"));
    const supplier = await resolveSupplier({ supplier_name: "Müller" });

    assert.equal(supplier.contactId, undefined);
    assert.match(String(supplier.warnings[0]?.reason), /2 Lieferantenkontakte/);
  });

  it("refuses a contact_id that is not a vendor", async () => {
    useApi(on("GET", /^\/contacts\//, () => contact("c-1", "Kundin GmbH", { customer: {} })));
    const supplier = await resolveSupplier({ supplier_name: "Kundin GmbH", contact_id: "c-1" });

    assert.equal(supplier.contactId, undefined);
    assert.match(String(supplier.warnings[0]?.reason), /kein Lieferantenkontakt/);
  });
});

describe("runPurchasePreflight", () => {
  const input = {
    supplier_name: "Musterlieferant GmbH",
    voucher_number: "R-2026-0042",
    voucher_date: "2026-05-13",
    total_gross_amount: 1578.83,
    tax_groups: [{ gross_amount: 1578.83, tax_rate_percent: 19 }],
  };

  it("takes over the one category the vendor's booked invoices use", async () => {
    useApi(vendor("Musterlieferant GmbH"), ...vendorHistory({ id: "v-1", categories: [WARENEINKAUF.id] }));
    const result = await runPurchasePreflight(input);

    assert.equal(result.category?.name, "Wareneinkauf");
    assert.ok(result.warnings.some((warning) => warning.kind === "category-history"));
  });

  it("leaves the choice open when the vendor has several categories", async () => {
    useApi(
      vendor("Musterlieferant GmbH"),
      ...vendorHistory({ id: "v-1", categories: [WARENEINKAUF.id] }, { id: "v-2", categories: [LIZENZEN.id] }),
    );
    const result = await runPurchasePreflight(input);

    assert.equal(result.category, null);
    assert.ok(result.warnings.some((warning) => warning.kind === "category-ambiguous" || warning.kind === "category-split"));
  });

  it("flags tax groups that miss the invoice total", async () => {
    useApi(vendor("Musterlieferant GmbH"), ...vendorHistory({ id: "v-1", categories: [WARENEINKAUF.id] }));
    const result = await runPurchasePreflight({ ...input, tax_groups: [{ gross_amount: 1400, tax_rate_percent: 19 }] });

    const mismatch = result.warnings.find((warning) => warning.kind === "voucher-total-mismatch");
    assert.ok(mismatch);
    assert.equal(mismatch.difference, -178.83);
  });

  it("says when a reverse-charge category books an invoice that charges VAT", async () => {
    useApi(vendor("Cloud Services Ltd."), ...vendorHistory({ id: "v-1", categories: [LIZENZEN.id] }));
    const result = await runPurchasePreflight({ ...input, supplier_name: "Cloud Services Ltd." });

    const reverse = result.warnings.find((warning) => warning.kind === "voucher-reverse-charge");
    assert.ok(reverse);
    assert.equal(reverse.invoiceChargesTax, true);
  });

  it("finds an invoice of the same number already captured", async () => {
    useApi(
      vendor("Musterlieferant GmbH"),
      on("GET", /^\/voucherlist$/, (call) =>
        call.query.get("voucherNumber") === "R-2026-0042"
          ? { content: [{ id: "dup", voucherNumber: "R-2026-0042", voucherDate: "2026-05-13", voucherStatus: "paid", contactName: "Musterlieferant GmbH" }] }
          : { content: [] },
      ),
      on("GET", /^\/vouchers\//, () => ({ voucherItems: [] })),
      on("GET", /^\/posting-categories$/, () => [WARENEINKAUF, LIZENZEN]),
    );
    const result = await runPurchasePreflight(input);

    const duplicate = result.warnings.find((warning) => warning.kind === "voucher-duplicate");
    assert.ok(duplicate);
    assert.match(duplicate.url, /dup/);
  });

  it("flags a missing attachment instead of failing", async () => {
    useApi(vendor("Musterlieferant GmbH"), ...vendorHistory({ id: "v-1", categories: [WARENEINKAUF.id] }));
    const result = await runPurchasePreflight(
      { ...input, attachment_path: "/workspace/attachments/aaaaaaaaaaaaaaaa/R-2026-0042.pdf" },
      { readFileSize: async () => null },
    );

    assert.ok(result.warnings.some((warning) => warning.kind === "voucher-attachment-missing"));
  });
});
