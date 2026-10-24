/**
 * Contacts — customers and vendors alike.
 *
 * Search is fuzzy on the API side: "Beispiel" finds "Beispiel GmbH",
 * "Müller" may find three. Functions here return candidates and leave
 * the choice to the caller; guessing one of several is the worse mistake.
 */

import { query, type LexwareClient } from "./client.ts";

export interface Contact {
  id: string;
  /** Company name, or first and last name of a person. */
  name: string;
  /** Customer or vendor number, where assigned. */
  number?: number;
  isCustomer: boolean;
  isVendor: boolean;
  /** A company rather than a person. */
  isCompany?: boolean;
  /** The company's VAT ID (USt-IdNr.) — needed for the § 13b and intra-community tax types. */
  vatRegistrationId?: string;
  /** „Steuerfreie Rechnung erlauben" — needed for the third-country tax types. */
  allowTaxFreeInvoices?: boolean;
  /** ISO code of the first billing address. */
  countryCode?: string;
}

interface RawContact {
  id: string;
  roles?: { customer?: { number?: number }; vendor?: { number?: number } };
  company?: { name?: string; vatRegistrationId?: string; allowTaxFreeInvoices?: boolean };
  addresses?: { billing?: { countryCode?: string }[] };
  person?: { firstName?: string; lastName?: string };
  emailAddresses?: Partial<Record<EmailType, string[]>>;
}

interface ContactPage {
  content?: RawContact[];
}

function nameOf(raw: Pick<RawContact, "company" | "person">): string {
  return raw.company?.name ?? [raw.person?.firstName, raw.person?.lastName].filter(Boolean).join(" ");
}

function toContact(raw: RawContact): Contact {
  return {
    id: raw.id,
    name: nameOf(raw) || "unbekannt",
    number: raw.roles?.customer?.number ?? raw.roles?.vendor?.number,
    isCustomer: raw.roles?.customer !== undefined,
    isVendor: raw.roles?.vendor !== undefined,
    isCompany: raw.company !== undefined,
    ...(raw.company?.vatRegistrationId?.trim() ? { vatRegistrationId: raw.company.vatRegistrationId.trim() } : {}),
    ...(raw.company?.allowTaxFreeInvoices !== undefined ? { allowTaxFreeInvoices: raw.company.allowTaxFreeInvoices } : {}),
    ...(raw.addresses?.billing?.[0]?.countryCode ? { countryCode: raw.addresses.billing[0].countryCode } : {}),
  };
}

/** A contact by its id. */
export async function getContact(client: LexwareClient, id: string, signal?: AbortSignal): Promise<Contact> {
  return toContact(await client.request<RawContact>(`/contacts/${encodeURIComponent(id)}`, { signal }));
}

/** The contact with this customer number, or null. */
export async function findContactByNumber(
  client: LexwareClient,
  customerNumber: number,
  signal?: AbortSignal,
): Promise<Contact | null> {
  const page = await client.request<ContactPage>(`/contacts${query({ number: customerNumber })}`, { signal });
  const raw = page.content?.[0];
  return raw ? toContact(raw) : null;
}

/** Lexware searches names from three characters on; shorter ones it refuses with a 400. */
export const MIN_NAME_SEARCH_LENGTH = 3;

/**
 * Contacts whose name matches — fuzzy, up to `size` (default 10). A name
 * shorter than MIN_NAME_SEARCH_LENGTH finds nothing (no request): callers
 * that must not mistake that for "no match" check the length themselves.
 */
export async function findContactsByName(
  client: LexwareClient,
  name: string,
  options: { customer?: boolean; vendor?: boolean; size?: number; signal?: AbortSignal } = {},
): Promise<Contact[]> {
  if (name.trim().length < MIN_NAME_SEARCH_LENGTH) return [];
  const page = await client.request<ContactPage>(
    `/contacts${query({ name, customer: options.customer, vendor: options.vendor, size: options.size ?? 10 })}`,
    { signal: options.signal },
  );
  return (page.content ?? []).map(toContact);
}

