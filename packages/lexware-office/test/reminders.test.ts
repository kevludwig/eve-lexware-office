/**
 * Reminder rules, ledger, and selection. Days count in Berlin; where "today"
 * matters it is fixed, or the dates keep wide margins.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_REMINDER_POLICY,
  createLexwareClient,
  daysPastReminderDue,
  earliestReminderDate,
  isDueImmediately,
  isOpenForReminder,
  memoryStore,
  reminderDueDate,
  reminderLedger,
  selectDueReminders,
  type ReminderRecord,
} from "../src/index.ts";

const net = { voucherDate: "2026-08-18", dueDate: "2026-09-01" };
const immediate = { voucherDate: "2026-09-01", dueDate: "2026-09-01" };
const at = (iso: string) => new Date(iso);

describe("reminder due date", () => {
  it("keeps the due date of an invoice with payment terms", () => {
    assert.equal(isDueImmediately(net), false);
    assert.equal(reminderDueDate(net), "2026-09-01");
    assert.equal(earliestReminderDate(net), "2026-09-04");
  });

  it("gives an invoice due immediately its payment term first", () => {
    assert.equal(isDueImmediately(immediate), true);
    assert.equal(reminderDueDate(immediate), "2026-09-15");
    assert.equal(earliestReminderDate(immediate), "2026-09-18");
    const strict = { ...DEFAULT_REMINDER_POLICY, immediatePaymentTermDays: 7, minDaysOverdue: 1 };
    assert.equal(earliestReminderDate(immediate, strict), "2026-09-09");
  });

  it("reaches the minimum on the earliest day, not before", () => {
    assert.equal(daysPastReminderDue(net, undefined, at("2026-09-03T10:00:00Z")), 2);
    assert.equal(daysPastReminderDue(net, undefined, at("2026-09-04T10:00:00Z")), 3);
  });

  it("counts Berlin days across midnight, summer time, and the new year", () => {
    assert.equal(daysPastReminderDue(net, undefined, at("2026-09-03T22:30:00Z")), 3);
    assert.equal(daysPastReminderDue(net, undefined, at("2026-09-03T21:30:00Z")), 2);
    assert.equal(daysPastReminderDue({ voucherDate: "2026-10-01", dueDate: "2026-10-24" }, undefined, at("2026-10-27T10:00:00Z")), 3);
    assert.equal(daysPastReminderDue({ voucherDate: "2026-12-01", dueDate: "2026-12-29" }, undefined, at("2026-12-31T23:30:00Z")), 3);
  });
});

describe("isOpenForReminder", () => {
  const now = Date.parse("2026-09-22T06:00:00Z");
  const record = (status: ReminderRecord["status"], hoursAgo: number): ReminderRecord => ({
    invoiceId: "i",
    voucherNumber: "RE1",
    status,
    at: new Date(now - hoursAgo * 3_600_000).toISOString(),
  });

  it("follows the record", () => {
    assert.equal(isOpenForReminder(null, undefined, now), true);
    assert.equal(isOpenForReminder(record("sent", 24 * 400), undefined, now), false);
    assert.equal(isOpenForReminder(record("pending", 19), undefined, now), false);
    assert.equal(isOpenForReminder(record("pending", 21), undefined, now), true);
    assert.equal(isOpenForReminder(record("declined", 24 * 6), undefined, now), false);
    assert.equal(isOpenForReminder(record("declined", 24 * 8), undefined, now), true);
  });
});

describe("reminderLedger", () => {
  it("keeps sent final and hands out each round once", async () => {
    const ledger = reminderLedger(memoryStore(), "live");
    await ledger.write({ invoiceId: "inv", voucherNumber: "RE1", status: "sent" });
    await ledger.markPending({ id: "inv", voucherNumber: "RE1" }, "s1");
    assert.equal((await ledger.read("inv"))?.status, "sent");

    assert.equal(await ledger.claimSend("inv", "first", "a"), true);
    assert.equal(await ledger.claimSend("inv", "first", "b"), false);
    assert.equal(await ledger.claimSend("inv", "2026-09-22T06:00:00.000Z", "c"), true);
    await ledger.releaseSend("inv", "first");
    assert.equal(await ledger.claimSend("inv", "first", "d"), true);
  });

  it("keeps namespaces apart", async () => {
    const store = memoryStore();
    await reminderLedger(store, "test").write({ invoiceId: "inv", voucherNumber: "RE1", status: "sent" });
    assert.equal(await reminderLedger(store, "live").read("inv"), null);
  });
});

describe("selectDueReminders", () => {
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const entry = (id: string, voucherDate: string, dueDate: string, contactId: string) => ({
    id,
    voucherNumber: `RE-${id}`,
    voucherDate,
    dueDate,
    contactId,
    contactName: "Kunde",
    totalAmount: 100,
    openAmount: 100,
    currency: "EUR",
  });
  const list = [
    entry("due", day(-40), day(-10), "c-ok"),
    entry("early", day(-30), day(0), "c-ok"),
    entry("immediate", day(-6), day(-6), "c-ok"),
    entry("sent", day(-40), day(-10), "c-ok"),
    entry("no-address", day(-40), day(-10), "c-none"),
    entry("lexware-down", day(-40), day(-10), "c-error"),
  ];

  const fetchImpl = (async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/voucherlist")) return Response.json({ content: list, last: true });
    if (path.endsWith("/contacts/c-ok")) return Response.json({ id: "c-ok", emailAddresses: { business: ["kunde@example.com"] } });
    if (path.endsWith("/contacts/c-none")) return Response.json({ id: "c-none" });
    return new Response("unavailable", { status: 503 });
  }) as typeof fetch;

  it("offers only what is due, reminded never, and reachable", async () => {
    const client = createLexwareClient({ apiKey: "k", fetch: fetchImpl, minSpacingMs: 0 });
    const ledger = reminderLedger(memoryStore(), "test");
    await ledger.write({ invoiceId: "sent", voucherNumber: "RE-sent", status: "sent" });

    const { due, held } = await selectDueReminders(client, ledger);
    const hold = (id: string) => held.find((entry) => entry.invoice.id === id)?.hold;

    assert.deepEqual(due.map((entry) => [entry.invoice.id, entry.customerEmail]), [["due", "kunde@example.com"]]);
    assert.equal(hold("early")?.kind, "too-early");
    const imm = hold("immediate");
    assert.ok(imm?.kind === "too-early" && imm.immediate && imm.earliest === day(-6 + 14 + 3));
    assert.equal(hold("sent")?.kind, "sent");
    assert.equal(hold("no-address")?.kind, "no-address");
    assert.equal(hold("lexware-down")?.kind, "unreadable");
  });

  it("holds back an invoice whose record cannot be read", async () => {
    const client = createLexwareClient({ apiKey: "k", fetch: fetchImpl, minSpacingMs: 0 });
    const broken = { ...memoryStore(), read: async () => { throw new Error("store down"); } };
    const { due, held } = await selectDueReminders(client, reminderLedger(broken, "test"));
    assert.equal(due.length, 0);
    assert.equal(held.find((entry) => entry.invoice.id === "due")?.hold.kind, "unreadable");
  });
});
