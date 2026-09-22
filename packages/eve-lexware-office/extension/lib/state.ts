/**
 * Session state of this extension — scoped to the package by eve, so the
 * names cannot collide with the consumer's.
 */

import type { ReminderTarget } from "@kevinludwig/lexware-office";
import { defineState } from "eve/context";

/** Contacts a customer card showed as similar, by tool call id. */
const shownContacts = defineState<Record<string, string[]>>("shown-contacts", () => ({}));

/** What a payment reminder's approval was bound to, by tool call id. */
const reminderTargets = defineState<Record<string, ReminderTarget>>("reminder-targets", () => ({}));

export function rememberShownContacts(callId: string, ids: string[]): void {
  try {
    shownContacts.update((all) => ({ ...all, [callId]: ids }));
  } catch (error) {
    console.warn(`[lexware] Cannot store shown contacts: ${String(error)}`);
  }
}

export function shownContactsOf(callId: string): Set<string> {
  try {
    return new Set(shownContacts.get()[callId] ?? []);
  } catch {
    return new Set();
  }
}

export function bindReminderTarget(callId: string, target: ReminderTarget): void {
  try {
    reminderTargets.update((all) => ({ ...all, [callId]: target }));
  } catch (error) {
    console.warn(`[lexware] Cannot bind reminder target: ${String(error)}`);
  }
}

export function boundReminderTarget(callId: string): ReminderTarget | null {
  try {
    return reminderTargets.get()[callId] ?? null;
  } catch {
    return null;
  }
}
