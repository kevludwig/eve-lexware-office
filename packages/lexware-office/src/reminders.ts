/**
 * Payment reminders: when an overdue invoice is due for one, and what has
 * happened per invoice.
 *
 * The selection is code, not judgment: an invoice is offered once it is a
 * number of days past its reminder due date, has not been reminded, is not
 * waiting for a decision elsewhere, was not declined lately, and its customer
 * has an address. An invoice due immediately ("sofort fällig" — Lexware Office
 * sets the due date to the invoice date) gets a payment term first.
 *
 * The ledger keeps one record per invoice, and one claim per send round: a
 * round is the first reminder, or a deliberate repeat after the reminder sent
 * at a given time. Claiming before sending makes "at most once per round"
 * hold across cards, duplicate schedule runs, and replays.
 */

import type { LexwareClient } from "./client.ts";
import { contactEmail } from "./contacts.ts";
import { addDays, daysSince } from "./dates.ts";
import { downloadInvoicePdf, findOverdueInvoice, findOverdueInvoices, type OverdueInvoice } from "./receivables.ts";
import { MailNotSentError, type RenderReminderMail, type ReminderMail, type SendReminderMail } from "./reminder-mail.ts";
import { keySegment, type JsonStore } from "./store.ts";

export interface ReminderPolicy {
  /** Days past the reminder due date before a first reminder. Default: 3. */
  minDaysOverdue: number;
  /** Payment term assumed for an invoice due immediately, in days. Default: 14. */
  immediatePaymentTermDays: number;
  /** A waiting reminder is offered again after this many hours. Default: 20. */
  pendingValidHours: number;
  /** A declined reminder stays quiet this many days. Default: 7. */
  declinedQuietDays: number;
}

export const DEFAULT_REMINDER_POLICY: ReminderPolicy = {
  minDaysOverdue: 3,
  immediatePaymentTermDays: 14,
  pendingValidHours: 20,
  declinedQuietDays: 7,
};

interface Dated {
  voucherDate: string;
  dueDate: string;
}

/** Whether the due date is the invoice date itself. */
export function isDueImmediately(invoice: Dated): boolean {
  return invoice.voucherDate !== "" && invoice.dueDate.slice(0, 10) <= invoice.voucherDate.slice(0, 10);
}

/** The day from which lateness counts (yyyy-MM-dd). */
export function reminderDueDate(invoice: Dated, policy: ReminderPolicy = DEFAULT_REMINDER_POLICY): string {
  return isDueImmediately(invoice)
    ? addDays(invoice.voucherDate, policy.immediatePaymentTermDays)
    : invoice.dueDate.slice(0, 10);
}

/** Days past the reminder due date. */
export function daysPastReminderDue(invoice: Dated, policy: ReminderPolicy = DEFAULT_REMINDER_POLICY, today?: Date): number {
  return daysSince(reminderDueDate(invoice, policy), today);
}

/** The first day a reminder is offered (yyyy-MM-dd). */
export function earliestReminderDate(invoice: Dated, policy: ReminderPolicy = DEFAULT_REMINDER_POLICY): string {
  return addDays(reminderDueDate(invoice, policy), policy.minDaysOverdue);
}

export type ReminderStatus = "pending" | "sent" | "declined";

export interface ReminderRecord {
  invoiceId: string;
  voucherNumber: string;
  status: ReminderStatus;
  /** ISO timestamp of the last change. */
  at: string;
  /** Where the reminder waits or was decided, e.g. an agent session. */
  sessionId?: string;
  recipient?: string;
}

/** Whether a record still lets a reminder be offered. */
export function isOpenForReminder(
  record: ReminderRecord | null,
  policy: ReminderPolicy = DEFAULT_REMINDER_POLICY,
  now: number = Date.now(),
): boolean {
  if (!record) return true;
  const age = now - Date.parse(record.at);
  switch (record.status) {
    case "sent":
      return false;
    case "pending":
      return age > policy.pendingValidHours * 3_600_000;
    case "declined":
      return age > policy.declinedQuietDays * 86_400_000;
  }
}

