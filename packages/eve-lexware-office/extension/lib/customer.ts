/**
 * Creating and changing a customer, without eve: the input schemas, the check
 * before the card (similar contacts; for a change the contact as it is and
 * what changes), and the approved write (a similar contact the card did not
 * show stops a creation; a contact changed since the card stops a change).
 * The eve tools (../tools/create_customer.ts, ../tools/update_customer.ts)
 * and any other caller — e.g. an approval page — share them.
 */

import {
  createCustomer,
  describeError,
  findContactByNumber,
  findContactsByName,
  getContactDetails,
  MAX_NOTE_LENGTH,
  MAX_SALUTATION_LENGTH,
  MIN_NAME_SEARCH_LENGTH,
  planCustomerUpdate,
  updateCustomer,
  type ContactChange,
  type ContactDetails,
  type CustomerChanges,
  type LexwareClient,
  type NewCustomer,
} from "@kevludwig/lexware-office";
import { z } from "zod";

import type { Warning } from "./warnings";
import type { Journal } from "./journal-store";

// --- Fields, shared by creating and changing --------------------------------------

const line = (max: number) => z.string().trim().min(1).max(max);
const email = z.string().trim().email().max(200);
const phone = line(50);
const countryCode = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{2}$/, "ISO-Ländercode aus zwei Buchstaben, z. B. DE")
  .transform((value) => value.toUpperCase());

const FIELD = {
  company_name: "Firmenname inkl. Rechtsform, so wie er auf Belegen stehen soll (Firma). Bei einer Firma ist das der Kundenname; die Person dort gehört in contact_person.",
  tax_number: "Steuernummer der Firma (nur Firma).",
  vat_id: "USt-IdNr. der Firma, z. B. DE123456789 (nur Firma). Lexware Office prüft sie nach deutschen Regeln; nötig für Rechnungen nach § 13b UStG und innergemeinschaftliche Lieferungen.",
  allow_tax_free_invoices: "„Steuerfreie Rechnung erlauben“ (nur Firma): nötig für Rechnungen an Kunden in Drittländern.",
  contact_person:
    "Ansprechpartner der Firma (nur Firma). Lexware Office nimmt über die Schnittstelle genau einen; er steht auf Belegen, wenn on_documents gilt.",
  salutation: `Anrede der Privatperson, z. B. „Frau“ (höchstens ${MAX_SALUTATION_LENGTH} Zeichen; nur Privatperson).`,
  first_name: "Vorname der Privatperson (nur Privatperson; bei einer Firma: contact_person).",
  last_name: "Nachname der Privatperson (nur Privatperson; bei einer Firma: contact_person).",
  address_supplement: "Zusatz zur Rechnungsadresse, z. B. Abteilung oder c/o.",
  street: "Straße und Hausnummer der Rechnungsadresse.",
  zip: "Postleitzahl der Rechnungsadresse.",
  city: "Ort der Rechnungsadresse.",
  country_code: "Land der Rechnungsadresse als ISO-Code (ISO 3166-1 alpha-2), Standard DE.",
  shipping_address: "Lieferadresse, nur wenn sie von der Rechnungsadresse abweicht.",
  xrechnung:
    "Nur für öffentliche Auftraggeber (Behörden): Leitweg-ID und die eigene Lieferantennummer beim Kunden, immer beide. Dann erzeugt Lexware Office Rechnungen als XRechnung.",
  email: "E-Mail-Adresse, Typ „Geschäftlich“. Belege und Zahlungserinnerungen gehen zuerst an diese Adresse.",
  email_office: "E-Mail-Adresse, Typ „Büro“.",
  email_private: "E-Mail-Adresse, Typ „Privat“.",
  email_other: "E-Mail-Adresse, Typ „Andere“.",
  phone: "Telefonnummer, Typ „Geschäftlich“.",
  phone_office: "Telefonnummer, Typ „Büro“.",
  phone_mobile: "Telefonnummer, Typ „Mobil“.",
  phone_private: "Telefonnummer, Typ „Privat“.",
  phone_fax: "Faxnummer.",
  phone_other: "Telefonnummer, Typ „Andere“.",
  note: `Interne Notiz zum Kontakt (höchstens ${MAX_NOTE_LENGTH} Zeichen); erscheint nicht auf Belegen.`,
} as const;

