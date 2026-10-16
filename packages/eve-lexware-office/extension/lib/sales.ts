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
  SALES_TAX_TYPES,
  SALES_TEXT_LIMITS,
  countsToTotal,
  createSalesDocument,
  describeError,
  findContactByNumber,
  findDuplicateSalesDocument,
  defaultPaymentCondition,
  getArticle,
  getContact,
  getProfile,
  getSalesDocument,
  listCountries,
  resolvePrintLayout,
  isPricedLine,
  isPursueRejection,
  isVatFreeTaxType,
  netTotal,
  paymentTermLabel,
  round2,
  salesDocumentProblems,
  type Contact,
  type LineItem,
  type NewSalesDocument,
  type PricedLineItem,
  type SalesDocumentKind,
  type SalesTaxType,
  type ShippingConditions,
  type LexwareClient,
} from "@kevludwig/lexware-office";
import { z } from "zod";

import { describeWarning, notesOf, saveWarnings, wasShownOnCard, type Warning } from "./findings";
import { runtimeJournal } from "./journal";
import type { Journal } from "./journal-store";
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

const price = (what: string) =>
  // Free items appear on documents at 0.00 and belong there.
  z.number().nonnegative().refine(isCentExact, { message: "höchstens zwei Nachkommastellen" }).optional().describe(what);

const pricedFields = {
  name: nameField.describe("Artikel- oder Leistungsbezeichnung"),
  description: descriptionField,
  quantity: z.number().positive().max(10_000).describe("Menge; auch nicht-ganzzahlig möglich (z.B. 1.5 Stunden)"),
  unit: z.string().trim().min(1).max(20).describe('Einheit, z.B. "Stück", "Stunde", "Pauschale". Ohne Angabe des Nutzers: "Stück"'),
  net_price: price("Netto-Einzelpreis in EUR, 0.00 für Gratisartikel. Bei tax_type \"gross\" stattdessen gross_price"),
  gross_price: price('Brutto-Einzelpreis in EUR — nur bei tax_type "gross" (Bruttobeleg), dann statt net_price'),
  tax_rate: z
    .number()
    .min(0)
    .max(30)
    .describe(
      "Steuersatz in Prozent: 19, 7 oder 0. Ohne Angabe des Nutzers: 19. Bei steuerfreien Steuerarten (tax_type außer net/gross) immer 0. " +
        "Andere EU-Sätze nur mit tax_sub_type",
    ),
  discount_percent: z
    .number()
    .min(0)
    .max(100)
    .refine(isCentExact, { message: "höchstens zwei Nachkommastellen" })
    .optional()
    .describe("Rabatt auf diese Position in Prozent, z.B. 10"),
  article_id: z
    .string()
    .uuid()
    .optional()
    .describe("UUID eines Artikels aus Lexware Office (/articles), wenn die Position einen Artikel referenziert. Alle anderen Felder trotzdem angeben"),
};

const onePrice = (item: { net_price?: number; gross_price?: number }) => (item.net_price === undefined) !== (item.gross_price === undefined);
const ONE_PRICE_MESSAGE = "Genau einen Preis angeben: net_price, oder gross_price bei tax_type \"gross\".";

/** An alternative to a position — only on quotations, priced, not in the total. */
const alternativeSchema = z.object(pricedFields).strict().refine(onePrice, { message: ONE_PRICE_MESSAGE });

/**
 * One line of a sales document: priced, or `type: "text"`. Only quotations
 * know optional and alternative lines — Lexware Office documents them for
 * nothing else.
 */
export function lineItemSchema(options: { allowOptional: boolean }) {
  const priced = z
    .object(
      options.allowOptional
        ? {
            ...pricedFields,
            optional: z.boolean().optional().describe('true: „Optionale Position" — mit Preis, aber nicht in der Angebotssumme'),
            alternatives: z
              .array(alternativeSchema)
              .min(1)
              .max(20)
              .optional()
              .describe("Alternativpositionen zu dieser Position, die der Kunde statt ihrer wählen kann — gedruckt darunter, nicht in der Summe"),
          }
        : pricedFields,
    )
    .strict()
    .refine(onePrice, { message: ONE_PRICE_MESSAGE })
    .refine((item) => !("optional" in item && item.optional && "alternatives" in item && item.alternatives), {
      message: "Eine optionale Position kann keine Alternativen haben.",
    });
  return z.union([textItemSchema, priced]);
}

/** A line as the model may send it — cards and checks also run on incomplete input. */
export interface PartialLineItemInput {
  type?: "text";
  name?: string;
  description?: string;
  quantity?: number;
  unit?: string;
  net_price?: number;
  gross_price?: number;
  tax_rate?: number;
  discount_percent?: number;
  article_id?: string;
  optional?: boolean;
  alternatives?: readonly PartialLineItemInput[];
}

