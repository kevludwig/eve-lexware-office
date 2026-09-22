import { defineTool } from "eve/tools";
import { z } from "zod";

import { approverPolicy } from "../lib/runtime";
import { MAX_LINE_ITEMS, customerFields, executeSalesDocument, lineItemSchema, salesApproval, titleSchema, type SalesInput } from "../lib/sales";

const inputSchema = z
  .object({
    ...customerFields,
    items: z
      .array(lineItemSchema)
      .min(1)
      .max(MAX_LINE_ITEMS)
      .describe("Alle Positionen der AB — beim Ableiten aus einem Angebot dessen Positionen (per Lese-Tool /quotations/{id}), plus gewünschte Änderungen"),
    title: titleSchema("der AB"),
    quotation_id: z
      .string()
      .uuid()
      .optional()
      .describe("UUID des Angebots, aus dem diese AB hervorgeht. Dann prüft das Tool Kunde und Positionssumme gegen das Angebot."),
  })
  .strict()
  .refine((input) => (input.customer_number === undefined) !== (input.contact_id === undefined), {
    message: "Genau eines von customer_number und contact_id angeben.",
  });

/** The quotation this confirmation follows, as the generic source fields. */
const withSource = (input: SalesInput & { quotation_id?: string }): SalesInput =>
  input.quotation_id && !input.source_document_id ? { ...input, source_document_id: input.quotation_id, source_document_type: "quotation" } : input;

export default defineTool({
  description:
    "Erstellt eine Auftragsbestätigung (AB) in Lexware Office und schreibt sie direkt fest (sie erhält eine AB-Nummer; kein " +
    "Entwurf). Geht die AB aus einem Angebot hervor, dessen quotation_id mitgeben — das Angebot vorher über /voucherlist " +
    "(voucherType 'quotation') suchen und lesen; bei mehreren passenden den Nutzer wählen lassen. Legt erst nach Freigabe an.",
  inputSchema,
  approval: { request: salesApproval("order-confirmation", withSource), response: approverPolicy },
  async execute(input, ctx) {
    return executeSalesDocument("order-confirmation", withSource(input), ctx);
  },
});
