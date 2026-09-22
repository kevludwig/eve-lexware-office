import { defineHook } from "eve/hooks";

import { ledger } from "../lib/runtime";
import { boundReminderTarget } from "../lib/state";

/**
 * Records a declined payment reminder, so the next runs leave the invoice
 * alone for a while. A sent reminder stays on record — declining a repeat
 * must not reopen it. Never throws.
 */
export default defineHook({
  events: {
    async "action.result"(event) {
      if (event.data.status !== "rejected") return;
      const callId = "callId" in event.data.result ? event.data.result.callId : undefined;
      if (typeof callId !== "string") return;
      const target = boundReminderTarget(callId);
      if (!target) return;
      try {
        if ((await ledger().read(target.invoiceId))?.status === "sent") return;
        await ledger().write({ invoiceId: target.invoiceId, voucherNumber: target.voucherNumber, status: "declined" });
      } catch (error) {
        console.warn(`[lexware] Cannot record declined reminder ${target.invoiceId}: ${String(error)}`);
      }
    },
  },
});
