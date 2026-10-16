/**
 * The input schemas and descriptions of the three sales document tools —
 * what a model fills in. The eve tools (../tools/create_*.ts) use them, and
 * so can any other agent surface (e.g. an MCP server) through ./operations.
 */

import { z } from "zod";

import {
  buyerReferenceField,
  COUNTING_LINE_MESSAGE,
  customerFields,
  deliveryTermsField,
  documentFields,
  documentTextFields,
  draftField,
  hasCountingLine,
  isCalendarDate,
  lineItemSchema,
  MAX_LINE_ITEMS,
  QUOTATION_VALIDITY_DAYS,
  type SalesInput,
  salesRefinement,
  shippingFields,
  titleSchema,
} from "./sales";

export const quotationInputSchema = z
  .object({
    ...customerFields,
    items: z
      .array(lineItemSchema({ allowOptional: true }))
      .min(1)
      .max(MAX_LINE_ITEMS)
      .refine(hasCountingLine, { message: COUNTING_LINE_MESSAGE })
      .describe("Alle Positionen des Angebots in Belegreihenfolge — bepreiste, Textpositionen (Zwischenüberschriften) und optionale"),
    title: titleSchema("des Angebots"),
    valid_until: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine(isCalendarDate, { message: "kein gültiges Kalenderdatum" })
      .optional()
      .describe(`Gültig bis, yyyy-MM-dd. Ohne Angabe ${QUOTATION_VALIDITY_DAYS} Tage ab Belegdatum.`),
    ...documentFields,
    ...documentTextFields,
    ...draftField("das Angebot"),
  })
  .strict()
  .superRefine(salesRefinement("quotation"))
  .refine((input) => (input.customer_number === undefined) !== (input.contact_id === undefined), {
    message: "Genau eines von customer_number und contact_id angeben.",
  });

export const quotationDescription =
    "Erstellt ein Angebot in Lexware Office und schreibt es direkt fest (es erhält eine Angebotsnummer); mit draft: true " +
    "entsteht ein Entwurf zum Gegenlesen. Positionen mit Beschreibung, Textpositionen als Zwischenüberschrift, optionale " +
    "Positionen (nicht in der Summe) und Alternativen, dazu Einleitung, Schlussnotiz, Zahlungsziel, Rabatte und Steuerart. Kunde per Kundennummer oder contact_id — existiert " +
    "er noch nicht, zuerst create_customer. Legt erst nach Freigabe an und prüft vorher, ob es für diesen Kunden schon ein " +
    "Angebot mit gleicher Positionssumme gibt. Versendet wird aus Lexware Office.";

export const orderConfirmationInputSchema = z
  .object({
    ...customerFields,
    items: z
      .array(lineItemSchema({ allowOptional: false }))
      .min(1)
      .max(MAX_LINE_ITEMS)
      .refine(hasCountingLine, { message: COUNTING_LINE_MESSAGE })
      .describe(
        "Alle Positionen der AB — beim Ableiten aus einem Angebot dessen nicht-optionale Positionen (per Lese-Tool " +
          "/quotations/{id}) und die optionalen, die der Kunde beauftragt hat, plus gewünschte Änderungen. Keine optionalen Positionen.",
      ),
    title: titleSchema("der AB"),
    quotation_id: z
      .string()
      .uuid()
      .optional()
      .describe("UUID des Angebots, aus dem diese AB hervorgeht. Dann prüft das Tool Kunde und Positionssumme gegen das Angebot."),
    ...shippingFields,
    ...documentFields,
    ...deliveryTermsField,
    ...documentTextFields,
    ...draftField("die AB"),
  })
  .strict()
  .superRefine(salesRefinement("order-confirmation"))
  .refine((input) => (input.customer_number === undefined) !== (input.contact_id === undefined), {
    message: "Genau eines von customer_number und contact_id angeben.",
  });

/** The quotation this confirmation follows, as the generic source fields. */
export const withSource = (input: SalesInput & { quotation_id?: string }): SalesInput =>
  input.quotation_id && !input.source_document_id ? { ...input, source_document_id: input.quotation_id, source_document_type: "quotation" } : input;

export const orderConfirmationDescription =
    "Erstellt eine Auftragsbestätigung (AB) in Lexware Office und schreibt sie direkt fest (sie erhält eine AB-Nummer); mit " +
    "draft: true entsteht ein Entwurf. Positionen mit Beschreibung und Textpositionen wie beim Angebot, aber ohne optionale. " +
    "Geht die AB aus einem Angebot hervor, dessen quotation_id mitgeben — das Angebot vorher über /voucherlist " +
    "(voucherType 'quotation') suchen und lesen; bei mehreren passenden den Nutzer wählen lassen. Legt erst nach Freigabe an.";

export const invoiceInputSchema = z
  .object({
    ...customerFields,
    items: z
      .array(lineItemSchema({ allowOptional: false }))
      .min(1)
      .max(MAX_LINE_ITEMS)
      .refine(hasCountingLine, { message: COUNTING_LINE_MESSAGE })
      .describe("Alle Positionen der Rechnung — bepreiste und Textpositionen, keine optionalen"),
    source_document_id: z.string().uuid().optional().describe("UUID des Angebots bzw. der AB, aus der diese Rechnung hervorgeht"),
    source_document_type: z.enum(["quotation", "order-confirmation"]).optional().describe("Art des Bezugsbelegs zu source_document_id"),
    title: titleSchema("der Rechnung"),
    ...shippingFields,
    ...documentFields,
    ...buyerReferenceField,
    ...documentTextFields,
  })
  .strict()
  .superRefine(salesRefinement("invoice"))
  .refine((input) => (input.customer_number === undefined) !== (input.contact_id === undefined), {
    message: "Genau eines von customer_number und contact_id angeben.",
  })
  .refine((input) => !input.source_document_id || input.source_document_type, {
    message: "source_document_type zu source_document_id angeben.",
  });

export const invoiceDescription =
    "Erstellt eine Ausgangsrechnung als Entwurf in Lexware Office — festgeschrieben und versendet wird dort, nie hier. " +
    "Kunde per Kundennummer oder contact_id, dazu die Positionen (mit Beschreibung, Textpositionen als Zwischenüberschrift); " +
    "source_document_id, wenn die Rechnung aus einem Angebot oder einer AB hervorgeht. Leistungsdatum bzw. -zeitraum " +
    "(service_date / service_period) und Zahlungsziel (payment_term_days) gehören in die Felder, nicht nur in den Text. " +
    "Legt erst nach Freigabe an und prüft vorher auf Dubletten.";
