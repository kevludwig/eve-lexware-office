import { defineHook } from "eve/hooks";

import { approvalCard } from "../lib/cards";
import { config } from "../lib/runtime";

/**
 * Hands the finished card of each approval to the mount's onApprovalCard —
 * the channel then shows figures and findings instead of raw tool input.
 * Never throws: a hook that throws fails the turn, a missing card only costs
 * the view.
 */
export default defineHook({
  events: {
    async "input.requested"(event) {
      const onApprovalCard = config().onApprovalCard;
      if (!onApprovalCard) return;
      for (const request of event.data.requests) {
        if (request.kind !== "tool-approval") continue;
        const action = request.action as { callId?: string; toolName?: string; input?: unknown };
        if (!action.callId || !action.toolName) continue;
        const card = approvalCard(action.toolName, action.callId, action.input);
        if (!card) continue;
        try {
          await onApprovalCard(action.callId, card);
        } catch (error) {
          console.warn(`[lexware] onApprovalCard failed for ${action.callId}: ${String(error)}`);
        }
      }
    },
  },
});
