/** The approval card as data — no eve, so ./operations can hand it to any surface. */

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
