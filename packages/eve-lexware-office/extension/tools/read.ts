import { defineTool } from "eve/tools";

import { readAccount, readDescription, readInputSchema } from "../lib/read";
import { client } from "../lib/runtime";

export default defineTool({
  description: readDescription,
  inputSchema: readInputSchema,

  // No approval: reading changes nothing, and the key decides what is visible.

  async execute(input, ctx) {
    return readAccount(client(), input, ctx.abortSignal);
  },
});