/** Net unit price of a gross price — four decimals, as the API keeps unit prices. */
const netOfGross = (gross: number, rate: number) => Math.round((gross / (1 + rate / 100)) * 10_000) / 10_000;

/** A priced line as the API takes it. `articleTypes` knows whether a referenced article is a service or a product. */
function toPricedLine(item: PartialLineItemInput, articleTypes?: ReadonlyMap<string, "service" | "material">): PricedLineItem {
  const taxRate = item.tax_rate ?? 19;
  return {
    name: item.name ?? "",
    ...(item.description ? { description: item.description } : {}),
    quantity: item.quantity ?? 0,
    unit: item.unit ?? "Stück",
    netPrice: item.gross_price !== undefined && item.net_price === undefined ? netOfGross(item.gross_price, taxRate) : (item.net_price ?? 0),
    ...(item.gross_price !== undefined ? { grossPrice: item.gross_price } : {}),
    taxRate,
    ...(item.discount_percent ? { discountPercentage: item.discount_percent } : {}),
    ...(item.article_id ? { article: { id: item.article_id, type: articleTypes?.get(item.article_id) ?? "service" } } : {}),
  };
}

export const toLineItems = (items: readonly PartialLineItemInput[] = [], articleTypes?: ReadonlyMap<string, "service" | "material">): LineItem[] =>
  items.map((item) =>
    item.type === "text"
      ? { type: "text" as const, name: item.name ?? "", ...(item.description ? { description: item.description } : {}) }
      : {
          ...toPricedLine(item, articleTypes),
          ...(item.optional ? { optional: true } : {}),
          ...(item.alternatives?.length ? { alternatives: item.alternatives.map((alternative) => toPricedLine(alternative, articleTypes)) } : {}),
        },
  );

/** The article ids a document references, alternatives included. */
export const articleIdsOf = (items: readonly PartialLineItemInput[] = []): string[] => [
  ...new Set(items.flatMap((item) => [item.article_id, ...(item.alternatives ?? []).map((alternative) => alternative.article_id)]).filter((id): id is string => Boolean(id))),
];

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

const dateField = (what: string) =>
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, { message: "Datum als yyyy-MM-dd" })
    .refine(isCalendarDate, { message: "kein gültiges Kalenderdatum" })
    .describe(what);

const periodField = (what: string) =>
  z
    .object({ from: dateField("Erster Tag, yyyy-MM-dd"), to: dateField("Letzter Tag, yyyy-MM-dd") })
    .strict()
    .refine((period) => period.to >= period.from, { message: "to darf nicht vor from liegen" })
    .optional()
    .describe(what);

export const TAX_TYPE_LABEL: Record<SalesTaxType, string> = {
  net: "Netto (USt. ausgewiesen)",
  gross: "Brutto (Preise inkl. USt.)",
  vatfree: "Steuerfrei",
  intraCommunitySupply: "Innergemeinschaftliche Lieferung",
  constructionService13b: "Bauleistung (§ 13b UStG)",
  externalService13b: "Fremdleistung EU (§ 13b UStG)",
  thirdPartyCountryService: "Dienstleistung an Drittland",
  thirdPartyCountryDelivery: "Ausfuhrlieferung an Drittland",
  photovoltaicEquipment: "Photovoltaik (0 %)",
};

/**
 * What every sales document takes beyond customer and positions: date,
 * payment, tax, discount, print. Left out, Lexware Office's defaults apply —
 * for payment conditions the contact's, else the account's.
 */