/**
 * The one contact a name clearly means: an exact match, or the only
 * candidate. Otherwise `match` is null and the candidates are for the caller
 * to choose from.
 */
export async function resolveContactByName(
  client: LexwareClient,
  name: string,
  options: { customer?: boolean; vendor?: boolean; signal?: AbortSignal } = {},
): Promise<{ match: Contact | null; candidates: Contact[] }> {
  const needle = name.trim();
  if (!needle) return { match: null, candidates: [] };
  const candidates = await findContactsByName(client, needle, options);
  const exact = candidates.filter((contact) => contact.name.toLowerCase() === needle.toLowerCase());
  if (exact.length === 1) return { match: exact[0]!, candidates };
  if (candidates.length === 1) return { match: candidates[0]!, candidates };
  return { match: null, candidates };
}

/** Where a contact receives mail: a business address first, then office, other, private. */
export async function contactEmail(client: LexwareClient, id: string, signal?: AbortSignal): Promise<string | null> {
  const raw = await client.request<RawContact>(`/contacts/${encodeURIComponent(id)}`, { signal });
  const addresses = raw.emailAddresses ?? {};
  return (
    [...(addresses.business ?? []), ...(addresses.office ?? []), ...(addresses.other ?? []), ...(addresses.private ?? [])]
      .map((address) => address.trim())
      .find((address) => address.includes("@")) ?? null
  );
}

// --- Contact details, creating and updating ------------------------------------

/** The kinds of email address a contact holds, as Lexware Office names them. */
export const EMAIL_TYPES = ["business", "office", "private", "other"] as const;
export type EmailType = (typeof EMAIL_TYPES)[number];

/** The kinds of phone number a contact holds, as Lexware Office names them. */
export const PHONE_TYPES = ["business", "office", "mobile", "private", "fax", "other"] as const;
export type PhoneType = (typeof PHONE_TYPES)[number];

/** Salutation of a person or contact person: at most this many characters. */
export const MAX_SALUTATION_LENGTH = 25;
/** The contact's note: at most this many characters. */
export const MAX_NOTE_LENGTH = 1000;

/** A billing or shipping address. */
export interface ContactAddress {
  /** Additional address information, e.g. a department or c/o. */
  supplement?: string;
  /** Street with street number. */
  street?: string;
  zip?: string;
  city?: string;
  /** ISO 3166-1 alpha-2, e.g. DE. Required by the API on every address. */
  countryCode: string;
}

/**
 * The contact person of a company. The API creates and updates contacts with
 * at most one; a contact with more can be read but not updated.
 */
export interface ContactPerson {
  /** Max MAX_SALUTATION_LENGTH characters, e.g. "Frau". */
  salutation?: string;
  firstName?: string;
  lastName: string;
  /** The primary contact person is shown on vouchers. API default: false. */
  primary?: boolean;
  emailAddress?: string;
  phoneNumber?: string;
}

/** A contact as the API returns it, every documented property typed. */
export interface ContactDetails {
  id: string;
  organizationId?: string;
  /** Revision for optimistic locking; an update must send the current one. */
  version: number;
  /** At least one role. The numbers are assigned by Lexware Office and cannot be set or changed. */
  roles: { customer?: { number?: number }; vendor?: { number?: number } };
  /** Exactly one of company or person. */
  company?: {
    name: string;
    /** Steuernummer. */
    taxNumber?: string;
    /** USt-IdNr.; Lexware Office checks it against the German rules. */
    vatRegistrationId?: string;
    /** „Steuerfreie Rechnung erlauben". */
    allowTaxFreeInvoices?: boolean;
    contactPersons?: ContactPerson[];
  };
  person?: { salutation?: string; firstName?: string; lastName: string };
  addresses?: { billing?: ContactAddress[]; shipping?: ContactAddress[] };
  /** For German public authorities: both set, Lexware Office writes XRechnung invoices. */
  xRechnung?: {
    /** The customer's Leitweg-ID. */
    buyerReference?: string;
    /** Your vendor number at the customer. */
    vendorNumberAtCustomer?: string;
  };
  emailAddresses?: Partial<Record<EmailType, string[]>>;
  phoneNumbers?: Partial<Record<PhoneType, string[]>>;
  /** Internal note, max MAX_NOTE_LENGTH characters; never on vouchers. */
  note?: string;
  /** Read-only. */
  archived?: boolean;
}

