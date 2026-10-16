/**
 * Creating a customer, without eve: the input schema, the check before the
 * card (similar contacts), and the approved write (a similar contact the card
 * did not show stops it). The eve tool (../tools/create_customer.ts) and any
 * other caller — e.g. an approval page — share them.
 */

import { createCustomer, describeError, findContactsByName, MIN_NAME_SEARCH_LENGTH, type LexwareClient } from "@kevludwig/lexware-office";
import { z } from "zod";

import type { Warning } from "./warnings";
import type { Journal } from "./journal-store";

export const customerInputSchema = z
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

export type CustomerInput = z.infer<typeof customerInputSchema>;

export const customerNameOf = (input: Partial<CustomerInput>) => input.company_name?.trim() || input.last_name?.trim() || "";
const label = (contact: { name: string; number?: number }) => `${contact.name}${contact.number ? ` (Nr. ${contact.number})` : ""}`;

export interface PreparedCustomer {
  warnings: Warning[];
  /** The similar contacts the card shows — approved knowingly, they do not stop the write. */
  shownContactIds: string[];
}

/** The finding that matters: a second „Müller GmbH" next to the first. */
export async function prepareCustomer(api: LexwareClient, input: Partial<CustomerInput>, signal?: AbortSignal): Promise<PreparedCustomer> {
  const name = customerNameOf(input);
  const warnings: Warning[] = [];
  if (!name) return { warnings, shownContactIds: [] };
  // Lexware does not search names this short — say so instead of "no similar contacts".
  if (name.length < MIN_NAME_SEARCH_LENGTH) {
    warnings.push({ kind: "note", title: "⚠ Name zu kurz für die Suche", value: `Ähnliche Kontakte ungeprüft (Lexware sucht ab ${MIN_NAME_SEARCH_LENGTH} Zeichen).` });
    return { warnings, shownContactIds: [] };
  }
  try {
    const similar = await findContactsByName(api, name, { size: 5, signal });
    if (similar.length > 0) warnings.push({ kind: "note", title: "⚠ Ähnliche Kontakte", value: similar.map(label).join(", ") });
    return { warnings, shownContactIds: similar.map((contact) => contact.id) };
  } catch (error) {
    // A failed search must not pass for "no similar contacts".
    warnings.push({ kind: "note", title: "⚠ Suche fehlgeschlagen", value: `Ähnliche Kontakte ungeprüft: ${describeError(error)}` });
    return { warnings, shownContactIds: [] };
  }
}

const isSet = (ids: ReadonlySet<string> | readonly string[]): ids is ReadonlySet<string> => typeof (ids as ReadonlySet<string>).has === "function";

/** Creates the approved customer. `id` keys the journal: a replay does not create twice. */
export async function executeApprovedCustomer(
  ops: { client: LexwareClient; journal: Journal },
  input: CustomerInput,
  approved: {
    id: string;
    /** The similar contacts the card showed: `prepareCustomer`'s `shownContactIds` as they are (an array), or a Set. */
    shownContactIds: ReadonlySet<string> | readonly string[];
    signal?: AbortSignal;
  },
): Promise<Record<string, unknown>> {
  const ids = approved.shownContactIds;
  const shown: ReadonlySet<string> = isSet(ids) ? ids : new Set(ids);
  const journal = await ops.journal.read("customer", approved.id);
  if (journal?.resourceId) {
    return { contactId: journal.resourceId, note: "Wiederaufnahme: Der Kunde war bereits angelegt — nichts doppelt erstellt." };
  }

  // Hours can pass between card and click. A similar contact the card did
  // not show stops the creation; those it showed were approved knowingly.
  try {
    const unseen = (await findContactsByName(ops.client, customerNameOf(input), { size: 5, signal: approved.signal })).filter(
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

  await ops.journal.write("customer", approved.id, { status: "pending" });
  let created;
  try {
    created = await createCustomer(
      ops.client,
      {
        ...(input.company_name ? { company: { name: input.company_name } } : {}),
        ...(input.last_name ? { person: { ...(input.first_name ? { firstName: input.first_name } : {}), lastName: input.last_name } } : {}),
        billingAddress: { street: input.street, zip: input.zip, city: input.city, countryCode: input.country_code },
        email: input.email,
        phone: input.phone,
      },
      approved.signal,
    );
  } catch (error) {
    throw new Error(`Kunde nicht angelegt: ${describeError(error)}`);
  }
  await ops.journal.write("customer", approved.id, { status: "created", resourceId: created.id });

  return {
    contactId: created.id,
    customerNumber: created.customerNumber,
    name: created.name,
    note: created.customerNumber === undefined ? "Angelegt; die Kundennummer ließ sich nicht zurücklesen." : undefined,
  };
}
