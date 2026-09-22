import { defineTool } from "eve/tools";
import { z } from "zod";

import { approverPolicy } from "../lib/runtime";
import { MAX_LINE_ITEMS, customerFields, executeSalesDocument, lineItemSchema, salesApproval } from "../lib/sales";

const inputSchema = z
  .object({
    ...customerFields,
    items: z.array(lineItemSchema).min(1).max(MAX_LINE_ITEMS).describe("Alle Positionen der Rechnung"),
    source_document_id: z.string().uuid().optional().describe("UUID des Angebots bzw. der AB, aus der diese Rechnung hervorgeht"),
    source_document_type: z.enum(["quotation", "order-confirmation"]).optional().describe("Art des Bezugsbelegs zu source_document_id"),
  })
  .strict()
  .refine((input) => (input.customer_number === undefined) !== (input.contact_id === undefined), {
    message: "Genau eines von customer_number und contact_id angeben.",
  })
  .refine((input) => !input.source_document_id || input.source_document_type, {
    message: "source_document_type zu source_document_id angeben.",
  });

export default defineTool({
  description:
    "Erstellt eine Ausgangsrechnung als Entwurf in Lexware Office — festgeschrieben und versendet wird dort, nie hier. " +
    "Kunde per Kundennummer oder contact_id, dazu die Positionen; source_document_id, wenn die Rechnung aus einem Angebot " +
    "oder einer AB hervorgeht. Legt erst nach Freigabe an und prüft vorher auf Dubletten.",
  inputSchema,
  approval: { request: salesApproval("invoice"), response: approverPolicy },
  async execute(input, ctx) {
    return executeSalesDocument("invoice", input, ctx);
  },
});
