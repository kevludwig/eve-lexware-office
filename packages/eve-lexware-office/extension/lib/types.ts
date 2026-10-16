import type { ApprovalContext, ApprovalResponseContext } from "eve/tools/approval";

import type { Warning } from "./findings";

/** Whoever answers an approval (approve or cancel), as the channel authenticated them. */
export type Responder = ApprovalResponseContext["response"]["principal"];

/**
 * Who may approve a writing tool, or cancel it. The second argument is eve's
 * response context: `session.initiator` (who started the session),
 * `request.principal` (whose turn requested the call, null if anonymous),
 * `response.decision` ("approve" or "cancel"), tool name and input.
 */
export type CanApprove = (responder: Responder, context: ApprovalResponseContext) => boolean | Promise<boolean>;

/** One line of findings on a card: "⚠ " in front of the title marks a warning. */
export interface Finding {
  title: string;
  value: string;
}

/**
 * What a writing tool is about to do, as a card any channel can render: a
 * title, a one-line subtitle, key facts, an optional note, and the findings
 * of its checks.
 */
export interface ApprovalCard {
  /** The tool's own name, without the mount's namespace. */
  tool: string;
  title: string;
  subtitle?: string;
  facts: { title: string; value: string }[];
  note?: string;
  findings: Finding[];
}

/** A second source for attachments eve staged under /workspace/.eve/attachments/ (before eve 0.70.2: /workspace/attachments/). */
export interface AttachmentFallback {
  /** The bytes of a staged attachment, or null if unknown. */
  read(path: string, signal?: AbortSignal): Promise<Uint8Array | null>;
  /** Its size, or null — for the check before the card. Default: read it. */
  size?(path: string): Promise<number | null>;
  /** Called once the file is attached in Lexware Office and needs no keeping. */
  release?(path: string): Promise<void>;
}

/** A purchase invoice as approved for capture, in EUR. */
export interface CapturedPurchase {
  callId: string;
  voucherNumber: string;
  supplierName: string;
  gross: number;
  tax: number;
  net: number;
}

/**
 * A writing call whose checks are done and that would now ask a person:
 * the tool (without the mount's namespace), its input, and what the checks
 * found. `context` is eve's approval context — session, caller, call id.
 */
export interface DecideCall {
  tool: string;
  input: unknown;
  warnings: readonly Warning[];
  findings: readonly Finding[];
  context: ApprovalContext;
}

/**
 * Who decides instead of a person: "ask" shows the card as before,
 * "approve" runs the call without one, `{ deny }` refuses it with a reason.
 * Record an automatic approval yourself before returning "approve" — the
 * extension cannot know where your protocol lives.
 */
export type Decide = (call: DecideCall) => "ask" | "approve" | { deny: string } | Promise<"ask" | "approve" | { deny: string }>;
