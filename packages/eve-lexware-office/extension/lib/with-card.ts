import type { ApprovalPolicy, ApprovalStatus } from "eve/tools/approval";

import { approvalCard, ownTool } from "./cards";
import { describeWarning, warningsOf } from "./findings";
import { config } from "./runtime";

/**
 * Wraps a writing tool's request policy. When it would ask a person, the
 * mount's `decide` may answer instead (approve, refuse, or ask after all);
 * when a person is asked, the finished card goes to the mount's
 * onApprovalCard right away — before eve announces the request
 * (`input.requested`). Channels render that event before hooks run, so a card
 * handed over from a hook would come too late for them (eve: channel
 * delivery, then hooks).
 *
 * A `decide` that throws asks a person: it must never approve by accident.
 */
export function withCard<T>(request: ApprovalPolicy<T>): ApprovalPolicy<T> {
  return async (ctx) => {
    let status: ApprovalStatus = await request(ctx);
    const asksPerson = (value: ApprovalStatus) =>
      value === "user-approval" || (typeof value === "object" && value !== null && value.type === "user-approval");

    const decide = config().decide;
    if (asksPerson(status) && decide) {
      try {
        const warnings = warningsOf(ctx.callId);
        const answer = await decide({
          tool: ownTool(ctx.toolName) ?? ctx.toolName,
          input: ctx.toolInput,
          warnings,
          findings: warnings.map(describeWarning),
          context: ctx as never,
        });
        if (answer === "approve") return "approved";
        if (typeof answer === "object" && answer !== null && typeof answer.deny === "string") return { type: "denied", reason: answer.deny };
      } catch (error) {
        console.warn(`[lexware] decide failed for ${ctx.callId}, a person decides: ${String(error)}`);
      }
      status = "user-approval";
    }

    const onApprovalCard = config().onApprovalCard;
    if (asksPerson(status) && onApprovalCard) {
      const card = approvalCard(ctx.toolName, ctx.callId, ctx.toolInput);
      if (card) {
        try {
          await onApprovalCard(ctx.callId, card);
        } catch (error) {
          // The card is a view; a failure must not block the approval.
          console.warn(`[lexware] onApprovalCard failed for ${ctx.callId}: ${String(error)}`);
        }
      }
    }
    return status;
  };
}
