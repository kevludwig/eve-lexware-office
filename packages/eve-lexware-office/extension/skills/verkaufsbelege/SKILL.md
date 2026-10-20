---
description: Angebot, Auftragsbestätigung oder Ausgangsrechnung für einen Kunden anlegen — inkl. Neukundenanlage und Suche nach Vorgängerbelegen in Lexware Office.
---

# Verkaufsbelege

Die Tools dieser Anleitung heißen im Agenten mit dem Präfix der Einbindung,
z.B. `lexware__create_quotation`.

Drei Tools, jedes autark nutzbar — es gibt keine Pflicht-Reihenfolge:

- `create_quotation` — Angebot, wird beim Anlegen **festgeschrieben**; mit
  `draft: true` als **Entwurf**.
- `create_order_confirmation` — Auftragsbestätigung, wird **festgeschrieben**;
  mit `draft: true` als Entwurf. Optional aus einem Angebot abgeleitet
  (`quotation_id`).
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
   Projekt („Beispiel"), suche zuerst den Kontakt mit diesem Namen.
2. Mit dem Lese-Tool (`read`) `/voucherlist` abfragen, mit
   `{ voucherType: "quotation", voucherStatus: "draft,open,accepted", contactId: "…", sort: "voucherDate,DESC", size: 10 }`
   — für ABs `voucherType: "orderconfirmation"`, Status `"draft,open"`.
3. **Genau ein plausibler Treffer**: verwenden und ansagen („Ich nehme Angebot
   AG2026-0001 vom 01.01., 1.000,00 EUR"). **Mehrere**: mit `ask_question`
   wählen lassen — je Option Belegnummer, Datum, Betrag. **Keiner**: sagen und
   fragen, ob der Beleg ohne Bezug entstehen soll.
4. Den Beleg mit dem Lese-Tool (`/quotations/{id}` bzw.
   `/order-confirmations/{id}`) lesen und die Positionen aus `lineItems`
   übernehmen: `name`, `description`, `quantity`, `unitName` → `unit`,
   `unitPrice.netAmount` → `net_price`, `unitPrice.taxRatePercentage` →
   `tax_rate`, `discountPercentage` → `discount_percent`. Zeilen mit
   `type: "text"` als `{ type: "text", name, description }`. Vom Beleg selbst
   übernimm, wenn der Auftrag nichts anderes sagt: `paymentConditions` →
   `payment_term_days` (+ `cash_discount`), `taxConditions.taxType` →
   `tax_type`, `totalPrice.totalDiscountPercentage` /
   `totalDiscountAbsolute` → `total_discount_percent` / `total_discount_amount`,
   und bei einer Rechnung aus einer AB deren `shippingConditions` (siehe unten). **AB aus Angebot**: nur die Positionen ohne
   `optional: true` übernehmen — eine optionale nur, wenn der Nutzer sie
   beauftragt hat, dann als normale Position (ohne `optional`). Hat das Angebot
   optionale Positionen, frag nach, welche beauftragt sind, falls der Auftrag
   es nicht sagt.
5. Die Quell-UUID mitgeben (`quotation_id` bzw. `source_document_id`) — das
   Tool prüft dann Kunde und Positionssumme gegen den Bezugsbeleg (optionale
   Positionen zählen auf keiner Seite) und verknüpft beide Belege in Lexware
   Office. Ausnahme: Ein Angebot mit optionalen Positionen verknüpft Lexware
   Office nicht mit einer AB — die AB entsteht dann ohne Belegkette, die Karte
   sagt es.

Übernommen werden **nur die Positionen** — nicht der `title` des Bezugsbelegs:
der Titel ist die gedruckte Überschrift, und eine AB mit dem Angebots-Titel
„Angebot" sieht für den Kunden wie ein zweites Angebot aus. `title` bleibt
leer, außer der Nutzer nennt einen Projektnamen.

Texte (Einleitung, Bemerkung, Positionsbeschreibungen) übernimmst du, passt
aber an, was nur im Angebot Sinn ergibt: „dieses Angebots" wird „dieses
Auftrags", eine Annahmefrist („sofern der Auftrag bis zum … erteilt wird")
entfällt, weil der Auftrag erteilt ist — der Rest des Satzes bleibt. Die Karte
nennt übersehene Stellen als „⚠ Angebotswortlaut" bzw. „⚠ Frist abgelaufen".

Positionen dürfen gegenüber dem Bezugsbeleg geändert, ergänzt oder gestrichen
werden, wenn der Auftrag das verlangt. Die Abweichung erscheint als Hinweis auf
der Freigabekarte — kündige sie an, damit klar ist, dass sie gewollt ist.

## Positionen

Jede Position: `name`, `quantity`, `unit`, `net_price` (netto!), `tax_rate`.
Defaults, wenn der Auftrag nichts sagt: `unit: "Stück"`, `tax_rate: 19`.
Dazu bei Bedarf:

- `discount_percent` — Rabatt auf die Position („10 % auf den Workshop").
- `article_id` — wenn die Position einen Artikel aus Lexware Office meint
  (`/articles`); Name, Menge, Preis trotzdem angeben.
- `alternatives` (nur Angebot) — Alternativen zu einer Position („Hosting S,
  alternativ M"), gedruckt darunter, nicht in der Summe.

Nennt der Auftrag Bruttopreise für Geschäftskunden, rechne auf netto um und
sage das an. Ist der Beleg selbst brutto gemeint (Privatkunde, „Endpreise
inkl. MwSt."), setze `tax_type: "gross"` und `gross_price` statt `net_price`.
Angebote sind 30 Tage ab Belegdatum gültig, wenn nichts anderes gesagt ist
(`valid_until` nur bei abweichendem Wunsch setzen).

Erfinde keine Positionen und keine Preise: Fehlen Positionen oder Preise im
Auftrag und gibt es keinen Bezugsbeleg, frage nach.

## Aufbau wie ein schriftliches Angebot

Liegt ein ausformuliertes Angebot vor (Dokument, Entwurf im Chat), bilde es
1:1 ab — Reihenfolge, Überschriften, Texte:

- **`description`** an einer Position: Leistungsumfang, „Enthalten“, „Nicht
  enthalten“, Annahmen — wörtlich aus der Vorlage. Zeilenumbrüche als `\n`,
  Markdown: `**fett**`, `__kursiv__`, Listen mit `- `. Höchstens 2000 Zeichen;
  ist ein Text länger, kürze nicht still — sag, welche Position, und frag, was
  wegfallen darf. Die Preiszeile der Vorlage („Festpreis · 100,00 €“) gehört
  nicht in die Beschreibung, sie steht in Menge und Preis.
- **Textpositionen** (`{ type: "text", name, description? }`) für
  Zwischenüberschriften wie „Teil 1: Festpreis“ und für erklärende Absätze
  zwischen Positionen. Ohne Menge, Preis, Steuer — sie zählen nicht zur Summe.
- **`optional: true`** (nur im Angebot) für Wahlleistungen, die die Vorlage
  „optional“ oder „nicht in der Summe“ nennt. Preis normal angeben; Lexware
  Office druckt sie als „Optionale Position“ ohne sie zu summieren. AB und
  Rechnung kennen keine optionalen Positionen.
- **`introduction`** (Einleitung über den Positionen, z.B. Ausgangslage und
  Ansatz) und **`remark`** (Schlussnotiz, z.B. Bedingungen, Zahlung,
  Annahme), je höchstens 2000 Zeichen. Nur setzen, wenn die Vorlage eigene
  Texte hat — weggelassen bleibt der Standardtext aus Lexware Office.
- **`draft: true`** bei langen Angeboten: Der Entwurf lässt sich in Lexware
  Office gegenlesen und anpassen, festgeschrieben wird dort. Empfiehl es von
  dir aus, wenn das Angebot Beschreibungen über mehrere Positionen hat, und
  sag nach dem Anlegen, dass es noch festgeschrieben werden muss.

Die Summe der Vorlage (ohne optionale Positionen) muss mit der Summe der
bepreisten Positionen übereinstimmen — prüfe das vor dem Aufruf und nenne
Abweichungen.

## Belegdaten: Leistungsdatum, Zahlung, Steuer, Rabatt

Was der Auftrag dazu sagt, gehört **in die Felder** — nicht nur in
`introduction` oder `remark`. Lexware Office druckt die Felder als
Pflichtangaben und rechnet mit ihnen (Fälligkeit, Steuersatz); ein Satz im
Text tut beides nicht.

| Auftrag sagt | Feld |
|---|---|
| „Leistungszeitraum 16.09.–30.09.2026", „für September" | `service_period: { from: "2026-09-16", to: "2026-09-30" }` |
| „Leistung am 01.10.", „Workshop am 01.10." | `service_date: "2026-10-01"` |
| „geliefert am …" / „Lieferung 02.–06.11." (Ware) | `delivery_date` / `delivery_period` |
| „14 Tage netto", „zahlbar in 14 Tagen" | `payment_term_days: 14` |
| „sofort fällig", „zahlbar sofort" | `payment_term_days: 0` |
| „2 % Skonto bei Zahlung in 10 Tagen, 30 Tage netto" | `payment_term_days: 30`, `cash_discount: { percent: 2, days: 10 }` |
| „5 % Rabatt auf alles" / „100 EUR Nachlass" | `total_discount_percent: 5` / `total_discount_amount: 100` |
| „Rechnungsdatum 30.09." | `voucher_date: "2026-09-30"` |
| „auf Englisch", englischsprachiger Kunde | `language: "en"` (dazu ggf. `print_layout`) |
| „mit der Vorlage X" | `print_layout: "X"` (Name aus `/print-layouts`) |
| „Lieferung frei Haus" (nur AB) | `delivery_terms` — ohne Angabe druckt Lexware Office die Standard-Lieferbedingung des Kontos |

Leistungsdatum gibt es nur bei AB und Rechnung — ein Angebot hat keins. Ein
„Monat" heißt erster bis letzter Tag dieses Monats. Liegen Termine in der
Vergangenheit ohne Jahr, nimm das Jahr, das zum Belegdatum passt; ist es
unklar, frag.

**Defaults, wenn der Auftrag nichts sagt:**

- **Leistungsdatum**: nichts setzen — Lexware Office druckt dann „Lieferdatum
  = Belegdatum". Für eine Rechnung über eine Leistung, die nicht heute
  erbracht wurde, ist das falsch (§ 14 Abs. 4 Nr. 6 UStG): Geht das Datum aus
  dem Kontext hervor (Bezugsbeleg, Projektzeitraum, „für September"), setze es;
  sonst frage nach, bevor du die Rechnung anlegst. Die Karte warnt, wenn es
  fehlt.
- **Zahlungsziel**: nichts setzen — dann gilt die Zahlungsbedingung, die beim
  Kontakt in Lexware Office hinterlegt ist, sonst die Standard-
  Zahlungsbedingung des Kontos. Die Karte nennt den Konto-Standard; den des
  Kontakts kann die API nicht lesen. Ist der Konto-Standard „sofort" und der
  Auftrag nennt ein Ziel, setze es.
- **Steuerart**: `net` (19 %/7 % ausgewiesen). Ein Gesamtrabatt, der beim
  Kontakt hinterlegt ist, greift ohne eigenen Rabatt automatisch.
- **Belegdatum**: heute. **Sprache**: Deutsch. **Druckvorlage**: Standard.

**Steuerart** (`tax_type`) nur setzen, wenn der Fall es verlangt — dann jede
Position mit `tax_rate: 0`:

- `externalService13b` — Dienstleistung an ein Unternehmen im EU-Ausland
  (Reverse Charge). Kunde braucht USt-IdNr.
- `intraCommunitySupply` — Warenlieferung an ein Unternehmen im EU-Ausland.
  Kunde braucht USt-IdNr.
- `constructionService13b` — Bauleistung nach § 13b an ein Unternehmen mit
  USt-IdNr.
- `thirdPartyCountryService` / `thirdPartyCountryDelivery` — Dienstleistung /
  Ausfuhr in ein Nicht-EU-Land; beim Kontakt muss „Steuerfreie Rechnung
  erlauben" aktiv sein.
- `vatfree` — nur, wenn das Konto steuerbefreit oder Kleinunternehmer ist.
- `photovoltaicEquipment` — PV-Anlagen mit 0 %.

`tax_note` ersetzt den gedruckten Hinweis zur Steuerbefreiung (ohne Angabe der
Standard des Kontos). `tax_sub_type` nur bei Privatkunden im EU-Ausland
(Fernverkauf, elektronische Dienstleistungen). Bist du unsicher, ob ein Fall
steuerfrei ist, frag — rate keine Steuerart. Die Karte prüft USt-IdNr., Land
und Kontoeinstellung und warnt bei Widersprüchen.

`buyer_reference` (nur Rechnung) überschreibt die Leitweg-ID eines
XRechnungs-Kontakts; `""` macht daraus eine normale Rechnung. Sonst weglassen.

## Ablauf

1. Kunden auflösen, ggf. Vorgängerbeleg suchen (siehe oben).
2. In einem Satz ankündigen, was entsteht — Belegart, Kunde, Positionssumme,
   ggf. Bezugsbeleg, Leistungszeitraum und Zahlungsziel.
3. Tool aufrufen. Die Freigabekarte zeigt die Zahlen, Leistungsdatum,
   Zahlungsziel, Steuerart und Rabatte, und die Befunde der Vorprüfung
   (Dubletten, abweichender Bezugsbeleg, fehlendes Leistungsdatum, geltende
   Zahlungsbedingung, Steuerart-Voraussetzungen); dort entscheidet der
   Nutzer. Warnungen führen nicht zur Ablehnung — erwähne sie in der
   Ankündigung, wenn du sie schon kennst.
4. Nach Erfolg melden: Belegart und -nummer, Kunde, Positionen, Netto, ggf.
   optionale Positionen mit ihrer Summe und „gültig bis", bei AB und Rechnung
   Leistungsdatum bzw. -zeitraum und Zahlungsziel — mit Lexware Office-Link.
   Bei Angebot/AB dazu: festgeschrieben, Versand aus Lexware Office — oder,
   als Entwurf: gegenlesen und festschreiben in Lexware Office.
   Bei Rechnung: Entwurf, festschreiben in Lexware Office.

Mehrere Belege in einem Auftrag („Angebot und gleich die AB dazu") sind in
Ordnung: nacheinander, jeder mit eigener Freigabekarte, die AB mit der
`quotation_id` des eben angelegten Angebots.
