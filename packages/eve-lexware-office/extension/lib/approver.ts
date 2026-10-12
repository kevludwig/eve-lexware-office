import type { ApprovalResponseContext, ApprovalResponseDecision } from "eve/tools/approval";

import type { CanApprove, Responder } from "./types";

/**
 * Decides one approval response. With the mount's canApprove, that decides:
 * it receives the responder and eve's whole response context — who requested
 * the call (`request.principal`), who started the session
 * (`session.initiator`), and whether the answer is approve or cancel
 * (`response.decision`).
 *
 * Without canApprove, eve's own default applies: only the principal whose
 * turn requested the call may approve or cancel it. A call requested by an
 * unauthenticated or anonymous caller (`request.principal` is null) stays open
 * to any responder, as in eve.
 */
export async function decideApproval<T>(
  canApprove: CanApprove | undefined,
  context: ApprovalResponseContext<T>,
): Promise<ApprovalResponseDecision> {
  if (!canApprove) {
    const requester = context.request.principal;
    if (requester === null || samePrincipal(context.response.principal, requester)) return { status: "allowed" };
    return { status: "rejected", reason: "Nur wer die Aktion angefragt hat, darf sie freigeben oder abbrechen." };
  }
  if (await canApprove(context.response.principal, context as ApprovalResponseContext)) return { status: "allowed" };
  return { status: "rejected", reason: "Nur berechtigte Personen dürfen freigeben." };
}

/** The full identity, as eve compares it for its requester-only default. */
function samePrincipal(a: Responder, b: Responder): boolean {
  return (
    a.authenticator === b.authenticator &&
    a.issuer === b.issuer &&
    a.principalType === b.principalType &&
    a.principalId === b.principalId
  );
}
