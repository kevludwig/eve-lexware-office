/**
 * What quotation, order confirmation, and invoice share: the line-item
 * schema, finding the customer, the checks before the card, and creating the
 * document — so the three cannot drift apart.
 *
 * None of these findings can be fixed by the model: behind a chat order there
 * is no document with a total to check against. They all go to the card.
 */

import {
  ITEMS_TOTAL_TOLERANCE,
  createSalesDocument,
  describeError,
  findContactByNumber,
  findDuplicateSalesDocument,
  getContact,
  getSalesDocument,
  isPursueRejection,
  netTotal,
  round2,
  type Contact,
  type LineItem,
  type SalesDocumentKind,
} from "@kevludwig/lexware-office";
import { z } from "zod";

import { describeWarning, notesOf, saveWarnings, wasShownOnCard, type Warning } from "./findings";
import { readJournal, writeJournal } from "./journal";
import { client } from "./runtime";

export const DOCUMENT_LABEL: Record<SalesDocumentKind, string> = {
  quotation: "Angebot",
  "order-confirmation": "Auftragsbestätigung",
  invoice: "Rechnung",
};

/** Amounts must be cent-exact — more digits are a reading artefact. */
export function isCentExact(value: number): boolean {
  return Math.abs(value * 100 - Math.round(value * 100)) < 1e-6;
}

/** Lexware accepts at most 300 line items per document. */
export const MAX_LINE_ITEMS = 300;

export const lineItemSchema = z
  .object({
    name: z.string().trim().min(1).max(255).describe("Artikel- oder Leistungsbezeichnung"),
    quantity: z.number().positive().max(10_000).describe("Menge; auch nicht-ganzzahlig möglich (z.B. 1.5 Stunden)"),
    unit: z.string().trim().min(1).max(20).describe('Einheit, z.B. "Stück", "Stunde", "Pauschale". Ohne Angabe des Nutzers: "Stück"'),
    // Free items appear on documents at 0.00 and belong there.
    net_price: z.number().nonnegative().refine(isCentExact, { message: "höchstens zwei Nachkommastellen" }).describe("Netto-Einzelpreis in EUR, 0.00 für Gratisartikel"),
    tax_rate: z.union([z.literal(0), z.literal(7), z.literal(19)]).describe("Steuersatz in Prozent: 0, 7 oder 19. Ohne Angabe des Nutzers: 19"),
  })
  .strict();

export type LineItemInput = z.infer<typeof lineItemSchema>;

export const toLineItems = (items: readonly Partial<LineItemInput>[] = []): LineItem[] =>
  items.map((item) => ({ name: item.name ?? "", quantity: item.quantity ?? 0, unit: item.unit ?? "Stück", netPrice: item.net_price ?? 0, taxRate: item.tax_rate ?? 19 }));

/** Titles that name a document type — a copied "Angebot" on an order confirmation prints it as a second quotation. */
const TYPE_LABELS = new Set(["angebot", "auftragsbestatigung", "angebotsbestatigung", "rechnung", "lieferschein", "gutschrift", "ab"]);

export function isDocumentTypeLabel(title: string): boolean {
  const bare = title
    .toLowerCase()
    .replace(/ä/g, "a")
    .replace(/ö/g, "o")
    .replace(/ü/g, "u")
    .replace(/ß/g, "ss")
    .replace(/ae/g, "a")
    .replace(/[^a-z]/g, "");
  return TYPE_LABELS.has(bare);
}

/** Whether yyyy-MM-dd names a real day — the pattern alone accepts 2026-02-30. */
export function isCalendarDate(value: string): boolean {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month! - 1 && date.getUTCDate() === day;
}

/** Title as the API allows it: max. 25 characters (a longer one answers 406), and no document type. */
export const titleSchema = (what: string) =>
  z
    .string()
    .trim()
    .min(1)
    .max(25)
    .refine((value) => !isDocumentTypeLabel(value), {
      message: "Der Titel ersetzt die gedruckte Überschrift — eine Belegart-Bezeichnung ist kein Titel. Ohne Projektnamen das Feld weglassen.",
    })
    .optional()
    .describe(
      `Titel ${what}, z.B. der Projektname — höchstens 25 Zeichen. Er ersetzt die gedruckte Überschrift; nicht den Titel ` +
        "eines anderen Belegs übernehmen. Ohne Angabe der Standard von Lexware Office",
    );

export const customerFields = {
  customer_number: z.number().int().positive().optional().describe("Kundennummer in Lexware Office"),
  contact_id: z.string().uuid().optional().describe("Alternativ zur Kundennummer: die Kontakt-UUID"),
};

export interface SalesInput {
  customer_number?: number;
  contact_id?: string;
  items?: readonly Partial<LineItemInput>[];
  title?: string;
  valid_until?: string;
  source_document_id?: string;
  source_document_type?: SalesDocumentKind;
}

/**
 * The customer behind a number or contact id. There is no collective customer:
 * a document to the wrong contact is wrong, not slightly off — an unresolvable
 * one is a warning on the card and an error when writing.
 */
