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
  SALES_TEXT_LIMITS,
  countsToTotal,
  createSalesDocument,
  describeError,
  findContactByNumber,
  findDuplicateSalesDocument,
  getContact,
  getSalesDocument,
  isPricedLine,
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

const nameField = z.string().trim().min(1).max(SALES_TEXT_LIMITS.lineItemName);

const descriptionField = z
  .string()
  .trim()
  .min(1)
  .max(SALES_TEXT_LIMITS.lineItemDescription)
  .optional()
  .describe(
    "Mehrzeiliger Text unter der Bezeichnung (Leistungsumfang, Enthalten/Nicht enthalten, Annahmen), höchstens 2000 Zeichen. " +
      "Zeilenumbruch \\n; Markdown: **fett**, __kursiv__, Listen mit \"- \"",
  );

/** A line without a price — a heading such as „Teil 1: Festpreis" or a paragraph between positions. */
export const textItemSchema = z
  .object({
    type: z.literal("text").describe('"text": Zwischenüberschrift oder Absatz ohne Preis, Menge und Steuer'),
    name: nameField.describe('Überschrift, z.B. "Teil 1: Festpreis"'),
    description: descriptionField,
  })
  .strict();

const pricedFields = {
  name: nameField.describe("Artikel- oder Leistungsbezeichnung"),
  description: descriptionField,
  quantity: z.number().positive().max(10_000).describe("Menge; auch nicht-ganzzahlig möglich (z.B. 1.5 Stunden)"),
  unit: z.string().trim().min(1).max(20).describe('Einheit, z.B. "Stück", "Stunde", "Pauschale". Ohne Angabe des Nutzers: "Stück"'),
  // Free items appear on documents at 0.00 and belong there.
  net_price: z.number().nonnegative().refine(isCentExact, { message: "höchstens zwei Nachkommastellen" }).describe("Netto-Einzelpreis in EUR, 0.00 für Gratisartikel"),
  tax_rate: z.union([z.literal(0), z.literal(7), z.literal(19)]).describe("Steuersatz in Prozent: 0, 7 oder 19. Ohne Angabe des Nutzers: 19"),
};

/**
 * One line of a sales document: priced, or `type: "text"`. Only quotations
 * know optional lines — Lexware Office documents the flag for nothing else.
 */
export function lineItemSchema(options: { allowOptional: boolean }) {
  const priced = z
    .object(
      options.allowOptional
        ? {
            ...pricedFields,
            optional: z.boolean().optional().describe('true: „Optionale Position" — mit Preis, aber nicht in der Angebotssumme'),
          }
        : pricedFields,
    )
    .strict();
  return z.union([textItemSchema, priced]);
}

export type LineItemInput =
  | z.infer<typeof textItemSchema>
  | { name: string; description?: string; quantity: number; unit: string; net_price: number; tax_rate: 0 | 7 | 19; optional?: boolean };

/** A line as the model may send it — cards and checks also run on incomplete input. */
export interface PartialLineItemInput {
  type?: "text";
  name?: string;
  description?: string;
  quantity?: number;
  unit?: string;
  net_price?: number;
  tax_rate?: number;
  optional?: boolean;
}

export const toLineItems = (items: readonly PartialLineItemInput[] = []): LineItem[] =>
  items.map((item) =>
    item.type === "text"
      ? { type: "text" as const, name: item.name ?? "", ...(item.description ? { description: item.description } : {}) }
      : {
          name: item.name ?? "",
          ...(item.description ? { description: item.description } : {}),
          quantity: item.quantity ?? 0,
          unit: item.unit ?? "Stück",
          netPrice: item.net_price ?? 0,
          taxRate: item.tax_rate ?? 19,
          ...(item.optional ? { optional: true } : {}),
        },
  );

/** Net total of the lines that count — no headings, no optional lines. */
export const totalOf = (items: readonly LineItem[]): number => netTotal(items.filter(countsToTotal));

export const optionalItemsOf = (items: readonly LineItem[]) => items.filter((item) => isPricedLine(item) && item.optional === true);

/** At least one line must carry the document — headings and optional lines alone make no total. */
export const hasCountingLine = (items: readonly PartialLineItemInput[]): boolean => toLineItems(items).some(countsToTotal);

export const COUNTING_LINE_MESSAGE = "Mindestens eine Position mit Preis, die in die Summe zählt (nicht nur Textpositionen oder optionale).";

/** Opening and closing text — left out, the account's defaults from Lexware Office stay. */
export const documentTextFields = {
  introduction: z
    .string()
    .trim()
    .min(1)
    .max(SALES_TEXT_LIMITS.introduction)
    .optional()
    .describe("Einleitungstext über den Positionen, höchstens 2000 Zeichen, Markdown. Ohne Angabe der Standardtext aus Lexware Office"),
  remark: z
    .string()
    .trim()
    .min(1)
    .max(SALES_TEXT_LIMITS.remark)
    .optional()
    .describe("Schlussnotiz unter den Positionen (z.B. Bedingungen), höchstens 2000 Zeichen, Markdown. Ohne Angabe der Standardtext aus Lexware Office"),
};

