import { defineTool } from "eve/tools";

import { customerDescription, customerInputSchema, executeApprovedCustomer, prepareCustomer, type CustomerInput } from "../lib/customer";
import { saveWarnings } from "../lib/findings";
import { runtimeJournal } from "../lib/journal";
import { approverPolicy, client } from "../lib/runtime";
import { rememberShownContacts, shownContactsOf } from "../lib/state";
import { withCard } from "../lib/with-card";

export default defineTool({
  description: customerDescription,
  inputSchema: customerInputSchema,

  approval: {
    request: withCard(async (ctx) => {
      const prepared = await prepareCustomer(client(), (ctx.toolInput ?? {}) as Partial<CustomerInput>, ctx.abortSignal);
      if (prepared.shownContactIds.length > 0) rememberShownContacts(ctx.callId, prepared.shownContactIds);
      saveWarnings(ctx.callId, prepared.warnings);
      return "user-approval" as const;
    }),
    response: approverPolicy,
  },

  async execute(input, ctx) {
    return executeApprovedCustomer({ client: client(), journal: runtimeJournal }, input, {
      id: ctx.callId,
      shownContactIds: shownContactsOf(ctx.callId),
      signal: ctx.abortSignal,
    });
  },
});