export async function resolveCustomer(input: SalesInput, signal?: AbortSignal): Promise<{ contact: Contact | null; warnings: Warning[] }> {
  if (input.contact_id) {
    try {
      const contact = await getContact(client(), input.contact_id, signal);
      if (!contact.isCustomer) {
        return { contact: null, warnings: [{ kind: "sales-contact", reason: `contact_id ${input.contact_id} („${contact.name}") ist kein Kundenkontakt` }] };
      }
      return { contact, warnings: [] };
    } catch (error) {
      return { contact: null, warnings: [{ kind: "sales-contact", reason: `contact_id ${input.contact_id} ließ sich nicht auflösen (${describeError(error)})` }] };
    }
  }
  if (typeof input.customer_number === "number") {
    try {
      const contact = await findContactByNumber(client(), input.customer_number, signal);
      return contact
        ? { contact, warnings: [] }
        : { contact: null, warnings: [{ kind: "sales-contact", reason: `Kein Kontakt mit Kundennummer ${input.customer_number}` }] };
    } catch (error) {
      return { contact: null, warnings: [{ kind: "sales-contact", reason: describeError(error) }] };
    }
  }
  return { contact: null, warnings: [{ kind: "sales-contact", reason: "weder Kundennummer noch contact_id angegeben" }] };
}

/** Customer, duplicates, and the source document — network errors become findings, not exceptions. */
export async function runSalesPreflight(kind: SalesDocumentKind, input: SalesInput, signal?: AbortSignal): Promise<Warning[]> {
  const warnings: Warning[] = [];
  const itemsNet = netTotal(toLineItems(input.items));
  const { contact, warnings: contactWarnings } = await resolveCustomer(input, signal);
  warnings.push(...contactWarnings);

  if (contact) {
    // The real name on the card: a valid but wrong contact_id passes every role check.
    warnings.push({ kind: "customer-resolved", name: contact.name, number: contact.number });
    try {
      const result = await findDuplicateSalesDocument(client(), { kind, contactId: contact.id, itemsTotalNet: itemsNet, signal });
      if (result.status === "match") {
        warnings.push({
          kind: "sales-duplicate",
          documentLabel: DOCUMENT_LABEL[kind],
          url: result.match.url,
          voucherNumber: result.match.voucherNumber,
          voucherDate: result.match.voucherDate,
          voucherStatus: result.match.voucherStatus,
        });
      } else if (result.status === "incomplete") {
        warnings.push({ kind: "duplicate-check-incomplete", reason: result.reason });
      }
    } catch (error) {
      warnings.push({ kind: "sales-duplicate-check-failed", reason: describeError(error) });
    }
  }

  warnings.push(...(await checkSource(input, contact, itemsNet, signal)));
  return warnings;
}

/**
 * The source document a new one derives from: does it exist, belong to the
 * same customer, and add up the same? A different total can be intended
 * (changed positions), a foreign customer almost never is.
 */
async function checkSource(input: SalesInput, contact: Contact | null, itemsNet: number, signal?: AbortSignal): Promise<Warning[]> {
  const id = input.source_document_id?.trim();
  if (!id) return [];
  const kind = input.source_document_type;
  if (!kind) return [{ kind: "source-check-failed", reason: "source_document_id ohne source_document_type angegeben" }];
  const label = DOCUMENT_LABEL[kind];
  try {
    const source = await getSalesDocument(client(), kind, id, signal);
    const sourceLabel = `${label} ${source.voucherNumber ?? id}`;
    const warnings: Warning[] = [{ kind: "source-resolved", sourceLabel, contactName: source.contactName }];
    // A total discount is invisible in the lines: copying them reproduces the full prices.
    if ((source.discountAbsolute ?? 0) > 0 || (source.discountPercentage ?? 0) > 0) {
      warnings.push({ kind: "source-discount", sourceLabel, discountAbsolute: source.discountAbsolute, discountPercentage: source.discountPercentage, sourceNet: source.totalNet });
    }
    if (contact && source.contactId && source.contactId !== contact.id) {
      warnings.push({ kind: "sales-contact", reason: `${sourceLabel} gehört zu „${source.contactName ?? source.contactId}", nicht zum angegebenen Kunden — vermutlich der falsche Bezugsbeleg` });
    }
    if (Number.isFinite(source.lineItemsNet)) {
      const difference = round2(itemsNet - source.lineItemsNet);
      if (Math.abs(difference) > ITEMS_TOTAL_TOLERANCE) warnings.push({ kind: "source-mismatch", sourceLabel, sourceNet: source.lineItemsNet, itemsNet, difference });
    }
    return warnings;
  } catch (error) {
    return [{ kind: "source-check-failed", reason: `${label} ${id}: ${describeError(error)}` }];
  }
}

/** The approval policy of a sales tool: checks to state, then the card decides. */
export function salesApproval(kind: SalesDocumentKind, normalize: (input: SalesInput) => SalesInput = (input) => input) {
  return async (ctx: { toolInput?: unknown; callId: string; abortSignal?: AbortSignal }) => {
    const input = ctx.toolInput as SalesInput | undefined;
    if (!input?.items?.length) return "user-approval" as const;
    saveWarnings(ctx.callId, await runSalesPreflight(kind, normalize(input), ctx.abortSignal));
    return "user-approval" as const;
  };
}

