import { call } from "eve/events";
import { defineHook } from "eve/hooks";

import { approvalCard } from "../lib/call-card";
import { config } from "../lib/runtime";

/**
 * Hands the finished card of each approval to the mount's onApprovalCard —
 * the channel then shows figures and findings instead of raw tool input.
 * Never throws: a hook that throws fails the turn, a missing card only costs
 * the view.
 */
export default defineHook({
  events: {
    async "interaction.opened"(event, ctx) {
      const onApprovalCard = config().onApprovalCard;
      if (!onApprovalCard) return;
      if (event.data.request.kind !== "approval" || !("callId" in event.data.subject)) return;
      const callId = event.data.subject.callId;
      const action = call(ctx.view, callId);
      if (!action) return;
      const card = approvalCard(action.name, callId, action.input);
      if (!card) return;
      try {
        await onApprovalCard(callId, card);
      } catch (error) {
        console.warn(`[lexware] onApprovalCard failed for ${callId}: ${String(error)}`);
      }
    },
  },
});
