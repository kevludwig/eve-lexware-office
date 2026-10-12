import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Not under the harness's runtime mock: the decision itself is pure.
const { decideApproval } = await import("../dist/extension/lib/approver.mjs");

type Person = { authenticator: string; principalType: string; principalId: string };

const person = (principalId: string): Person => ({ authenticator: "test", principalType: "user", principalId });
const owner = person("anna");
const other = person("ben");

function context(responder: Person, initiator: Person | null, decision: "approve" | "cancel" = "approve") {
  return {
    auth: {},
    request: { callId: "call-1", requestId: "req-1", principal: initiator, toolName: "lexware__create_invoice", toolInput: {} },
    response: { decision, principal: responder },
    session: { id: "session-1", initiator, turn: { id: "turn-1" } },
  };
}

const ownsSession = (responder: Person, ctx: { session: { initiator: Person | null } }) =>
  ctx.session.initiator !== null &&
  ctx.session.initiator.authenticator === responder.authenticator &&
  ctx.session.initiator.principalType === responder.principalType &&
  ctx.session.initiator.principalId === responder.principalId;

describe("canApprove", () => {
  it("allows anyone without canApprove", async () => {
    assert.deepEqual(await decideApproval(undefined, context(other, owner)), { status: "allowed" });
  });

  it("receives the session's initiator, so it can require the session's owner", async () => {
    assert.deepEqual(await decideApproval(ownsSession, context(owner, owner)), { status: "allowed" });
    assert.equal((await decideApproval(ownsSession, context(other, owner))).status, "rejected");
  });

  it("refuses when the session has no initiator", async () => {
    assert.equal((await decideApproval(ownsSession, context(owner, null))).status, "rejected");
  });

  it("passes the responder and eve's whole context, decision included", async () => {
    const seen: unknown[][] = [];
    const ctx = context(other, owner, "cancel");
    await decideApproval(async (...args: unknown[]) => (seen.push(args), true), ctx);
    assert.equal(seen[0]![0], other);
    assert.equal(seen[0]![1], ctx);
  });

  it("still takes a canApprove that reads only the responder", async () => {
    const onlyAnna = (responder: Person) => responder.principalId === "anna";
    assert.equal((await decideApproval(onlyAnna, context(owner, other))).status, "allowed");
    assert.equal((await decideApproval(onlyAnna, context(other, owner))).status, "rejected");
  });
});