const PERSON_FIELD = {
  salutation: `Anrede, z. B. „Herr“ (höchstens ${MAX_SALUTATION_LENGTH} Zeichen).`,
  first_name: "Vorname.",
  last_name: "Nachname.",
  email: "E-Mail-Adresse des Ansprechpartners.",
  phone: "Telefonnummer des Ansprechpartners.",
  on_documents: "„Ansprechpartner auf dem Beleg anzeigen“. Standard: ja.",
} as const;

const ADDRESS_FIELD = {
  supplement: "Adresszusatz, z. B. Abteilung oder c/o.",
  street: "Straße und Hausnummer.",
  zip: "Postleitzahl.",
  city: "Ort.",
  country_code: "ISO-Ländercode (ISO 3166-1 alpha-2), Standard DE.",
} as const;

const XRECHNUNG_FIELD = {
  buyer_reference: "Leitweg-ID des Kunden, z. B. 04011000-1234512345-35.",
  vendor_number_at_customer: "Die eigene Lieferantennummer beim Kunden.",
} as const;

const COMPANY_ONLY = ["tax_number", "vat_id", "allow_tax_free_invoices", "contact_person"] as const;
const PERSON_ONLY = ["salutation", "first_name"] as const;
const CHANGE_FIELDS = [
  "company_name",
  ...COMPANY_ONLY,
  ...PERSON_ONLY,
  "last_name",
  "address_supplement",
  "street",
  "zip",
  "city",
  "country_code",
  "shipping_address",
  "xrechnung",
  "email",
  "email_office",
  "email_private",
  "email_other",
  "phone",
  "phone_office",
  "phone_mobile",
  "phone_private",
  "phone_fax",
  "phone_other",
  "note",
] as const;

// --- Creating ----------------------------------------------------------------------

export const customerInputSchema = z
  .object({
    company_name: line(255).optional().describe(`${FIELD.company_name} Entweder dieser oder last_name.`),
    tax_number: line(50).optional().describe(FIELD.tax_number),
    vat_id: line(20).optional().describe(FIELD.vat_id),
    allow_tax_free_invoices: z.boolean().optional().describe(FIELD.allow_tax_free_invoices),
    contact_person: z
      .object({
        salutation: line(MAX_SALUTATION_LENGTH).optional().describe(PERSON_FIELD.salutation),
        first_name: line(100).optional().describe(PERSON_FIELD.first_name),
        last_name: line(100).describe(PERSON_FIELD.last_name),
        email: email.optional().describe(PERSON_FIELD.email),
        phone: phone.optional().describe(PERSON_FIELD.phone),
        on_documents: z.boolean().optional().describe(PERSON_FIELD.on_documents),
      })
      .strict()
      .optional()
      .describe(FIELD.contact_person),
    salutation: line(MAX_SALUTATION_LENGTH).optional().describe(FIELD.salutation),
    first_name: line(100).optional().describe(FIELD.first_name),
    last_name: line(100).optional().describe(`${FIELD.last_name} Entweder dieser oder company_name.`),
    address_supplement: line(200).optional().describe(FIELD.address_supplement),
    // Required on purpose: the description asks to ask for a missing address;
    // the schema enforces it, so a skipped question cannot create half a contact.
    street: line(200).describe(FIELD.street),
    zip: line(10).describe(FIELD.zip),
    city: line(100).describe(FIELD.city),
    country_code: countryCode.optional().describe(FIELD.country_code),
    shipping_address: z
      .object({
        supplement: line(200).optional().describe(ADDRESS_FIELD.supplement),
        street: line(200).describe(ADDRESS_FIELD.street),
        zip: line(10).describe(ADDRESS_FIELD.zip),
        city: line(100).describe(ADDRESS_FIELD.city),
        country_code: countryCode.optional().describe(ADDRESS_FIELD.country_code),
      })
      .strict()
      .optional()
      .describe(FIELD.shipping_address),
    xrechnung: z
      .object({
        buyer_reference: line(100).describe(XRECHNUNG_FIELD.buyer_reference),
        vendor_number_at_customer: line(100).describe(XRECHNUNG_FIELD.vendor_number_at_customer),
      })
      .strict()
      .optional()
      .describe(FIELD.xrechnung),
    email: email.optional().describe(FIELD.email),
    email_office: email.optional().describe(FIELD.email_office),
    email_private: email.optional().describe(FIELD.email_private),
    email_other: email.optional().describe(FIELD.email_other),
    phone: phone.optional().describe(FIELD.phone),
    phone_office: phone.optional().describe(FIELD.phone_office),
    phone_mobile: phone.optional().describe(FIELD.phone_mobile),
    phone_private: phone.optional().describe(FIELD.phone_private),
    phone_fax: phone.optional().describe(FIELD.phone_fax),
    phone_other: phone.optional().describe(FIELD.phone_other),
    note: line(MAX_NOTE_LENGTH).optional().describe(FIELD.note),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (Boolean(input.company_name) === Boolean(input.last_name)) {
      ctx.addIssue({ code: "custom", message: "Genau eines von company_name (Firma) und last_name (Privatperson) angeben." });
    }
    if (input.company_name) {
      for (const key of PERSON_ONLY) {
        if (input[key] !== undefined) ctx.addIssue({ code: "custom", path: [key], message: `${key} gilt nur für Privatpersonen; bei einer Firma gehört die Person in contact_person.` });
      }
    }
    if (input.last_name) {
      for (const key of COMPANY_ONLY) {
        if (input[key] !== undefined) ctx.addIssue({ code: "custom", path: [key], message: `${key} gilt nur für Firmen.` });
      }
    }
  });