/** Every documented property of a contact, by its id. */
export async function getContactDetails(client: LexwareClient, id: string, signal?: AbortSignal): Promise<ContactDetails> {
  return client.request<ContactDetails>(`/contacts/${encodeURIComponent(id)}`, { signal });
}

/** An address to write: the country defaults to DE. */
export type AddressInput = Omit<ContactAddress, "countryCode"> & { countryCode?: string };

export interface NewCustomer {
  /** Exactly one of company or person. */
  company?: {
    name: string;
    /** Steuernummer. */
    taxNumber?: string;
    /** USt-IdNr.; Lexware Office checks it against the German rules. */
    vatRegistrationId?: string;
    /** „Steuerfreie Rechnung erlauben" — needed for the third-country tax types. */
    allowTaxFreeInvoices?: boolean;
    /** The one contact person the API accepts. `primary: true` shows them on vouchers. */
    contactPerson?: ContactPerson;
  };
  person?: { salutation?: string; firstName?: string; lastName: string };
  billingAddress?: AddressInput;
  shippingAddress?: AddressInput;
  /** For German public authorities: both or neither. */
  xRechnung?: { buyerReference: string; vendorNumberAtCustomer: string };
  /** One address per type — the API accepts no more on writes. */
  emailAddresses?: Partial<Record<EmailType, string>>;
  /** One number per type — the API accepts no more on writes. */
  phoneNumbers?: Partial<Record<PhoneType, string>>;
  /** Shortcut for `emailAddresses.business`. */
  email?: string;
  /** Shortcut for `phoneNumbers.business`. */
  phone?: string;
  /** Internal note, max MAX_NOTE_LENGTH characters; never on vouchers. */
  note?: string;
}

export interface CreatedCustomer {
  id: string;
  /** Assigned by Lexware Office on creation; missing if the read-back failed. */
  customerNumber?: number;
  /** The name as stored. */
  name: string;
}

const filled = (value: string | undefined | null): value is string => typeof value === "string" && value.trim() !== "";

/** What the API would reject in a contact about to be written, in German — empty when it is fine. */
export function contactProblems(contact: Omit<ContactDetails, "id" | "version" | "roles"> & { version?: number }): string[] {
  const problems: string[] = [];
  if (Boolean(contact.company) === Boolean(contact.person)) problems.push("Ein Kontakt ist entweder eine Firma oder eine Person.");
  if (contact.company && !filled(contact.company.name)) problems.push("Firmenname fehlt.");
  if (contact.person && !filled(contact.person.lastName)) problems.push("Nachname fehlt.");
  const persons = contact.company?.contactPersons ?? [];
  if (persons.length > 1) problems.push("Lexware Office nimmt über die Schnittstelle höchstens einen Ansprechpartner an.");
  for (const person of persons) if (!filled(person.lastName)) problems.push("Nachname des Ansprechpartners fehlt.");
  for (const salutation of [contact.person?.salutation, ...persons.map((person) => person.salutation)]) {
    if (salutation && salutation.length > MAX_SALUTATION_LENGTH) problems.push(`Anrede länger als ${MAX_SALUTATION_LENGTH} Zeichen.`);
  }
  for (const kind of ["billing", "shipping"] as const) {
    const list = contact.addresses?.[kind] ?? [];
    const label = kind === "billing" ? "Rechnungsadresse" : "Lieferadresse";
    if (list.length > 1) problems.push(`Lexware Office nimmt über die Schnittstelle höchstens eine ${label} an.`);
    for (const address of list) if (!/^[A-Z]{2}$/.test(address.countryCode ?? "")) problems.push(`${label}: Ländercode nach ISO 3166-1 alpha-2 (z. B. DE) fehlt.`);
  }
  for (const type of EMAIL_TYPES) if ((contact.emailAddresses?.[type]?.length ?? 0) > 1) problems.push(`Höchstens eine E-Mail-Adresse je Typ (${type}).`);
  for (const type of PHONE_TYPES) if ((contact.phoneNumbers?.[type]?.length ?? 0) > 1) problems.push(`Höchstens eine Telefonnummer je Typ (${type}).`);
  const x = contact.xRechnung;
  if (x && filled(x.buyerReference) && !filled(x.vendorNumberAtCustomer)) problems.push("XRechnung: Zur Leitweg-ID gehört die eigene Lieferantennummer beim Kunden.");
  if (contact.note && contact.note.length > MAX_NOTE_LENGTH) problems.push(`Notiz länger als ${MAX_NOTE_LENGTH} Zeichen.`);
  return problems;
}

