/** Findings: how they read on a card, and which of them a better call could fix. */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import "./harness.ts";

const { describeWarning, isCorrectable } = await import("../dist/extension/lib/findings.mjs");

describe("describeWarning", () => {
  it("marks a warning with ⚠ and leaves plain facts unmarked", () => {
    assert.equal(describeWarning({ kind: "customer-resolved", name: "Nordlicht Consulting GmbH", number: 10001 }).title, "Kunde");
    assert.equal(describeWarning({ kind: "sales-contact", reason: "unklar" }).title, "⚠ Kunde");
  });

  it("names the customer with the number as the account knows it", () => {
    const finding = describeWarning({ kind: "customer-resolved", name: "Nordlicht Consulting GmbH", number: 10001 });
    assert.equal(finding.value, "Nordlicht Consulting GmbH (Nr. 10001)");
  });

  it("puts document, date, status and link into a duplicate", () => {
    const finding = describeWarning({
      kind: "sales-duplicate",
      documentLabel: "Auftragsbestätigung",
      url: "https://app.lexware.de/vouchers#!/VoucherDetail/aaaa1111",
      voucherNumber: "AB20260007",
      voucherDate: "2026-08-21",
      voucherStatus: "open",
    });

    assert.equal(finding.title, "⚠ Dublette");
    assert.match(finding.value, /AB20260007, 21.8.2026, open/);
    assert.match(finding.value, /aaaa1111$/);
  });

  it("states the difference of a totals mismatch in the invoice currency", () => {
    const finding = describeWarning({ kind: "voucher-total-mismatch", computed: 1400, expected: 1578.83, difference: -178.83, currency: "USD" });
    assert.match(finding.value, /1\.400,00 USD/);
    assert.match(finding.value, /-178,83 USD/);
  });

  it("calls out a foreign invoice booked one to one", () => {
    const converted = describeWarning({ kind: "voucher-foreign-currency", currency: "USD", original: 51.75, booked: 44.12, rate: 0.8526 });
    const unconverted = describeWarning({ kind: "voucher-foreign-currency", currency: "USD", original: 51.75, booked: 51.75, rate: 1 });

    assert.equal(converted.title, "Fremdwährung");
    assert.equal(unconverted.title, "⚠ Fremdwährung");
    assert.match(unconverted.value, /1:1/);
  });

  it("warns when a reverse-charge category meets an invoice that charges VAT", () => {
    const clean = describeWarning({ kind: "voucher-reverse-charge", categories: ["Fremdleistungen §13b Drittland"], rate: 19, invoiceChargesTax: false });
    const conflict = describeWarning({ kind: "voucher-reverse-charge", categories: ["Fremdleistungen §13b Drittland"], rate: 19, invoiceChargesTax: true });

    assert.equal(clean.title, "Reverse Charge");
    assert.equal(conflict.title, "⚠ Reverse Charge");
    assert.match(conflict.value, /weist aber Umsatzsteuer aus/);
  });

  it("says a copied document loses the source's discount", () => {
    const finding = describeWarning({ kind: "source-discount", sourceLabel: "Angebot AG2026001", discountAbsolute: 240, sourceNet: 2160 });
    assert.match(finding.value, /NICHT/);
    assert.match(finding.value, /240,00 EUR/);
  });
});

describe("isCorrectable", () => {
  it("sends back what a better call can fix", () => {
    assert.equal(isCorrectable({ kind: "voucher-total-mismatch", computed: 1, expected: 2, difference: -1, currency: "EUR" }), true);
    assert.equal(isCorrectable({ kind: "category-ambiguous", candidates: ["Wareneinkauf", "Lizenzen"] }), true);
    assert.equal(isCorrectable({ kind: "category-deviation", chosen: "Lizenzen", usual: "Wareneinkauf" }), true);
  });

  it("leaves everything else to the user at the card", () => {
    assert.equal(isCorrectable({ kind: "voucher-duplicate", url: "u", voucherNumber: "R-2026-0042" }), false);
    assert.equal(isCorrectable({ kind: "sales-contact", reason: "unklar" }), false);
    assert.equal(isCorrectable({ kind: "voucher-attachment-missing", reason: "weg" }), false);
  });
});