/** One record per invoice and one claim per send round, in a JsonStore. */
export interface ReminderLedger {
  /** The record, or null. Throws when the store fails: unknown is not "never reminded". */
  read(invoiceId: string): Promise<ReminderRecord | null>;
  write(record: Omit<ReminderRecord, "at">): Promise<void>;
  /** Marks the invoice as waiting — unless it was sent: "sent" is final. */
  markPending(invoice: { id: string; voucherNumber: string }, sessionId?: string): Promise<void>;
  /**
   * Takes the one send of a round before the mail goes out. `round` is
   * "first", or the time of the reminder a deliberate repeat follows. False
   * when another send holds the round.
   */
  claimSend(invoiceId: string, round: string, owner: string): Promise<boolean>;
  /** Gives a round back when its mail certainly did not go out. */
  releaseSend(invoiceId: string, round: string): Promise<void>;
}

/**
 * A ledger under `namespace` in the store. Keep separate namespaces for test
 * and live sending, and per environment, so a test never stands in for a real
 * reminder.
 */
export function reminderLedger(store: JsonStore, namespace: string): ReminderLedger {
  const base = namespace.replace(/\/+$/, "");
  const recordKey = (invoiceId: string) => `${base}/${keySegment(invoiceId)}`;
  const claimKey = (invoiceId: string, round: string) => `${recordKey(invoiceId)}.send-${keySegment(round)}`;

  return {
    read: (invoiceId) => store.read<ReminderRecord>(recordKey(invoiceId)),
    write: (record) => store.write(recordKey(record.invoiceId), { ...record, at: new Date().toISOString() }),
    async markPending(invoice, sessionId) {
      if ((await store.read<ReminderRecord>(recordKey(invoice.id)))?.status === "sent") return;
      await store.write(recordKey(invoice.id), {
        invoiceId: invoice.id,
        voucherNumber: invoice.voucherNumber,
        status: "pending",
        at: new Date().toISOString(),
        ...(sessionId ? { sessionId } : {}),
      });
    },
    claimSend: (invoiceId, round, owner) =>
      store.create(claimKey(invoiceId, round), { owner, at: new Date().toISOString() }),
    releaseSend: (invoiceId, round) => store.delete(claimKey(invoiceId, round)),
  };
}

/** Why an overdue invoice is not offered now. */
export type ReminderHold =
  | { kind: "too-early"; earliest: string; immediate: boolean }
  | { kind: "sent" | "pending" | "declined"; at: string; sessionId?: string }
  | { kind: "no-address" }
  | { kind: "unreadable"; reason: string };

export interface DueReminder {
  invoice: OverdueInvoice;
  /** The customer's address as Lexware Office has it. */
  customerEmail: string;
}

export interface ReminderSelection {
  due: DueReminder[];
  held: { invoice: OverdueInvoice; hold: ReminderHold }[];
}

/**
 * Which overdue invoices get a reminder now. An invoice whose record or
 * address cannot be read is held back, never offered as "never reminded".
 */
