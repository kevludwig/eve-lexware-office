import type { ApprovalResponseContext } from "eve/tools/approval";

/** Whoever answers an approval, as the channel authenticated them. */
export type Responder = ApprovalResponseContext["responder"];

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

/** A second source for attachments eve staged under /workspace/attachments/. */
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
