import type { ApprovalContext, ApprovalPolicy, ApprovalStatus } from "eve/tools/approval";

import { approvalCard } from "./call-card";
import { ownTool } from "./cards";
import { warningsOf } from "./findings";
import { config } from "./runtime";
import { rememberSettled, settledOf } from "./state";
import { describeWarning } from "./warnings";

export interface WithCardOptions<T> {
  /**
   * Runs once the call goes ahead — a person is asked, or `decide` approved
   * it — and never after a denial. E.g. to mark a reminder as waiting only
   * when someone will actually see its card.
   */
  onProceed?: (ctx: ApprovalContext<T>) => void | Promise<void>;
}

const asksPerson = (value: ApprovalStatus) =>
  value === "user-approval" || (typeof value === "object" && value !== null && value.type === "user-approval");

/**
 * Wraps a writing tool's request policy. When it would ask a person, the
 * mount's `decide` may answer instead (approve, refuse, or ask after all);
 * when a person is asked, the finished card goes to the mount's
 * onApprovalCard right away — before eve announces the request
 * (`input.requested`). Channels render that event before hooks run, so a card
 * handed over from a hook would come too late for them (eve: channel
 * delivery, then hooks).
 *
 * eve runs the policy again before an approved call executes (its recheck):
 * the tool's own checks run again and may still deny, but `decide`,
 * onApprovalCard and `onProceed` do not — a person already answered, or
 * `decide` already approved. Session state tells the two runs apart; where
 * it cannot be read, `decide` may be called a second time.
 *
 * A `decide` that throws asks a person: it must never approve by accident.
 */
export function withCard<T>(request: ApprovalPolicy<T>, options: WithCardOptions<T> = {}): ApprovalPolicy<T> {
  return async (ctx) => {
    let status: ApprovalStatus = await request(ctx);
    if (!asksPerson(status)) return status;

    // The recheck of a call that was already settled: the checks above passed again.
    const earlier = settledOf(ctx.callId);
    if (earlier === "ask") return status;
    if (earlier === "approve") return "approved";

    const decide = config().decide;
    if (decide) {
      try {
        const warnings = warningsOf(ctx.callId);
        const answer = await decide({
          tool: ownTool(ctx.toolName) ?? ctx.toolName,
          input: ctx.toolInput,
          warnings,
          findings: warnings.map(describeWarning),
          context: ctx as never,
        });
        if (answer === "approve") {
          rememberSettled(ctx.callId, "approve");
          await proceed(options, ctx);
          return "approved";
        }
        if (typeof answer === "object" && answer !== null && typeof answer.deny === "string") return { type: "denied", reason: answer.deny };
      } catch (error) {
        console.warn(`[lexware] decide failed for ${ctx.callId}, a person decides: ${String(error)}`);
      }
      status = "user-approval";
    }

    rememberSettled(ctx.callId, "ask");
    await proceed(options, ctx);
    const onApprovalCard = config().onApprovalCard;
    if (onApprovalCard) {
      const card = approvalCard(ctx.toolName, ctx.callId, ctx.toolInput);
      if (card) {
        try {
          await onApprovalCard(ctx.callId, card);
        } catch (error) {
          // The card is a view; a failure must not block the approval.
          console.warn(`[lexware] onApprovalCard failed for ${ctx.callId}: ${String(error)}`);
        }
      }
    }
    return status;
  };
}

async function proceed<T>(options: WithCardOptions<T>, ctx: ApprovalContext<T>): Promise<void> {
  try {
    await options.onProceed?.(ctx);
  } catch (error) {
    console.warn(`[lexware] onProceed failed for ${ctx.callId}: ${String(error)}`);
  }
}