export async function selectDueReminders(
  client: LexwareClient,
  ledger: ReminderLedger,
  options: { policy?: Partial<ReminderPolicy>; signal?: AbortSignal; today?: Date } = {},
): Promise<ReminderSelection> {
  const policy = { ...DEFAULT_REMINDER_POLICY, ...options.policy };
  const overdue = await findOverdueInvoices(client, { signal: options.signal });
  const now = (options.today ?? new Date()).getTime();

  const checked = await Promise.all(
    overdue.map(async (invoice): Promise<{ invoice: OverdueInvoice; hold: ReminderHold | null; email?: string }> => {
      if (daysPastReminderDue(invoice, policy, options.today) < policy.minDaysOverdue) {
        return {
          invoice,
          hold: { kind: "too-early", earliest: earliestReminderDate(invoice, policy), immediate: isDueImmediately(invoice) },
        };
      }
      let record: ReminderRecord | null;
      try {
        record = await ledger.read(invoice.id);
      } catch (error) {
        return { invoice, hold: { kind: "unreadable", reason: String(error) } };
      }
      if (record && !isOpenForReminder(record, policy, now)) {
        return { invoice, hold: { kind: record.status, at: record.at, sessionId: record.sessionId } };
      }
      try {
        const email = invoice.contactId ? await contactEmail(client, invoice.contactId, options.signal) : null;
        return email ? { invoice, hold: null, email } : { invoice, hold: { kind: "no-address" } };
      } catch (error) {
        return { invoice, hold: { kind: "unreadable", reason: String(error) } };
      }
    }),
  );

  return {
    due: checked.flatMap(({ invoice, hold, email }) => (hold === null && email ? [{ invoice, customerEmail: email }] : [])),
    held: checked.flatMap(({ invoice, hold }) => (hold ? [{ invoice, hold }] : [])),
  };
}

/** Everything a send needs, fixed when the reminder was decided on. */
export interface ReminderTarget {
  invoiceId: string;
  voucherNumber: string;
  voucherDate: string;
  dueDate: string;
  currency: string;
  /** The recipient — the customer live, someone else in test mode. */
  to: string;
  cc?: readonly string[];
  test: boolean;
  /** The customer's address, for the test banner. */
  customer?: string | null;
  /** When a deliberate repeat follows an earlier reminder: that reminder's time — its send round. */
  earlierSentAt?: string;
}

export type SendReminderOutcome =
  | { sent: true; openAmount: number; attachment: string }
  | { sent: false; reason: "paid" | "taken" };

/**
 * Sends one reminder, at most once per round: re-checks that the invoice is
 * still overdue, claims the round, renders and sends with the invoice PDF,
 * and records it. Up to the mail call nothing has left, so a failure there
 * frees the round; so does MailNotSentError. Any other failure while sending
 * keeps the round taken.
 */
export async function sendReminder(
  client: LexwareClient,
  ledger: ReminderLedger,
  target: ReminderTarget,
  options: {
    render: RenderReminderMail;
    sendMail: SendReminderMail;
    /** Who sends — recorded with the claim, e.g. a tool call id. */
    owner: string;
    sessionId?: string;
    signal?: AbortSignal;
  },
): Promise<SendReminderOutcome> {
  const still = await findOverdueInvoice(client, target.invoiceId, options.signal);
  if (!still) return { sent: false, reason: "paid" };

  const round = target.earlierSentAt ?? "first";
  if (!(await ledger.claimSend(target.invoiceId, round, options.owner))) return { sent: false, reason: "taken" };
  const release = () => ledger.releaseSend(target.invoiceId, round).catch(() => {});

  let mail: ReminderMail;
  try {
    const pdf = await downloadInvoicePdf(client, { id: target.invoiceId, voucherNumber: target.voucherNumber }, options.signal);
    const rendered = await options.render({
      voucherNumber: target.voucherNumber,
      voucherDate: target.voucherDate,
      dueDate: target.dueDate,
      openAmount: still.openAmount,
      currency: target.currency,
      testRecipientFor: target.test ? (target.customer ?? "den Kunden (keine Adresse hinterlegt)") : undefined,
    });
    mail = { to: target.to, cc: target.cc ?? [], ...rendered, attachments: [pdf] };
  } catch (error) {
    await release();
    throw error;
  }

  try {
    await options.sendMail(mail, options.signal);
  } catch (error) {
    if (error instanceof MailNotSentError) await release();
    throw error;
  }

  // The mail is out; the claim alone already keeps a second one away.
  await ledger
    .write({
      invoiceId: target.invoiceId,
      voucherNumber: target.voucherNumber,
      status: "sent",
      recipient: target.to,
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    })
    .catch(() => {});
  return { sent: true, openAmount: still.openAmount, attachment: mail.attachments[0]!.filename };
}