export const documentFields = {
  voucher_date: dateField("Belegdatum, yyyy-MM-dd — nur wenn es nicht heute sein soll").optional(),
  payment_term_days: z
    .number()
    .int()
    .min(0)
    .max(365)
    .optional()
    .describe(
      'Zahlungsziel in Tagen netto, z.B. 14 für „14 Tage netto", 0 für „sofort". Ohne Angabe gilt die Zahlungsbedingung ' +
        "des Kontakts in Lexware Office, sonst die Standard-Zahlungsbedingung des Kontos",
    ),
  payment_term_label: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .optional()
    .describe('Eigener Text der Zahlungsbedingung (nur mit payment_term_days). Ohne Angabe z.B. „Zahlbar innerhalb von 14 Tagen ohne Abzug"'),
  cash_discount: z
    .object({
      percent: z.number().positive().max(100).refine(isCentExact, { message: "höchstens zwei Nachkommastellen" }).describe("Skonto in Prozent"),
      days: z.number().int().min(1).max(365).describe("Skontofrist in Tagen"),
    })
    .strict()
    .optional()
    .describe('Skonto, z.B. { percent: 2, days: 10 } für „10 Tage 2 % Skonto" — nur mit payment_term_days'),
  total_discount_percent: z
    .number()
    .positive()
    .max(100)
    .refine(isCentExact, { message: "höchstens zwei Nachkommastellen" })
    .optional()
    .describe("Rabatt auf die Gesamtsumme in Prozent. Nicht zusammen mit total_discount_amount"),
  total_discount_amount: z
    .number()
    .positive()
    .refine(isCentExact, { message: "höchstens zwei Nachkommastellen" })
    .optional()
    .describe("Rabatt auf die Gesamtsumme in EUR (netto, bei tax_type gross brutto). Nicht zusammen mit total_discount_percent"),
  tax_type: z
    .enum(SALES_TAX_TYPES as [SalesTaxType, ...SalesTaxType[]])
    .optional()
    .describe(
      "Steuerart. Ohne Angabe net (Netto mit USt.). gross: Bruttopreise (gross_price je Position). Steuerfrei mit 0 % je Position: " +
        "vatfree (Kleinunternehmer/steuerbefreit), intraCommunitySupply (innergemeinschaftliche Lieferung, Firmenkunde EU mit USt-ID), " +
        "constructionService13b (Bauleistung § 13b, Firmenkunde mit USt-ID), externalService13b (Dienstleistung an Unternehmen im EU-Ausland, " +
        "Reverse Charge, USt-ID nötig), thirdPartyCountryService / thirdPartyCountryDelivery (Dienstleistung / Ausfuhr in ein Nicht-EU-Land), " +
        "photovoltaicEquipment (PV-Anlagen, 0 %)",
    ),
  tax_sub_type: z
    .enum(["distanceSales", "electronicServices"])
    .optional()
    .describe("Nur bei net/gross an Privatkunden im EU-Ausland: Fernverkauf bzw. elektronische Dienstleistung (dann Steuersätze des Ziellands)"),
  tax_note: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .optional()
    .describe('Hinweistext zur Steuerbefreiung bei steuerfreien Steuerarten, z.B. „Steuerschuldnerschaft des Leistungsempfängers". Ohne Angabe der Standard des Kontos'),
  language: z.enum(["de", "en"]).optional().describe('Sprache des Belegs und seiner Standardtexte: "en" für englische Kunden. Ohne Angabe Deutsch'),
  print_layout: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional()
    .describe("Druckvorlage: Name oder UUID aus /print-layouts. Ohne Angabe die Standard-Vorlage"),
};

/** When the service or delivery happens — order confirmations and invoices. Quotations have no such field. */
export const shippingFields = {
  service_date: dateField('Leistungsdatum (eine Leistung an einem Tag), yyyy-MM-dd → Druck „Leistungsdatum"').optional(),
  service_period: periodField('Leistungszeitraum { from, to } → Druck „Leistungszeitraum". Für Dienstleistungen über mehrere Tage, z.B. ein Monat Entwicklung'),
  delivery_date: dateField('Lieferdatum (Ware), yyyy-MM-dd → Druck „Lieferdatum"').optional(),
  delivery_period: periodField('Lieferzeitraum { from, to } (Ware) → Druck „Lieferzeitraum"'),
  no_service_date: z
    .literal(true)
    .optional()
    .describe("true: kein Liefer-/Leistungsdatum drucken. Bei Rechnungen nur, wenn das Datum anderswo steht"),
};

export const SHIPPING_KEYS = ["service_date", "service_period", "delivery_date", "delivery_period", "no_service_date"] as const;

export const deliveryTermsField = {
  delivery_terms: z
    .string()
    .trim()
    .min(1)
    .max(SALES_TEXT_LIMITS.deliveryTerms)
    .optional()
    .describe('Lieferbedingungen, höchstens 255 Zeichen, z.B. „Lieferung frei Haus". Ohne Angabe die Vorgabe aus Lexware Office'),
};

export const buyerReferenceField = {
  buyer_reference: z
    .string()
    .trim()
    .max(255)
    .optional()
    .describe('XRechnung: Leitweg-ID, abweichend von der des Kontakts. "" erzeugt für einen XRechnungs-Kontakt eine normale Rechnung. Sonst weglassen'),
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
  voucher_date?: string;
  payment_term_days?: number;
  payment_term_label?: string;
  cash_discount?: { percent: number; days: number };
  total_discount_percent?: number;
  total_discount_amount?: number;
  tax_type?: SalesTaxType;
  tax_sub_type?: "distanceSales" | "electronicServices";
  tax_note?: string;
  language?: "de" | "en";
  print_layout?: string;
  service_date?: string;
  service_period?: { from?: string; to?: string };
  delivery_date?: string;
  delivery_period?: { from?: string; to?: string };
  no_service_date?: boolean;
  delivery_terms?: string;
  buyer_reference?: string;
}

/** Today in Berlin, yyyy-MM-dd. */
export const berlinToday = (): string => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });

