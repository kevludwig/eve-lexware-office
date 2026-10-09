/**
 * The approval cards of this extension's writing tools, built from the tool
 * input and the findings its approval stored. Channels only render them.
 */

import { countsToTotal, daysSince, isPricedLine, netTotal, round2, type LineItem, type PricedLineItem } from "@kevludwig/lexware-office";

import { eur, shortDate } from "./format";
import { purchaseCard } from "./purchase-card";
import { toLineItems, totalOf, type SalesInput } from "./sales";
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
  const describe = (item: LineItem, prefix = "") => {
    if (!isPricedLine(item)) return { title: unique(`▸ ${cut(item.name, NAME_PREVIEW)}`), value: preview(item.description) || "Zwischenüberschrift" };
    number++;
    const price = `${quantity(item.quantity)} ${item.unit} × ${eur(item.netPrice)}`;
    const about = preview(item.description);
    return { title: unique(`${prefix}${number}. ${cut(item.name, NAME_PREVIEW)}`), value: about ? `${price} · ${about}` : price };
  };
  const all = [
    ...items.filter((item) => !isPricedLine(item) || !item.optional).map((item) => describe(item)),
    ...items.filter((item) => isPricedLine(item) && item.optional).map((item) => describe(item, "Optional ")),
  ];
  const shown: { title: string; value: string }[] = [];
  for (const fact of all) {
    if (shown.length >= MAX_LINE_FACTS || factLength([...shown, fact]) > budget - 60) break;
    shown.push(fact);
  }
  const rest = all.length - shown.length;
  return rest > 0 ? [...shown, { title: "…", value: `${rest} weitere ${rest === 1 ? "Zeile" : "Zeilen"}, vollständig in Lexware Office` }] : shown;
}

/** The facts every sales document shows: customer as given, totals, texts, what it derives from, then the positions. */
function salesFacts(input: SalesInput & { quotation_id?: string }, budget: number) {
  const items = toLineItems(input.items);
  const counting = items.filter(countsToTotal);
  const optional = items.filter((item): item is PricedLineItem => isPricedLine(item) && item.optional === true);
  const gross = round2(counting.reduce((sum, item) => sum + item.quantity * item.netPrice * (1 + item.taxRate / 100), 0));
  const source = input.quotation_id ?? input.source_document_id;
  const ownText = (value?: string) => (value ? `eigener Text (${value.trim().length} Zeichen)` : "Standard aus Lexware Office");
  const head = [
    ...(typeof input.customer_number === "number"
      ? [{ title: "Kundennummer", value: String(input.customer_number) }]
      : input.contact_id
        ? [{ title: "Kontakt", value: input.contact_id }]
        : []),
    { title: "Positionen", value: String(counting.length) },
    { title: "Netto", value: eur(totalOf(items)) },
    { title: "Brutto", value: eur(gross) },
    ...(optional.length > 0
      ? [{ title: "Optional", value: `${optional.length} Pos. · ${eur(netTotal(optional))} netto, nicht in der Summe` }]
      : []),
    ...(input.title ? [{ title: "Titel", value: input.title }] : []),
    ...(input.valid_until ? [{ title: "Gültig bis", value: shortDate(input.valid_until) }] : []),
    ...(source ? [{ title: "Bezugsbeleg", value: source }] : []),
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
    `${count} ${count === 1 ? "Position" : "Positionen"} · ${eur(totalOf(items))} netto` +
    (optional > 0 ? ` · ${optional} optional` : "") +
    (input.draft ? " · Entwurf" : "")
  );
}

/** Quotation and order confirmation: finalized by default, a draft on request — the card must say which. */
function finalizableCard(label: string, numberName: string) {
  return (input: Record<string, unknown>, reserved: number) => {
    const draft = (input as SalesInput).draft === true;
    const title = draft ? `${label} als Entwurf anlegen?` : `${label} anlegen?`;
    const note = draft
      ? `Entwurf — nicht festgeschrieben, noch ohne ${numberName}. Gegenlesen und festschreiben in Lexware Office.`
      : `Wird direkt festgeschrieben (nicht als Entwurf) und erhält eine ${numberName}.`;
    const subtitle = salesHeadline(input);
    return { title, subtitle, facts: salesFacts(input, CARD_TEXT_BUDGET - reserved - title.length - subtitle.length - note.length), note };
  };
}

const BUILDERS: Record<string, Builder> = {
  create_quotation: finalizableCard("Angebot", "Angebotsnummer"),

  create_order_confirmation: finalizableCard("Auftragsbestätigung", "AB-Nummer"),

  create_invoice(input, reserved) {
    const title = "Rechnung als Entwurf anlegen?";
    const note = "Entsteht als Entwurf — festgeschrieben und versendet wird in Lexware Office.";
    const subtitle = salesHeadline(input);
    return { title, subtitle, facts: salesFacts(input, CARD_TEXT_BUDGET - reserved - title.length - subtitle.length - note.length), note };
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
