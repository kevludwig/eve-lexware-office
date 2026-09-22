import { defineTool } from "eve/tools";
import { z } from "zod";

import { approverPolicy } from "../lib/runtime";
import { MAX_LINE_ITEMS, QUOTATION_VALIDITY_DAYS, customerFields, executeSalesDocument, isCalendarDate, lineItemSchema, salesApproval, titleSchema } from "../lib/sales";

const inputSchema = z
  .object({
    ...customerFields,
    items: z.array(lineItemSchema).min(1).max(MAX_LINE_ITEMS).describe("Alle Positionen des Angebots"),
    title: titleSchema("des Angebots"),
    valid_until: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine(isCalendarDate, { message: "kein gültiges Kalenderdatum" })
      .optional()
      .describe(`Gültig bis, yyyy-MM-dd. Ohne Angabe ${QUOTATION_VALIDITY_DAYS} Tage ab heute.`),
  })
  .strict()
  .refine((input) => (input.customer_number === undefined) !== (input.contact_id === undefined), {
    message: "Genau eines von customer_number und contact_id angeben.",
  });

export default defineTool({
  description:
    "Erstellt ein Angebot in Lexware Office und schreibt es direkt fest (es erhält eine Angebotsnummer; kein Entwurf). " +
    "Kunde per Kundennummer oder contact_id — existiert er noch nicht, zuerst create_customer. Legt erst nach Freigabe " +
    "an und prüft vorher, ob es für diesen Kunden schon ein Angebot mit gleicher Positionssumme gibt. Versendet wird aus " +
    "Lexware Office.",
  inputSchema,
  approval: { request: salesApproval("quotation"), response: approverPolicy },
  async execute(input, ctx) {
    return executeSalesDocument("quotation", input, ctx);
  },
});