/** The shipping conditions the input names, or undefined — then Lexware prints delivery on the voucher date. */
export function shippingOf(input: SalesInput): ShippingConditions | undefined {
  if (input.service_period?.from && input.service_period.to) {
    return { shippingType: "serviceperiod", shippingDate: input.service_period.from, shippingEndDate: input.service_period.to };
  }
  if (input.delivery_period?.from && input.delivery_period.to) {
    return { shippingType: "deliveryperiod", shippingDate: input.delivery_period.from, shippingEndDate: input.delivery_period.to };
  }
  if (input.service_date) return { shippingType: "service", shippingDate: input.service_date };
  if (input.delivery_date) return { shippingType: "delivery", shippingDate: input.delivery_date };
  if (input.no_service_date) return { shippingType: "none" };
  return undefined;
}

/** The payment conditions the input names, or undefined — then Lexware takes the contact's, else the account's. */
export function paymentOf(input: SalesInput): NewSalesDocument["paymentConditions"] {
  if (input.payment_term_days === undefined) return undefined;
  const discount = input.cash_discount ? { percentage: input.cash_discount.percent, days: input.cash_discount.days } : undefined;
  return {
    paymentTermLabel: input.payment_term_label ?? paymentTermLabel(input.payment_term_days, discount),
    paymentTermDuration: input.payment_term_days,
    ...(input.cash_discount ? { paymentDiscountConditions: { discountPercentage: input.cash_discount.percent, discountRange: input.cash_discount.days } } : {}),
  };
}

/** Default validity of a quotation when the user names none. */
export const QUOTATION_VALIDITY_DAYS = 30;

