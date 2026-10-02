import type { ApprovalPolicy } from "eve/tools/approval";

import { approvalCard } from "./cards";
import { config } from "./runtime";

/**
 * Wraps a writing tool's request policy: when it asks for approval, the
 * finished card goes to the mount's onApprovalCard right away — before eve
 * announces the request (`input.requested`). Channels render that event
 * before hooks run, so a card handed over from a hook would come too late
 * for them (eve: channel delivery, then hooks).
 */
export function withCard<T>(request: ApprovalPolicy<T>): ApprovalPolicy<T> {
  return async (ctx) => {
    const status = await request(ctx);
    const asksPerson = status === "user-approval" || (typeof status === "object" && status !== null && status.type === "user-approval");
    const onApprovalCard = config().onApprovalCard;
    if (asksPerson && onApprovalCard) {
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