const address = (input: AddressInput): ContactAddress => ({
  ...(filled(input.supplement) ? { supplement: input.supplement } : {}),
  ...(filled(input.street) ? { street: input.street } : {}),
  ...(filled(input.zip) ? { zip: input.zip } : {}),
  ...(filled(input.city) ? { city: input.city } : {}),
  countryCode: filled(input.countryCode) ? input.countryCode.trim().toUpperCase() : "DE",
});

const person = (input: ContactPerson): ContactPerson => ({
  ...(filled(input.salutation) ? { salutation: input.salutation } : {}),
  ...(filled(input.firstName) ? { firstName: input.firstName } : {}),
  lastName: input.lastName,
  primary: input.primary ?? false,
  ...(filled(input.emailAddress) ? { emailAddress: input.emailAddress } : {}),
  ...(filled(input.phoneNumber) ? { phoneNumber: input.phoneNumber } : {}),
});

function lists<T extends string>(types: readonly T[], values: Partial<Record<T, string>>): Partial<Record<T, string[]>> | undefined {
  const entries = types.filter((type) => filled(values[type])).map((type): [T, string[]] => [type, [values[type]!.trim()]]);
  return entries.length > 0 ? (Object.fromEntries(entries) as Partial<Record<T, string[]>>) : undefined;
}

/** The POST body of a new customer. */
function newCustomerBody(input: NewCustomer): Record<string, unknown> {
  const company = input.company;
  const emails = lists(EMAIL_TYPES, { business: input.email, ...input.emailAddresses });
  const phones = lists(PHONE_TYPES, { business: input.phone, ...input.phoneNumbers });
  const addresses = {
    ...(input.billingAddress ? { billing: [address(input.billingAddress)] } : {}),
    ...(input.shippingAddress ? { shipping: [address(input.shippingAddress)] } : {}),
  };
  return {
    version: 0,
    roles: { customer: {} },
    ...(company
      ? {
          company: {
            name: company.name,
            ...(filled(company.taxNumber) ? { taxNumber: company.taxNumber } : {}),
            ...(filled(company.vatRegistrationId) ? { vatRegistrationId: company.vatRegistrationId.replace(/\s+/g, "") } : {}),
            ...(company.allowTaxFreeInvoices !== undefined ? { allowTaxFreeInvoices: company.allowTaxFreeInvoices } : {}),
            ...(company.contactPerson ? { contactPersons: [person(company.contactPerson)] } : {}),
          },
        }
      : {}),
    ...(input.person
      ? {
          person: {
            ...(filled(input.person.salutation) ? { salutation: input.person.salutation } : {}),
            ...(filled(input.person.firstName) ? { firstName: input.person.firstName } : {}),
            lastName: input.person.lastName,
          },
        }
      : {}),
    ...(Object.keys(addresses).length > 0 ? { addresses } : {}),
    ...(input.xRechnung ? { xRechnung: input.xRechnung } : {}),
    ...(emails ? { emailAddresses: emails } : {}),
    ...(phones ? { phoneNumbers: phones } : {}),
    ...(filled(input.note) ? { note: input.note } : {}),
  };
}

