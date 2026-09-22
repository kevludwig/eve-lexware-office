/** Which overdue invoices are due for a reminder — and why the others are not. */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ledger, on, useApi } from "./harness.ts";

const { default: duePaymentReminders } = await import("../dist/extension/tools/due_payment_reminders.mjs");

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

/** One overdue invoice, its customer reachable by mail. */
const overdue = (dueDate: string, extra: Record<string, unknown> = {}) => [
  on("GET", /^\/voucherlist$/, () => ({
    content: [
      {
        id: "inv-1",
        voucherNumber: "RE20260042",
        voucherDate: daysAgo(40),
        dueDate,
        contactId: "c-1",
        contactName: "Nordlicht Consulting GmbH",
        openAmount: 1190,
        currency: "EUR",
        voucherStatus: "overdue",
        ...extra,
      },
    ],
    totalPages: 1,
  })),
  on("GET", /^\/contacts\//, () => ({ id: "c-1", company: { name: "Nordlicht Consulting GmbH" }, emailAddresses: { business: ["rechnung@nordlicht.example"] } })),
];

const run = () => duePaymentReminders.execute({}, { abortSignal: undefined }) as Promise<Record<string, any>>;

describe("due_payment_reminders", () => {
  it("lists an invoice past the buffer with everything the send tool needs", async () => {
    useApi(...overdue(daysAgo(10)));
    const result = await run();

    assert.equal(result.due.length, 1);
    assert.deepEqual(
      { ...result.due[0], days_overdue: undefined },
      { invoice_id: "inv-1", voucher_number: "RE20260042", customer_name: "Nordlicht Consulting GmbH", open_amount: 1190, due_date: daysAgo(10), days_overdue: undefined },
    );
    assert.equal(result.due[0].days_overdue, 10);
    assert.equal(result.test_mode, true);
  });

  it("holds an invoice inside the buffer and says from when it reminds", async () => {
    useApi(...overdue(daysAgo(1)));
    const result = await run();

    assert.equal(result.due.length, 0);
    assert.match(result.not_yet[0].reason, /erinnert wird ab/);
  });

  it("counts an invoice due immediately from the internal payment term", async () => {
    // Due on the invoice date: internally 14 days plus the buffer.
    useApi(...overdue(daysAgo(40), { voucherDate: daysAgo(40) }));
    const dueImmediately = await run();
    assert.equal(dueImmediately.due.length, 1);

    useApi(...overdue(daysAgo(5), { voucherDate: daysAgo(5) }));
    const tooEarly = await run();
    assert.equal(tooEarly.due.length, 0);
    assert.match(tooEarly.not_yet[0].reason, /sofort fällig/);
  });

  it("holds an invoice that was already reminded", async () => {
    useApi(...overdue(daysAgo(10)));
    await ledger().write({ invoiceId: "inv-1", voucherNumber: "RE20260042", status: "sent" });
    const result = await run();

    assert.equal(result.due.length, 0);
    assert.match(result.not_yet[0].reason, /schon erinnert/);
  });

  it("holds a reminder that waits for approval", async () => {
    useApi(...overdue(daysAgo(10)));
    await ledger().markPending({ id: "inv-1", voucherNumber: "RE20260042" }, "session-1");
    const result = await run();

    assert.equal(result.due.length, 0);
    assert.match(result.not_yet[0].reason, /wartet seit/);
  });

  it("holds a customer without an email address", async () => {
    useApi(
      ...overdue(daysAgo(10)).slice(0, 1),
      on("GET", /^\/contacts\//, () => ({ id: "c-1", company: { name: "Nordlicht Consulting GmbH" } })),
    );
    const result = await run();

    assert.equal(result.due.length, 0);
    assert.match(result.not_yet[0].reason, /keine E-Mail-Adresse/);
  });
});
