/**
 * The approval cards of this extension's writing tools, built from the tool
 * input and the findings its approval stored. Channels only render them.
 */

import { countsToTotal, daysSince, isPricedLine, isVatFreeTaxType, lineNet, netTotal, round2, type LineItem, type PricedLineItem } from "@kevludwig/lexware-office";

import { eur, shortDate } from "./format";
import { purchaseCard } from "./purchase-card";
import { TAX_TYPE_LABEL, berlinToday, paymentOf, shippingOf, toLineItems, validUntilOf, type SalesInput } from "./sales";
import { findingsOf } from "./findings";
import type { ApprovalCard } from "./types";

/** `reserved`: characters the findings already take on the card. */
type Builder = (input: Record<string, unknown>, reserved: number) => Omit<ApprovalCard, "tool" | "findings">;

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/**
 * Text a card may carry in all — Teams cuts a TextBlock at 4000 characters and
 * an approval must never be confirmed on a cut-off list. Below that with room
 * for the renderer's own labels and buttons.
 */
export const CARD_TEXT_BUDGET = 3500;
/** Positions listed one by one; the rest is counted. */
const MAX_LINE_FACTS = 15;
const DESCRIPTION_PREVIEW = 60;
/** The web card keeps a fact's title on one line. */
const NAME_PREVIEW = 40;

const cut = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value);

/** The first line of a description without its Markdown — enough to recognise it. */
function preview(description?: string): string {
  const line = (description ?? "")
    .split("\n")
    .map((part) => part.replace(/\*\*|__/g, "").replace(/^\s*[-*]\s+/, "").trim())
    .find(Boolean);
  return line ? cut(line, DESCRIPTION_PREVIEW) : "";
}

const quantity = (value: number) => value.toLocaleString("de-DE", { maximumFractionDigits: 4 });

const factLength = (facts: readonly { title: string; value: string }[]) => facts.reduce((sum, fact) => sum + fact.title.length + fact.value.length, 0);

/**
 * The positions in document order — headings as „▸", optional lines in a
 * block of their own after them, each with a cut description. Titles are
 * unique: the web card keys its rows by them.
 */
function lineFacts(items: readonly LineItem[], budget: number): { title: string; value: string }[] {
  const used = new Set<string>();
  const unique = (title: string) => {
    let candidate = title;
    for (let index = 2; used.has(candidate); index++) candidate = `${title} (${index})`;
    used.add(candidate);
    return candidate;
  };
  let number = 0;
  const priceOf = (item: Omit<PricedLineItem, "alternatives">) =>
    `${quantity(item.quantity)} ${item.unit} × ${item.grossPrice !== undefined ? `${eur(item.grossPrice)} brutto` : eur(item.netPrice)}` +
    (item.discountPercentage ? ` − ${quantity(item.discountPercentage)} %` : "");
  const describe = (item: LineItem, prefix = "") => {
    if (!isPricedLine(item)) return [{ title: unique(`▸ ${cut(item.name, NAME_PREVIEW)}`), value: preview(item.description) || "Zwischenüberschrift" }];
    number++;
    const about = preview(item.description);
    const own = { title: unique(`${prefix}${number}. ${cut(item.name, NAME_PREVIEW)}`), value: about ? `${priceOf(item)} · ${about}` : priceOf(item) };
    const alternatives = (item.alternatives ?? []).map((alternative) => ({
      title: unique(`Alternative zu ${number}. ${cut(alternative.name, NAME_PREVIEW)}`),
      value: `${priceOf(alternative)} · nicht in der Summe`,
    }));
    return [own, ...alternatives];
  };
  const all = [
    ...items.filter((item) => !isPricedLine(item) || !item.optional).flatMap((item) => describe(item)),
    ...items.filter((item) => isPricedLine(item) && item.optional).flatMap((item) => describe(item, "Optional ")),
  ];
  const shown: { title: string; value: string }[] = [];
  for (const fact of all) {
    if (shown.length >= MAX_LINE_FACTS || factLength([...shown, fact]) > budget - 60) break;
    shown.push(fact);
  }
  const rest = all.length - shown.length;
  return rest > 0 ? [...shown, { title: "…", value: `${rest} weitere ${rest === 1 ? "Zeile" : "Zeilen"}, vollständig in Lexware Office` }] : shown;
}

/**
 * Net and gross of the lines that count, after line and total discounts. On
 * a gross document the gross prices lead and the net follows from them.
 */
export function salesTotals(input: SalesInput): { linesNet: number; discount: number; net: number; gross: number } {
  const counting = toLineItems(input.items).filter(countsToTotal);
  const taxFree = isVatFreeTaxType(input.tax_type ?? "net");
  const linesNet = netTotal(counting);
  const linesGross =
    input.tax_type === "gross"
      ? counting.reduce((sum, item) => sum + item.quantity * (item.grossPrice ?? 0) * (1 - (item.discountPercentage ?? 0) / 100), 0)
      : counting.reduce((sum, item) => sum + lineNet(item) * (1 + (taxFree ? 0 : item.taxRate) / 100), 0);
  // An absolute discount counts against the net total — on a gross document against the gross one.
  const base = input.tax_type === "gross" ? linesGross : linesNet;
  const discountShare = base > 0 ? Math.min(1, input.total_discount_percent ? input.total_discount_percent / 100 : (input.total_discount_amount ?? 0) / base) : 0;
  const net = round2(linesNet * (1 - discountShare));
  return { linesNet, discount: round2(linesNet - net), net, gross: round2(linesGross * (1 - discountShare)) };
}

