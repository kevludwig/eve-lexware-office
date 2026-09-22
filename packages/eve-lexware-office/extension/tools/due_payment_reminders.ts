import { DEFAULT_REMINDER_POLICY, daysSince, selectDueReminders, type ReminderHold } from "@kevinludwig/lexware-office";
import { defineTool } from "eve/tools";
import { z } from "zod";

import { shortDate } from "../lib/format";
import { client, config, ledger } from "../lib/runtime";

function describeHold(hold: ReminderHold, immediateTermDays: number): string {
  switch (hold.kind) {
    case "too-early":
      return hold.immediate
        ? `sofort fällig — erinnert wird ab ${shortDate(hold.earliest)} (intern ${immediateTermDays} Tage Zahlungsziel, dann Puffer)`
        : `erinnert wird ab ${shortDate(hold.earliest)}`;
    case "sent":
      return `schon erinnert am ${shortDate(hold.at)}`;
    case "pending":
      return `Erinnerung wartet seit ${shortDate(hold.at)} auf Freigabe`;
    case "declined":
      return `Erinnerung am ${shortDate(hold.at)} abgebrochen — vorerst Ruhe`;
    case "no-address":
      return "für den Kunden ist keine E-Mail-Adresse hinterlegt";
    case "unreadable":
      return "Status oder Adresse gerade nicht lesbar — vorsichtshalber ausgelassen";
  }
}

/** Which overdue invoices are due for a reminder now — the same rule a scheduled run applies. Reads only. */
export default defineTool({
  description:
    "Prüft, zu welchen überfälligen Rechnungen jetzt eine Zahlungserinnerung fällig ist (Puffer nach Fälligkeit, " +
    "Zahlungsziel bei sofort fälligen Rechnungen, schon erinnert, wartet auf Freigabe, abgebrochen, keine Adresse). " +
    "`due` enthält je Rechnung genau die Werte für das Tool send_payment_reminder; `not_yet` die übrigen mit Grund. Liest nur.",
  inputSchema: z.object({}).strict(),

  async execute(_input, ctx) {
    const reminders = config().reminders;
    const policy = { ...DEFAULT_REMINDER_POLICY, ...reminders.policy };
    const { due, held } = await selectDueReminders(client(), ledger(), { policy, signal: ctx.abortSignal });
    const link = config().conversationUrl;
    return {
      test_mode: reminders.mode !== "live",
      due: due.map(({ invoice }) => ({
        invoice_id: invoice.id,
        voucher_number: invoice.voucherNumber,
        customer_name: invoice.contactName,
        open_amount: invoice.openAmount,
        due_date: invoice.dueDate,
        days_overdue: daysSince(invoice.dueDate),
      })),
      not_yet: held.map(({ invoice, hold }) => ({
        voucher_number: invoice.voucherNumber,
        customer_name: invoice.contactName,
        open_amount: invoice.openAmount,
        reason: describeHold(hold, policy.immediatePaymentTermDays),
        ...(hold.kind === "pending" && hold.sessionId && link ? { conversation: link(hold.sessionId) } : {}),
      })),
    };
  },
});
