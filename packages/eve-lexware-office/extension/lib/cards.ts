/**
 * The approval cards of this extension's writing tools, built from the tool
 * input and the findings its approval stored. Channels only render them.
 */

import { daysSince, netTotal, round2 } from "@kevinludwig/lexware-office";

import { eur, shortDate } from "./format";
import { purchaseCard } from "./purchase-card";
import { toLineItems, type SalesInput } from "./sales";
import { findingsOf } from "./findings";
import type { ApprovalCard } from "./types";

type Builder = (input: Record<string, unknown>) => Omit<ApprovalCard, "tool" | "findings">;

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/** The facts every sales document shows: customer as given, positions, totals, and what it derives from. */
function salesFacts(input: SalesInput & { quotation_id?: string }) {
  const items = toLineItems(input.items);
  const gross = round2(items.reduce((sum, item) => sum + item.quantity * item.netPrice * (1 + item.taxRate / 100), 0));
  const source = input.quotation_id ?? input.source_document_id;
  return [
    ...(typeof input.customer_number === "number"
      ? [{ title: "Kundennummer", value: String(input.customer_number) }]
      : input.contact_id
        ? [{ title: "Kontakt", value: input.contact_id }]
        : []),
    { title: "Positionen", value: String(items.length) },
    { title: "Netto", value: eur(netTotal(items)) },
    { title: "Brutto", value: eur(gross) },
    ...(input.title ? [{ title: "Titel", value: input.title }] : []),
    ...(input.valid_until ? [{ title: "Gültig bis", value: shortDate(input.valid_until) }] : []),
    ...(source ? [{ title: "Bezugsbeleg", value: source }] : []),
  ];
}

const salesHeadline = (input: SalesInput) => {
  const items = toLineItems(input.items);
  return `${items.length} ${items.length === 1 ? "Position" : "Positionen"} · ${eur(netTotal(items))} netto`;
};

const BUILDERS: Record<string, Builder> = {
  create_quotation(input) {
    return {
      title: "Angebot anlegen?",
      subtitle: salesHeadline(input),
      facts: salesFacts(input),
      note: "Wird direkt festgeschrieben (nicht als Entwurf) und erhält eine Angebotsnummer.",
    };
  },

  create_order_confirmation(input) {
    return {
      title: "Auftragsbestätigung anlegen?",
      subtitle: salesHeadline(input),
      facts: salesFacts(input),
      note: "Wird direkt festgeschrieben (nicht als Entwurf) und erhält eine AB-Nummer.",
    };
  },

  create_invoice(input) {
    return {
      title: "Rechnung als Entwurf anlegen?",
      subtitle: salesHeadline(input),
      facts: salesFacts(input),
      note: "Entsteht als Entwurf — festgeschrieben und versendet wird in Lexware Office.",
    };
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
  return { tool, ...BUILDERS[tool]!(values), findings: findingsOf(callId) };
}
