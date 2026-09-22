---
description: Angebot, Auftragsbestätigung oder Ausgangsrechnung für einen Kunden anlegen — inkl. Neukundenanlage und Suche nach Vorgängerbelegen in Lexware Office.
---

# Verkaufsbelege

Die Tools dieser Anleitung heißen im Agenten mit dem Präfix der Einbindung,
z.B. `lexware__create_quotation`.

Drei Tools, jedes autark nutzbar — es gibt keine Pflicht-Reihenfolge:

- `create_quotation` — Angebot, wird beim Anlegen **festgeschrieben**.
- `create_order_confirmation` — Auftragsbestätigung, wird **festgeschrieben**.
  Optional aus einem Angebot abgeleitet (`quotation_id`).
- `create_invoice` — Rechnung, entsteht immer als **Entwurf**. Optional aus
  Angebot oder AB abgeleitet (`source_document_id` + `source_document_type`).

Dazu `create_customer` für Neukunden. Versendet wird ausschließlich aus
Lexware Office — du legst Belege an, mehr nicht.

## Kunden auflösen

Jeder Beleg braucht `customer_number` **oder** `contact_id`. Nenne der Auftrag
einen Namen, suche mit dem Lese-Tool (`read`):
`/contacts` mit `{ name: "…", customer: true }`.

- **Genau ein Treffer**: verwenden, im Ankündigungssatz mit Namen nennen.
- **Mehrere Treffer**: mit `ask_question` wählen lassen (Name + Kundennummer je
  Option). Nie raten — ein Beleg am falschen Kunden ist der teurere Fehler.
- **Kein Treffer**: Neukunde. Pflicht sind Name (Firma oder Person) **und**
  Rechnungsadresse (Straße, PLZ, Ort); E-Mail ist optional, aber fürs Versenden
  aus Lexware Office nützlich. Fehlt davon etwas im Auftrag, frage es mit
  `ask_question` ab — **eine** Frage für alles Fehlende, nicht drei einzelne.
  Dann `create_customer`, und mit der zurückgegebenen `contactId` weiter.

## Vorgängerbeleg finden („die AB zum Angebot", „die Rechnung zur AB")

Bezieht sich der Auftrag auf einen bestehenden Beleg, such ihn — frag nicht nach
der Nummer, wenn du sie selbst finden kannst:

1. Kunden auflösen (siehe oben). Nennt der Auftrag statt eines Kunden ein
   Projekt („Nordlicht"), suche zuerst den Kontakt mit diesem Namen.
2. Mit dem Lese-Tool (`read`) `/voucherlist` abfragen, mit
   `{ voucherType: "quotation", voucherStatus: "draft,open,accepted", contactId: "…", sort: "voucherDate,DESC", size: 10 }`
   — für ABs `voucherType: "orderconfirmation"`, Status `"draft,open"`.
3. **Genau ein plausibler Treffer**: verwenden und ansagen („Ich nehme Angebot
   AG20260001 vom 10.08., 3.034,50 EUR"). **Mehrere**: mit `ask_question`
   wählen lassen — je Option Belegnummer, Datum, Betrag. **Keiner**: sagen und
   fragen, ob der Beleg ohne Bezug entstehen soll.
4. Den Beleg mit dem Lese-Tool (`/quotations/{id}` bzw.
   `/order-confirmations/{id}`) lesen und die Positionen aus `lineItems`
   übernehmen: `name`, `quantity`, `unitName` → `unit`,
   `unitPrice.netAmount` → `net_price`, `unitPrice.taxRatePercentage` →
   `tax_rate`.
5. Die Quell-UUID mitgeben (`quotation_id` bzw. `source_document_id`) — das
   Tool prüft dann Kunde und Positionssumme gegen den Bezugsbeleg und
   verknüpft beide Belege in Lexware Office.

Übernommen werden **nur die Positionen** — nicht der `title` des Bezugsbelegs:
der Titel ist die gedruckte Überschrift, und eine AB mit dem Angebots-Titel
„Angebot" sieht für den Kunden wie ein zweites Angebot aus. `title` bleibt
leer, außer der Nutzer nennt einen Projektnamen.

Positionen dürfen gegenüber dem Bezugsbeleg geändert, ergänzt oder gestrichen
werden, wenn der Auftrag das verlangt. Die Abweichung erscheint als Hinweis auf
der Freigabekarte — kündige sie an, damit klar ist, dass sie gewollt ist.

## Positionen

Jede Position: `name`, `quantity`, `unit`, `net_price` (netto!), `tax_rate`.
Defaults, wenn der Auftrag nichts sagt: `unit: "Stück"`, `tax_rate: 19`.
Nennt der Auftrag Bruttopreise, rechne auf netto um und sage das an. Angebote
sind 30 Tage gültig, wenn nichts anderes gesagt ist (`valid_until` nur bei
abweichendem Wunsch setzen).

Erfinde keine Positionen und keine Preise: Fehlen Positionen oder Preise im
Auftrag und gibt es keinen Bezugsbeleg, frage nach.

## Ablauf

1. Kunden auflösen, ggf. Vorgängerbeleg suchen (siehe oben).
2. In einem Satz ankündigen, was entsteht — Belegart, Kunde, Positionssumme,
   ggf. Bezugsbeleg.
3. Tool aufrufen. Die Freigabekarte zeigt die Zahlen und die Befunde der
   Vorprüfung (Dubletten, abweichender Bezugsbeleg); dort entscheidet der
   Nutzer. Warnungen führen nicht zur Ablehnung — erwähne sie in der
   Ankündigung, wenn du sie schon kennst.
4. Nach Erfolg melden: Belegart und -nummer, Kunde, Positionen, Netto, ggf.
   „gültig bis" — mit Lexware Office-Link. Bei Angebot/AB dazu: festgeschrieben,
   Versand aus Lexware Office. Bei Rechnung: Entwurf, festschreiben in Lexware Office.

Mehrere Belege in einem Auftrag („Angebot und gleich die AB dazu") sind in
Ordnung: nacheinander, jeder mit eigener Freigabekarte, die AB mit der
`quotation_id` des eben angelegten Angebots.
