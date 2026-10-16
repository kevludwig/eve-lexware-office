import { defineTool } from "eve/tools";

import { customerInputSchema, executeApprovedCustomer, prepareCustomer, type CustomerInput } from "../lib/customer";
import { saveWarnings } from "../lib/findings";
import { runtimeJournal } from "../lib/journal";
import { approverPolicy, client } from "../lib/runtime";
import { rememberShownContacts, shownContactsOf } from "../lib/state";
import { withCard } from "../lib/with-card";

export default defineTool({
  description:
    "Legt einen neuen Kunden in Lexware Office an. Pflicht sind Name (Firma oder Person) UND die Rechnungsadresse " +
    "(Straße, PLZ, Ort) — fehlt die Adresse, frage sie zuerst beim Nutzer ab. E-Mail und Telefon sind optional. " +
    "Prüfe vorher mit dem Lese-Tool (/contacts?name=…), ob der Kunde schon existiert — Lexware sucht erst ab 3 Zeichen; " +
    "kürzere Namen (z. B. „AB“) sind als Kundenname erlaubt, dann ohne Vorabsuche direkt dieses Tool aufrufen. Legt erst nach Freigabe an.",
  inputSchema: customerInputSchema,

  approval: {
    request: withCard(async (ctx) => {
      const prepared = await prepareCustomer(client(), (ctx.toolInput ?? {}) as Partial<CustomerInput>, ctx.abortSignal);
      if (prepared.shownContactIds.length > 0) rememberShownContacts(ctx.callId, prepared.shownContactIds);
      saveWarnings(ctx.callId, prepared.warnings);
      return "user-approval" as const;
    }),
    response: approverPolicy,
  },

  async execute(input, ctx) {
    return executeApprovedCustomer({ client: client(), journal: runtimeJournal }, input, {
      id: ctx.callId,
      shownContactIds: shownContactsOf(ctx.callId),
      signal: ctx.abortSignal,
    });
  },
});
