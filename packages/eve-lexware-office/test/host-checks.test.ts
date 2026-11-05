/**
 * The mount's `checks`: the host's own findings for quotations, order
 * confirmations and invoices, next to the extension's — on the card, in
 * `decide` and in the result. A failing check shows, it never blocks.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it, mock } from "node:test";

import { contact, on, useApi, useConfig } from "./harness.ts";

// eve's session state, which only exists inside a running session; here one map per state.
const states = new Map<string, unknown>();
mock.module("eve/context", {
  exports: {
    defineState: <T>(name: string, initial: () => T) => ({
      get: () => (states.has(name) ? states.get(name) : initial()) as T,
      update: (change: (value: T) => T) => void states.set(name, change((states.has(name) ? states.get(name) : initial()) as T)),
    }),
  },
});

const { default: createQuotation } = await import("../dist/extension/tools/create_quotation.mjs");
const { default: createOrderConfirmation } = await import("../dist/extension/tools/create_order_confirmation.mjs");
const { default: createInvoice } = await import("../dist/extension/tools/create_invoice.mjs");
const { findingsOf, notesOf } = await import("../dist/extension/lib/findings.mjs");
const { HOST_CHECK_FAILED } = await import("../dist/extension/lib/sales-eve.mjs");

const items = [{ name: "Workshop-Tag", quantity: 2, unit: "Tag", net_price: 1200, tax_rate: 19 }];
const api = () =>
  useApi(
    on("GET", /^\/contacts$/, () => ({ content: [contact("c-1", "Beispiel GmbH", { customer: { number: 10001 } })] })),
    on("GET", /^\/voucherlist$/, () => ({ content: [] })),
    on("GET", /^\/payment-conditions$/, () => []),
  );

type Tool = { approval: { request: (ctx: unknown) => Promise<unknown> } };
const request = (tool: Tool, name: string, toolInput: Record<string, unknown>, callId = "call-1") =>
  tool.approval.request({ toolName: `lexware__${name}`, callId, toolInput, abortSignal: new AbortController().signal });

const NOTE = { kind: "note", title: "⚠ Marge", value: "unter 30 %" } as const;

beforeEach(() => {
  states.clear();
  useConfig({});
});

describe("the mount's checks", () => {
  it("adds its findings after the extension's, on the card, in decide and in the result", async () => {
    api();
    const calls: { tool: string; input: unknown; signal?: AbortSignal }[] = [];
    const cards: { findings: { title: string; value: string }[] }[] = [];
    const decided: { title: string }[][] = [];
    useConfig({
      checks: async (call: { tool: string; input: unknown }) => (calls.push(call), [NOTE]),
      decide: (call: { findings: { title: string }[] }) => (decided.push([...call.findings]), "ask"),
      onApprovalCard: (_: string, card: never) => void cards.push(card),
    });

    assert.equal(await request(createQuotation, "create_quotation", { customer_number: 10001, items }), "user-approval");

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.tool, "create_quotation");
    assert.deepEqual(calls[0]!.input, { customer_number: 10001, items });
    assert.ok(calls[0]!.signal instanceof AbortSignal);
    const own = findingsOf("call-1");
    assert.deepEqual(own.at(-1), { title: "⚠ Marge", value: "unter 30 %" });
    assert.ok(own.length > 1, "the extension's own findings stay");
    assert.deepEqual(cards[0]!.findings, own);
    assert.deepEqual(decided[0]!.at(-1), { title: "⚠ Marge", value: "unter 30 %" });
    assert.ok(notesOf("call-1").includes("⚠ Marge: unter 30 %"));
  });

  it("runs for order confirmations and invoices with the tool's name and input", async () => {
    api();
    const tools: string[] = [];
    useConfig({ checks: (call: { tool: string; input: { quotation_id?: string } }) => (tools.push(call.tool), [NOTE]) });

    await request(createOrderConfirmation, "create_order_confirmation", { customer_number: 10001, items }, "call-ab");
    await request(createInvoice, "create_invoice", { customer_number: 10001, items }, "call-re");

    assert.deepEqual(tools, ["create_order_confirmation", "create_invoice"]);
    assert.deepEqual(findingsOf("call-ab").at(-1), { title: "⚠ Marge", value: "unter 30 %" });
    assert.deepEqual(findingsOf("call-re").at(-1), { title: "⚠ Marge", value: "unter 30 %" });
  });

  it("says so on the card when a check throws or returns no findings, and the call goes on", async () => {
    const failed = { title: HOST_CHECK_FAILED.title, value: HOST_CHECK_FAILED.value };
    const warn = mock.method(console, "warn", () => {});
    try {
      api();
      useConfig({
        checks: () => {
          throw new Error("margin service down");
        },
      });
      assert.equal(await request(createQuotation, "create_quotation", { customer_number: 10001, items }, "call-throws"), "user-approval");
      assert.deepEqual(findingsOf("call-throws").at(-1), failed);

      useConfig({ checks: async () => Promise.reject(new Error("timeout")) });
      assert.equal(await request(createQuotation, "create_quotation", { customer_number: 10001, items }, "call-rejects"), "user-approval");
      assert.deepEqual(findingsOf("call-rejects").at(-1), failed);

      useConfig({ checks: () => "alles gut" });
      await request(createQuotation, "create_quotation", { customer_number: 10001, items }, "call-no-list");
      assert.deepEqual(findingsOf("call-no-list").at(-1), failed);

      useConfig({ checks: () => [NOTE, { kind: "unknown" }] });
      await request(createQuotation, "create_quotation", { customer_number: 10001, items }, "call-unreadable");
      assert.deepEqual(findingsOf("call-unreadable").slice(-2), [{ title: "⚠ Marge", value: "unter 30 %" }, failed]);

      assert.ok(warn.mock.calls.some((call) => /checks failed for call-throws: Error: margin service down/.test(String(call.arguments[0]))));
    } finally {
      warn.mock.restore();
    }
  });

  it("is not asked again on eve's recheck, and the card's findings stay", async () => {
    api();
    let asked = 0;
    useConfig({ checks: () => (asked++, [{ kind: "note", title: "Prüfung", value: `Lauf ${asked}` }]) });

    await request(createQuotation, "create_quotation", { customer_number: 10001, items });
    const shown = findingsOf("call-1");
    await request(createQuotation, "create_quotation", { customer_number: 10001, items });

    assert.equal(asked, 1);
    assert.deepEqual(findingsOf("call-1"), shown);
    assert.deepEqual(shown.at(-1), { title: "Prüfung", value: "Lauf 1" });
  });

  it("leaves the findings alone without checks", async () => {
    api();
    await request(createQuotation, "create_quotation", { customer_number: 10001, items });
    assert.ok(!findingsOf("call-1").some((finding: { title: string }) => finding.title === HOST_CHECK_FAILED.title));
  });
});
