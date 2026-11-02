/**
 * eve runs a tool's request policy again before an approved call executes
 * (its recheck). A person already answered: onApprovalCard must not run
 * again, `decide` may only still deny (a rule switched off between card and
 * click), and the tool's own checks may still refuse.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it, mock } from "node:test";

import type { ReminderTarget } from "@kevludwig/lexware-office";

import { ledger, on, useApi, useConfig } from "./harness.ts";

// eve's session state, which only exists inside a running session; here plain maps.
const settled = new Map<string, "ask" | "approve">();
const targets = new Map<string, ReminderTarget>();
mock.module(new URL("../dist/extension/lib/state.mjs", import.meta.url).href, {
  exports: {
    bindReminderTarget: (callId: string, target: ReminderTarget) => void targets.set(callId, target),
    boundReminderTarget: (callId: string) => targets.get(callId) ?? null,
    rememberShownContacts: () => {},
    shownContactsOf: () => new Set(),
    rememberSettled: (callId: string, outcome: "ask" | "approve") => void settled.set(callId, outcome),
    settledOf: (callId: string) => settled.get(callId) ?? null,
  },
});

const { default: createCustomer } = await import("../dist/extension/tools/create_customer.mjs");
const { default: sendPaymentReminder } = await import("../dist/extension/tools/send_payment_reminder.mjs");

const customer = (callId = "call-1") =>
  createCustomer.approval.request({
    toolName: "lexware__create_customer",
    callId,
    toolInput: { company_name: "Beispiel GmbH", street: "Musterstraße 1", zip: "12345", city: "Musterstadt" },
    abortSignal: new AbortController().signal,
  });

beforeEach(() => {
  settled.clear();
  targets.clear();
  useConfig({});
});

describe("the recheck of a settled call", () => {
  it("skips the card once a person was asked, and a decide that now asks or approves changes nothing", async () => {
    useApi(on("GET", /^\/contacts$/, () => ({ content: [] })));
    const seen: boolean[] = [];
    let cards = 0;
    useConfig({ decide: (call: { recheck: boolean }) => (seen.push(call.recheck), "ask"), onApprovalCard: () => void cards++ });

    assert.equal(await customer(), "user-approval");
    assert.deepEqual([seen, cards], [[false], 1]);

    assert.equal(await customer(), "user-approval");
    useConfig({ decide: (call: { recheck: boolean }) => (seen.push(call.recheck), "approve"), onApprovalCard: () => void cards++ });
    assert.equal(await customer(), "user-approval");
    assert.deepEqual([seen, cards], [[false, true, true], 1]);
  });

  it("stops the call when decide denies on the recheck", async () => {
    useApi(on("GET", /^\/contacts$/, () => ({ content: [] })));
    let cards = 0;
    useConfig({ decide: () => "ask", onApprovalCard: () => void cards++ });
    assert.equal(await customer(), "user-approval");

    // The rule was switched off between card and click.
    useConfig({ decide: () => ({ deny: "rule switched off" }), onApprovalCard: () => void cards++ });
    assert.deepEqual(await customer(), { type: "denied", reason: "rule switched off" });
    assert.equal(cards, 1);
  });

  it("keeps the approval when decide throws on the recheck", async () => {
    useApi(on("GET", /^\/contacts$/, () => ({ content: [] })));
    useConfig({ decide: () => "ask" });
    assert.equal(await customer(), "user-approval");
    useConfig({
      decide: () => {
        throw new Error("rules unreadable");
      },
    });
    assert.equal(await customer(), "user-approval");
  });

  it("does not run decide twice for a call it approved", async () => {
    useApi(on("GET", /^\/contacts$/, () => ({ content: [] })));
    let decided = 0;
    useConfig({ decide: () => (decided++, "approve") });
    assert.equal(await customer(), "approved");
    assert.equal(await customer(), "approved");
    assert.equal(decided, 1);
  });

  it("keeps a denial of the tool's own checks", async () => {
    let paid = false;
    const invoice = { id: "11111111-1111-4111-8111-111111111111", voucherNumber: "RE-1", voucherDate: "2026-08-01", dueDate: "2026-08-15", contactName: "Beispiel GmbH", openAmount: 100, currency: "EUR", voucherStatus: "overdue" };
    useApi(on("GET", /^\/voucherlist$/, () => ({ content: paid ? [] : [invoice], totalPages: 1 })));
    useConfig({ reminders: { mode: "test", ownerEmail: "owner@example.com" } });
    const request = () =>
      sendPaymentReminder.approval.request({
        toolName: "lexware__send_payment_reminder",
        callId: "call-r",
        toolInput: { invoice_id: invoice.id, voucher_number: "RE-1", customer_name: "Beispiel GmbH", open_amount: 100, due_date: "2026-08-15" },
        abortSignal: new AbortController().signal,
        session: { id: "s-1" },
      });
    assert.equal(await request(), "user-approval");
    paid = true;
    const status = await request();
    assert.equal(typeof status === "object" && status !== null ? status.type : status, "denied");
  });
});

describe("send_payment_reminder marks a reminder as waiting", () => {
  const invoice = { id: "22222222-2222-4222-8222-222222222222", voucherNumber: "RE-2", voucherDate: "2026-08-01", dueDate: "2026-08-15", contactName: "Beispiel GmbH", openAmount: 50, currency: "EUR", voucherStatus: "overdue" };
  const request = () =>
    sendPaymentReminder.approval.request({
      toolName: "lexware__send_payment_reminder",
      callId: "call-p",
      toolInput: { invoice_id: invoice.id, voucher_number: "RE-2", customer_name: "Beispiel GmbH", open_amount: 50, due_date: "2026-08-15" },
      abortSignal: new AbortController().signal,
      session: { id: "s-1" },
    });

  it("only when a person is asked or decide approves, never after decide refuses", async () => {
    useApi(on("GET", /^\/voucherlist$/, () => ({ content: [invoice], totalPages: 1 })));

    useConfig({ reminders: { mode: "test", ownerEmail: "owner@example.com" }, decide: () => ({ deny: "not now" }) });
    assert.deepEqual(await request(), { type: "denied", reason: "not now" });
    assert.equal(await ledger().read(invoice.id), null);

    useConfig({ reminders: { mode: "test", ownerEmail: "owner@example.com" }, decide: () => "ask" });
    assert.equal(await request(), "user-approval");
    const record = await ledger().read(invoice.id);
    assert.equal(record?.status, "pending");
    assert.equal(record?.sessionId, "s-1");
  });

  it("when decide approves", async () => {
    useApi(on("GET", /^\/voucherlist$/, () => ({ content: [invoice], totalPages: 1 })));
    useConfig({ reminders: { mode: "test", ownerEmail: "owner@example.com" }, decide: () => "approve" });
    assert.equal(await request(), "approved");
    assert.equal((await ledger().read(invoice.id))?.status, "pending");
  });

  it("not over a reminder already sent", async () => {
    useApi(on("GET", /^\/voucherlist$/, () => ({ content: [invoice], totalPages: 1 })));
    await ledger().write({ invoiceId: invoice.id, voucherNumber: "RE-2", status: "sent", recipient: "owner@example.com" });
    useConfig({ reminders: { mode: "test", ownerEmail: "owner@example.com" } });
    assert.equal(await request(), "user-approval");
    assert.equal((await ledger().read(invoice.id))?.status, "sent");
  });
});
