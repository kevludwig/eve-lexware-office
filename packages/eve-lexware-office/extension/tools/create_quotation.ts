import { defineTool } from "eve/tools";
import { z } from "zod";

import { approverPolicy } from "../lib/runtime";
import { withCard } from "../lib/with-card";
import {
  COUNTING_LINE_MESSAGE,
  MAX_LINE_ITEMS,
  QUOTATION_VALIDITY_DAYS,
  customerFields,
  documentTextFields,
  draftField,
  executeSalesDocument,
  hasCountingLine,
  isCalendarDate,
  lineItemSchema,
  salesApproval,
  titleSchema,
} from "../lib/sales";

const inputSchema = z
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
      .describe(`Gültig bis, yyyy-MM-dd. Ohne Angabe ${QUOTATION_VALIDITY_DAYS} Tage ab heute.`),
    ...documentTextFields,
    ...draftField("das Angebot"),
  })
  .strict()
  .refine((input) => (input.customer_number === undefined) !== (input.contact_id === undefined), {
    message: "Genau eines von customer_number und contact_id angeben.",
  });

export default defineTool({
  description:
    "Erstellt ein Angebot in Lexware Office und schreibt es direkt fest (es erhält eine Angebotsnummer); mit draft: true " +
    "entsteht ein Entwurf zum Gegenlesen. Positionen mit Beschreibung, Textpositionen als Zwischenüberschrift, optionale " +
    "Positionen (nicht in der Summe), dazu Einleitung und Schlussnotiz. Kunde per Kundennummer oder contact_id — existiert " +
    "er noch nicht, zuerst create_customer. Legt erst nach Freigabe an und prüft vorher, ob es für diesen Kunden schon ein " +
    "Angebot mit gleicher Positionssumme gibt. Versendet wird aus Lexware Office.",
  inputSchema,
  approval: { request: withCard(salesApproval("quotation")), response: approverPolicy },
  async execute(input, ctx) {
    return executeSalesDocument("quotation", input, ctx);
  },
});