/**
 * Creates a customer and reads it back: the customer number is assigned
 * server-side, and the stored name is what belongs in a confirmation. Throws
 * on what contactProblems finds, before sending. Needs the key permission
 * "Kontakte bearbeiten".
 */
export async function createCustomer(
  client: LexwareClient,
  input: NewCustomer,
  signal?: AbortSignal,
): Promise<CreatedCustomer> {
  if (Boolean(input.company) === Boolean(input.person)) {
    throw new Error("Ein Kunde ist entweder eine Firma oder eine Person.");
  }
  const payload = newCustomerBody(input);
  const problems = contactProblems(payload as Parameters<typeof contactProblems>[0]);
  if (problems.length > 0) throw new Error(problems.join(" "));

  const created = await client.request<{ id: string }>("/contacts", { method: "POST", json: payload, signal });
  const fallbackName = input.company?.name ?? input.person?.lastName ?? "unbekannt";
  try {
    const detail = await client.request<RawContact>(`/contacts/${created.id}`, { signal });
    return { id: created.id, customerNumber: detail.roles?.customer?.number, name: nameOf(detail) || fallbackName };
  } catch {
    // The customer exists; a failed read-back must not look like a failed creation.
    return { id: created.id, name: fallbackName };
  }
}

/**
 * Changes to a contact. A field left out stays as it is; `null` removes it.
 * A company stays a company and a person a person — the API cannot switch.
 */
export interface CustomerChanges {
  company?: {
    name?: string;
    taxNumber?: string | null;
    vatRegistrationId?: string | null;
    allowTaxFreeInvoices?: boolean;
    /** Replaces the contact person field by field: `null` in a field removes it, `null` for the whole removes the person. */
    contactPerson?: { [K in keyof ContactPerson]?: ContactPerson[K] | null } | null;
  };
  person?: { salutation?: string | null; firstName?: string | null; lastName?: string };
  /** Merged field by field into the existing address; `null` removes the address. */
  billingAddress?: { [K in keyof AddressInput]?: AddressInput[K] | null } | null;
  shippingAddress?: { [K in keyof AddressInput]?: AddressInput[K] | null } | null;
  /** `null` removes both. */
  xRechnung?: { buyerReference?: string | null; vendorNumberAtCustomer?: string | null } | null;
  emailAddresses?: Partial<Record<EmailType, string | null>>;
  phoneNumbers?: Partial<Record<PhoneType, string | null>>;
  note?: string | null;
}

/** One changed field: `field` is the property path, e.g. "company.vatRegistrationId"; values as text, "" for empty. */
export interface ContactChange {
  field: string;
  before: string;
  after: string;
}

/**
 * Lists the API cannot update when they hold more than one entry — a
 * contact with any of them can be read but not changed via the API.
 */
export function updateBlockers(contact: ContactDetails): string[] {
  const blocked: string[] = [];
  if ((contact.addresses?.billing?.length ?? 0) > 1) blocked.push("addresses.billing");
  if ((contact.addresses?.shipping?.length ?? 0) > 1) blocked.push("addresses.shipping");
  for (const type of EMAIL_TYPES) if ((contact.emailAddresses?.[type]?.length ?? 0) > 1) blocked.push(`emailAddresses.${type}`);
  for (const type of PHONE_TYPES) if ((contact.phoneNumbers?.[type]?.length ?? 0) > 1) blocked.push(`phoneNumbers.${type}`);
  if ((contact.company?.contactPersons?.length ?? 0) > 1) blocked.push("company.contactPersons");
  return blocked;
}

const shown = (value: unknown): string => (value === undefined || value === null ? "" : typeof value === "boolean" ? (value ? "ja" : "nein") : String(value).trim());

