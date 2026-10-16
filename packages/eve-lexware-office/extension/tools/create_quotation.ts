import { defineTool } from "eve/tools";

import { approverPolicy } from "../lib/runtime";
import { executeSalesDocument, salesApproval } from "../lib/sales";
import { quotationDescription, quotationInputSchema } from "../lib/sales-tools";
import { withCard } from "../lib/with-card";

export default defineTool({
  description: quotationDescription,
  inputSchema: quotationInputSchema,
  approval: { request: withCard(salesApproval("quotation")), response: approverPolicy },
  async execute(input, ctx) {
    return executeSalesDocument("quotation", input, ctx);
  },
});
