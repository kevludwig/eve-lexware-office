import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  MailNotSentError,
  createLexwareClient,
  defaultReminderMail,
  memoryStore,
  reminderLedger,
  sendReminder,
  type ReminderMail,
  type ReminderTarget,
} from "../src/index.ts";

let overdue = true;
let pdfFails = false;
const fetchImpl = (async (url: string | URL | Request) => {
  const path = new URL(String(url)).pathname;
  if (path.endsWith("/voucherlist")) {
    const content = overdue
      ? [{ id: "inv", voucherNumber: "RE1", voucherDate: "2026-09-01", dueDate: "2026-09-01", openAmount: 761.6, currency: "EUR" }]
      : [];
    return Response.json({ content, last: true });
  }
  if (path.endsWith("/invoices/inv/file")) {
    return pdfFails ? new Response("gone", { status: 500 }) : new Response(new Uint8Array([37, 80, 68, 70]), { headers: { "content-type": "application/pdf" } });
  }
  return new Response("unexpected", { status: 404 });
}) as typeof fetch;

const client = createLexwareClient({ apiKey: "k", fetch: fetchImpl, minSpacingMs: 0 });
const render = defaultReminderMail({ name: "Kevin Ludwig", signature: ["KL, Metzingen"], legal: ["Kevin Ludwig, Musterstraße 1"] });
const target: ReminderTarget = {
  invoiceId: "inv",
  voucherNumber: "RE1",
  voucherDate: "2026-09-01",
  dueDate: "2026-09-01",
  currency: "EUR",
  to: "kunde@example.com",
  cc: ["owner@example.com"],
  test: false,
};

let ledger = reminderLedger(memoryStore(), "live");
let sent: ReminderMail[] = [];
let mailFailure: Error | null = null;
const sendMail = async (mail: ReminderMail) => {
  if (mailFailure) throw mailFailure;
  sent.push(mail);
};
const send = (owner: string, extra: Partial<ReminderTarget> = {}) =>
  sendReminder(client, ledger, { ...target, ...extra }, { render, sendMail, owner });

beforeEach(() => {
  ledger = reminderLedger(memoryStore(), "live");
  sent = [];
  mailFailure = null;
  overdue = true;
  pdfFails = false;
});

describe("sendReminder", () => {
  it("sends once with the PDF and Cc, and records it", async () => {
    const outcome = await send("a");
    assert.deepEqual(outcome, { sent: true, openAmount: 761.6, attachment: "RE1.pdf" });
    assert.equal(sent.length, 1);
    assert.deepEqual([sent[0]!.to, sent[0]!.cc], ["kunde@example.com", ["owner@example.com"]]);
    assert.equal(sent[0]!.attachments[0]!.mediaType, "application/pdf");
    assert.equal((await ledger.read("inv"))?.status, "sent");
  });

  it("sends nothing for a second sender of the same round", async () => {
    await send("a");
    assert.deepEqual(await send("b"), { sent: false, reason: "taken" });
    assert.equal(sent.length, 1);
  });

  it("sends a deliberate repeat once", async () => {
    await send("a");
    const at = (await ledger.read("inv"))!.at;
    assert.equal((await send("repeat", { earlierSentAt: at })).sent, true);
    assert.equal((await send("repeat-again", { earlierSentAt: at })).sent, false);
    assert.equal(sent.length, 2);
  });

  it("frees the round when the mail certainly did not leave", async () => {
    mailFailure = new MailNotSentError("refused");
    await assert.rejects(send("a"), /refused/);
    mailFailure = null;
    assert.equal((await send("b")).sent, true);
  });

  it("frees the round when it fails before the mail call", async () => {
    pdfFails = true;
    await assert.rejects(send("a"));
    pdfFails = false;
    assert.equal((await send("b")).sent, true);
  });

  it("keeps the round when a send broke off midway", async () => {
    mailFailure = new Error("socket hang up");
    await assert.rejects(send("a"), /socket/);
    mailFailure = null;
    assert.deepEqual(await send("b"), { sent: false, reason: "taken" });
    assert.equal(sent.length, 0);
  });

  it("sends nothing once the invoice is paid", async () => {
    overdue = false;
    assert.deepEqual(await send("a"), { sent: false, reason: "paid" });
  });
});

describe("defaultReminderMail", () => {
  it("writes a friendly German reminder with the sender's details", async () => {
    const mail = await render({ voucherNumber: "RE1", voucherDate: "2026-09-01", dueDate: "2026-09-01", openAmount: 761.6, currency: "EUR" });
    assert.equal(mail.subject, "Zahlungserinnerung zur Rechnung RE1");
    assert.match(mail.html, /761,60 €/);
    assert.match(mail.html, /1\. September 2026/);
    assert.match(mail.html, /automatisch erstellt und versendet/);
    assert.match(mail.text ?? "", /Kevin Ludwig, Musterstraße 1/);
  });

  it("marks tests and escapes what comes from Lexware Office", async () => {
    const mail = await render({
      voucherNumber: "<b>RE1</b>",
      voucherDate: "2026-09-01",
      dueDate: "2026-09-01",
      openAmount: 1,
      currency: "EUR",
      testRecipientFor: "kunde@example.com",
    });
    assert.match(mail.subject, /^\[Test\] /);
    assert.match(mail.html, /Testversand/);
    assert.doesNotMatch(mail.html, /<b>RE1<\/b>/);
    assert.match(mail.html, /&lt;b&gt;RE1&lt;\/b&gt;/);
  });
});