/** Applies `changes` field by field: undefined keeps, null removes, a value sets. */
function merged<T extends object>(current: T | undefined, changes: { [K in keyof T]?: T[K] | null }): Partial<T> {
  const result: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) continue;
    if (value === null || (typeof value === "string" && value.trim() === "")) delete result[key];
    else result[key] = typeof value === "string" ? value.trim() : value;
  }
  return result as Partial<T>;
}

function flatten(contact: Partial<ContactDetails>): Map<string, string> {
  const fields = new Map<string, string>();
  const put = (field: string, value: unknown) => fields.set(field, shown(value));
  if (contact.company) {
    put("company.name", contact.company.name);
    put("company.taxNumber", contact.company.taxNumber);
    put("company.vatRegistrationId", contact.company.vatRegistrationId);
    put("company.allowTaxFreeInvoices", contact.company.allowTaxFreeInvoices ?? false);
    const cp = contact.company.contactPersons?.[0];
    for (const key of ["salutation", "firstName", "lastName", "emailAddress", "phoneNumber"] as const) put(`company.contactPerson.${key}`, cp?.[key]);
    put("company.contactPerson.primary", cp ? (cp.primary ?? false) : undefined);
  }
  if (contact.person) for (const key of ["salutation", "firstName", "lastName"] as const) put(`person.${key}`, contact.person[key]);
  for (const kind of ["billing", "shipping"] as const) {
    const a = contact.addresses?.[kind]?.[0];
    for (const key of ["supplement", "street", "zip", "city", "countryCode"] as const) put(`addresses.${kind}.${key}`, a?.[key]);
  }
  put("xRechnung.buyerReference", contact.xRechnung?.buyerReference);
  put("xRechnung.vendorNumberAtCustomer", contact.xRechnung?.vendorNumberAtCustomer);
  for (const type of EMAIL_TYPES) put(`emailAddresses.${type}`, contact.emailAddresses?.[type]?.[0]);
  for (const type of PHONE_TYPES) put(`phoneNumbers.${type}`, contact.phoneNumbers?.[type]?.[0]);
  put("note", contact.note);
  return fields;
}

/**
 * The PUT body for `changes` on `contact`, and what changes field by field.
 * Pure: the caller shows `changes` before writing. Throws, in German, on what
 * the API would reject — lists with more than one entry (updateBlockers), a
 * switch between company and person, or what contactProblems finds.
 */