/** Valid-until of a quotation: as given, else QUOTATION_VALIDITY_DAYS after the voucher date. */
export function validUntilOf(input: SalesInput): string {
  if (input.valid_until) return input.valid_until;
  const start = new Date(`${input.voucher_date ?? berlinToday()}T12:00:00Z`);
  return new Date(start.getTime() + QUOTATION_VALIDITY_DAYS * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The input as the client's NewSalesDocument — one mapping for validation,
 * card and write, so they cannot disagree. `resolved` carries what needs the
 * API: the contact, the print layout's id, the articles' types.
 */
export function toSalesDocument(
  kind: SalesDocumentKind,
  input: SalesInput,
  resolved: { contactId: string; printLayoutId?: string; articleTypes?: ReadonlyMap<string, "service" | "material"> },
): NewSalesDocument {
  const items = toLineItems(input.items, resolved.articleTypes);
  return {
    kind,
    contactId: resolved.contactId,
    items,
    ...(input.voucher_date ? { voucherDate: input.voucher_date } : {}),
    ...(input.title ? { title: input.title } : {}),
    ...(kind === "quotation" ? { expirationDate: validUntilOf(input) } : {}),
    ...(input.total_discount_amount ? { totalDiscountAbsolute: input.total_discount_amount } : {}),
    ...(input.total_discount_percent ? { totalDiscountPercentage: input.total_discount_percent } : {}),
    ...(input.tax_type || input.tax_sub_type || input.tax_note
      ? {
          taxConditions: {
            taxType: input.tax_type ?? "net",
            ...(input.tax_sub_type ? { taxSubType: input.tax_sub_type } : {}),
            ...(input.tax_note ? { taxTypeNote: input.tax_note } : {}),
          },
        }
      : {}),
    ...(paymentOf(input) ? { paymentConditions: paymentOf(input) } : {}),
    ...(kind !== "quotation" && shippingOf(input) ? { shippingConditions: shippingOf(input) } : {}),
    ...(input.language ? { language: input.language } : {}),
    ...(resolved.printLayoutId ? { printLayoutId: resolved.printLayoutId } : {}),
    ...(input.delivery_terms ? { deliveryTerms: input.delivery_terms } : {}),
    ...(input.buyer_reference !== undefined ? { xRechnung: { buyerReference: input.buyer_reference } } : {}),
    ...(input.introduction ? { introduction: input.introduction } : {}),
    ...(input.remark ? { remark: input.remark } : {}),
  };
}

/**
 * The checks across fields a single field cannot make — for the tool's
 * schema. What the model can fix itself belongs here, not on the card.
 */
export function salesRefinement(kind: SalesDocumentKind) {
  return (input: SalesInput, ctx: z.RefinementCtx) => {
    const issue = (message: string, path: string[] = []) => ctx.addIssue({ code: "custom", message, path });
    const shipping = SHIPPING_KEYS.filter((key) => input[key] !== undefined);
    if (shipping.length > 1) issue(`Nur eines von ${SHIPPING_KEYS.join(", ")} angeben — gesetzt: ${shipping.join(", ")}.`);
    if (input.total_discount_percent && input.total_discount_amount) issue("Nur eines von total_discount_percent und total_discount_amount angeben.");
    if (input.payment_term_days === undefined && (input.payment_term_label || input.cash_discount)) {
      issue("payment_term_label und cash_discount nur zusammen mit payment_term_days.", ["payment_term_days"]);
    }
    if (input.cash_discount && input.payment_term_days !== undefined && input.cash_discount.days > input.payment_term_days) {
      issue("Die Skontofrist kann nicht länger sein als das Zahlungsziel.", ["cash_discount"]);
    }
    const taxType = input.tax_type ?? "net";
    const lines = (input.items ?? []).filter((item) => item.type !== "text").flatMap((item) => [item, ...(item.alternatives ?? [])]);
    if (isVatFreeTaxType(taxType) && lines.some((item) => (item.tax_rate ?? 19) !== 0)) {
      issue(`Steuerart ${taxType} ist steuerfrei — tax_rate 0 auf jeder Position.`, ["items"]);
    }
    if (taxType === "gross" && lines.some((item) => item.gross_price === undefined)) issue('tax_type "gross": jede Position mit gross_price statt net_price.', ["items"]);
    if (taxType !== "gross" && lines.some((item) => item.gross_price !== undefined)) issue('gross_price nur bei tax_type "gross" — sonst net_price.', ["items"]);
    if (input.tax_sub_type && isVatFreeTaxType(taxType)) issue("tax_sub_type nur bei tax_type net oder gross.", ["tax_sub_type"]);
    if (input.tax_note && !isVatFreeTaxType(taxType)) issue("tax_note nur bei steuerfreien Steuerarten.", ["tax_note"]);
    if (kind === "quotation" && input.valid_until && input.valid_until < (input.voucher_date ?? berlinToday())) {
      issue("valid_until liegt vor dem Belegdatum.", ["valid_until"]);
    }
    // The client's own checks catch the rest (tax rates without subtype, …) — in its words.
    for (const problem of salesDocumentProblems(toSalesDocument(kind, input, { contactId: "00000000-0000-4000-8000-000000000000" }))) issue(problem);
  };
}

/**
 * The customer behind a number or contact id. There is no collective customer:
 * a document to the wrong contact is wrong, not slightly off — an unresolvable
 * one is a warning on the card and an error when writing.
 */
export async function resolveCustomer(api: LexwareClient, input: SalesInput, signal?: AbortSignal): Promise<{ contact: Contact | null; warnings: Warning[] }> {
  if (input.contact_id) {
    try {
      const contact = await getContact(api, input.contact_id, signal);
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
      const contact = await findContactByNumber(api, input.customer_number, signal);
      return contact
        ? { contact, warnings: [] }
        : { contact: null, warnings: [{ kind: "sales-contact", reason: `Kein Kontakt mit Kundennummer ${input.customer_number}` }] };
    } catch (error) {
      return { contact: null, warnings: [{ kind: "sales-contact", reason: describeError(error) }] };
    }
  }
  return { contact: null, warnings: [{ kind: "sales-contact", reason: "weder Kundennummer noch contact_id angegeben" }] };
}

/** The checks with the mount's client — for the eve tools. */
export function runSalesPreflight(kind: SalesDocumentKind, input: SalesInput, signal?: AbortSignal): Promise<Warning[]> {
  return prepareSalesDocument(client(), kind, input, signal);
}

/**
 * Customer, duplicates, the source document and the document settings —
 * what the card shows before a person approves. Network errors become
 * findings, not exceptions. Needs no eve: any caller with a client can run it.
 */
export async function prepareSalesDocument(api: LexwareClient, kind: SalesDocumentKind, input: SalesInput, signal?: AbortSignal): Promise<Warning[]> {
  const warnings: Warning[] = [];
  const itemsNet = totalOf(toLineItems(input.items));
  const { contact, warnings: contactWarnings } = await resolveCustomer(api, input, signal);
  warnings.push(...contactWarnings);

  if (contact) {
    // The real name on the card: a valid but wrong contact_id passes every role check.
    warnings.push({ kind: "customer-resolved", name: contact.name, number: contact.number });
    try {
      const result = await findDuplicateSalesDocument(api, { kind, contactId: contact.id, itemsTotalNet: itemsNet, signal });
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

  warnings.push(...(await checkSource(api, kind, input, contact, itemsNet, signal)));
  warnings.push(...(await checkDocumentSettings(api, kind, input, contact, signal)));
  return warnings;
}

/**
 * What the card cannot know from the input alone: which payment term
 * applies without one, whether print layout and articles exist, whether the
 * tax type fits customer and account, and whether an invoice says when the
 * service was supplied. Network errors become findings.
 */
async function checkDocumentSettings(api: LexwareClient, kind: SalesDocumentKind, input: SalesInput, contact: Contact | null, signal?: AbortSignal): Promise<Warning[]> {
  const warnings: Warning[] = [];
  const note = (title: string, value: string) => warnings.push({ kind: "note", title, value });

  if (kind === "invoice") {
    const shipping = shippingOf(input);
    if (!shipping) {
      note(
        "⚠ Leistungsdatum fehlt",
        "nicht angegeben — Lexware Office druckt „Lieferdatum = Belegdatum“. Pflichtangabe nach § 14 Abs. 4 Nr. 6 UStG: " +
          "Leistungsdatum oder -zeitraum setzen, wenn die Leistung nicht am Belegdatum erbracht wurde",
      );
    } else if (shipping.shippingType === "none") {
      note("⚠ Leistungsdatum fehlt", "wird nicht gedruckt — Pflichtangabe nach § 14 Abs. 4 Nr. 6 UStG, muss dann im Text stehen");
    }
  }

  if (input.payment_term_days === undefined) {
    try {
      const fallback = await defaultPaymentCondition(api, signal);
      note(
        fallback?.duration === 0 ? "⚠ Zahlungsziel-Vorgabe" : "Zahlungsziel-Vorgabe",
        fallback
          ? `nicht angegeben — es gilt die Zahlungsbedingung des Kontakts, falls dort eine hinterlegt ist, sonst der Konto-Standard „${fallback.label}“`
          : "nicht angegeben — es gilt die Zahlungsbedingung des Kontakts, sonst der Standard aus Lexware Office",
      );
    } catch (error) {
      note("Zahlungsziel-Vorgabe", `nicht angegeben — es gilt die Vorgabe aus Lexware Office (Konto-Standard nicht lesbar: ${describeError(error)})`);
    }
  }

  if (input.print_layout) {
    try {
      const layout = await resolvePrintLayout(api, input.print_layout, signal);
      if (layout) note("Druckvorlage gefunden", layout.name);
      else note("⚠ Druckvorlage", `„${input.print_layout}“ nicht eindeutig gefunden — Anlegen bricht ab; Namen aus /print-layouts nehmen`);
    } catch (error) {
      note("⚠ Druckvorlage", `nicht prüfbar — ${describeError(error)}`);
    }
  }

  for (const id of articleIdsOf(input.items)) {
    try {
      const article = await getArticle(api, id, signal);
      note("Artikel", `${article.title}${article.articleNumber ? ` (${article.articleNumber})` : ""} — ${article.lineType === "material" ? "Produkt" : "Dienstleistung"}`);
    } catch (error) {
      note("⚠ Artikel", `${id} nicht lesbar — Anlegen bricht ab (${describeError(error)})`);
    }
  }

  warnings.push(...(await checkTaxType(api, input, contact, signal)));
  return warnings;
}

/**
 * What Lexware Office demands of a vat-free tax type (cookbook "Rechnungen"):
 * § 13b and intra-community supply a company with VAT ID, third countries a
 * contact that allows tax-free invoices, vatfree an account set up that way.
 * A mismatch is a 406 later — the card says so now.
 */
async function checkTaxType(api: LexwareClient, input: SalesInput, contact: Contact | null, signal?: AbortSignal): Promise<Warning[]> {
  const type = input.tax_type ?? "net";
  if (!isVatFreeTaxType(type) || type === "photovoltaicEquipment") return [];
  const warnings: Warning[] = [];
  const warn = (value: string) => warnings.push({ kind: "note", title: "⚠ Steuerart", value: `${TAX_TYPE_LABEL[type]}: ${value}` });

  if (type === "vatfree") {
    try {
      const profile = await getProfile(api, signal);
      if (profile.taxType !== "vatfree" && !profile.smallBusiness) warn("das Konto ist nicht als steuerfrei oder Kleinunternehmer eingerichtet — Lexware Office lehnt den Beleg ab");
    } catch (error) {
      warn(`Konto-Einstellung nicht prüfbar (${describeError(error)})`);
    }
    return warnings;
  }
  if (!contact) return warnings;

  const needsVatId = type === "intraCommunitySupply" || type === "constructionService13b" || type === "externalService13b";
  if (needsVatId && (!contact.isCompany || !contact.vatRegistrationId)) warn("braucht einen Firmenkontakt mit USt-IdNr. — beim Kunden fehlt sie");
  if ((type === "thirdPartyCountryService" || type === "thirdPartyCountryDelivery") && contact.allowTaxFreeInvoices !== true) {
    warn("beim Kunden ist „Steuerfreie Rechnung erlauben“ nicht aktiviert");
  }

  const expected = type === "constructionService13b" ? null : type === "intraCommunitySupply" || type === "externalService13b" ? "intraCommunity" : "thirdPartyCountry";
  if (expected && contact.countryCode) {
    try {
      const country = (await listCountries(api, signal)).find((entry) => entry.countryCode === contact.countryCode);
      if (country && country.taxClassification !== expected) {
        warn(`Rechnungsadresse in ${country.countryNameDE ?? contact.countryCode} — passt nicht (${expected === "intraCommunity" ? "EU-Ausland erwartet" : "Nicht-EU-Land erwartet"})`);
      }
    } catch (error) {
      warn(`Land nicht prüfbar (${describeError(error)})`);
    }
  }
  return warnings;
}

/**
 * The source document a new one derives from: does it exist, belong to the
 * same customer, and add up the same? A different total can be intended
 * (changed positions), a foreign customer almost never is. Optional lines
 * count on neither side.
 */
async function checkSource(api: LexwareClient, target: SalesDocumentKind, input: SalesInput, contact: Contact | null, itemsNet: number, signal?: AbortSignal): Promise<Warning[]> {
  const id = input.source_document_id?.trim();
  if (!id) return [];
  const kind = input.source_document_type;
  if (!kind) return [{ kind: "source-check-failed", reason: "source_document_id ohne source_document_type angegeben" }];
  const label = DOCUMENT_LABEL[kind];
  try {
    const source = await getSalesDocument(api, kind, id, signal);
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

/**
 * Creates the document: quotations and order confirmations finalized (they
 * get their number now) unless `draft` asks otherwise, invoices always as
 * drafts — finalized and sent in Lexware Office. A replay of the same call does not create twice; a document that
 * appeared between card and click stops the write.
 */
export function executeSalesDocument(
  kind: SalesDocumentKind,
  input: SalesInput,
  ctx: { callId: string; abortSignal?: AbortSignal },
): Promise<Record<string, unknown>> {
  return executeApprovedSalesDocument({ client: client(), journal: runtimeJournal }, kind, input, {
    id: ctx.callId,
    shownOnCard: (url) => wasShownOnCard(ctx.callId, url),
    notes: () => notesOf(ctx.callId),
    signal: ctx.abortSignal,
  });
}

/** What an approved write needs besides the input: where it runs, and what the card showed. */
export interface Operations {
  client: LexwareClient;
  journal: Journal;
}

export interface Approved {
  /** The approved call or action, unique: the journal key, so a replay does not create twice. */
  id: string;
  /** Whether the card showed this duplicate — a known one was approved, a new one stops the write. */
  shownOnCard: (url: string) => boolean;
  /** The card's findings as lines for the result, so the answer does not contradict the card. */
  notes: () => string[];
  signal?: AbortSignal;
}

/**
 * Creates the approved document — the same steps as the eve tool, for any
 * caller: a replay finds the journal entry, a duplicate that appeared after
 * the card stops the write, print layout and articles are looked up again.
 */
export async function executeApprovedSalesDocument(
  ops: Operations,
  kind: SalesDocumentKind,
  input: SalesInput,
  approved: Approved,
): Promise<Record<string, unknown>> {
  const api = ops.client;
  const ctx = { callId: approved.id, abortSignal: approved.signal };
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

  const journal = await ops.journal.read(kind, ctx.callId);
  if (journal?.resourceId) {
    return {
      ...(await describeCreated(api, kind, journal.resourceId, ctx.abortSignal)),
      ...counts,
      note: `Wiederaufnahme: ${label} war aus einem abgebrochenen Lauf bereits angelegt — nichts doppelt erstellt.`,
    };
  }

  const { contact, warnings } = await resolveCustomer(api, input, ctx.abortSignal);
  if (!contact) throw new Error(`Kunde nicht auflösbar: ${warnings.map((warning) => describeWarning(warning).value).join("; ")}`);

  // Hours can pass between card and click; a search error must not block the approved write.
  try {
    const duplicate = await findDuplicateSalesDocument(api, { kind, contactId: contact.id, itemsTotalNet: computed, signal: ctx.abortSignal });
    if (duplicate.status === "match" && !approved.shownOnCard(duplicate.match.url)) {
      throw new Error(
        `Abgebrochen: Inzwischen gibt es bereits ${kind === "invoice" ? "eine" : "ein"} ${label} mit dieser Positionssumme: ${duplicate.match.url}. ` +
          "Nichts angelegt. Rufe das Tool erneut auf, wenn trotzdem ein weiterer Beleg entstehen soll — dann steht der Fund auf der Karte.",
      );
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Abgebrochen:")) throw error;
  }

  // Print layout and articles are looked up again: hours can pass between card and click.
  let printLayoutId: string | undefined;
  if (input.print_layout) {
    const layout = await resolvePrintLayout(api, input.print_layout, ctx.abortSignal).catch(() => null);
    if (!layout) throw new Error(`${label} nicht angelegt: Druckvorlage „${input.print_layout}“ nicht eindeutig gefunden.`);
    printLayoutId = layout.id;
  }
  const articleTypes = new Map<string, "service" | "material">();
  for (const id of articleIdsOf(input.items)) {
    try {
      articleTypes.set(id, (await getArticle(api, id, ctx.abortSignal)).lineType);
    } catch (error) {
      throw new Error(`${label} nicht angelegt: Artikel ${id} nicht lesbar (${describeError(error)}).`);
    }
  }
  const document = toSalesDocument(kind, input, { contactId: contact.id, printLayoutId, articleTypes });

  await ops.journal.write(kind, ctx.callId, { status: "pending" });

  // A named source becomes a document chain; an invalid pursue (406) must not
  // block the approved document — then it is created without the link.
  const sourceId = input.source_document_id?.trim() || undefined;
  const linkable = sourceId ? await canChain(api, kind, input.source_document_type, sourceId, ctx.abortSignal) : false;
  let chained = linkable;
  const create = (precedingSalesVoucherId?: string) => createSalesDocument(api, { ...document, finalize, precedingSalesVoucherId }, ctx.abortSignal);

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

  await ops.journal.write(kind, ctx.callId, { status: "created", resourceId: created.id });
  const detail = await describeCreated(api, kind, created.id, ctx.abortSignal);

  return {
    ...detail,
    kind,
    documentName: [label, detail.voucherNumber].filter(Boolean).join(" "),
    contactName: contact.name,
    status: finalize ? "festgeschrieben" : "Entwurf",
    ...counts,
    ...(document.expirationDate ? { validUntil: document.expirationDate } : {}),
    ...settingsResult(document),
    ...(sourceId
      ? {
          sourceDocument: chained
            ? `verknüpft mit ${DOCUMENT_LABEL[input.source_document_type ?? "quotation"]} ${sourceId}`
            : linkable
              ? `KEINE Verknüpfung — Lexware Office hat den Bezug auf ${sourceId} abgelehnt (ohne Belegkette angelegt)`
              : `KEINE Verknüpfung — das Angebot ${sourceId} hat optionale Positionen, daraus verknüpft Lexware Office keine AB (ohne Belegkette angelegt)`,
        }
      : {}),
    preflightNotes: approved.notes(),
    note: finalize
      ? `${[label, detail.voucherNumber].filter(Boolean).join(" ")} ist festgeschrieben. Versand an den Kunden aus Lexware Office.`
      : `${label} ist ein Entwurf, nicht festgeschrieben — gegenlesen, festschreiben und versenden in Lexware Office.`,
  };
}

/** What the result reports beyond positions and totals — the chat answer must match the card. */
function settingsResult(document: NewSalesDocument): Record<string, unknown> {
  const shipping = document.shippingConditions;
  return {
    ...(document.voucherDate ? { voucherDate: document.voucherDate } : {}),
    ...(shipping && shipping.shippingType !== "none"
      ? { shipping: "shippingEndDate" in shipping ? `${shipping.shippingType} ${shipping.shippingDate} – ${shipping.shippingEndDate}` : `${shipping.shippingType} ${shipping.shippingDate}` }
      : document.kind === "quotation"
        ? {}
        : { shipping: shipping ? "kein Datum gedruckt" : "nicht angegeben — Lieferdatum = Belegdatum" }),
    paymentTerm: document.paymentConditions?.paymentTermLabel ?? "Vorgabe aus Lexware Office (Kontakt, sonst Konto)",
    taxType: TAX_TYPE_LABEL[document.taxConditions?.taxType ?? "net"],
    ...(document.totalDiscountPercentage ? { totalDiscount: `${document.totalDiscountPercentage} %` } : {}),
    ...(document.totalDiscountAbsolute ? { totalDiscount: `${document.totalDiscountAbsolute} EUR` } : {}),
    ...(document.language ? { language: document.language } : {}),
  };
}

/**
 * Whether to send the link at all: a quotation with optional lines cannot
 * become an order confirmation's predecessor. A failed read tries the link —
 * the 406 fallback still catches it.
 */
async function canChain(api: LexwareClient, kind: SalesDocumentKind, sourceKind: SalesDocumentKind | undefined, id: string, signal?: AbortSignal): Promise<boolean> {
  if (!sourceKind) return true;
  if (kind !== "order-confirmation" || sourceKind !== "quotation") return true;
  try {
    return !chainImpossible(kind, sourceKind, await getSalesDocument(api, sourceKind, id, signal));
  } catch {
    return true;
  }
}

async function describeCreated(api: LexwareClient, kind: SalesDocumentKind, id: string, signal?: AbortSignal): Promise<{ documentId: string; url: string; voucherNumber?: string }> {
  try {
    const detail = await getSalesDocument(api, kind, id, signal);
    return { documentId: id, url: detail.url, voucherNumber: detail.voucherNumber };
  } catch {
    // The document exists — a failed read-back only costs the number.
    return { documentId: id, url: api.voucherUrl(id) };
  }
}