export type CustomerInput = z.infer<typeof customerInputSchema>;

export const customerDescription =
  "Legt einen neuen Kunden in Lexware Office an — eine Firma (company_name) oder eine Privatperson (last_name, dazu first_name und salutation). " +
  "Bei einer Firma steht der Firmenname als Kunde auf den Belegen; die Person dort ist contact_person (Ansprechpartner, standardmäßig auf Belegen angezeigt) — nie first_name/last_name. " +
  "Pflicht ist die Rechnungsadresse (Straße, PLZ, Ort) — fehlt sie, frage sie zuerst beim Nutzer ab. " +
  "Alles Weitere ist optional und nur zu setzen, wenn es bekannt ist: Steuernummer, USt-IdNr., steuerfreie Rechnungen (Drittland), " +
  "Lieferadresse, XRechnung (nur Behörden: Leitweg-ID und Lieferantennummer), je eine E-Mail-Adresse und Telefonnummer pro Typ und eine interne Notiz. " +
  "Prüfe vorher mit dem Lese-Tool (/contacts?name=…), ob der Kunde schon existiert — Lexware sucht erst ab 3 Zeichen; " +
  "kürzere Namen (z. B. „XY“) sind als Kundenname erlaubt, dann ohne Vorabsuche direkt dieses Tool aufrufen. " +
  "Einen bestehenden Kunden ergänzt oder korrigiert update_customer. Legt erst nach Freigabe an.";

export const customerNameOf = (input: Partial<CustomerInput>) => input.company_name?.trim() || input.last_name?.trim() || "";
const label = (contact: { name: string; number?: number }) => `${contact.name}${contact.number ? ` (Nr. ${contact.number})` : ""}`;

