import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { on, useApi, useConfig } from "./harness.ts";

const { default: createCustomer } = await import("../dist/extension/tools/create_customer.mjs");

describe("the card reaches the channel before the request does", () => {
  it("hands it to onApprovalCard while the approval is being prepared", async () => {
    const cards: { callId: string; card: { title: string; findings: { title: string }[] } }[] = [];
    useConfig({ onApprovalCard: (callId: string, card: never) => void cards.push({ callId, card }) });
    useApi(on("GET", /^\/contacts$/, () => ({ content: [] })));

    const status = await createCustomer.approval.request({
      toolName: "lexware__create_customer",
      callId: "call-kl",
      toolInput: { company_name: "KL", street: "Lenbachweg 10", zip: "72555", city: "Metzingen" },
      abortSignal: new AbortController().signal,
    });

    assert.equal(status, "user-approval");
    assert.equal(cards.length, 1);
    assert.equal(cards[0]!.callId, "call-kl");
    assert.match(cards[0]!.card.title, /Kunde/);
    // Findings live in eve's session state, which only exists inside a running session.
    useConfig({});
  });
});
