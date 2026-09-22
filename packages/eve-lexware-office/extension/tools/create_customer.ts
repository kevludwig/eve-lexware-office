import { createCustomer, describeError, findContactsByName } from "@kevinludwig/lexware-office";
import { defineTool } from "eve/tools";
import { z } from "zod";

import { readJournal, writeJournal } from "../lib/journal";
import { approverPolicy, client } from "../lib/runtime";
import { saveWarnings, type Warning } from "../lib/findings";
import { rememberShownContacts, shownContactsOf } from "../lib/state";

const inputSchema = z
  .object({
    company_name: z.string().trim().min(1).max(255).optional().describe("Firmenname inkl. Rechtsform — entweder dieser oder last_name"),
    first_name: z.string().trim().max(100).optional().describe("Vorname (nur bei Privatperson)"),
    last_name: z.string().trim().min(1).max(100).optional().describe("Nachname (nur bei Privatperson) — entweder dieser oder company_name"),
    // Required on purpose: the description asks to ask for a missing address;
    // the schema enforces it, so a skipped question cannot create half a contact.
    street: z.string().trim().min(1).max(200).describe("Straße und Hausnummer"),
    zip: z.string().trim().min(1).max(10).describe("Postleitzahl"),
    city: z.string().trim().min(1).max(100).describe("Ort"),
    country_code: z.string().trim().length(2).optional().describe("ISO-Ländercode, Standard DE"),
    email: z.string().trim().email().max(200).optional().describe("E-Mail-Adresse (optional)"),
    phone: z.string().trim().max(50).optional().describe("Telefonnummer (optional)"),
  })
  .strict()
  .refine((input) => Boolean(input.company_name) !== Boolean(input.last_name), {
    message: "Genau eines von company_name und last_name angeben.",
  });

type Input = z.infer<typeof inputSchema>;

const nameOf = (input: Partial<Input>) => input.company_name?.trim() || input.last_name?.trim() || "";
const label = (contact: { name: string; number?: number }) => `${contact.name}${contact.number ? ` (Nr. ${contact.number})` : ""}`;

export default defineTool({
  description:
    "Legt einen neuen Kunden in Lexware Office an. Pflicht sind Name (Firma oder Person) UND die Rechnungsadresse " +
    "(Straße, PLZ, Ort) — fehlt die Adresse, frage sie zuerst beim Nutzer ab. E-Mail und Telefon sind optional. " +
    "Prüfe vorher mit dem Lese-Tool (/contacts?name=…), ob der Kunde schon existiert. Legt erst nach Freigabe an.",
  inputSchema,

  approval: {
    /** The finding that matters: a second „Müller GmbH" next to the first. */
    request: async (ctx) => {
      const name = nameOf((ctx.toolInput ?? {}) as Partial<Input>);
      if (!name) return "user-approval" as const;
      const findings: Warning[] = [];
      try {
        const similar = await findContactsByName(client(), name, { size: 5, signal: ctx.abortSignal });
        if (similar.length > 0) findings.push({ kind: "note", title: "⚠ Ähnliche Kontakte", value: similar.map(label).join(", ") });
        rememberShownContacts(ctx.callId, similar.map((contact) => contact.id));
      } catch (error) {
        // A failed search must not pass for "no similar contacts".
        findings.push({ kind: "note", title: "⚠ Suche fehlgeschlagen", value: `Ähnliche Kontakte ungeprüft: ${describeError(error)}` });
      }
      saveWarnings(ctx.callId, findings);
      return "user-approval" as const;
    },
    response: approverPolicy,
  },

  async execute(input, ctx) {
    const journal = await readJournal("customer", ctx.callId);
    if (journal?.resourceId) {
      return { contactId: journal.resourceId, note: "Wiederaufnahme: Der Kunde war bereits angelegt — nichts doppelt erstellt." };
    }

    // Hours can pass between card and click. A similar contact the card did
    // not show stops the creation; those it showed were approved knowingly.
    const shown = shownContactsOf(ctx.callId);
    try {
      const unseen = (await findContactsByName(client(), nameOf(input), { size: 5, signal: ctx.abortSignal })).filter(
        (contact) => !shown.has(contact.id),
      );
      if (unseen.length > 0) {
        throw new Error(
          `Abgebrochen: Inzwischen gibt es einen ähnlichen Kontakt, den die Karte nicht zeigte: ${unseen.map(label).join(", ")}. ` +
            "Nichts angelegt. Rufe das Tool erneut auf, wenn trotzdem ein neuer Kunde entstehen soll.",
        );
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Abgebrochen")) throw error;
      // A failed second search must not block the approved creation.
    }

    await writeJournal("customer", ctx.callId, { status: "pending" });
    let created;
    try {
      created = await createCustomer(
        client(),
        {
          ...(input.company_name ? { company: { name: input.company_name } } : {}),
          ...(input.last_name ? { person: { ...(input.first_name ? { firstName: input.first_name } : {}), lastName: input.last_name } } : {}),
          billingAddress: { street: input.street, zip: input.zip, city: input.city, countryCode: input.country_code },
          email: input.email,
          phone: input.phone,
        },
        ctx.abortSignal,
      );
    } catch (error) {
      throw new Error(`Kunde nicht angelegt: ${describeError(error)}`);
    }
    await writeJournal("customer", ctx.callId, { status: "created", resourceId: created.id });

    return {
      contactId: created.id,
      customerNumber: created.customerNumber,
      name: created.name,
      note: created.customerNumber === undefined ? "Angelegt; die Kundennummer ließ sich nicht zurücklesen." : undefined,
    };
  },
});