/** The input as the library writes it. */
function newCustomerOf(input: CustomerInput): NewCustomer {
  const cp = input.contact_person;
  return {
    ...(input.company_name
      ? {
          company: {
            name: input.company_name,
            taxNumber: input.tax_number,
            vatRegistrationId: input.vat_id,
            allowTaxFreeInvoices: input.allow_tax_free_invoices,
            ...(cp
              ? {
                  contactPerson: {
                    salutation: cp.salutation,
                    firstName: cp.first_name,
                    lastName: cp.last_name,
                    primary: cp.on_documents ?? true,
                    emailAddress: cp.email,
                    phoneNumber: cp.phone,
                  },
                }
              : {}),
          },
        }
      : {}),
    ...(input.last_name ? { person: { salutation: input.salutation, firstName: input.first_name, lastName: input.last_name } } : {}),
    billingAddress: { supplement: input.address_supplement, street: input.street, zip: input.zip, city: input.city, countryCode: input.country_code },
    ...(input.shipping_address
      ? {
          shippingAddress: {
            supplement: input.shipping_address.supplement,
            street: input.shipping_address.street,
            zip: input.shipping_address.zip,
            city: input.shipping_address.city,
            countryCode: input.shipping_address.country_code,
          },
        }
      : {}),
    ...(input.xrechnung ? { xRechnung: { buyerReference: input.xrechnung.buyer_reference, vendorNumberAtCustomer: input.xrechnung.vendor_number_at_customer } } : {}),
    emailAddresses: { business: input.email, office: input.email_office, private: input.email_private, other: input.email_other },
    phoneNumbers: {
      business: input.phone,
      office: input.phone_office,
      mobile: input.phone_mobile,
      private: input.phone_private,
      fax: input.phone_fax,
      other: input.phone_other,
    },
    note: input.note,
  };
}

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
    created = await createCustomer(ops.client, newCustomerOf(input), approved.signal);
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

// --- Changing ----------------------------------------------------------------------

/** A field to change: a value sets it, null removes it, left out keeps it. */
const change = <T extends z.ZodType>(schema: T, description: string) => schema.nullable().optional().describe(`${description} null entfernt den Wert.`);

export const customerUpdateInputSchema = z
  .object({
    contact_id: z.string().uuid().optional().describe("Id des Kontakts in Lexware Office — entweder diese oder customer_number."),
    customer_number: z.number().int().positive().optional().describe("Kundennummer in Lexware Office — entweder diese oder contact_id."),
    company_name: line(255).optional().describe(FIELD.company_name),
    tax_number: change(line(50), FIELD.tax_number),
    vat_id: change(line(20), FIELD.vat_id),
    allow_tax_free_invoices: z.boolean().optional().describe(FIELD.allow_tax_free_invoices),
    contact_person: z
      .object({
        salutation: change(line(MAX_SALUTATION_LENGTH), PERSON_FIELD.salutation),
        first_name: change(line(100), PERSON_FIELD.first_name),
        last_name: line(100).optional().describe(`${PERSON_FIELD.last_name} Pflicht, wenn die Firma noch keinen Ansprechpartner hat.`),
        email: change(email, PERSON_FIELD.email),
        phone: change(phone, PERSON_FIELD.phone),
        on_documents: z.boolean().optional().describe(PERSON_FIELD.on_documents),
      })
      .strict()
      .nullable()
      .optional()
      .describe(`${FIELD.contact_person} Angegebene Felder ersetzen die bisherigen, die übrigen bleiben. null entfernt den Ansprechpartner.`),
    salutation: change(line(MAX_SALUTATION_LENGTH), FIELD.salutation),
    first_name: change(line(100), FIELD.first_name),
    last_name: line(100).optional().describe(FIELD.last_name),
    address_supplement: change(line(200), FIELD.address_supplement),
    street: line(200).optional().describe(FIELD.street),
    zip: line(10).optional().describe(FIELD.zip),
    city: line(100).optional().describe(FIELD.city),
    country_code: countryCode.optional().describe(FIELD.country_code),
    shipping_address: z
      .object({
        supplement: change(line(200), ADDRESS_FIELD.supplement),
        street: line(200).optional().describe(ADDRESS_FIELD.street),
        zip: line(10).optional().describe(ADDRESS_FIELD.zip),
        city: line(100).optional().describe(ADDRESS_FIELD.city),
        country_code: countryCode.optional().describe(ADDRESS_FIELD.country_code),
      })
      .strict()
      .nullable()
      .optional()
      .describe(`${FIELD.shipping_address} Angegebene Felder ersetzen die bisherigen. null entfernt die Lieferadresse.`),
    xrechnung: z
      .object({
        buyer_reference: line(100).optional().describe(XRECHNUNG_FIELD.buyer_reference),
        vendor_number_at_customer: line(100).optional().describe(XRECHNUNG_FIELD.vendor_number_at_customer),
      })
      .strict()
      .nullable()
      .optional()
      .describe(`${FIELD.xrechnung} null entfernt beide.`),
    email: change(email, FIELD.email),
    email_office: change(email, FIELD.email_office),
    email_private: change(email, FIELD.email_private),
    email_other: change(email, FIELD.email_other),
    phone: change(phone, FIELD.phone),
    phone_office: change(phone, FIELD.phone_office),
    phone_mobile: change(phone, FIELD.phone_mobile),
    phone_private: change(phone, FIELD.phone_private),
    phone_fax: change(phone, FIELD.phone_fax),
    phone_other: change(phone, FIELD.phone_other),
    note: change(line(MAX_NOTE_LENGTH), `${FIELD.note} Ersetzt die bisherige Notiz.`),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (Boolean(input.contact_id) === (input.customer_number !== undefined)) {
      ctx.addIssue({ code: "custom", message: "Genau eines von contact_id und customer_number angeben." });
    }
    if (!CHANGE_FIELDS.some((key) => input[key] !== undefined)) {
      ctx.addIssue({ code: "custom", message: "Keine Änderung angegeben." });
    }
  });

