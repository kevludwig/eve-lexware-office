import {
  REVERSE_CHARGE_TAX_RATE,
  createVoucher,
  describeError,
  findPurchaseInvoiceByNumber,
  isReverseChargeCategory,
  round2,
  taxFromGross,
  uploadVoucherFile,
} from "@kevludwig/lexware-office";
import { defineTool } from "eve/tools";
import { z } from "zod";

import { describeWarning, isCorrectable, notesOf, rememberRejection, saveWarnings, wasRejected, wasShownOnCard } from "../lib/findings";
import { eur } from "../lib/format";
import { readJournal, writeJournal } from "../lib/journal";
import {
  MISSING_EUR_AMOUNT_INSTRUCTION,
  approvedPurchaseTarget,
  bookedGroupsOf,
  invoiceCurrencyOf,
  isAllowedAttachmentPath,
  isForeignCurrency,
  lacksEurAmount,
  purchaseSignatureOf,
  rememberPurchaseTarget,
  runPurchasePreflight,
  totalsOf,
} from "../lib/purchase";
import { approverPolicy, client, config } from "../lib/runtime";

/**
 * Status and tax type are fixed: `unchecked` files the voucher under "Belege
 * zur Prüfung" — captured, not booked, right for numbers read from a
 * document. The API forbids unchecked with net amounts, so gross it is, as
 * the invoice states them anyway.
 */
const VOUCHER_STATUS = "unchecked" as const;
const TAX_TYPE = "gross" as const;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const TAX_RATES = [0, 5, 7, 16, 19] as const;

const taxGroupSchema = z
  .object({
    gross_amount: z.number().positive().describe("Bruttobetrag dieser Steuersatz-Gruppe in Rechnungswährung, wie auf der Rechnung — nicht umgerechnet"),
    tax_rate_percent: z
      .number()
      .refine((rate) => (TAX_RATES as readonly number[]).includes(rate), { message: `Steuersatz muss einer von ${TAX_RATES.join(", ")} sein` })
      .describe("Steuersatz dieser Gruppe in Prozent"),
    category: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .optional()
      .describe(
        "Buchungskategorie NUR dieser Gruppe (Name oder Id) — nur für einen auf mehrere Kategorien aufgeteilten Beleg; dann bei " +
          "ALLEN Gruppen setzen und das Feld category weglassen. Bei gleichem Steuersatz mehrere Gruppen mit demselben Satz anlegen.",
      ),
  })
  .strict();

const inputSchema = z
  .object({
    supplier_name: z.string().trim().min(1).max(255).describe("Name des Lieferanten laut Rechnungskopf"),
    voucher_number: z.string().trim().min(1).max(100).describe("Rechnungsnummer des Lieferanten. Pflicht — daran wird eine schon erfasste Rechnung erkannt."),
    voucher_date: z.string().regex(ISO_DATE).describe("Rechnungsdatum, yyyy-MM-dd"),
    due_date: z.string().regex(ISO_DATE).optional().describe("Fälligkeitsdatum, yyyy-MM-dd, wenn die Rechnung eines nennt"),
    currency: z.string().trim().regex(/^[A-Za-z]{3}$/).describe("Währung der Rechnung als ISO-Code (EUR, USD, GBP, …). Alle Beträge sind in dieser Währung."),
    bank_statement_eur_amount: z
      .number()
      .positive()
      .optional()
      .describe("Nur bei currency ungleich EUR, dann Pflicht: der abgebuchte EUR-Betrag laut Kontoauszug, wie der Nutzer ihn nennt. Nie selbst umrechnen."),
    total_gross_amount: z.number().positive().describe("Rechnungsendbetrag brutto in Rechnungswährung. Die Summe der tax_groups muss ihn ergeben."),
    tax_groups: z
      .array(taxGroupSchema)
      .min(1)
      .max(5)
      .describe(
        "Die Beträge nach Steuersatz gruppiert, nicht die Einzelpositionen — 48 Artikel zu 19 % sind eine Gruppe. Mehrere Gruppen " +
          "bei mehreren Steuersätzen oder für eine Aufteilung auf mehrere Kategorien (dann je Kategorie eine Gruppe mit category).",
      ),
    category: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .optional()
      .describe(
        "Buchungskategorie (Name oder Id). Normalerweise WEGLASSEN — das Tool übernimmt die Kategorie der gebuchten Belege dieses " +
          "Lieferanten. Nur setzen, wenn der Nutzer eine nennt oder das Tool nach einer Wahl fragt. Der Name muss wörtlich einer " +
          "Kategorie des Kontos entsprechen.",
      ),
    contact_id: z
      .string()
      .uuid()
      .optional()
      .describe("Kontakt-Id des Lieferanten. Normalerweise weglassen — das Tool sucht selbst. Nur setzen, wenn die Suche mehrere findet und der Nutzer einen nennt."),
    remark: z.string().trim().max(500).optional().describe("Bemerkung am Beleg. Ohne Angabe: Lieferant und Rechnungsnummer."),
    attachment_path: z
      .string()
      .trim()
      .max(500)
      .optional()
      .describe("Sandbox-Pfad des Originals, wie beim hochgeladenen Dokument angegeben (/workspace/attachments/…). Wird als Anhang hochgeladen."),
  })
  .strict()
  .refine(
    (input) => {
      const withCategory = input.tax_groups.filter((group) => group.category).length;
      return withCategory === 0 || withCategory === input.tax_groups.length;
    },
    { message: "category je Gruppe entweder bei allen tax_groups setzen oder bei keiner." },
  )
  .refine((input) => !input.category || !input.tax_groups.some((group) => group.category), {
    message: "Entweder das Feld category ODER category je tax_group — nicht beides.",
  })
  .refine((input) => !lacksEurAmount(input), { message: MISSING_EUR_AMOUNT_INSTRUCTION })
  .refine((input) => isForeignCurrency(input) || input.bank_statement_eur_amount === undefined, {
    message: "bank_statement_eur_amount nur bei einer Rechnung in Fremdwährung setzen.",
  });

