import { defineTool } from "eve/tools";

import { customerUpdateDescription, customerUpdateInputSchema, executeApprovedCustomerUpdate, prepareCustomerUpdate, type CustomerUpdateInput } from "../lib/customer";
import { saveWarnings } from "../lib/findings";
import { runtimeJournal } from "../lib/journal";
import { approverPolicy, client } from "../lib/runtime";
import { bindCustomerUpdate, boundCustomerUpdate } from "../lib/state";
import { withCard } from "../lib/with-card";

export default defineTool({
  description: customerUpdateDescription,
  inputSchema: customerUpdateInputSchema,

  approval: {
    request: withCard(async (ctx) => {
      const prepared = await prepareCustomerUpdate(client(), customerUpdateInputSchema.parse(ctx.toolInput ?? {}) as CustomerUpdateInput, ctx.abortSignal);
      if (prepared.refusal || !prepared.binding) return { type: "denied" as const, reason: prepared.refusal ?? "Nichts zu ändern." };
      bindCustomerUpdate(ctx.callId, prepared.binding);
      saveWarnings(ctx.callId, prepared.warnings);
      return "user-approval" as const;
    }),
    response: approverPolicy,
  },

  async execute(input, ctx) {
    const target = boundCustomerUpdate(ctx.callId);
    if (!target) throw new Error("Abgebrochen: Die Freigabe gehört zu keinem gelesenen Kontakt. Nichts geändert. Rufe das Tool erneut auf.");
    return executeApprovedCustomerUpdate({ client: client(), journal: runtimeJournal }, input, { id: ctx.callId, ...target, signal: ctx.abortSignal });
  },
});