export type CustomerUpdateInput = z.infer<typeof customerUpdateInputSchema>;

export const customerUpdateDescription =
  "Ändert oder ergänzt einen bestehenden Kunden in Lexware Office, etwa Ansprechpartner, USt-IdNr., Adresse, E-Mail oder Telefon. " +
  "Den Kunden nennt contact_id oder customer_number (vorher mit dem Lese-Tool über /contacts suchen). " +
  "Nur angegebene Felder ändern sich: ein Wert setzt, null entfernt, weggelassen bleibt. Gruppen (contact_person, shipping_address, xrechnung) " +
  "werden feldweise zusammengeführt; null für die ganze Gruppe entfernt sie. Eine Firma bleibt Firma, eine Person bleibt Person. " +
  "Die Karte zeigt jedes Feld mit altem und neuem Wert. Kontakte mit mehreren Adressen, Ansprechpartnern oder Einträgen je Typ lässt Lexware " +
  "über die Schnittstelle nicht ändern — dann in Lexware Office selbst bearbeiten. Ändert erst nach Freigabe.";

/** The input as the library's changes. */
export function customerChangesOf(input: CustomerUpdateInput): CustomerChanges {
  const cp = input.contact_person;
  const company: NonNullable<CustomerChanges["company"]> = {
    ...(input.company_name !== undefined ? { name: input.company_name } : {}),
    ...(input.tax_number !== undefined ? { taxNumber: input.tax_number } : {}),
    ...(input.vat_id !== undefined ? { vatRegistrationId: input.vat_id } : {}),
    ...(input.allow_tax_free_invoices !== undefined ? { allowTaxFreeInvoices: input.allow_tax_free_invoices } : {}),
    ...(cp === null
      ? { contactPerson: null }
      : cp
        ? {
            contactPerson: {
              ...(cp.salutation !== undefined ? { salutation: cp.salutation } : {}),
              ...(cp.first_name !== undefined ? { firstName: cp.first_name } : {}),
              ...(cp.last_name !== undefined ? { lastName: cp.last_name } : {}),
              ...(cp.email !== undefined ? { emailAddress: cp.email } : {}),
              ...(cp.phone !== undefined ? { phoneNumber: cp.phone } : {}),
              primary: cp.on_documents ?? true,
            },
          }
        : {}),
  };
  const person: NonNullable<CustomerChanges["person"]> = {
    ...(input.salutation !== undefined ? { salutation: input.salutation } : {}),
    ...(input.first_name !== undefined ? { firstName: input.first_name } : {}),
    ...(input.last_name !== undefined ? { lastName: input.last_name } : {}),
  };
  const billing = {
    ...(input.address_supplement !== undefined ? { supplement: input.address_supplement } : {}),
    ...(input.street !== undefined ? { street: input.street } : {}),
    ...(input.zip !== undefined ? { zip: input.zip } : {}),
    ...(input.city !== undefined ? { city: input.city } : {}),
    ...(input.country_code !== undefined ? { countryCode: input.country_code } : {}),
  };
  const shipping = input.shipping_address;
  const x = input.xrechnung;
  const entries = <T extends string>(pairs: [T, string | null | undefined][]) =>
    Object.fromEntries(pairs.filter(([, value]) => value !== undefined)) as Partial<Record<T, string | null>>;
  const emails = entries([
    ["business", input.email],
    ["office", input.email_office],
    ["private", input.email_private],
    ["other", input.email_other],
  ]);
  const phones = entries([
    ["business", input.phone],
    ["office", input.phone_office],
    ["mobile", input.phone_mobile],
    ["private", input.phone_private],
    ["fax", input.phone_fax],
    ["other", input.phone_other],
  ]);
  return {
    ...(Object.keys(company).length > 0 ? { company } : {}),
    ...(Object.keys(person).length > 0 ? { person } : {}),
    ...(Object.keys(billing).length > 0 ? { billingAddress: billing } : {}),
    ...(shipping === null
      ? { shippingAddress: null }
      : shipping
        ? {
            shippingAddress: {
              ...(shipping.supplement !== undefined ? { supplement: shipping.supplement } : {}),
              ...(shipping.street !== undefined ? { street: shipping.street } : {}),
              ...(shipping.zip !== undefined ? { zip: shipping.zip } : {}),
              ...(shipping.city !== undefined ? { city: shipping.city } : {}),
              ...(shipping.country_code !== undefined ? { countryCode: shipping.country_code } : {}),
            },
          }
        : {}),
    ...(x === null
      ? { xRechnung: null }
      : x
        ? {
            xRechnung: {
              ...(x.buyer_reference !== undefined ? { buyerReference: x.buyer_reference } : {}),
              ...(x.vendor_number_at_customer !== undefined ? { vendorNumberAtCustomer: x.vendor_number_at_customer } : {}),
            },
          }
        : {}),
    ...(Object.keys(emails).length > 0 ? { emailAddresses: emails } : {}),
    ...(Object.keys(phones).length > 0 ? { phoneNumbers: phones } : {}),
    ...(input.note !== undefined ? { note: input.note } : {}),
  };
}