type Input = z.infer<typeof inputSchema>;

function mediaTypeOf(path: string): string {
  switch (path.slice(path.lastIndexOf(".") + 1).toLowerCase()) {
    case "pdf":
      return "application/pdf";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "xml":
      return "application/xml";
    default:
      return "application/octet-stream";
  }
}

const basename = (path: string) => path.split("/").pop() || path;

export default defineTool({
  description:
    "Erfasst eine Eingangsrechnung (Lieferantenrechnung) als Beleg in Lexware Office und hängt das Original an. Beträge nach " +
    "Steuersatz gruppiert, nicht als Einzelpositionen — die Artikel stehen im Anhang. Entsteht erst nach Freigabe, unter " +
    "„Belege zur Prüfung“. Vorher wird geprüft, ob die Gruppen den Endbetrag ergeben und ob die Rechnungsnummer schon erfasst ist.",
  inputSchema,

  approval: {
    /**
     * Check first, then ask. A correctable finding (totals, a category to
     * choose) goes back once so the model fixes the call; the same call again
     * goes to the card, where the user decides.
     */
    request: async (ctx) => {
      const input = ctx.toolInput as Partial<Input> | undefined;
      if (!input?.voucher_number) return "user-approval";
      // Without the debited amount there is nothing to approve — denied until it is there.
      if (lacksEurAmount(input)) return { type: "denied", reason: MISSING_EUR_AMOUNT_INSTRUCTION };

      const fallback = config().attachments;
      const { warnings, supplier, category, groupCategories } = await runPurchasePreflight(input, {
        signal: ctx.abortSignal,
        readFileSize: async (path) => {
          const sandbox = await ctx.getSandbox();
          const bytes = await sandbox.readBinaryFile({ path });
          if (bytes) return bytes.byteLength;
          // execute() would use the fallback too — the check must not be stricter.
          if (!fallback) return null;
          if (fallback.size) return fallback.size(path);
          return (await fallback.read(path))?.byteLength ?? null;
        },
      });

      const signature = purchaseSignatureOf(input);
      const correctable = warnings.filter(isCorrectable);
      if (correctable.length > 0 && !wasRejected(signature)) {
        rememberRejection(signature);
        const totals = correctable.some((warning) => warning.kind === "voucher-total-mismatch");
        const deviation = correctable.some((warning) => warning.kind === "category-deviation");
        return {
          type: "denied",
          reason:
            correctable.map((warning) => describeWarning(warning).value).join(" — ") +
            (totals
              ? ". Prüfe die Beträge erneut: Der Rechnungsendbetrag ist brutto, die tax_groups müssen ihn in Summe ergeben. Korrigiere " +
                "und rufe das Tool erneut auf. Bleibt die Abweichung, rufe es unverändert erneut auf — dann entscheidet der Nutzer."
              : deviation
                ? ". Setze category nur, wenn der Nutzer diese Kategorie genannt hat — sonst weglassen oder die übliche nehmen. Ist die " +
                  "Abweichung gewollt, rufe das Tool unverändert erneut auf — dann entscheidet der Nutzer an der Karte."
                : ". Rufe das Tool danach erneut auf; ohne Kategorie-Wahl entscheidet der Nutzer an der Karte."),
        };
      }

      saveWarnings(ctx.callId, warnings);
      // Execute writes this supplier and this category — not a re-resolution hours later.
      rememberPurchaseTarget(ctx.callId, {
        contactId: supplier.contactId,
        contactName: supplier.contactName,
        categoryId: category?.id,
        categoryName: category?.name,
        groupCategories: groupCategories?.map((match) => ({ id: match?.id, name: match?.name })),
      });

      const onCaptured = config().onPurchaseCaptured;
      if (onCaptured && input.tax_groups?.length) {
        const totals = totalsOf(bookedGroupsOf(input));
        try {
          await onCaptured({ callId: ctx.callId, voucherNumber: input.voucher_number, supplierName: supplier.contactName, ...totals });
        } catch (error) {
          console.warn(`[lexware] onPurchaseCaptured failed: ${String(error)}`);
        }
      }
      return "user-approval";
    },
    response: approverPolicy,
  },

  async execute(input, ctx) {
    const bookedGroups = bookedGroupsOf(input);
    const totals = totalsOf(bookedGroups);
    const currency = invoiceCurrencyOf(input);
    const invoiceGross = totalsOf(input.tax_groups).gross;
    const conversion = isForeignCurrency(input) ? `${eur(invoiceGross, currency)} laut Rechnung, abgebucht ${eur(totals.gross)} laut Kontoauszug` : null;
    const fallback = config().attachments;

    // The attachment is read first, but never stops the capture: numbers
    // without the original are worth more than no voucher.
    let attachment: { bytes: Uint8Array; filename: string; mediaType: string } | null = null;
    let attachmentProblem: string | null = null;
    if (input.attachment_path) {
      if (!isAllowedAttachmentPath(input.attachment_path)) {
        attachmentProblem = `„${input.attachment_path}" liegt nicht unter /workspace/attachments/`;
      } else {
        let bytes: Uint8Array | null = null;
        try {
          bytes = await (await ctx.getSandbox()).readBinaryFile({ path: input.attachment_path });
        } catch (error) {
          console.warn(`[lexware] Sandbox read failed: ${describeError(error)}`);
        }
        if (!bytes && fallback) bytes = await fallback.read(input.attachment_path, ctx.abortSignal).catch(() => null);
        if (bytes) attachment = { bytes, filename: basename(input.attachment_path), mediaType: mediaTypeOf(input.attachment_path) };
        else attachmentProblem = `${basename(input.attachment_path)} liegt nicht mehr in der Sandbox${fallback ? " und nicht im Archiv" : ""}`;
      }
    }

    // A replay of this call finds the voucher and does not write it again.
    const journal = await readJournal("purchase", ctx.callId);
    let voucher: { id: string; url: string };
    let contactNote: string;
    let categoryNote: string;

    if (journal?.resourceId) {
      voucher = { id: journal.resourceId, url: client().voucherUrl(journal.resourceId) };
      contactNote = `${input.supplier_name} (Wiederaufnahme — Beleg existierte bereits)`;
      categoryNote = "wie beim ersten Lauf — in Lexware Office prüfen";
    } else {
      // A voucher that appeared between card and click stops the write; one the card showed was approved knowingly.
      let existing: Awaited<ReturnType<typeof findPurchaseInvoiceByNumber>> = null;
      try {
        existing = await findPurchaseInvoiceByNumber(client(), input.voucher_number, ctx.abortSignal);
      } catch {
        // A failed search must not block the approved capture.
      }
      if (existing && !wasShownOnCard(ctx.callId, existing.url)) {
        throw new Error(
          `Abgebrochen: Rechnung ${input.voucher_number} ist inzwischen bereits erfasst: ${existing.url}. Nichts angelegt. Schicke ` +
            "die Rechnung erneut, wenn trotzdem ein zweiter Beleg entstehen soll — dann steht der Fund auf der Karte.",
        );
      }

      // Without the binding, fail closed: a fresh resolution could book something the card never showed.
      const target = approvedPurchaseTarget(ctx.callId);
      if (!target) {
        throw new Error("Abgebrochen: Die an die Freigabe gebundene Lieferanten- und Kategorienwahl fehlt — nichts angelegt. Rufe das Tool erneut auf.");
      }
      const categoryOf = (index: number) => target.groupCategories?.[index]?.id ?? target.categoryId;
      const reverseCharge = (index: number, rate: number) =>
        rate === 0 && isReverseChargeCategory(target.groupCategories?.[index]?.name ?? target.categoryName);
      categoryNote = target.groupCategories
        ? target.groupCategories.map((entry) => entry.name ?? "keine — in Lexware Office zuordnen").join(" / ")
        : (target.categoryName ?? "keine — in Lexware Office zuordnen");

      const common = {
        type: "purchaseinvoice",
        voucherStatus: VOUCHER_STATUS,
        taxType: TAX_TYPE,
        voucherNumber: input.voucher_number,
        voucherDate: input.voucher_date,
        dueDate: input.due_date,
        totalGrossAmount: totals.gross,
        totalTaxAmount: totals.tax,
        remark: input.remark ?? `Lieferantenrechnung ${input.voucher_number} — ${target.contactName}${conversion ? ` · ${conversion}` : ""}`,
        voucherItems: bookedGroups.map((group, index) =>
          reverseCharge(index, group.tax_rate_percent)
            ? { amount: group.gross_amount, taxAmount: 0, taxRatePercent: REVERSE_CHARGE_TAX_RATE, categoryId: categoryOf(index) }
            : { amount: group.gross_amount, taxAmount: taxFromGross(group.gross_amount, group.tax_rate_percent), taxRatePercent: group.tax_rate_percent, categoryId: categoryOf(index) },
        ),
      } as const;

      await writeJournal("purchase", ctx.callId, { status: "pending" });
      // No fallback to the collective vendor on an error: a 406 means the payload is off.
      voucher = target.contactId
        ? await createVoucher(client(), { ...common, contactId: target.contactId }, ctx.abortSignal)
        : await createVoucher(client(), { ...common, useCollectiveContact: true, contactName: target.contactName }, ctx.abortSignal);
      await writeJournal("purchase", ctx.callId, { status: "created", resourceId: voucher.id });
      contactNote = target.contactId ? target.contactName : `Sammellieferant (${target.contactName})`;
    }

    // The voucher stands; a failed attachment is reported, not thrown.
    let attachmentResult = attachmentProblem ? `ohne Original — ${attachmentProblem}. In Lexware Office am Beleg nachreichen.` : "kein Anhang";
    if (journal?.status === "attached") {
      attachmentResult = "bereits angehängt (Wiederaufnahme)";
    } else if (attachment) {
      try {
        await uploadVoucherFile(client(), voucher.id, attachment, ctx.abortSignal);
        await writeJournal("purchase", ctx.callId, { status: "attached", resourceId: voucher.id });
        attachmentResult = `${attachment.filename} angehängt`;
        if (input.attachment_path) await fallback?.release?.(input.attachment_path).catch(() => {});
      } catch (error) {
        attachmentResult = `${attachment.filename} konnte nicht angehängt werden: ${describeError(error)}`;
      }
    }

    return {
      voucherId: voucher.id,
      url: voucher.url,
      supplier: input.supplier_name,
      contact: contactNote,
      voucherNumber: input.voucher_number,
      voucherDate: input.voucher_date,
      status: VOUCHER_STATUS,
      gross: totals.gross,
      tax: totals.tax,
      net: totals.net,
      currency,
      conversion,
      declaredGross: input.total_gross_amount,
      difference: round2(invoiceGross - input.total_gross_amount),
      category: categoryNote,
      attachment: attachmentResult,
      preflightNotes: notesOf(ctx.callId),
      note: `Der Beleg liegt unter „Belege zur Prüfung" und ist noch nicht gebucht. Netto ${eur(totals.net)}, USt. ${eur(totals.tax)}.`,
    };
  },
});
