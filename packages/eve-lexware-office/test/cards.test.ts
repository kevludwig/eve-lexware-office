/** The approval cards: what a user sees before saying yes. */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import "./harness.ts";

const { approvalCard, ownTool } = await import("../dist/extension/lib/cards.mjs");

const factOf = (card: { facts: { title: string; value: string }[] }, title: string) => card.facts.find((fact) => fact.title === title)?.value;

const items = [
  { name: "Workshop-Tag", quantity: 2, unit: "Tag", net_price: 1200, tax_rate: 19 },
  { name: "Anreisepauschale", quantity: 1, unit: "Pauschale", net_price: 150, tax_rate: 19 },
];

describe("approvalCard", () => {
  it("knows its own tools under the mount's prefix", () => {
    assert.equal(ownTool("lexware__create_quotation"), "create_quotation");
    assert.equal(ownTool("create_quotation"), "create_quotation");
    assert.equal(ownTool("lexware__create_custom_invoice"), null);
    assert.equal(ownTool("read"), null);
    assert.equal(approvalCard("create_custom_invoice", "call", {}), null);
  });

  it("shows customer, positions and totals of a quotation", () => {
    const card = approvalCard("lexware__create_quotation", "call", { customer_number: 10001, items, valid_until: "2026-10-31" })!;

    assert.equal(card.tool, "create_quotation");
    assert.equal(card.title, "Angebot anlegen?");
    assert.equal(card.subtitle, "2 Positionen · 2.550,00 EUR netto");
    assert.equal(factOf(card, "Kundennummer"), "10001");
    assert.equal(factOf(card, "Netto"), "2.550,00 EUR");
    assert.equal(factOf(card, "Brutto"), "3.034,50 EUR");
    assert.equal(factOf(card, "Gültig bis"), "31.10.2026");
    assert.match(card.note!, /festgeschrieben/);
  });

  it("counts a single position in the singular", () => {
    const card = approvalCard("lexware__create_quotation", "call", { customer_number: 10001, items: items.slice(1) })!;
    assert.equal(card.subtitle, "1 Position · 150,00 EUR netto");
  });

  it("names the source document of an order confirmation", () => {
    const card = approvalCard("lexware__create_order_confirmation", "call", { contact_id: "c-1", items, quotation_id: "q-1" })!;

    assert.equal(factOf(card, "Kontakt"), "c-1");
    assert.equal(factOf(card, "Bezugsbeleg"), "q-1");
  });

  it("says an invoice stays a draft", () => {
    const card = approvalCard("lexware__create_invoice", "call", { customer_number: 10001, items })!;
    assert.match(card.note!, /Entwurf/);
  });

  it("shows a purchase invoice with its booked amounts and the original", () => {
    const card = approvalCard("lexware__create_purchase_invoice", "call", {
      supplier_name: "Musterlieferant GmbH",
      voucher_number: "R-2026-0042",
      voucher_date: "2026-05-13",
      total_gross_amount: 1578.83,
      tax_groups: [{ gross_amount: 1578.83, tax_rate_percent: 19 }],
      category: "Wareneinkauf",
      attachment_path: "/workspace/attachments/0123456789abcdef/R-2026-0042.pdf",
    })!;

    assert.equal(card.subtitle, "Musterlieferant GmbH · Rechnung R-2026-0042 · 1.578,83 EUR brutto");
    assert.equal(factOf(card, "davon USt."), "252,08 EUR (1.578,83 EUR zu 19 %)");
    assert.equal(factOf(card, "Netto"), "1.326,75 EUR");
    assert.equal(factOf(card, "Rechnungsendbetrag"), "1.578,83 EUR — passt");
    assert.equal(factOf(card, "Buchungskategorie"), "Wareneinkauf");
    assert.equal(factOf(card, "Original"), "R-2026-0042.pdf");
  });

  it("shows a foreign invoice with the debited amount, and the invoice amount beside it", () => {
    const card = approvalCard("lexware__create_purchase_invoice", "call", {
      supplier_name: "Cloud Services Ltd.",
      voucher_number: "INV-2026-0311",
      currency: "USD",
      bank_statement_eur_amount: 44.12,
      total_gross_amount: 51.75,
      tax_groups: [{ gross_amount: 51.75, tax_rate_percent: 0 }],
    })!;

    assert.equal(card.subtitle, "Cloud Services Ltd. · Rechnung INV-2026-0311 · 44,12 EUR brutto (51,75 USD)");
    assert.equal(factOf(card, "Brutto"), "44,12 EUR");
    assert.equal(factOf(card, "Rechnungsendbetrag"), "51,75 USD — passt");
    assert.equal(factOf(card, "Original"), "kein Anhang");
  });

  it("names the difference when the tax groups miss the invoice total", () => {
    const card = approvalCard("lexware__create_purchase_invoice", "call", {
      supplier_name: "Beispiel Hosting GmbH",
      voucher_number: "R-1",
      total_gross_amount: 100,
      tax_groups: [{ gross_amount: 90, tax_rate_percent: 19 }],
    })!;

    assert.equal(factOf(card, "Rechnungsendbetrag"), "100,00 EUR — Abweichung -10,00 EUR");
  });

  it("shows name and address of a new customer", () => {
    const card = approvalCard("lexware__create_customer", "call", {
      company_name: "Nordlicht Consulting GmbH",
      street: "Deichstraße 12",
      zip: "20459",
      city: "Hamburg",
    })!;

    assert.equal(card.subtitle, "Nordlicht Consulting GmbH");
    assert.equal(factOf(card, "Adresse"), "Deichstraße 12, 20459 Hamburg");
    assert.equal(factOf(card, "E-Mail"), undefined);
  });

  it("shows invoice, amount and days overdue on a payment reminder", () => {
    const due = new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10);
    const card = approvalCard("lexware__send_payment_reminder", "call", {
      voucher_number: "RE20260042",
      customer_name: "Nordlicht Consulting GmbH",
      open_amount: 1190,
      due_date: due,
    })!;

    assert.equal(card.subtitle, "Nordlicht Consulting GmbH · Rechnung RE20260042 · 1.190,00 EUR offen");
    assert.match(factOf(card, "Fällig seit")!, /\(5 Tage\)$/);
    assert.equal(factOf(card, "Anhang"), "RE20260042.pdf");
  });
});