/** A changed field as a person reads it on the card. */
export const CONTACT_FIELD_LABEL: Record<string, string> = {
  "company.name": "Firmenname",
  "company.taxNumber": "Steuernummer",
  "company.vatRegistrationId": "USt-IdNr.",
  "company.allowTaxFreeInvoices": "Steuerfreie Rechnungen",
  "company.contactPerson.salutation": "Ansprechpartner: Anrede",
  "company.contactPerson.firstName": "Ansprechpartner: Vorname",
  "company.contactPerson.lastName": "Ansprechpartner: Nachname",
  "company.contactPerson.emailAddress": "Ansprechpartner: E-Mail",
  "company.contactPerson.phoneNumber": "Ansprechpartner: Telefon",
  "company.contactPerson.primary": "Ansprechpartner auf Belegen",
  "person.salutation": "Anrede",
  "person.firstName": "Vorname",
  "person.lastName": "Nachname",
  "addresses.billing.supplement": "Rechnungsadresse: Zusatz",
  "addresses.billing.street": "Rechnungsadresse: Straße",
  "addresses.billing.zip": "Rechnungsadresse: PLZ",
  "addresses.billing.city": "Rechnungsadresse: Ort",
  "addresses.billing.countryCode": "Rechnungsadresse: Land",
  "addresses.shipping.supplement": "Lieferadresse: Zusatz",
  "addresses.shipping.street": "Lieferadresse: Straße",
  "addresses.shipping.zip": "Lieferadresse: PLZ",
  "addresses.shipping.city": "Lieferadresse: Ort",
  "addresses.shipping.countryCode": "Lieferadresse: Land",
  "xRechnung.buyerReference": "Leitweg-ID",
  "xRechnung.vendorNumberAtCustomer": "Lieferantennummer beim Kunden",
  "emailAddresses.business": "E-Mail geschäftlich",
  "emailAddresses.office": "E-Mail Büro",
  "emailAddresses.private": "E-Mail privat",
  "emailAddresses.other": "E-Mail andere",
  "phoneNumbers.business": "Telefon geschäftlich",
  "phoneNumbers.office": "Telefon Büro",
  "phoneNumbers.mobile": "Telefon mobil",
  "phoneNumbers.private": "Telefon privat",
  "phoneNumbers.fax": "Fax",
  "phoneNumbers.other": "Telefon andere",
  note: "Notiz",
};

