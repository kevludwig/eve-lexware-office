import { defineTool } from "eve/tools";

import { approverPolicy } from "../lib/runtime";
import { executeSalesDocument, salesApproval } from "../lib/sales-eve";
import { orderConfirmationDescription, orderConfirmationInputSchema, withSource } from "../lib/sales-tools";
import { withCard } from "../lib/with-card";

export default defineTool({
  description: orderConfirmationDescription,
  inputSchema: orderConfirmationInputSchema,
  approval: { request: withCard(salesApproval("order-confirmation", withSource)), response: approverPolicy },
  async execute(input, ctx) {
    return executeSalesDocument("order-confirmation", withSource(input), ctx);
  },
});
