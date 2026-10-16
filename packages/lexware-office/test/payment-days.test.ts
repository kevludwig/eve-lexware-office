import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { germanNationwideHolidays, germanPaymentDay, nextPaymentDay, reminderDueDate, earliestReminderDate, DEFAULT_REMINDER_POLICY } from "../src/index.ts";

const policy = { ...DEFAULT_REMINDER_POLICY, minDaysOverdue: 2, isPaymentDay: germanPaymentDay };
const invoice = (dueDate: string, voucherDate = "2026-09-01") => ({ dueDate, voucherDate });

describe("payment days", () => {
  it("knows Germany's nationwide holidays, Easter-based ones included", () => {
    assert.deepEqual(germanNationwideHolidays(2026), [
      "2026-01-01", "2026-04-03", "2026-04-06", "2026-05-01", "2026-05-14", "2026-05-25", "2026-10-03", "2026-12-25", "2026-12-26",
    ]);
    assert.equal(germanPaymentDay("2026-10-16"), true); // Friday
    assert.equal(germanPaymentDay("2026-10-17"), false); // Saturday
    assert.equal(germanPaymentDay("2026-04-06"), false); // Easter Monday
  });

  it("moves a due date off weekends and holidays, and leaves a weekday alone", () => {
    assert.equal(nextPaymentDay("2026-10-17", germanPaymentDay), "2026-10-19");
    assert.equal(nextPaymentDay("2026-12-25", germanPaymentDay), "2026-12-28");
    assert.equal(nextPaymentDay("2026-10-15", germanPaymentDay), "2026-10-15");
    assert.equal(nextPaymentDay("2026-10-17"), "2026-10-17");
  });

  it("reminds on the second payment day after a weekend or holiday, two calendar days after a weekday", () => {
    assert.equal(earliestReminderDate(invoice("2026-10-15"), policy), "2026-10-17"); // Thu → Sat
    assert.equal(earliestReminderDate(invoice("2026-10-16"), policy), "2026-10-18"); // Fri → Sun
    assert.equal(earliestReminderDate(invoice("2026-10-17"), policy), "2026-10-20"); // Sat → Tue
    assert.equal(earliestReminderDate(invoice("2026-10-18"), policy), "2026-10-20"); // Sun → Tue
    assert.equal(earliestReminderDate(invoice("2026-12-25"), policy), "2026-12-29"); // Christmas → Mon, Tue
    assert.equal(earliestReminderDate(invoice("2026-05-14", "2026-05-01"), policy), "2026-05-18"); // Ascension (Thu) → Fri, Mon
    // Due immediately: invoice date + 14; on a weekend, again the second payment day after.
    assert.equal(earliestReminderDate(invoice("2026-10-03", "2026-10-03"), policy), "2026-10-20"); // +14 = Sat 17.10. → Tue
    assert.equal(reminderDueDate(invoice("2026-10-17"), DEFAULT_REMINDER_POLICY), "2026-10-17");
  });
});
