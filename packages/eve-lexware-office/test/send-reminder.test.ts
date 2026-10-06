/** send_payment_reminder: what a send returns, and what a replay of it returns. */

import assert from "node:assert/strict";
import { beforeEach, describe, it, mock } from "node:test";

import { mailContentSha256, type ReminderMail, type ReminderTarget } from "@kevludwig/lexware-office";

import { on, store, useApi, useConfig } from "./harness.ts";

// The approval binds the target in eve's session state, which only exists
// inside a running session; here it is a plain map.
const targets = new Map<string, ReminderTarget>();
mock.module(new URL("../dist/extension/lib/state.mjs", import.meta.url).href, {
  exports: {
    bindReminderTarget: (callId: string, target: ReminderTarget) => void targets.set(callId, target),
    boundReminderTarget: (callId: string) => targets.get(callId) ?? null,
    rememberShownContacts: () => {},
    shownContactsOf: () => new Set(),
  },
});

const { default: sendPaymentReminder } = await import("../dist/extension/tools/send_payment_reminder.mjs");

const target: ReminderTarget = {
  invoiceId: "inv-1",
  voucherNumber: "RE20260042",
  voucherDate: "2026-08-01",
  dueDate: "2026-08-15",
  currency: "EUR",
  to: "owner@example.com",
  cc: [],
  test: true,
  customer: "rechnung@nordlicht.example",
};

let sent: ReminderMail[] = [];

beforeEach(() => {
  sent = [];
  targets.clear();
  targets.set("call-1", target);
  useConfig({ reminders: { mode: "test", ownerEmail: "owner@example.com", sendMail: async (mail: ReminderMail) => void sent.push(mail) } });
  useApi(
    on("GET", /^\/voucherlist$/, () => ({
      content: [{ id: "inv-1", voucherNumber: "RE20260042", voucherDate: "2026-08-01", dueDate: "2026-08-15", contactId: "c-1", contactName: "Nordlicht Consulting GmbH", openAmount: 1190, currency: "EUR", voucherStatus: "overdue" }],
      totalPages: 1,
    })),
    (call) => (call.method === "GET" && /^\/invoices\/inv-1\/file$/.test(call.path) ? new Response(new Uint8Array([37, 80, 68, 70]), { headers: { "content-type": "application/pdf" } }) : undefined),
  );
});

const execute = () =>
  sendPaymentReminder.execute({}, { callId: "call-1", session: { id: "session-1" }, abortSignal: undefined }) as Promise<Record<string, any>>;

describe("send_payment_reminder", () => {
  it("returns the effect and keeps it in the journal", async () => {
    const result = await execute();

    assert.equal(sent.length, 1);
    const effect = {
      kind: "payment_reminder",
      to: "owner@example.com",
      cc: [],
      test: true,
      invoice: "RE20260042",
      invoiceId: "inv-1",
      amount: 1190,
      currency: "EUR",
      contentSha256: mailContentSha256(sent[0]!),
    };
    assert.deepEqual(result.effect, effect);
    assert.deepEqual((await store().read<Record<string, unknown>>("journal/reminder/call-1"))?.effect, effect);
  });

  it("returns the same effect on a replay and sends nothing again", async () => {
    const first = await execute();
    const replay = await execute();

    assert.equal(sent.length, 1);
    assert.equal(replay.sent, true);
    assert.deepEqual(replay.effect, first.effect);
    assert.deepEqual(
      [replay.to, replay.cc, replay.test, replay.invoice, replay.openAmount],
      [first.to, first.cc, first.test, first.invoice, first.openAmount],
    );
    assert.match(replay.note, /Wiederaufnahme/);
  });

  it("reconstructs only what is known for a journal entry without an effect", async () => {
    await store().write("journal/reminder/call-1", { status: "created", resourceId: "inv-1", at: new Date().toISOString() });
    const replay = await execute();

    assert.equal(sent.length, 0);
    assert.deepEqual(replay.effect, {
      kind: "payment_reminder",
      to: "owner@example.com",
      cc: [],
      test: true,
      invoice: "RE20260042",
      invoiceId: "inv-1",
      amount: null,
      currency: "EUR",
      contentSha256: null,
    });
    assert.equal(replay.openAmount, null);
    assert.match(replay.note, /nicht mehr bekannt/);
  });

  it("says it is unclear when the replay finds only a pending entry", async () => {
    await store().write("journal/reminder/call-1", { status: "pending", at: new Date().toISOString() });
    const replay = await execute();

    assert.equal(sent.length, 0);
    assert.equal(replay.sent, false);
    assert.equal(replay.effect, undefined);
  });
});
