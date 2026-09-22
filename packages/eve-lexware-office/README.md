# @kevinludwig/eve-lexware-office

An [eve](https://eve.dev) extension for [Lexware Office](https://www.lexware.de/lexware-office/) (formerly lexoffice): an agent reads the account, creates customers and documents, captures purchase invoices, and sends payment reminders — every write behind a human approval, with the checks already done.

Built on [`@kevinludwig/lexware-office`](../lexware-office), which holds the API client and the rules.

```bash
npm install @kevinludwig/eve-lexware-office @kevinludwig/lexware-office
```

Node 24 or newer, eve 0.63 or newer.

## Mount it

```ts
// agent/extensions/lexware.ts
import lexware from "@kevinludwig/eve-lexware-office";

export default lexware({
  apiKey: process.env.LEXWARE_API_KEY!,
  reminders: {
    mode: "test",
    ownerEmail: "you@example.com",
    sender: { name: "Beispiel GmbH", legal: ["Beispiel GmbH, Musterstraße 1, 12345 Musterstadt"] },
    async sendMail(mail) {
      // your mailer: mail.to, mail.cc, mail.subject, mail.html, mail.attachments
    },
  },
});
```

The file name is the namespace: this mount gives the agent `lexware__read`, `lexware__create_invoice`, `lexware__send_payment_reminder`, and the skills `lexware__verkaufsbelege`, `lexware__eingangsrechnung`, `lexware__zahlungserinnerung`. A file called `buchhaltung.ts` would prefix everything with `buchhaltung__` instead.

`examples/agent` in this repository is a complete agent that mounts the extension with in-memory records and a mailer that only logs.

## Tools

| Tool | What it does | Approval |
|---|---|---|
| `read` | One tool for the readable endpoints: contacts, articles, voucher list, single documents, posting categories, payment conditions, profile, countries. Writes nothing. | no |
| `due_payment_reminders` | Which overdue invoices are due for a reminder right now, and why the others are not. Reads only. | no |
| `create_customer` | A customer contact — name and address required. | yes |
| `create_quotation` | A quotation. Finalized on creation, so it gets its number. | yes |
| `create_order_confirmation` | An order confirmation, optionally following a quotation (`quotation_id`). Finalized. | yes |
| `create_invoice` | An outgoing invoice, optionally following a quotation or order confirmation. **Always a draft** — you finalize and send it in Lexware Office. | yes |
| `create_purchase_invoice` | A purchase invoice as a voucher, with the original attached, amounts per tax rate, and the posting category. Foreign currency is booked with the amount actually debited. | yes |
| `send_payment_reminder` | One friendly reminder by mail, with the invoice PDF attached. | yes |

The agent-facing texts — tool descriptions, skills, cards — are **German**.

## Approvals and findings

A writing tool checks before it asks, and the card carries what the checks found: the customer as the account really knows them, a document with the same net total, a purchase invoice with that number already captured, tax groups that miss the invoice total, a total discount the source document had, a posting category that deviates from this vendor's history, a reverse-charge category meeting an invoice that charges VAT, an attachment that is no longer readable.

Two things follow from that:

- **The model cannot skip a finding.** The checks run server-side in the approval policy, and their results live in session state under the call id — there is no "acknowledged" field in any schema.
- **What a better call could fix goes back once.** Totals that do not add up, or an ambiguous category, are denied the first time with the reason; if the same call comes back unchanged, the user decides at the card.

Between card and click, hours can pass, so every writing tool checks again immediately before it writes. A document that appeared in the meantime and was *not* on the card stops the write; one that was on the card is a decision already taken. A step that runs again after a crash finds its journal entry and does not create twice.

## Configuration

| Field | Default | What for |
|---|---|---|
| `apiKey` | — | Public API key. Not needed when you pass `client`. |
| `client` | — | A `LexwareClient` your own code already uses: one client, one rate-limit queue. |
| `baseUrl`, `appUrl` | the API and app URLs | Only for another environment. |
| `storage.store` | Vercel Blob | Where journal, reminder records, and send claims live. Any `JsonStore`. |
| `storage.prefix` | `lexware-office` | Key prefix inside the store. |
| `canApprove` | anyone in the session | `(responder) => boolean` — who may approve a write. |
| `onApprovalCard` | — | `(callId, card)` with the finished card: title, subtitle, facts, note, findings. For your own UI. |
| `conversationUrl` | — | `(sessionId) => string`, for "waits in another conversation". |
| `attachments` | — | A second source for an upload the sandbox lost: `{ read, size?, release? }`. |
| `onPurchaseCaptured` | — | `(purchase)` with the figures of an approved purchase invoice, before it is written. |
| `reminders.mode` | `test` | `test`: every reminder goes to `ownerEmail`, marked as a test. `live`: to the customer. |
| `reminders.ownerEmail` | — | Receives test reminders, and live ones in Cc. |
| `reminders.ccOwner` | `true` | Owner in Cc when live. |
| `reminders.policy` | see the library | Buffer days, payment term for invoices due immediately, and the rest. |
| `reminders.namespace` | `reminders/<mode>` | Keeps test and live records apart. |
| `reminders.sendMail` | — | Delivers the mail. Without it nothing is sent, and the card says so. |
| `reminders.render` | a German reminder | Builds subject and body. |
| `reminders.sender` | — | Name and legal lines under the default mail. |

Nothing reads the environment except the Blob store's own token — where the key, the mailer, and the approval rule come from is the mount's decision.

## Tests

`npm test` runs 62 tests against a fake API — no account, no network. They run against the build (`pretest` builds it), so they test what a consumer installs.

## Not affiliated with Lexware

An independent open-source project, MIT licensed. Not made, endorsed, or supported by Haufe-Lexware or its group; the names are used only to say which API this speaks to.
