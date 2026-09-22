import {
  DEFAULT_REMINDER_POLICY,
  contactEmail,
  daysPastReminderDue,
  daysSince,
  describeError,
  earliestReminderDate,
  findOverdueInvoice,
  isDueImmediately,
  sendReminder,
  type ReminderRecord,
} from "@kevinludwig/lexware-office";
import { defineTool } from "eve/tools";
import { z } from "zod";

import { shortDate } from "../lib/format";
import { readJournal, writeJournal } from "../lib/journal";
import { approverPolicy, client, config, ledger, renderReminder } from "../lib/runtime";
import { saveWarnings, type Warning } from "../lib/findings";
import { bindReminderTarget, boundReminderTarget } from "../lib/state";

const inputSchema = z
  .object({
    invoice_id: z.string().uuid().describe("Id der überfälligen Rechnung in Lexware Office"),
    voucher_number: z.string().trim().min(1).max(50).describe("Rechnungsnummer, z.B. RE20260192"),
    customer_name: z.string().trim().min(1).max(255).describe("Kunde laut Lexware Office"),
    open_amount: z.number().positive().describe("Offener Betrag laut Lexware Office"),
    due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Fälligkeitsdatum yyyy-MM-dd laut Lexware Office"),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

/** Names compared as people read them: spacing does not make another customer. */
const sameName = (a: string | undefined, b: string) => a !== undefined && a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();

/**
 * A friendly payment reminder by mail, with the invoice PDF attached. The
 * text comes from the mount's template, the recipient from Lexware Office and
 * the mode — never from the model. Sent at most once per invoice and round.
 */
export default defineTool({
  description:
    "Schickt eine freundliche Zahlungserinnerung zu einer überfälligen Rechnung per E-Mail, mit der Rechnung als PDF " +
    "im Anhang. Die Werte (Nummer, Kunde, offener Betrag, Fälligkeit) übernimmst du unverändert aus Lexware Office " +
    "bzw. aus dem Tool due_payment_reminders — dieses Tool prüft sie. Der Text ist fest vorgegeben. Verschickt wird " +
    "erst nach Freigabe.",
  inputSchema,

  approval: {
    /**
     * The card's figures come from the input, so the input has to match
     * Lexware Office: a mismatch is denied with the real values. Recipient,
     * lateness, and an earlier reminder become findings.
     */
    request: async (ctx) => {
      const input = ctx.toolInput as Partial<Input> | undefined;
      if (!input?.invoice_id) return "user-approval";
      const reminders = config().reminders;
      const policy = { ...DEFAULT_REMINDER_POLICY, ...reminders.policy };

      let invoice;
      try {
        invoice = await findOverdueInvoice(client(), input.invoice_id, ctx.abortSignal);
      } catch (error) {
        return { type: "denied", reason: `Lexware Office nicht erreichbar (${describeError(error)}). Später erneut versuchen.` };
      }
      if (!invoice) {
        return { type: "denied", reason: `Rechnung ${input.voucher_number ?? input.invoice_id} ist nicht (mehr) überfällig — keine Erinnerung nötig.` };
      }
      const mismatches = [
        input.voucher_number !== invoice.voucherNumber && `Rechnungsnummer ${invoice.voucherNumber}`,
        Math.abs((input.open_amount ?? 0) - invoice.openAmount) > 0.01 && `offener Betrag ${invoice.openAmount}`,
        input.due_date !== invoice.dueDate && `Fälligkeit ${invoice.dueDate}`,
        !sameName(input.customer_name, invoice.contactName) && `Kunde „${invoice.contactName}“`,
      ].filter(Boolean);
      if (mismatches.length > 0) {
        return { type: "denied", reason: `Die Angaben passen nicht zu Lexware Office. Richtig ist: ${mismatches.join(", ")}. Rufe das Tool mit diesen Werten erneut auf.` };
      }

      let customer: string | null = null;
      if (invoice.contactId) {
        try {
          customer = await contactEmail(client(), invoice.contactId, ctx.abortSignal);
        } catch (error) {
          console.warn(`[lexware] Customer address not readable: ${describeError(error)}`);
        }
      }
      const live = reminders.mode === "live";
      const to = live ? customer : (reminders.ownerEmail ?? null);
      if (!to) {
        return {
          type: "denied",
          reason: live
            ? `Für ${invoice.contactName} ist keine E-Mail-Adresse hinterlegt — keine Erinnerung möglich. Melde das dem Nutzer.`
            : "Im Testmodus fehlt reminders.ownerEmail — kein Testversand möglich. Melde das dem Nutzer.",
        };
      }
      const cc = live && reminders.ccOwner && reminders.ownerEmail && reminders.ownerEmail !== to ? [reminders.ownerEmail] : [];

      let earlier: ReminderRecord | null;
      try {
        earlier = await ledger().read(invoice.id);
      } catch (error) {
        return { type: "denied", reason: `Ob zu ${invoice.voucherNumber} schon erinnert wurde, ist gerade nicht lesbar. Später erneut versuchen.` };
      }

      const findings: Warning[] = [
        live
          ? { kind: "note", title: "Empfänger", value: cc.length ? `${to}, Cc ${cc.join(", ")}` : to }
          : { kind: "note", title: "Testmodus", value: `Geht an ${to}, nicht an den Kunden (im Echtbetrieb: ${customer ?? "keine Adresse hinterlegt"})` },
      ];
      if (daysPastReminderDue(invoice, policy) < policy.minDaysOverdue) {
        findings.push({
          kind: "note",
          title: "⚠ Früh",
          value: isDueImmediately(invoice)
            ? `Sofort fällig, erinnert wird sonst erst ab ${shortDate(earliestReminderDate(invoice, policy))}`
            : `Erst ${daysSince(invoice.dueDate)} Tage überfällig — erinnert wird sonst ab ${shortDate(earliestReminderDate(invoice, policy))}`,
        });
      }
      if (earlier?.status === "sent") {
        findings.push({ kind: "note", title: "⚠ Schon erinnert", value: `Am ${shortDate(earlier.at)} ging bereits eine Erinnerung raus${earlier.recipient ? ` an ${earlier.recipient}` : ""}` });
      }
      if (earlier?.status === "pending" && earlier.sessionId && earlier.sessionId !== ctx.session.id) {
        const link = config().conversationUrl?.(earlier.sessionId);
        findings.push({ kind: "note", title: "⚠ Wartet schon", value: `Eine Erinnerung wartet seit ${shortDate(earlier.at)} in einer anderen Unterhaltung${link ? ` (${link})` : ""} — verschickt wird höchstens eine` });
      }
      if (!reminders.sendMail) findings.push({ kind: "note", title: "⚠ Mailversand fehlt", value: "Ohne reminders.sendMail wird nichts verschickt." });
      saveWarnings(ctx.callId, findings);

      bindReminderTarget(ctx.callId, {
        invoiceId: invoice.id,
        voucherNumber: invoice.voucherNumber,
        voucherDate: invoice.voucherDate,
        dueDate: invoice.dueDate,
        currency: invoice.currency,
        to,
        cc,
        test: !live,
        customer,
        earlierSentAt: earlier?.status === "sent" ? earlier.at : undefined,
      });
      if (earlier?.status !== "sent") await ledger().markPending(invoice, ctx.session.id).catch(() => {});
      return "user-approval";
    },
    response: approverPolicy,
  },

  async execute(_input, ctx) {
    // Bound at approval time; without it, fail closed — a fresh resolution
    // could reach someone the card never showed.
    const target = boundReminderTarget(ctx.callId);
    if (!target) throw new Error("Abgebrochen: Die an die Freigabe gebundenen Angaben fehlen — nichts verschickt.");
    const sendMail = config().reminders.sendMail;
    if (!sendMail) throw new Error("Abgebrochen: Der Mailversand ist nicht eingerichtet (reminders.sendMail) — nichts verschickt.");

    // A replay that finds this call started does not send again.
    const journal = await readJournal("reminder", ctx.callId);
    if (journal) {
      if (journal.status === "created") {
        await ledger()
          .write({ invoiceId: target.invoiceId, voucherNumber: target.voucherNumber, status: "sent", recipient: target.to, sessionId: ctx.session.id })
          .catch(() => {});
      }
      return journal.status === "created"
        ? { sent: true, note: "Wiederaufnahme: Die Erinnerung war bereits verschickt." }
        : { sent: false, note: "Wiederaufnahme nach Abbruch: Ob die Erinnerung rausging, ist unklar. Im Postausgang nachsehen." };
    }

    await writeJournal("reminder", ctx.callId, { status: "pending" });
    const outcome = await sendReminder(client(), ledger(), target, {
      render: renderReminder(),
      sendMail,
      owner: ctx.callId,
      sessionId: ctx.session.id,
      signal: ctx.abortSignal,
    });
    if (!outcome.sent) {
      return {
        sent: false,
        note:
          outcome.reason === "paid"
            ? `Rechnung ${target.voucherNumber} ist inzwischen nicht mehr überfällig — nichts verschickt.`
            : `Zu ${target.voucherNumber} ist über eine andere Freigabe schon eine Erinnerung rausgegangen oder unterwegs — nichts verschickt.`,
      };
    }
    await writeJournal("reminder", ctx.callId, { status: "created", resourceId: target.invoiceId });
    return {
      sent: true,
      to: target.to,
      cc: target.cc ?? [],
      test: target.test,
      invoice: target.voucherNumber,
      openAmount: outcome.openAmount,
      attachment: outcome.attachment,
      note: target.test
        ? `Testversand an ${target.to}. Im Echtbetrieb ginge die Erinnerung an ${target.customer ?? "den Kunden (keine Adresse hinterlegt)"}.`
        : `Erinnerung an ${target.to} verschickt.`,
    };
  },
});
