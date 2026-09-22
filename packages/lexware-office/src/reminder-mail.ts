/**
 * The payment reminder as a mail: what is sent, how it is rendered, and the
 * default text — a friendly first reminder that assumes an oversight.
 *
 * Bring your own look with `render`; the default is plain, inline-styled
 * HTML that every mail client shows. Sender details (name, address, legal
 * notes) are yours to pass: a business letter needs them.
 */

export interface ReminderMailData {
  voucherNumber: string;
  /** yyyy-MM-dd */
  voucherDate: string;
  /** yyyy-MM-dd */
  dueDate: string;
  openAmount: number;
  currency: string;
  /** Set in test mode: whom the mail would reach live. */
  testRecipientFor?: string;
}

export interface ReminderMail {
  to: string;
  cc: readonly string[];
  subject: string;
  html: string;
  text?: string;
  attachments: readonly { filename: string; mediaType: string; bytes: Uint8Array }[];
}

/** Sends one mail. Throw MailNotSentError when it certainly did not go out. */
export type SendReminderMail = (mail: ReminderMail, signal?: AbortSignal) => Promise<void>;

/**
 * The mail certainly did not leave: sign-in failed, the mail service refused
 * it. Anything else thrown while sending counts as "may have left" — the send
 * round then stays taken, since a second reminder is worse than none.
 */
export class MailNotSentError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MailNotSentError";
  }
}

export interface ReminderSender {
  /** Signature name, e.g. "Kevin Ludwig". */
  name: string;
  /** Lines under the name, e.g. the company and town. */
  signature?: readonly string[];
  /** Legal details below the mail: name, form, address, VAT id, links. */
  legal?: readonly string[];
}

export type RenderReminderMail = (data: ReminderMailData) => { subject: string; html: string; text?: string } | Promise<{ subject: string; html: string; text?: string }>;

const escape = (value: string) =>
  value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

const longDate = (day: string) =>
  new Date(`${day.slice(0, 10)}T12:00:00Z`).toLocaleDateString("de-DE", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Europe/Berlin",
  });

const money = (value: number, currency: string) => value.toLocaleString("de-DE", { style: "currency", currency });

export function reminderSubject(voucherNumber: string, test: boolean): string {
  return `${test ? "[Test] " : ""}Zahlungserinnerung zur Rechnung ${voucherNumber}`;
}

/** The default reminder: German, friendly, marked as sent automatically. */
export function defaultReminderMail(sender: ReminderSender): RenderReminderMail {
  return (data) => {
    const amount = money(data.openAmount, data.currency);
    const lines = [
      "Guten Tag,",
      "",
      `vielleicht ist es im Alltag untergegangen: Für unsere Rechnung ${data.voucherNumber} vom ${longDate(data.voucherDate)} ` +
        `haben wir noch keinen Zahlungseingang gesehen. Sie war am ${longDate(data.dueDate)} fällig.`,
      "",
      "Die Rechnung hängt noch einmal an. Wir freuen uns, wenn Sie den offenen Betrag in den nächsten Tagen " +
        "überweisen; die Bankverbindung steht auf der Rechnung.",
      "",
      `Rechnung: ${data.voucherNumber}`,
      `Rechnungsdatum: ${longDate(data.voucherDate)}`,
      `Fällig seit: ${longDate(data.dueDate)}`,
      `Offener Betrag: ${amount}`,
      "",
      "Hat sich Ihre Zahlung mit dieser Nachricht überschnitten, betrachten Sie sie bitte als erledigt.",
      "",
      "Mit besten Grüßen",
      sender.name,
      ...(sender.signature ?? []),
    ];
    const footer = [
      "Diese Zahlungserinnerung wurde automatisch erstellt und versendet.",
      ...(sender.legal ?? []),
    ];

    const paragraph = (text: string) => `<p style="margin:0 0 12px">${escape(text)}</p>`;
    const html = [
      `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1a1a1a;max-width:600px">`,
      data.testRecipientFor
        ? `<p style="margin:0 0 16px;padding:8px 12px;background:#fff1c2">Testversand. Im Echtbetrieb ginge diese Mail an ${escape(data.testRecipientFor)}.</p>`
        : "",
      lines
        .join("\n")
        .split("\n\n")
        .map((block) => paragraph(block).replaceAll("\n", "<br>"))
        .join(""),
      `<p style="margin:24px 0 0;font-size:12px;color:#666">${footer.map(escape).join("<br>")}</p>`,
      "</div>",
    ].join("");

    const text = [...(data.testRecipientFor ? [`[Testversand, im Echtbetrieb an ${data.testRecipientFor}]`, ""] : []), ...lines, "", "--", ...footer].join("\n");
    return { subject: reminderSubject(data.voucherNumber, Boolean(data.testRecipientFor)), html, text };
  };
}