export const draftField = (what: string) => ({
  draft: z
    .boolean()
    .optional()
    .describe(`true: ${what} als Entwurf anlegen, nicht festschreiben — zum Gegenlesen in Lexware Office. Ohne Angabe festgeschrieben`),
});

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
  items?: readonly PartialLineItemInput[];
  title?: string;
  introduction?: string;
  remark?: string;
  draft?: boolean;
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
  const itemsNet = totalOf(toLineItems(input.items));
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

  warnings.push(...(await checkSource(kind, input, contact, itemsNet, signal)));
  return warnings;
}

/**
 * The source document a new one derives from: does it exist, belong to the
 * same customer, and add up the same? A different total can be intended
 * (changed positions), a foreign customer almost never is. Optional lines
 * count on neither side.
 */
async function checkSource(target: SalesDocumentKind, input: SalesInput, contact: Contact | null, itemsNet: number, signal?: AbortSignal): Promise<Warning[]> {
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
    if (chainImpossible(target, kind, source)) warnings.push({ kind: "source-chain-impossible", sourceLabel });
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

/** Lexware Office refuses an order confirmation pursued from a quotation with optional or alternative lines (406). */
function chainImpossible(target: SalesDocumentKind, source: SalesDocumentKind, detail: { hasOptionalOrAlternative: boolean }): boolean {
  return target === "order-confirmation" && source === "quotation" && detail.hasOptionalOrAlternative;
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
 * get their number now) unless `draft` asks otherwise, invoices always as
 * drafts — finalized and sent in Lexware Office. A replay of the same call does not create twice; a document that
 * appeared between card and click stops the write.
 */
export async function executeSalesDocument(
  kind: SalesDocumentKind,
  input: SalesInput,
  ctx: { callId: string; abortSignal?: AbortSignal },
): Promise<Record<string, unknown>> {
  const label = DOCUMENT_LABEL[kind];
  const items = toLineItems(input.items);
  const computed = totalOf(items);
  const optional = optionalItemsOf(items);
  const finalize = kind !== "invoice" && input.draft !== true;
  const counts = {
    positions: items.filter(countsToTotal).length,
    netTotal: computed,
    ...(optional.length > 0 ? { optionalPositions: optional.length, optionalNetTotal: netTotal(optional.filter(isPricedLine)) } : {}),
  };

  const journal = await readJournal(kind, ctx.callId);
  if (journal?.resourceId) {
    return {
      ...(await describeCreated(kind, journal.resourceId, ctx.abortSignal)),
      ...counts,
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
  const linkable = sourceId ? await canChain(kind, input.source_document_type, sourceId, ctx.abortSignal) : false;
  let chained = linkable;
  const create = (precedingSalesVoucherId?: string) =>
    createSalesDocument(
      client(),
      {
        kind,
        contactId: contact.id,
        items,
        title: input.title,
        expirationDate,
        finalize,
        precedingSalesVoucherId,
        introduction: input.introduction,
        remark: input.remark,
      },
      ctx.abortSignal,
    );

  let created;
  try {
    created = await create(linkable ? sourceId : undefined);
  } catch (error) {
    if (!(linkable && isPursueRejection(error))) throw new Error(`${label} nicht angelegt: ${describeError(error)}`);
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
    status: finalize ? "festgeschrieben" : "Entwurf",
    ...counts,
    ...(expirationDate ? { validUntil: expirationDate } : {}),
    ...(sourceId
      ? {
          sourceDocument: chained
            ? `verknüpft mit ${DOCUMENT_LABEL[input.source_document_type ?? "quotation"]} ${sourceId}`
            : linkable
              ? `KEINE Verknüpfung — Lexware Office hat den Bezug auf ${sourceId} abgelehnt (ohne Belegkette angelegt)`
              : `KEINE Verknüpfung — das Angebot ${sourceId} hat optionale Positionen, daraus verknüpft Lexware Office keine AB (ohne Belegkette angelegt)`,
        }
      : {}),
    preflightNotes: notesOf(ctx.callId),
    note: finalize
      ? `${[label, detail.voucherNumber].filter(Boolean).join(" ")} ist festgeschrieben. Versand an den Kunden aus Lexware Office.`
      : `${label} ist ein Entwurf, nicht festgeschrieben — gegenlesen, festschreiben und versenden in Lexware Office.`,
  };
}

/**
 * Whether to send the link at all: a quotation with optional lines cannot
 * become an order confirmation's predecessor. A failed read tries the link —
 * the 406 fallback still catches it.
 */
async function canChain(kind: SalesDocumentKind, sourceKind: SalesDocumentKind | undefined, id: string, signal?: AbortSignal): Promise<boolean> {
  if (!sourceKind) return true;
  if (kind !== "order-confirmation" || sourceKind !== "quotation") return true;
  try {
    return !chainImpossible(kind, sourceKind, await getSalesDocument(client(), sourceKind, id, signal));
  } catch {
    return true;
  }
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
