# @kevludwig/lexware-office

A typed client and the domain logic for the [Lexware Office](https://www.lexware.de/lexware-office/) Public API (formerly lexoffice): contacts, vouchers, sales documents, posting categories, overdue receivables, and the rules behind payment reminders.

No framework, no agent, no environment variables — you pass the key, the store, and the mailer. For an agent, see [`@kevludwig/eve-lexware-office`](../eve-lexware-office).

```bash
npm install @kevludwig/lexware-office
```

Node 24 or newer, ESM only.

## The client

```ts
import { createLexwareClient } from "@kevludwig/lexware-office";

const client = createLexwareClient({ apiKey: process.env.LEXWARE_API_KEY! });
```

One client is one rate-limit queue: requests are spaced (the API allows two per second), a 429 waits and is retried once, and each request has a time limit that starts when it actually fires. Several accounts are several clients — every function takes the client as its first argument.

| Option | Default | What for |
|---|---|---|
| `apiKey` | — | Public API key, from Lexware Office under "Erweiterungen → Public API" |
| `baseUrl` | `https://api.lexware.io/v1` | The old `api.lexoffice.io/v1` still works |
| `appUrl` | `https://app.lexware.de` | Base of the links `voucherUrl()` builds |
| `minSpacingMs` | `550` | Spacing between two requests |
| `timeoutMs` | `20000` | Per request, counted from when it fires |
| `rateLimitBackoffMs` | `1000` | Wait before the retry after a 429 |
| `fetch` | global `fetch` | Your own implementation, e.g. in tests |

A failed request throws `LexwareApiError` with `status` and `responseBody`; `describeError(error)` turns it into a sentence worth showing a person — a 403 says which permission the key lacks, a 406 what the API usually means by it.

## What is in it

**Contacts** — `getContact`, `findContactByNumber`, `findContactsByName`, `resolveContactByName` (exact name first, then the single candidate), `contactEmail`, `createCustomer`.

**Sales documents** — `createSalesDocument` for quotations, order confirmations, and invoices, with `finalize`, a total discount, and `precedingSalesVoucherId` for a document chain; `getSalesDocument` (line items, totals, discounts, customer), `invoiceExists`, `findRecentSalesDocuments`, `findDuplicateSalesDocument` (same net total, same customer, within a window), `isPursueRejection` for the 406 an unusable chain answers with.

**Purchase invoices** — `createVoucher`, `uploadVoucherFile` for the original, `findVouchers`, `findPurchaseInvoiceByNumber` for a document already captured, `findVendorCategoryHistory` for how this vendor's invoices were booked so far.

**Posting categories** — `listPostingCategories` (cached per client), `resolveCategory` by name or id and direction, `isReverseChargeCategory` for §13b.

**Receivables** — `findOverdueInvoices`, `findOverdueInvoice`, `downloadInvoicePdf`.

**Payment reminders** — the rules below.

**Money and dates** — `netTotal`, `round2`, `taxFromGross`, `taxFromNet`, the tolerances `ITEMS_TOTAL_TOLERANCE` and `DUPLICATE_TOTAL_TOLERANCE`, and `berlinDay`, `daysSince`, `addDays`.

## Payment reminders

`selectDueReminders` decides in code, not by judgment, which overdue invoices are due for a reminder:

```ts
import { defaultReminderMail, reminderLedger, selectDueReminders, sendReminder, vercelBlobStore } from "@kevludwig/lexware-office";

const ledger = reminderLedger(vercelBlobStore({ prefix: "lexware-office" }), "reminders/live");
const { due, held } = await selectDueReminders(client, ledger);

for (const { invoice, customerEmail } of due) {
  await sendReminder(
    client,
    ledger,
    { ...invoice, invoiceId: invoice.id, to: customerEmail, test: false },
    { render: defaultReminderMail({ name: "Beispiel GmbH" }), sendMail: yourMailer, owner: "nightly-run" },
  );
}
```

An invoice is offered when it is past its reminder due date by `minDaysOverdue`, has not been reminded, is not waiting for a decision somewhere else, was not declined recently, and its customer has an address. An invoice "due immediately" — Lexware Office sets the due date to the invoice date — gets `immediatePaymentTermDays` first. Everything else comes back in `held`, each with the reason.

| Policy | Default | |
|---|---|---|
| `minDaysOverdue` | `3` | Buffer after the reminder due date |
| `immediatePaymentTermDays` | `14` | Payment term assumed for an invoice due immediately |
| `pendingValidHours` | `20` | How long a reminder waiting for approval blocks the invoice |
| `declinedQuietDays` | `7` | Quiet after a declined reminder |

`sendReminder` claims the send round in the ledger **before** the mail goes out, so "at most once per round" holds across parallel cards, a repeated schedule run, and a replayed step. If your mailer throws `MailNotSentError`, the claim is given back — anything else counts as possibly sent and stays claimed. The mail itself is yours: `sendMail` delivers it, `render` builds subject and body (the default is a friendly German reminder with the invoice PDF attached, signed by `sender`).

## Storage

The ledger needs somewhere to keep one small JSON record per invoice. `JsonStore` is four methods — `read`, `write`, `create` (which must fail when the key exists, that is what makes a claim a claim), `delete`:

- `memoryStore()` — tests and scripts.
- `vercelBlobStore({ prefix })` — Vercel Blob, needs `BLOB_READ_WRITE_TOKEN` (or a `token`). Imported from `@kevludwig/lexware-office/vercel-blob`, with `@vercel/blob` as an optional peer.
- Your own, for Redis, S3, Postgres, a file — whatever makes `create` atomic.

## Tests

`npm test` runs 38 tests against a fake API — no account, no network. `test/fake-api.ts` shows the pattern: routes answer by method and path, and every call is recorded.

## Not affiliated with Lexware

An independent open-source project, MIT licensed. Not made, endorsed, or supported by Haufe-Lexware or its group; the names are used only to say which API this speaks to.
