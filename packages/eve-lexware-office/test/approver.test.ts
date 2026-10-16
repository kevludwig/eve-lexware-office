import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Not under the harness's runtime mock: the decision itself is pure.
const { decideApproval } = await import("../dist/extension/lib/approver.mjs");

type Person = { authenticator: string; issuer?: string; principalType: string; principalId: string };

const person = (principalId: string): Person => ({ authenticator: "test", principalType: "user", principalId });
const owner = person("ada");
const other = person("ben");

function context(
  responder: Person,
  initiator: Person | null,
  decision: "approve" | "cancel" = "approve",
  requester: Person | null = initiator,
) {
  return {
    auth: {},
    request: { callId: "call-1", requestId: "req-1", principal: requester, toolName: "lexware__create_invoice", toolInput: {} },
    response: { decision, principal: responder },
    session: { id: "session-1", initiator, turn: { id: "turn-1" } },
  };
}

const ownsSession = (responder: Person, ctx: { session: { initiator: Person | null } }) =>
  ctx.session.initiator !== null &&
  ctx.session.initiator.authenticator === responder.authenticator &&
  ctx.session.initiator.principalType === responder.principalType &&
  ctx.session.initiator.principalId === responder.principalId;

describe("default without canApprove: requester only, as in eve", () => {
  it("allows the requester to approve and to cancel", async () => {
    assert.deepEqual(await decideApproval(undefined, context(owner, owner)), { status: "allowed" });
    assert.deepEqual(await decideApproval(undefined, context(owner, owner, "cancel")), { status: "allowed" });
  });

  it("refuses anyone else, for approve and for cancel", async () => {
    assert.equal((await decideApproval(undefined, context(other, owner))).status, "rejected");
    assert.equal((await decideApproval(undefined, context(other, owner, "cancel"))).status, "rejected");
  });

  it("follows the requester, not the session's initiator", async () => {
    assert.deepEqual(await decideApproval(undefined, context(other, owner, "approve", other)), { status: "allowed" });
    assert.equal((await decideApproval(undefined, context(owner, owner, "approve", other))).status, "rejected");
  });

  it("compares the full identity: authenticator, issuer, type and id", async () => {
    const reject = async (responder: Person) => (await decideApproval(undefined, context(responder, owner))).status;
    assert.equal(await reject({ ...owner, authenticator: "slack" }), "rejected");
    assert.equal(await reject({ ...owner, issuer: "https://idp.example" }), "rejected");
    assert.equal(await reject({ ...owner, principalType: "service" }), "rejected");
  });

  it("leaves a call by an unauthenticated or anonymous requester open to anyone", async () => {
    assert.deepEqual(await decideApproval(undefined, context(other, owner, "approve", null)), { status: "allowed" });
  });
});

describe("canApprove", () => {
  it("overrides the default: () => true lets anyone answer", async () => {
    assert.deepEqual(await decideApproval(() => true, context(other, owner)), { status: "allowed" });
  });

  it("overrides the default: the requester is refused when canApprove says no", async () => {
    assert.equal((await decideApproval(() => false, context(owner, owner))).status, "rejected");
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
    const onlyAda = (responder: Person) => responder.principalId === "ada";
    assert.equal((await decideApproval(onlyAda, context(owner, other))).status, "allowed");
    assert.equal((await decideApproval(onlyAda, context(other, owner))).status, "rejected");
  });
});
