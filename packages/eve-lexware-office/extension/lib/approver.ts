import type { ApprovalResponseContext, ApprovalResponseDecision } from "eve/tools/approval";

import type { CanApprove } from "./types";

/**
 * Decides one approval response with the mount's canApprove. It receives the
 * responder and eve's whole response context: who requested the call
 * (`request.principal`), who started the session (`session.initiator`), and
 * whether the answer is approve or cancel (`response.decision`).
 */
export async function decideApproval<T>(
  canApprove: CanApprove | undefined,
  context: ApprovalResponseContext<T>,
): Promise<ApprovalResponseDecision> {
  if (!canApprove || (await canApprove(context.response.principal, context as ApprovalResponseContext))) return { status: "allowed" };
  return { status: "rejected", reason: "Nur berechtigte Personen dürfen freigeben." };
}
