/**
 * Contacts — customers and vendors alike.
 *
 * Search is fuzzy on the API side: "Nordlicht" finds "Nordlicht Consulting
 * GmbH", "Müller" may find three. Functions here return candidates and leave
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
}

interface RawContact {
  id: string;
  roles?: { customer?: { number?: number }; vendor?: { number?: number } };
  company?: { name?: string };
  person?: { firstName?: string; lastName?: string };
  emailAddresses?: { business?: string[]; office?: string[]; private?: string[]; other?: string[] };
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

/** Contacts whose name matches — fuzzy, up to `size` (default 10). */
export async function findContactsByName(
  client: LexwareClient,
  name: string,
  options: { customer?: boolean; vendor?: boolean; size?: number; signal?: AbortSignal } = {},
): Promise<Contact[]> {
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

export interface NewCustomer {
  /** Exactly one of company or person. */
  company?: { name: string };
  person?: { firstName?: string; lastName: string };
  billingAddress?: {
    supplement?: string;
    street?: string;
    zip?: string;
    city?: string;
    /** ISO 3166-1 alpha-2. Default: DE. */
    countryCode?: string;
  };
  email?: string;
  phone?: string;
  /** Internal note, invisible on documents. */
  note?: string;
}

export interface CreatedCustomer {
  id: string;
  /** Assigned by Lexware Office on creation; missing if the read-back failed. */
  customerNumber?: number;
  /** The name as stored. */
  name: string;
}

/**
 * Creates a customer and reads it back: the customer number is assigned
 * server-side, and the stored name is what belongs in a confirmation. Needs
 * the key permission "Kontakte bearbeiten".
 */
export async function createCustomer(
  client: LexwareClient,
  input: NewCustomer,
  signal?: AbortSignal,
): Promise<CreatedCustomer> {
  if (Boolean(input.company) === Boolean(input.person)) {
    throw new Error("Ein Kunde ist entweder eine Firma oder eine Person.");
  }
  const address = input.billingAddress;
  const payload: Record<string, unknown> = {
    version: 0,
    roles: { customer: {} },
    ...(input.company ? { company: { name: input.company.name } } : {}),
    ...(input.person
      ? { person: { ...(input.person.firstName ? { firstName: input.person.firstName } : {}), lastName: input.person.lastName } }
      : {}),
    ...(address
      ? {
          addresses: {
            billing: [
              {
                ...(address.supplement ? { supplement: address.supplement } : {}),
                ...(address.street ? { street: address.street } : {}),
                ...(address.zip ? { zip: address.zip } : {}),
                ...(address.city ? { city: address.city } : {}),
                countryCode: address.countryCode ?? "DE",
              },
            ],
          },
        }
      : {}),
    ...(input.email ? { emailAddresses: { business: [input.email] } } : {}),
    ...(input.phone ? { phoneNumbers: { business: [input.phone] } } : {}),
    ...(input.note ? { note: input.note } : {}),
  };

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
