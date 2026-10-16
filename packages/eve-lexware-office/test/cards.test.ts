/** The approval cards: what a user sees before saying yes. */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import "./harness.ts";

const { CARD_TEXT_BUDGET, ownTool } = await import("../dist/extension/lib/cards.mjs");
const { approvalCard } = await import("../dist/extension/lib/call-card.mjs");

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

  it("marks a draft quotation in title, subtitle and note", () => {
    const card = approvalCard("lexware__create_quotation", "call", { customer_number: 10001, items, draft: true })!;

    assert.equal(card.title, "Angebot als Entwurf anlegen?");
    assert.match(card.subtitle!, /· Entwurf$/);
    assert.match(card.note!, /^Entwurf — nicht festgeschrieben/);
  });

  it("marks a draft order confirmation the same way", () => {
    const card = approvalCard("lexware__create_order_confirmation", "call", { customer_number: 10001, items, draft: true })!;
    assert.equal(card.title, "Auftragsbestätigung als Entwurf anlegen?");
    assert.match(card.note!, /AB-Nummer/);
  });

  it("lists headings, described positions and optional lines apart, with their own total", () => {
    const card = approvalCard("lexware__create_quotation", "call", {
      customer_number: 10001,
      items: [
        { type: "text", name: "Teil 1: Festpreis", description: "Leistungen mit festem Umfang auf Basis der genannten Annahmen und zwei Korrekturschleifen." },
        { ...items[0], description: "**Enthalten:**\n- Workshop vor Ort\n- Protokoll" },
        { name: "Wartung", quantity: 1, unit: "Monat", net_price: 50, tax_rate: 19, optional: true },
        items[1],
      ],
      introduction: "Ausgangslage",
    })!;

    assert.equal(card.subtitle, "2 Positionen · 2.550,00 EUR netto · 1 optional");
    assert.equal(factOf(card, "Netto"), "2.550,00 EUR");
    assert.equal(factOf(card, "Optional"), "1 Pos. · 50,00 EUR netto, nicht in der Summe");
    assert.equal(factOf(card, "Einleitung"), "eigener Text (12 Zeichen)");
    assert.equal(factOf(card, "Schlussnotiz"), "Standard aus Lexware Office");
    const titles = card.facts.map((fact) => fact.title);
    assert.deepEqual(titles.slice(titles.indexOf("Schlussnotiz") + 1), ["▸ Teil 1: Festpreis", "1. Workshop-Tag", "2. Anreisepauschale", "Optional 3. Wartung"]);
    assert.equal(factOf(card, "▸ Teil 1: Festpreis"), "Leistungen mit festem Umfang auf Basis der genannten Annahm…");
    assert.equal(factOf(card, "1. Workshop-Tag"), "2 Tag × 1.200,00 EUR · Enthalten:");
    assert.equal(factOf(card, "Optional 3. Wartung"), "1 Monat × 50,00 EUR");
  });

  it("stays within the card budget with 300 long positions", () => {
    const many = Array.from({ length: 300 }, (_, index) => ({
      name: `Position ${index} ${"mit sehr langem Namen ".repeat(10)}`.slice(0, 255),
      description: "y".repeat(2000),
      quantity: 1,
      unit: "Stück",
      net_price: 1,
      tax_rate: 19,
      ...(index % 2 ? { optional: true } : {}),
    }));
    const card = approvalCard("lexware__create_quotation", "call", { customer_number: 10001, items: many, introduction: "x".repeat(2000) })!;
    const length = [card.title, card.subtitle, card.note, ...card.facts.flatMap((fact) => [fact.title, fact.value])].join("").length;

    assert.ok(length <= CARD_TEXT_BUDGET, `${length} characters`);
    assert.match(card.facts.at(-1)!.value, /weitere Zeilen/);
    assert.equal(new Set(card.facts.map((fact) => fact.title)).size, card.facts.length);
  });

  it("shows a long written quotation in full", () => {
    const fixed = ["Leistung A", "Leistung B", "Leistung C", "Leistung D", "Leistung E", "Leistung F", "Leistung G", "Leistung H", "Leistung I"];
    const lines = [
      { type: "text", name: "Teil 1: Festpreis", description: "Leistungen mit festem Umfang auf Basis der genannten Annahmen." },
      ...fixed.map((name) => ({ name, description: `Enthalten:\n- ${"Leistung ".repeat(80)}`, quantity: 1, unit: "Pauschale", net_price: 400, tax_rate: 19 })),
      { type: "text", name: "Teil 2: Leistungen nach Aufwand" },
      { name: "Stundenkontingent", description: "Kontingent, kein Mindestabruf", quantity: 6, unit: "Stunde", net_price: 100, tax_rate: 19 },
      { type: "text", name: "Teil 3: Laufender Betrieb (optional)" },
      { name: "Wartung", description: "x".repeat(1950), quantity: 1, unit: "Monat", net_price: 50, tax_rate: 19, optional: true },
    ];
    const card = approvalCard("lexware__create_quotation", "call", { customer_number: 10001, items: lines, introduction: "x".repeat(877), remark: "x".repeat(1201), draft: true })!;

    assert.equal(card.facts.filter((fact) => /^(▸ |\d+\. |Optional \d)/.test(fact.title)).length, 14);
    assert.ok(!card.facts.some((fact) => fact.title === "…"));
    assert.equal(factOf(card, "Optional 11. Wartung")?.startsWith("1 Monat × 50,00 EUR · "), true);
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
      company_name: "Beispiel GmbH",
      street: "Musterstraße 1",
      zip: "12345",
      city: "Musterstadt",
    })!;

    assert.equal(card.subtitle, "Beispiel GmbH");
    assert.equal(factOf(card, "Adresse"), "Musterstraße 1, 12345 Musterstadt");
    assert.equal(factOf(card, "E-Mail"), undefined);
  });

  it("shows invoice, amount and days overdue on a payment reminder", () => {
    const due = new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10);
    const card = approvalCard("lexware__send_payment_reminder", "call", {
      voucher_number: "RE2026-0042",
      customer_name: "Beispiel GmbH",
      open_amount: 1190,
      due_date: due,
    })!;

    assert.equal(card.subtitle, "Beispiel GmbH · Rechnung RE2026-0042 · 1.190,00 EUR offen");
    assert.match(factOf(card, "Fällig seit")!, /\(5 Tage\)$/);
    assert.equal(factOf(card, "Anhang"), "RE2026-0042.pdf");
  });
});

