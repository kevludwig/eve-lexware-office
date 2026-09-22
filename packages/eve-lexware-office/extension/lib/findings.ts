/**
 * What the checks found, per tool call — typed, so a tool can ask "did the
 * card show this duplicate?" or "can the model fix this itself?", and
 * described once for cards and results.
 *
 * The checks run in the approval policy, server-side; findings live in
 * session state under the call id. The model can neither set nor skip them.
 */

import { round2 } from "@kevludwig/lexware-office";
import { defineState } from "eve/context";

import { eur, shortDate } from "./format";
import type { Finding } from "./types";

export type Warning =
  // A finished line — for tools whose findings need no logic later. "⚠ " in the title marks a warning.
  | { kind: "note"; title: string; value: string }
  // Sales documents
  | { kind: "sales-duplicate"; documentLabel: string; url: string; voucherNumber?: string; voucherDate?: string; voucherStatus?: string }
  | { kind: "sales-duplicate-check-failed"; reason: string }
  | { kind: "duplicate-check-incomplete"; reason: string }
  | { kind: "sales-contact"; reason: string }
  | { kind: "customer-resolved"; name: string; number?: number }
  | { kind: "source-resolved"; sourceLabel: string; contactName?: string }
  | { kind: "source-mismatch"; sourceLabel: string; sourceNet: number; itemsNet: number; difference: number }
  | { kind: "source-discount"; sourceLabel: string; discountAbsolute?: number; discountPercentage?: number; sourceNet?: number }
  | { kind: "source-check-failed"; reason: string }
  // Purchase invoices
  | { kind: "voucher-total-mismatch"; computed: number; expected: number; difference: number; currency: string }
  | { kind: "voucher-reverse-charge"; categories: string[]; rate: number; invoiceChargesTax: boolean }
  | { kind: "voucher-foreign-currency"; currency: string; original: number; booked: number; rate: number }
  | { kind: "voucher-duplicate"; url: string; voucherNumber: string; voucherDate?: string; voucherStatus?: string; contactName?: string }
  | { kind: "voucher-duplicate-check-failed"; reason: string }
  | { kind: "voucher-category-missing"; reason: string }
  | { kind: "voucher-attachment-missing"; reason: string }
  | { kind: "voucher-contact-fallback"; reason: string }
  | { kind: "voucher-contact-explicit"; contactName: string; contactId: string; extractedName: string }
  | { kind: "category-history"; name: string; basis: string }
  | { kind: "category-ambiguous"; candidates: string[] }
  | { kind: "category-no-history" }
  | { kind: "category-split"; candidates: string[] }
  | { kind: "category-deviation"; chosen: string; usual: string };

const warnings = defineState<Record<string, Warning[]>>("warnings", () => ({}));

/** Signatures of calls already sent back for correction once — the model cannot reset them. */
const rejected = defineState<Record<string, true>>("rejected-signatures", () => ({}));

export function saveWarnings(callId: string, list: Warning[]): void {
  try {
    warnings.update((all) => ({ ...all, [callId]: list }));
  } catch (error) {
    console.warn(`[lexware] Cannot store findings: ${String(error)}`);
  }
}

export function warningsOf(callId: string): Warning[] {
  try {
    return warnings.get()[callId] ?? [];
  } catch {
    return [];
  }
}

/** The findings as the card and the result show them. */
export function findingsOf(callId: string): Finding[] {
  return warningsOf(callId).map(describeWarning);
}

/** Findings as lines for a tool result — the chat must not contradict the card. */
export function notesOf(callId: string): string[] {
  return findingsOf(callId).map((finding) => `${finding.title}: ${finding.value}`);
}

/**
 * Whether the card showed this document as a duplicate. Separates a warning
 * the user overrode from a document that only appeared between card and
 * click — only the latter stops the write. Unreadable state counts as "not
 * shown": better to stop than to create an unseen duplicate.
 */
export function wasShownOnCard(callId: string, url: string): boolean {
  return warningsOf(callId).some(
    (warning) => (warning.kind === "sales-duplicate" || warning.kind === "voucher-duplicate") && warning.url === url,
  );
}

