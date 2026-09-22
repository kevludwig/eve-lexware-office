/**
 * The mount's configuration turned into working parts — one API client (one
 * rate-limit queue) and one store per mount, created on first use.
 */

import {
  createLexwareClient,
  defaultReminderMail,
  keySegment,
  reminderLedger,
  type JsonStore,
  type LexwareClient,
  type ReminderLedger,
} from "@kevludwig/lexware-office";
import { vercelBlobStore } from "@kevludwig/lexware-office/vercel-blob";
import type { ApprovalResponseContext, ApprovalResponseDecision } from "eve/tools/approval";

import extension from "../extension";

type Config = typeof extension.config;

let cached: { config: Config; client: LexwareClient; store: JsonStore } | undefined;

function parts() {
  const config = extension.config;
  if (cached?.config !== config) {
    cached = {
      config,
      client: config.client ?? createLexwareClient({ apiKey: config.apiKey ?? "", baseUrl: config.baseUrl, appUrl: config.appUrl }),
      store: config.storage.store ?? vercelBlobStore({ prefix: config.storage.prefix }),
    };
  }
  return cached;
}

export const config = (): Config => extension.config;
export const client = (): LexwareClient => parts().client;
export const store = (): JsonStore => parts().store;

/** A key of this mount's own documents in the store, e.g. the journal. */
export function key(...segments: string[]): string {
  return segments.map(keySegment).join("/");
}

export function ledger(): ReminderLedger {
  const reminders = config().reminders;
  return reminderLedger(store(), reminders.namespace ?? `reminders/${reminders.mode}`);
}

export function renderReminder() {
  const reminders = config().reminders;
  if (reminders.render) return reminders.render;
  return defaultReminderMail(reminders.sender ?? { name: "Ihr Team" });
}

/** The response policy of every writing tool: the mount's canApprove, if any. */
export async function approverPolicy<T>({ responder }: ApprovalResponseContext<T>): Promise<ApprovalResponseDecision> {
  const canApprove = config().canApprove;
  if (!canApprove || (await canApprove(responder))) return { status: "allowed" };
  return { status: "rejected", reason: "Nur berechtigte Personen dürfen freigeben." };
}
