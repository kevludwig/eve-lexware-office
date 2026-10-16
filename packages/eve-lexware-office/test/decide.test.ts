/** The mount's `decide`: a rule instead of a person, after the checks (lib/with-card.ts). */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { on, useApi, useConfig } from "./harness.ts";

const { default: createCustomer } = await import("../dist/extension/tools/create_customer.mjs");

const request = () =>
  createCustomer.approval.request({
    toolName: "lexware__create_customer",
    callId: "call-1",
    toolInput: { company_name: "Beispiel GmbH", street: "Musterstraße 1", zip: "12345", city: "Musterstadt" },
    abortSignal: new AbortController().signal,
  });

describe("decide", () => {
  it("approves without a card, refuses with a reason, or asks after all", async () => {
    useApi(on("GET", /^\/contacts$/, () => ({ content: [] })));
    const cards: unknown[] = [];
    const seen: { tool: string; input: unknown }[] = [];

    useConfig({ decide: (call: { tool: string; input: unknown }) => (seen.push(call), "approve"), onApprovalCard: () => void cards.push(1) });
    assert.equal(await request(), "approved");
    assert.equal(seen[0]!.tool, "create_customer");
    assert.equal(cards.length, 0);

    useConfig({ decide: () => ({ deny: "gesperrt" }) });
    assert.deepEqual(await request(), { type: "denied", reason: "gesperrt" });

    useConfig({ decide: () => "ask", onApprovalCard: () => void cards.push(1) });
    assert.equal(await request(), "user-approval");
    assert.equal(cards.length, 1);
    useConfig({});
  });

  it("asks a person when decide throws", async () => {
    useApi(on("GET", /^\/contacts$/, () => ({ content: [] })));
    useConfig({
      decide: () => {
        throw new Error("rules unreadable");
      },
    });
    assert.equal(await request(), "user-approval");
    useConfig({});
  });

  it("is not asked when the tool's own check already refuses", async () => {
    let asked = false;
    useConfig({ decide: () => ((asked = true), "approve") });
    const { default: reminder } = await import("../dist/extension/tools/send_payment_reminder.mjs");
    useApi();
    const status = await reminder.approval.request({
      toolName: "lexware__send_payment_reminder",
      callId: "call-2",
      toolInput: { invoice_id: "00000000-0000-0000-0000-000000000000", voucher_number: "RE-1", customer_name: "x", open_amount: 1, due_date: "2026-01-01" },
      abortSignal: new AbortController().signal,
      session: { id: "s-1" },
    });
    assert.equal(typeof status === "object" && status !== null && "type" in status ? status.type : status, "denied");
    assert.equal(asked, false);
    useConfig({});
  });
});