/** Default validity of a quotation when the user names none. */
export const QUOTATION_VALIDITY_DAYS = 30;

/**
 * Creates the document: quotations and order confirmations finalized (they
 * get their number now), invoices as drafts — finalized and sent in Lexware
 * Office. A replay of the same call does not create twice; a document that
 * appeared between card and click stops the write.
 */
export async function executeSalesDocument(
  kind: SalesDocumentKind,
  input: SalesInput,
  ctx: { callId: string; abortSignal?: AbortSignal },
): Promise<Record<string, unknown>> {
  const label = DOCUMENT_LABEL[kind];
  const items = toLineItems(input.items);
  const computed = netTotal(items);
  const finalize = kind !== "invoice";

  const journal = await readJournal(kind, ctx.callId);
  if (journal?.resourceId) {
    return {
      ...(await describeCreated(kind, journal.resourceId, ctx.abortSignal)),
      positions: items.length,
      netTotal: computed,
      note: `Wiederaufnahme: ${label} war aus einem abgebrochenen Lauf bereits angelegt — nichts doppelt erstellt.`,
    };
  }

  const { contact, warnings } = await resolveCustomer(input, ctx.abortSignal);
  if (!contact) throw new Error(`Kunde nicht auflösbar: ${warnings.map((warning) => describeWarning(warning).value).join("; ")}`);

  // Hours can pass between card and click; a search error must not block the approved write.
  try {
    const duplicate = await findDuplicateSalesDocument(client(), { kind, contactId: contact.id, itemsTotalNet: computed, signal: ctx.abortSignal });
    if (duplicate.status === "match" && !wasShownOnCard(ctx.callId, duplicate.match.url)) {
      throw new Error(
        `Abgebrochen: Inzwischen gibt es bereits ${kind === "invoice" ? "eine" : "ein"} ${label} mit dieser Positionssumme: ${duplicate.match.url}. ` +
          "Nichts angelegt. Rufe das Tool erneut auf, wenn trotzdem ein weiterer Beleg entstehen soll — dann steht der Fund auf der Karte.",
      );
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Abgebrochen:")) throw error;
  }

  const expirationDate =
    kind === "quotation" ? (input.valid_until ?? new Date(Date.now() + QUOTATION_VALIDITY_DAYS * 86_400_000).toISOString().slice(0, 10)) : undefined;

  await writeJournal(kind, ctx.callId, { status: "pending" });

  // A named source becomes a document chain; an invalid pursue (406) must not
  // block the approved document — then it is created without the link.
  const sourceId = input.source_document_id?.trim() || undefined;
  let chained = Boolean(sourceId);
  const create = (precedingSalesVoucherId?: string) =>
    createSalesDocument(
      client(),
      { kind, contactId: contact.id, items, title: input.title, expirationDate, finalize, precedingSalesVoucherId },
      ctx.abortSignal,
    );

  let created;
  try {
    created = await create(sourceId);
  } catch (error) {
    if (!(sourceId && isPursueRejection(error))) throw new Error(`${label} nicht angelegt: ${describeError(error)}`);
    chained = false;
    try {
      created = await create(undefined);
    } catch (retryError) {
      throw new Error(`${label} nicht angelegt: ${describeError(retryError)}`);
    }
  }

  await writeJournal(kind, ctx.callId, { status: "created", resourceId: created.id });
  const detail = await describeCreated(kind, created.id, ctx.abortSignal);

  return {
    ...detail,
    kind,
    documentName: [label, detail.voucherNumber].filter(Boolean).join(" "),
    contactName: contact.name,
    positions: items.length,
    netTotal: computed,
    ...(expirationDate ? { validUntil: expirationDate } : {}),
    ...(sourceId
      ? {
          sourceDocument: chained
            ? `verknüpft mit ${DOCUMENT_LABEL[input.source_document_type ?? "quotation"]} ${sourceId}`
            : `KEINE Verknüpfung — Lexware Office hat den Bezug auf ${sourceId} abgelehnt (ohne Belegkette angelegt)`,
        }
      : {}),
    preflightNotes: notesOf(ctx.callId),
    note: finalize
      ? `${[label, detail.voucherNumber].filter(Boolean).join(" ")} ist festgeschrieben. Versand an den Kunden aus Lexware Office.`
      : "Der Entwurf ist nicht festgeschrieben — prüfen und versenden in Lexware Office.",
  };
}

async function describeCreated(kind: SalesDocumentKind, id: string, signal?: AbortSignal): Promise<{ documentId: string; url: string; voucherNumber?: string }> {
  try {
    const detail = await getSalesDocument(client(), kind, id, signal);
    return { documentId: id, url: detail.url, voucherNumber: detail.voucherNumber };
  } catch {
    // The document exists — a failed read-back only costs the number.
    return { documentId: id, url: client().voucherUrl(id) };
  }
}