const changeWarning = (change: ContactChange): Warning => ({
  kind: "contact-change",
  label: CONTACT_FIELD_LABEL[change.field] ?? change.field,
  before: change.before,
  after: change.after,
});

const nameOfDetails = (contact: ContactDetails) =>
  contact.company?.name ?? ([contact.person?.firstName, contact.person?.lastName].filter(Boolean).join(" ") || "unbekannt");

export interface PreparedCustomerUpdate {
  /** The contact as the account knows it, then every changed field with its old and new value. */
  warnings: Warning[];
  /** What the card was made for: the contact and its version. A contact changed since stops the write. */
  binding: { contactId: string; version: number } | null;
  /** Set when the change cannot go ahead — nothing to approve; say this instead. */
  refusal?: string;
}

/** Reads the contact and plans the change: the card shows each field with its old and new value. */
export async function prepareCustomerUpdate(api: LexwareClient, input: CustomerUpdateInput, signal?: AbortSignal): Promise<PreparedCustomerUpdate> {
  let contact: ContactDetails;
  try {
    let id = input.contact_id;
    if (!id) {
      const found = await findContactByNumber(api, input.customer_number!, signal);
      if (!found) return { warnings: [], binding: null, refusal: `Keinen Kontakt mit der Kundennummer ${input.customer_number} gefunden.` };
      id = found.id;
    }
    contact = await getContactDetails(api, id, signal);
  } catch (error) {
    return { warnings: [], binding: null, refusal: `Kontakt nicht lesbar: ${describeError(error)}` };
  }
  let changes: ContactChange[];
  try {
    changes = planCustomerUpdate(contact, customerChangesOf(input)).changes;
  } catch (error) {
    return { warnings: [], binding: null, refusal: error instanceof Error ? error.message : String(error) };
  }
  if (changes.length === 0) return { warnings: [], binding: null, refusal: "Nichts zu ändern: Der Kontakt hat diese Werte schon." };
  return {
    warnings: [{ kind: "customer-resolved", name: nameOfDetails(contact), number: contact.roles?.customer?.number }, ...changes.map(changeWarning)],
    binding: { contactId: contact.id, version: contact.version },
  };
}

/** Changes the approved customer. `id` keys the journal: a replay does not write twice. */
export async function executeApprovedCustomerUpdate(
  ops: { client: LexwareClient; journal: Journal },
  input: CustomerUpdateInput,
  approved: {
    id: string;
    /** `prepareCustomerUpdate`'s binding: the contact and the version the card showed. */
    contactId: string;
    version: number;
    signal?: AbortSignal;
  },
): Promise<Record<string, unknown>> {
  const journal = await ops.journal.read("customer-update", approved.id);
  if (journal?.status === "created") {
    return { contactId: approved.contactId, note: "Wiederaufnahme: Der Kunde war bereits geändert — nichts doppelt geschrieben." };
  }
  await ops.journal.write("customer-update", approved.id, { status: "pending" });
  let updated;
  try {
    // The version the card showed: a contact edited since in Lexware Office is not overwritten.
    updated = await updateCustomer(ops.client, approved.contactId, customerChangesOf(input), { expectedVersion: approved.version, signal: approved.signal });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Abgebrochen")) throw error;
    throw new Error(`Kunde nicht geändert: ${describeError(error)}`);
  }
  await ops.journal.write("customer-update", approved.id, { status: "created", resourceId: updated.id });
  return {
    contactId: updated.id,
    customerNumber: updated.customerNumber,
    name: updated.name,
    changed: updated.changes.map((change) => CONTACT_FIELD_LABEL[change.field] ?? change.field),
  };
}
