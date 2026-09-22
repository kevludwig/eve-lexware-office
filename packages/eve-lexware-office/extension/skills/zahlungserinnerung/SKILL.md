---
description: Überfällige Rechnungen freundlich erinnern — eine Zahlungserinnerung per Mail mit der Rechnung im Anhang, nach Freigabe.
---

# Zahlungserinnerung

Ziel: Zu jeder überfälligen Rechnung, um die es geht, geht **eine** freundliche
Erinnerung per E-Mail raus, mit der Rechnung als PDF im Anhang. Den Text gibt
das Tool fest vor; du wählst nur die Rechnung.

Die Tools dieser Anleitung heißen im Agenten mit dem Präfix der Einbindung,
z.B. `lexware__send_payment_reminder`.

## Woher die Rechnungen kommen

- **Prüfauftrag** („prüf die Zahlungserinnerungen", „wer muss erinnert werden?")
  oder ein automatischer Lauf: Rufe `due_payment_reminders` auf. Zu jeder
  Rechnung unter `due` bereitest du eine Erinnerung vor, mit den Werten
  unverändert. Die unter `not_yet` nennst du nur kurz mit Grund (und dem Link,
  falls eine Freigabe schon woanders wartet). Ist `due` leer, sag das.
- **Auftrag zu einer Rechnung** („erinnere Müller an die offene Rechnung"):
  Suche sie mit dem Lese-Tool unter `/voucherlist` mit
  `voucherType: "invoice", voucherStatus: "overdue"`. Dort stehen `id`,
  `voucherNumber`, `contactName`, `openAmount` und `dueDate` (nur das Datum,
  `yyyy-MM-dd`). Ist die Rechnung nicht eindeutig, frag nach.

## Ablauf

1. Rufe `send_payment_reminder` für jede Rechnung genau einmal auf — bei
   mehreren alle im selben Schritt, damit die Freigaben zusammen erscheinen.
2. Lehnt das Tool ab, weil die Werte nicht passen, rufe es mit den genannten
   Werten erneut auf. Ist die Rechnung nicht mehr überfällig, melde das.
3. Hinweise auf der Karte (Testmodus, schon erinnert, früh) entscheidet der
   Nutzer. Erwähne sie kurz.
4. Danach meldest du je Rechnung: verschickt an wen, oder abgebrochen.

Schreibe keine eigene Mail und erfinde keine Beträge oder Fristen.