/** Whether a better call could resolve this finding — then the call is sent back once. */
export function isCorrectable(warning: Warning): boolean {
  return (
    warning.kind === "voucher-total-mismatch" ||
    warning.kind === "category-ambiguous" ||
    warning.kind === "category-no-history" ||
    warning.kind === "category-split" ||
    warning.kind === "category-deviation"
  );
}

export function wasRejected(signature: string): boolean {
  try {
    return rejected.get()[signature] === true;
  } catch {
    return false;
  }
}

export function rememberRejection(signature: string): void {
  try {
    rejected.update((all) => ({ ...all, [signature]: true }));
  } catch {
    // Without state the correction simply runs again — no harm done.
  }
}

const amountIn = (value: number, currency: string) => eur(value, currency);

export function describeWarning(warning: Warning): Finding {
  switch (warning.kind) {
    case "note":
      return { title: warning.title, value: warning.value };
    case "sales-duplicate":
      return {
        title: "⚠ Dublette",
        value:
          `${warning.documentLabel} mit gleicher Positionssumme existiert bereits` +
          (warning.voucherNumber ? ` (${warning.voucherNumber}` : " (") +
          (warning.voucherDate ? `, ${shortDate(warning.voucherDate)}` : "") +
          (warning.voucherStatus ? `, ${warning.voucherStatus}` : "") +
          `): ${warning.url}`,
      };
    case "sales-duplicate-check-failed":
      return { title: "⚠ Dublettenprüfung", value: `fehlgeschlagen — ${warning.reason}` };
    case "duplicate-check-incomplete":
      return { title: "⚠ Dublettenprüfung", value: `unvollständig — ${warning.reason}` };
    case "sales-contact":
      return { title: "⚠ Kunde", value: warning.reason };
    case "customer-resolved":
      return { title: "Kunde", value: warning.number !== undefined ? `${warning.name} (Nr. ${warning.number})` : warning.name };
    case "source-resolved":
      return { title: "Bezugsbeleg", value: warning.contactName ? `${warning.sourceLabel} (${warning.contactName})` : warning.sourceLabel };
    case "source-mismatch":
      return {
        title: "⚠ Bezugsbeleg",
        value:
          `Positionen ergeben ${eur(warning.itemsNet)}, ${warning.sourceLabel} hat ${eur(warning.sourceNet)} ` +
          `(Differenz ${eur(warning.difference)}) — Abweichung kann gewollt sein (geänderte Positionen)`,
      };
    case "source-discount": {
      const parts = [warning.discountAbsolute ? eur(warning.discountAbsolute) : null, warning.discountPercentage ? `${warning.discountPercentage} %` : null].filter(Boolean);
      return {
        title: "⚠ Rabatt im Bezugsbeleg",
        value:
          `${warning.sourceLabel} enthält einen Gesamtrabatt (${parts.join(" / ")})` +
          (warning.sourceNet !== undefined ? `, End-Netto ${eur(warning.sourceNet)}` : "") +
          " — der neue Beleg übernimmt ihn NICHT; ohne eigenen Rabatt entsteht er zum vollen Preis",
      };
    }
    case "source-check-failed":
      return { title: "⚠ Bezugsbeleg", value: `nicht prüfbar — ${warning.reason}` };
    case "voucher-total-mismatch":
      return {
        title: "⚠ Summenabgleich",
        value:
          `Steuergruppen ergeben ${amountIn(warning.computed, warning.currency)} brutto, angegeben ist ` +
          `${amountIn(warning.expected, warning.currency)} (Differenz ${amountIn(warning.difference, warning.currency)})`,
      };
    case "voucher-reverse-charge": {
      const booking =
        `${warning.categories.join(", ")}: gebucht mit ${warning.rate} % ohne Steuerbetrag — die Umsatzsteuer ` +
        "schuldest du selbst und ziehst sie als Vorsteuer wieder ab";
      return warning.invoiceChargesTax
        ? { title: "⚠ Reverse Charge", value: `${booking}. Die Rechnung weist aber Umsatzsteuer aus — Kategorie oder Rechnung prüfen` }
        : { title: "Reverse Charge", value: booking };
    }
    case "voucher-foreign-currency": {
      const rate = warning.rate.toLocaleString("de-DE", { minimumFractionDigits: 4, maximumFractionDigits: 4 });
      const conversion =
        `${amountIn(warning.original, warning.currency)} laut Rechnung, gebucht mit ${eur(warning.booked)} laut Kontoauszug ` +
        `(1 ${warning.currency} = ${rate} EUR)`;
      // The same figure in both currencies is the mistake this finding exists for.
      return round2(warning.booked) === round2(warning.original)
        ? { title: "⚠ Fremdwährung", value: `${conversion} — Kurs 1:1, vermutlich nicht umgerechnet` }
        : { title: "Fremdwährung", value: conversion };
    }
    case "voucher-duplicate":
      return {
        title: "⚠ Dublette",
        value:
          `Rechnung ${warning.voucherNumber} ist bereits als Eingangsbeleg erfasst` +
          (warning.contactName ? ` (${warning.contactName}` : " (") +
          (warning.voucherDate ? `, ${shortDate(warning.voucherDate)}` : "") +
          (warning.voucherStatus ? `, ${warning.voucherStatus}` : "") +
          `): ${warning.url}`,
      };
    case "voucher-duplicate-check-failed":
      return { title: "⚠ Dublettenprüfung", value: `fehlgeschlagen — ${warning.reason}` };
    case "voucher-category-missing":
      return { title: "⚠ Buchungskategorie", value: warning.reason };
    case "voucher-attachment-missing":
      return { title: "⚠ Anhang", value: warning.reason };
    case "voucher-contact-fallback":
      return { title: "⚠ Lieferant", value: warning.reason };
    case "voucher-contact-explicit":
      return {
        title: "⚠ Kontakt",
        value: `Beleg geht per contact_id an „${warning.contactName}" (${warning.contactId}) — auf der Rechnung steht „${warning.extractedName}"`,
      };
    case "category-history":
      return { title: "Buchungskategorie", value: `${warning.name} (${warning.basis})` };
    case "category-ambiguous":
      return {
        title: "⚠ Buchungskategorie",
        value:
          `dieser Lieferant wurde bisher auf mehrere Kategorien gebucht (${warning.candidates.join(", ")}) — wähle anhand ` +
          "des Dokumentinhalts eine davon und übergib sie als category; ist der Inhalt nicht eindeutig, frage den Nutzer. " +
          "Ohne Wahl wird der Beleg ohne Kategorie erfasst",
      };
    case "category-no-history":
      return {
        title: "⚠ Buchungskategorie",
        value:
          "keine gebuchten Belege dieses Lieferanten als Vorlage — sieh mit dem Lese-Tool unter /posting-categories nach, " +
          "wähle eine fachlich passende Kategorie und übergib sie als category; bei Unsicherheit frage den Nutzer. Ohne Wahl " +
          "wird der Beleg ohne Kategorie erfasst",
      };
    case "category-split":
      return {
        title: "⚠ Buchungskategorie",
        value:
          `gebuchte Belege dieses Lieferanten sind innerhalb eines Belegs auf mehrere Kategorien aufgeteilt ` +
          `(${warning.candidates.join(", ")}) — eine Einzelwahl wäre falsch. Teile den Beleg anhand des Dokumentinhalts auf: ` +
          "eine tax_group je Kategorie (auch bei gleichem Steuersatz), jeweils mit category. Ist die Aufteilung nicht " +
          "ableitbar, frage den Nutzer; ohne Aufteilung wird der Beleg ohne Kategorie erfasst",
      };
    case "category-deviation":
      return {
        title: "⚠ Buchungskategorie",
        value: `„${warning.chosen}" weicht von der bisher üblichen Kategorie dieses Lieferanten ab („${warning.usual}")`,
      };
  }
}
