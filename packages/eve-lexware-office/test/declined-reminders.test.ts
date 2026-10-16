/** A declined payment reminder rests the invoice — unless the card said "⚠ Früh": then it means "not yet". */

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import { ledger, useApi } from "./harness.ts";

let warnings: { kind: string; title: string; value: string }[] = [];
const target = { invoiceId: "inv-1", voucherNumber: "RE-1", voucherDate: "2026-10-01", dueDate: "2026-10-01", currency: "EUR", to: "kunde@example.com", cc: [], test: true, customer: "kunde@example.com" };

mock.module(new URL("../dist/extension/lib/findings.mjs", import.meta.url).href, {
  namedExports: { warningsOf: () => warnings },
});
mock.module(new URL("../dist/extension/lib/state.mjs", import.meta.url).href, {
  namedExports: { boundReminderTarget: () => target },
});

const { default: hook } = await import("../dist/extension/hooks/declined-reminders.mjs");
const declined = (callId: string) =>
  (hook as { events: Record<string, (event: unknown) => Promise<void>> }).events["action.result"]!({
    data: { status: "rejected", result: { callId } },
  });

describe("declined reminders", () => {
  it("rests the invoice when a reminder that was due is declined", async () => {
    useApi();
    warnings = [{ kind: "note", title: "Empfänger", value: "kunde@example.com" }];
    await declined("call-1");
    assert.equal((await ledger().read("inv-1"))?.status, "declined");
  });

  it("does not count declining an early reminder", async () => {
    useApi();
    warnings = [{ kind: "note", title: "⚠ Früh", value: "Sofort fällig, erinnert wird sonst erst ab 17.10." }];
    await declined("call-2");
    assert.equal(await ledger().read("inv-1"), null);
  });
});
