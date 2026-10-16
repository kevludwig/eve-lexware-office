/** The card of a call in eve's session: the input with the findings its checks saved. */

import type { ApprovalCard } from "./card-types";
import { buildCard } from "./cards";
import { warningsOf } from "./findings";

export function approvalCard(toolName: string, callId: string, input: unknown): ApprovalCard | null {
  return buildCard(toolName, input, warningsOf(callId));
}