const SHIPPING_LABEL = { service: "Leistungsdatum", serviceperiod: "Leistungszeitraum", delivery: "Lieferdatum", deliveryperiod: "Lieferzeitraum" } as const;

/** When the service is supplied, as Lexware Office will print it — and what it prints when nothing is set. */
function shippingFact(input: SalesInput): { title: string; value: string } {
  const shipping = shippingOf(input);
  if (!shipping) return { title: "Leistungsdatum", value: "nicht angegeben — Lexware Office druckt „Lieferdatum = Belegdatum“" };
  if (shipping.shippingType === "none") return { title: "Leistungsdatum", value: "keins (wird nicht gedruckt)" };
  return {
    title: SHIPPING_LABEL[shipping.shippingType],
    value: "shippingEndDate" in shipping ? `${shortDate(shipping.shippingDate)} – ${shortDate(shipping.shippingEndDate)}` : shortDate(shipping.shippingDate),
  };
}

/** The payment term as printed; on an invoice with the due date it gives. */
function paymentFact(input: SalesInput, kind: string): { title: string; value: string } {
  const payment = paymentOf(input);
  if (!payment) return { title: "Zahlungsziel", value: "nicht angegeben — Vorgabe aus Lexware Office (siehe Befunde)" };
  const days = payment.paymentTermDuration ?? 0;
  const due = new Date(new Date(`${input.voucher_date ?? berlinToday()}T12:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);
  return { title: "Zahlungsziel", value: kind === "invoice" && days > 0 ? `${payment.paymentTermLabel} · fällig ${shortDate(due)}` : payment.paymentTermLabel! };
}

function taxFact(input: SalesInput): { title: string; value: string } {
  const type = input.tax_type ?? "net";
  const extra = [
    input.tax_sub_type === "distanceSales" ? "Fernverkauf EU" : input.tax_sub_type === "electronicServices" ? "elektronische Dienstleistung EU" : null,
    input.tax_note ? `Hinweis: ${cut(input.tax_note, DESCRIPTION_PREVIEW)}` : null,
  ].filter(Boolean);
  return { title: "Steuerart", value: [TAX_TYPE_LABEL[type], ...extra].join(" · ") };
}

/**
 * The facts every sales document shows: customer as given, totals and
 * discount, dates, payment and tax, texts, what it derives from, then the
 * positions.
 */
function salesFacts(kind: "quotation" | "order-confirmation" | "invoice", input: SalesInput & { quotation_id?: string }, budget: number) {
  const items = toLineItems(input.items);
  const optional = items.filter((item): item is PricedLineItem => isPricedLine(item) && item.optional === true);
  const totals = salesTotals(input);
  const source = input.quotation_id ?? input.source_document_id;
  const ownText = (value?: string) => (value ? `eigener Text (${value.trim().length} Zeichen)` : "Standard aus Lexware Office");
  const head = [
    ...(typeof input.customer_number === "number"
      ? [{ title: "Kundennummer", value: String(input.customer_number) }]
      : input.contact_id
        ? [{ title: "Kontakt", value: input.contact_id }]
        : []),
    { title: "Positionen", value: String(items.filter(countsToTotal).length) },
    { title: "Netto", value: eur(totals.net) },
    { title: "Brutto", value: eur(totals.gross) },
    ...(totals.discount > 0 || input.total_discount_percent || input.total_discount_amount
      ? [
          {
            title: "Rabatt",
            value:
              `${input.total_discount_percent ? `${quantity(input.total_discount_percent)} %` : eur(input.total_discount_amount ?? 0)} auf die Summe ` +
              `(−${eur(totals.discount)} netto, vor Rabatt ${eur(totals.linesNet)})`,
          },
        ]
      : []),
    ...(optional.length > 0
      ? [{ title: "Optional", value: `${optional.length} Pos. · ${eur(netTotal(optional))} netto, nicht in der Summe` }]
      : []),
    ...(input.voucher_date ? [{ title: "Belegdatum", value: shortDate(input.voucher_date) }] : []),
    ...(kind === "quotation" ? [] : [shippingFact(input)]),
    paymentFact(input, kind),
    taxFact(input),
    ...(input.title ? [{ title: "Titel", value: input.title }] : []),
    ...(kind === "quotation" ? [{ title: "Gültig bis", value: shortDate(validUntilOf(input)) + (input.valid_until ? "" : " (Standard)") }] : []),
    ...(source ? [{ title: "Bezugsbeleg", value: source }] : []),
    ...(input.language === "en" ? [{ title: "Sprache", value: "Englisch" }] : []),
    ...(input.print_layout ? [{ title: "Druckvorlage", value: input.print_layout }] : []),
    ...(input.delivery_terms ? [{ title: "Lieferbedingungen", value: cut(input.delivery_terms, DESCRIPTION_PREVIEW) }] : []),
    ...(input.buyer_reference !== undefined ? [{ title: "Leitweg-ID", value: input.buyer_reference || "keine (normale Rechnung statt XRechnung)" }] : []),
    { title: "Einleitung", value: ownText(input.introduction) },
    { title: "Schlussnotiz", value: ownText(input.remark) },
  ];
  return [...head, ...lineFacts(items, budget - factLength(head))];
}

function salesHeadline(input: SalesInput) {
  const items = toLineItems(input.items);
  const count = items.filter(countsToTotal).length;
  const optional = items.filter((item) => isPricedLine(item) && item.optional).length;
  return (
    `${count} ${count === 1 ? "Position" : "Positionen"} · ${eur(salesTotals(input).net)} netto` +
    (optional > 0 ? ` · ${optional} optional` : "") +
    (input.draft ? " · Entwurf" : "")
  );
}

/** Quotation and order confirmation: finalized by default, a draft on request — the card must say which. */
function finalizableCard(kind: "quotation" | "order-confirmation", label: string, numberName: string) {
  return (input: Record<string, unknown>, reserved: number) => {
    const draft = (input as SalesInput).draft === true;
    const title = draft ? `${label} als Entwurf anlegen?` : `${label} anlegen?`;
    const note = draft
      ? `Entwurf — nicht festgeschrieben, noch ohne ${numberName}. Gegenlesen und festschreiben in Lexware Office.`
      : `Wird direkt festgeschrieben (nicht als Entwurf) und erhält eine ${numberName}.`;
    const subtitle = salesHeadline(input);
    return { title, subtitle, facts: salesFacts(kind, input, CARD_TEXT_BUDGET - reserved - title.length - subtitle.length - note.length), note };
  };
}

const BUILDERS: Record<string, Builder> = {
  create_quotation: finalizableCard("quotation", "Angebot", "Angebotsnummer"),

  create_order_confirmation: finalizableCard("order-confirmation", "Auftragsbestätigung", "AB-Nummer"),

  create_invoice(input, reserved) {
    const title = "Rechnung als Entwurf anlegen?";
    const note = "Entsteht als Entwurf — festgeschrieben und versendet wird in Lexware Office.";
    const subtitle = salesHeadline(input);
    return { title, subtitle, facts: salesFacts("invoice", input, CARD_TEXT_BUDGET - reserved - title.length - subtitle.length - note.length), note };
  },

  create_purchase_invoice: purchaseCard,

  create_customer(input) {
    const name = text(input.company_name) || [text(input.first_name), text(input.last_name)].filter(Boolean).join(" ") || "ohne Namen";
    const address = [text(input.street), [text(input.zip), text(input.city)].filter(Boolean).join(" ")].filter(Boolean).join(", ");
    return {
      title: "Kunden anlegen?",
      subtitle: name,
      facts: [
        { title: "Name", value: name },
        ...(address ? [{ title: "Adresse", value: address }] : []),
        ...(text(input.email) ? [{ title: "E-Mail", value: text(input.email) }] : []),
        ...(text(input.phone) ? [{ title: "Telefon", value: text(input.phone) }] : []),
      ],
    };
  },

  send_payment_reminder(input) {
    const number = text(input.voucher_number) || "ohne Nummer";
    const customer = text(input.customer_name) || "unbekannter Kunde";
    const amount = typeof input.open_amount === "number" ? eur(input.open_amount) : "Betrag unbekannt";
    const due = text(input.due_date);
    const days = due ? daysSince(due) : null;
    return {
      title: "Zahlungserinnerung senden?",
      subtitle: `${customer} · Rechnung ${number} · ${amount} offen`,
      facts: [
        { title: "Kunde", value: customer },
        { title: "Rechnung", value: number },
        ...(due ? [{ title: "Fällig seit", value: `${shortDate(due)}${days !== null ? ` (${days} ${days === 1 ? "Tag" : "Tage"})` : ""}` }] : []),
        { title: "Offener Betrag", value: amount },
        { title: "Anhang", value: `${number}.pdf` },
      ],
      note: "Freundliche Erinnerung mit der Rechnung im Anhang.",
    };
  },
};

/** The tool's own name if it is one of ours, as the mount named it ("<ns>__<tool>") or bare. */
export function ownTool(name: string): string | null {
  const local = name.includes("__") ? name.slice(name.lastIndexOf("__") + 2) : name;
  return local in BUILDERS ? local : null;
}

export function approvalCard(toolName: string, callId: string, input: unknown): ApprovalCard | null {
  const tool = ownTool(toolName);
  if (!tool) return null;
  const values = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const findings = findingsOf(callId);
  return { tool, ...BUILDERS[tool]!(values, factLength(findings)), findings };
}