describe("sales card: dates, payment, tax, discounts", () => {
  /** An invoice with a service period in September, 14 days net. */
  const order = {
    customer_number: 10042,
    items: [{ name: "Beratung", quantity: 1, unit: "Pauschale", net_price: 1200, tax_rate: 19 }],
    voucher_date: "2026-10-13",
    service_period: { from: "2026-09-16", to: "2026-09-30" },
    payment_term_days: 14,
  };

  it("shows service period, payment term with due date, and tax type of an invoice", (t) => {
    const card = approvalCard("lexware__create_invoice", "call", order)!;

    assert.equal(factOf(card, "Leistungszeitraum"), "16.9.2026 – 30.9.2026");
    assert.equal(factOf(card, "Zahlungsziel"), "Zahlbar innerhalb von 14 Tagen ohne Abzug · fällig 27.10.2026");
    assert.equal(factOf(card, "Steuerart"), "Netto (USt. ausgewiesen)");
    assert.equal(factOf(card, "Belegdatum"), "13.10.2026");
    t.assert.snapshot(card);
  });

  it("says what Lexware prints when date and payment term are missing", () => {
    const card = approvalCard("lexware__create_invoice", "call", { customer_number: 10042, items: order.items })!;

    assert.equal(factOf(card, "Leistungsdatum"), "nicht angegeben — Lexware Office druckt „Lieferdatum = Belegdatum“");
    assert.equal(factOf(card, "Zahlungsziel"), "nicht angegeben — Vorgabe aus Lexware Office (siehe Befunde)");
  });

  it("shows a quotation's discounts, gross prices, alternatives, language and layout", (t) => {
    const card = approvalCard("lexware__create_quotation", "call", {
      customer_number: 10001,
      voucher_date: "2026-10-13",
      tax_type: "gross",
      items: [
        {
          name: "Hosting S",
          quantity: 12,
          unit: "Monat",
          gross_price: 29.75,
          tax_rate: 19,
          discount_percent: 10,
          alternatives: [{ name: "Hosting M", quantity: 12, unit: "Monat", gross_price: 59.5, tax_rate: 19 }],
        },
      ],
      total_discount_percent: 5,
      payment_term_days: 30,
      cash_discount: { percent: 2, days: 10 },
      language: "en",
      print_layout: "Englisch",
    })!;

    assert.equal(factOf(card, "Netto"), "256,50 EUR");
    assert.equal(factOf(card, "Brutto"), "305,24 EUR");
    assert.equal(factOf(card, "Rabatt"), "5 % auf die Summe (−13,50 EUR netto, vor Rabatt 270,00 EUR)");
    assert.equal(factOf(card, "1. Hosting S"), "12 Monat × 29,75 EUR brutto − 10 %");
    assert.equal(factOf(card, "Alternative zu 1. Hosting M"), "12 Monat × 59,50 EUR brutto · nicht in der Summe");
    assert.equal(factOf(card, "Zahlungsziel"), "10 Tage 2 % Skonto, 30 Tage netto");
    assert.equal(factOf(card, "Gültig bis"), "12.11.2026 (Standard)");
    assert.equal(factOf(card, "Leistungsdatum"), undefined);
    t.assert.snapshot(card);
  });

  it("shows reverse charge with its note, delivery terms and the Leitweg-ID", () => {
    const confirmation = approvalCard("lexware__create_order_confirmation", "call", {
      customer_number: 10001,
      items: [{ ...items[0], tax_rate: 0 }],
      tax_type: "externalService13b",
      tax_note: "Steuerschuldnerschaft des Leistungsempfängers",
      delivery_period: { from: "2026-11-02", to: "2026-11-06" },
      delivery_terms: "Lieferung frei Haus",
    })!;
    assert.equal(factOf(confirmation, "Steuerart"), "Fremdleistung EU (§ 13b UStG) · Hinweis: Steuerschuldnerschaft des Leistungsempfängers");
    assert.equal(factOf(confirmation, "Lieferzeitraum"), "2.11.2026 – 6.11.2026");
    assert.equal(factOf(confirmation, "Lieferbedingungen"), "Lieferung frei Haus");
    assert.equal(factOf(confirmation, "Brutto"), factOf(confirmation, "Netto"));

    const invoice = approvalCard("lexware__create_invoice", "call", { customer_number: 10001, items, buyer_reference: "", no_service_date: true })!;
    assert.equal(factOf(invoice, "Leitweg-ID"), "keine (normale Rechnung statt XRechnung)");
    assert.equal(factOf(invoice, "Leistungsdatum"), "keins (wird nicht gedruckt)");
  });
});
