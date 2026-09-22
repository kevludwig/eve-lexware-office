# Lexware Office for TypeScript and eve

Two packages for the [Lexware Office](https://www.lexware.de/lexware-office/) Public API (formerly lexoffice):

| Package | What it is |
|---|---|
| [`@kevinludwig/lexware-office`](packages/lexware-office) | A typed client and the domain logic: contacts, vouchers, sales documents, posting categories, overdue receivables, payment-reminder rules. No agent, no framework. |
| [`@kevinludwig/eve-lexware-office`](packages/eve-lexware-office) | An [eve](https://eve.dev) extension built on it: tools, skills, and checks so an agent can read the account, create documents, and send payment reminders — every write behind a human approval. |

Use the library on its own for scripts and backends. Add the extension when an agent should do the work.

```bash
npm install @kevinludwig/lexware-office
npm install @kevinludwig/eve-lexware-office   # plus the library, for an eve agent
```

## The library in a minute

```ts
import { createLexwareClient, findOverdueInvoices, selectDueReminders, reminderLedger, memoryStore } from "@kevinludwig/lexware-office";

const client = createLexwareClient({ apiKey: process.env.LEXWARE_API_KEY! });

const overdue = await findOverdueInvoices(client);
const { due, held } = await selectDueReminders(client, reminderLedger(memoryStore(), "reminders"));
```

One client is one rate-limit queue: requests are spaced, a 429 is retried once. Functions take the client first, so several accounts are several clients.

## The extension in a minute

```ts
// agent/extensions/lexware.ts
import lexware from "@kevinludwig/eve-lexware-office";

export default lexware({
  apiKey: process.env.LEXWARE_API_KEY!,
  reminders: { mode: "test", ownerEmail: "you@example.com", sendMail: async (mail) => { /* your mailer */ } },
});
```

The mount's file name is the namespace: tools arrive as `lexware__read`, `lexware__create_invoice`, `lexware__send_payment_reminder`, and so on. `examples/agent` is a complete agent that mounts it with in-memory records and a logging mailer.

## What it does not do

- It never finalizes or sends a sales document. Quotations and order confirmations are written as finished documents because Lexware Office assigns their number on creation; **invoices stay drafts** — you check and send them in Lexware Office.
- It never writes without approval. Every writing tool asks first, and the card carries what the checks found: duplicates, totals that do not add up, the customer as the account really knows them.
- It reads only what the API key allows. Missing permissions surface as the API's 403, not as a guess.

## Development

```bash
pnpm install
pnpm build      # library to dist/, extension to dist/extension/
pnpm typecheck
pnpm test       # 100 tests, no network: a fake API answers every request
```

Node 24, pnpm workspaces. The tests run without a Lexware Office account.

## Not affiliated with Lexware

An independent open-source project. Not made, endorsed, or supported by Haufe-Lexware or its group. "Lexware", "Lexware Office", and "lexoffice" are trademarks of their respective owners and are used here only to say which API these packages speak to.

MIT licensed. Use of the Lexware Office API is subject to Lexware's own terms; you bring your own key.