export function planCustomerUpdate(contact: ContactDetails, changes: CustomerChanges): { body: Record<string, unknown>; changes: ContactChange[] } {
  const blocked = updateBlockers(contact);
  if (blocked.length > 0) {
    throw new Error(`Lexware Office lässt diesen Kontakt über die Schnittstelle nicht ändern: mehr als ein Eintrag in ${blocked.join(", ")}. Bitte in Lexware Office bearbeiten.`);
  }
  if (changes.company && !contact.company) throw new Error("Der Kontakt ist eine Person; Firmenangaben lassen sich nicht setzen.");
  if (changes.person && !contact.person) throw new Error("Der Kontakt ist eine Firma; Personenangaben lassen sich nicht setzen.");

  const next: Partial<ContactDetails> = {
    version: contact.version,
    roles: Object.fromEntries(Object.keys(contact.roles ?? {}).map((role) => [role, {}])) as ContactDetails["roles"],
  };
  if (contact.company) {
    const { contactPerson, ...companyChanges } = changes.company ?? {};
    const { contactPersons, ...company } = contact.company;
    const current = contactPersons?.[0];
    const cp = contactPerson === null ? undefined : contactPerson ? merged<ContactPerson>(current, contactPerson) : current;
    next.company = {
      ...(merged(company, { ...companyChanges, vatRegistrationId: companyChanges.vatRegistrationId?.replace(/\s+/g, "") ?? companyChanges.vatRegistrationId }) as NonNullable<ContactDetails["company"]>),
      ...(cp ? { contactPersons: [cp as ContactPerson] } : {}),
    };
  }
  if (contact.person) next.person = merged(contact.person, changes.person ?? {}) as NonNullable<ContactDetails["person"]>;

  const addresses: NonNullable<ContactDetails["addresses"]> = {};
  for (const kind of ["billing", "shipping"] as const) {
    const change = kind === "billing" ? changes.billingAddress : changes.shippingAddress;
    const current = contact.addresses?.[kind]?.[0];
    if (change === null) continue;
    const result = change ? merged<ContactAddress>(current, change) : current;
    if (result && Object.keys(result).length > 0) addresses[kind] = [{ ...result, countryCode: result.countryCode?.toUpperCase() ?? "DE" } as ContactAddress];
  }
  if (Object.keys(addresses).length > 0) next.addresses = addresses;

  const x = changes.xRechnung === null ? undefined : changes.xRechnung ? merged(contact.xRechnung, changes.xRechnung) : contact.xRechnung;
  if (x && Object.keys(x).length > 0) next.xRechnung = x;

  const emails = lists(EMAIL_TYPES, merged(Object.fromEntries(EMAIL_TYPES.map((type) => [type, contact.emailAddresses?.[type]?.[0]])), changes.emailAddresses ?? {}) as Partial<Record<EmailType, string>>);
  if (emails) next.emailAddresses = emails;
  const phones = lists(PHONE_TYPES, merged(Object.fromEntries(PHONE_TYPES.map((type) => [type, contact.phoneNumbers?.[type]?.[0]])), changes.phoneNumbers ?? {}) as Partial<Record<PhoneType, string>>);
  if (phones) next.phoneNumbers = phones;

  const note = changes.note === undefined ? contact.note : changes.note === null || changes.note.trim() === "" ? undefined : changes.note;
  if (filled(note)) next.note = note;

  const problems = contactProblems(next as Parameters<typeof contactProblems>[0]);
  if (problems.length > 0) throw new Error(problems.join(" "));

  const before = flatten(contact);
  const after = flatten(next);
  const diff = [...new Set([...before.keys(), ...after.keys()])]
    .map((field) => ({ field, before: before.get(field) ?? "", after: after.get(field) ?? "" }))
    .filter((change) => change.before !== change.after);
  return { body: next, changes: diff };
}

export interface UpdatedCustomer {
  id: string;
  /** The version after the update; missing if the read-back failed. */
  version?: number;
  customerNumber?: number;
  name: string;
  changes: ContactChange[];
}

/**
 * Updates a contact: reads it, applies `changes` (planCustomerUpdate) and
 * writes it back with its version. With `expectedVersion`, a contact changed
 * since — e.g. since a person approved the changes — is not written: the
 * error starts with "Abgebrochen". Needs the key permission "Kontakte bearbeiten".
 */
export async function updateCustomer(
  client: LexwareClient,
  id: string,
  changes: CustomerChanges,
  options: { expectedVersion?: number; signal?: AbortSignal } = {},
): Promise<UpdatedCustomer> {
  const contact = await getContactDetails(client, id, options.signal);
  if (options.expectedVersion !== undefined && contact.version !== options.expectedVersion) {
    throw new Error(
      `Abgebrochen: Der Kontakt wurde inzwischen in Lexware Office geändert (Version ${contact.version} statt ${options.expectedVersion}). Nichts geändert.`,
    );
  }
  const plan = planCustomerUpdate(contact, changes);
  if (plan.changes.length === 0) return { id, version: contact.version, customerNumber: contact.roles?.customer?.number, name: nameOf(contact) || "unbekannt", changes: [] };

  await client.request(`/contacts/${encodeURIComponent(id)}`, { method: "PUT", json: plan.body, signal: options.signal });
  try {
    const detail = await getContactDetails(client, id, options.signal);
    return { id, version: detail.version, customerNumber: detail.roles?.customer?.number, name: nameOf(detail) || "unbekannt", changes: plan.changes };
  } catch {
    // The update went through; a failed read-back must not look like a failed update.
    return { id, customerNumber: contact.roles?.customer?.number, name: nameOf(plan.body as Partial<ContactDetails>) || nameOf(contact) || "unbekannt", changes: plan.changes };
  }
}
