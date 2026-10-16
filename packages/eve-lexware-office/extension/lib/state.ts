/**
 * Session state of this extension — scoped to the package by eve, so the
 * names cannot collide with the consumer's.
 */

import type { ReminderTarget } from "@kevludwig/lexware-office";
import { defineState } from "eve/context";

/** Contacts a customer card showed as similar, by tool call id. */
const shownContacts = defineState<Record<string, string[]>>("shown-contacts", () => ({}));

/** What a payment reminder's approval was bound to, by tool call id. */
const reminderTargets = defineState<Record<string, ReminderTarget>>("reminder-targets", () => ({}));

export function rememberShownContacts(callId: string, ids: string[]): void {
  // On eve's recheck of an approved call the card's state must stay as shown: the "unseen ⇒ stop" checks compare against it.
  if (settledOf(callId) !== null) return;
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
  // The approval was bound to the target the card showed — a recheck must not rebind it.
  if (settledOf(callId) !== null) return;
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

/**
 * What the request policy settled for a call, by tool call id: "ask" once a
 * person was asked (the card went out), "approve" once `decide` approved it.
 * eve runs the request policy again before an approved call executes (its
 * recheck); the marker tells that run apart from the first, without eve's
 * internal recheck flag.
 */
const settled = defineState<Record<string, "ask" | "approve">>("settled-calls", () => ({}));

export function rememberSettled(callId: string, outcome: "ask" | "approve"): void {
  try {
    settled.update((all) => ({ ...all, [callId]: outcome }));
  } catch (error) {
    console.warn(`[lexware] Cannot store the approval outcome: ${String(error)}`);
  }
}

export function settledOf(callId: string): "ask" | "approve" | null {
  try {
    return settled.get()[callId] ?? null;
  } catch {
    return null;
  }
}
