import { defineTool } from "eve/tools";

import { approverPolicy } from "../lib/runtime";
import { executeSalesDocument, salesApproval } from "../lib/sales-eve";
import { invoiceDescription, invoiceInputSchema } from "../lib/sales-tools";
import { withCard } from "../lib/with-card";

export default defineTool({
  description: invoiceDescription,
  inputSchema: invoiceInputSchema,
  approval: { request: withCard(salesApproval("invoice")), response: approverPolicy },
  async execute(input, ctx) {
    return executeSalesDocument("invoice", input, ctx);
  },
});
