# @kevludwig/eve-lexware-office

An [eve](https://eve.dev) extension for [Lexware Office](https://www.lexware.de/lexware-office/) (formerly lexoffice): an agent reads the account, creates customers and documents, captures purchase invoices, and sends payment reminders — every write behind a human approval, with the checks already done.

Built on [`@kevludwig/lexware-office`](../lexware-office), which holds the API client and the rules.

```bash
npm install @kevludwig/eve-lexware-office @kevludwig/lexware-office zod
```

Node 24 or newer, eve 0.77 or newer, zod 4 (a peer dependency, so the schemas the extension exports are your zod's).

## Mount it

```ts
// agent/extensions/lexware.ts
import lexware from "@kevludwig/eve-lexware-office";

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
| `create_quotation` | A quotation as written by hand: positions with a `description`, `type: "text"` headings, `optional` positions outside the total, `alternatives` to a position, `introduction` and `remark`. Finalized on creation, so it gets its number — or a draft with `draft: true`. | yes |
| `create_order_confirmation` | An order confirmation, optionally following a quotation (`quotation_id`). Descriptions, headings and texts as on a quotation, no optional positions; service or delivery date and `delivery_terms`. Finalized, or a draft with `draft: true`. Lexware Office does not chain it to a quotation with optional positions. | yes |
| `create_invoice` | An outgoing invoice, optionally following a quotation or order confirmation. Descriptions, headings and texts as above, service date or period, `title`, and a Leitweg-ID override. **Always a draft** — you finalize and send it in Lexware Office. | yes |

| `create_purchase_invoice` | A purchase invoice as a voucher, with the original attached, amounts per tax rate, and the posting category. Foreign currency is booked with the amount actually debited. | yes |
| `send_payment_reminder` | One friendly reminder by mail, with the invoice PDF attached. | yes |

The three sales document tools take the document's other writable fields too: `voucher_date`, a payment term (`payment_term_days`, optional `payment_term_label` and `cash_discount`), `total_discount_percent` or `total_discount_amount`, `discount_percent` per position, `tax_type` (net, gross with `gross_price`, and the vat-free types such as `externalService13b`) with `tax_sub_type` and `tax_note`, `language`, `print_layout` (name or id), and `article_id` per position. Service date and period (`service_date`, `service_period`, `delivery_date`, `delivery_period`, `no_service_date`) exist on order confirmations and invoices only — the API has none on quotations. Left out, Lexware Office's defaults apply: delivery on the voucher date, the contact's payment term or else the account's, net taxation. The card shows each of these, warns about an invoice without a service date (§ 14 (4) No. 6 UStG), names the account's default payment term when none is given, and checks a vat-free tax type against the customer's VAT ID, country, and the account.

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
| `decide` | — | `({ tool, input, warnings, findings, context })` → `"ask"`, `"approve"`, or `{ deny }` — a rule instead of a person, after the checks. See [Deciding without a person](#deciding-without-a-person). |
| `canApprove` | the requester only | `(responder, context) => boolean` — who may approve a write or cancel it. See [Who may approve](#who-may-approve). |
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

### Who may approve

`canApprove(responder, context)` runs for Approve and for Cancel. `responder` is the principal who answered. `context` is eve's `ApprovalResponseContext` (from `eve/tools/approval`):

- `context.session.initiator` — who started the session, `null` if anonymous
- `context.request.principal` — whose turn requested the call, `null` if anonymous
- `context.response.decision` — `"approve"` or `"cancel"`
- `context.request.toolName`, `context.request.toolInput`, `context.session.id`

A `canApprove` that reads only `responder` keeps working. To require that the approver owns the session:

```ts
import type { SessionAuthContext } from "eve/context";

const same = (a: SessionAuthContext, b: SessionAuthContext) =>
  a.authenticator === b.authenticator && a.issuer === b.issuer && a.principalType === b.principalType && a.principalId === b.principalId;

export default lexware({
  // …
  canApprove: (responder, { session }) => session.initiator !== null && same(responder, session.initiator) && isTeamMember(responder),
});
```

Without `canApprove`, the extension follows eve's default for tools without a response policy: only the principal whose turn requested the call (`context.request.principal`) may approve or cancel it, compared by `authenticator`, `issuer`, `principalType` and `principalId`. A call requested by an unauthenticated or anonymous caller stays open to anyone who can answer in the session. A `canApprove` replaces this default entirely.

To let anyone who can answer in the session approve, as before 0.4.0:

```ts
export default lexware({
  // …
  canApprove: () => true,
});
```

## Deciding without a person

`decide` runs after a writing tool's checks, only when the tool would ask a person. `tool` is the tool's own name (`send_payment_reminder`), `input` what the model passed, `warnings` the typed findings and `findings` the same as the card shows them, `context` eve's approval context (session, caller, call id).

```ts
export default lexware({
  // …
  async decide({ tool, input, warnings, context }) {
    if (tool !== "send_payment_reminder" || warnings.length > 0) return "ask";
    if (context.session.auth.current?.attributes?.origin !== "schedule") return "ask";
    await recordRuleApproval(context.callId, "first reminder, no findings"); // your protocol
    return "approve";
  },
});
```

Return `"ask"` for the card, `"approve"` to run without one, `{ deny: "reason" }` to refuse. What the tool's own checks refuse never reaches `decide`, and a `decide` that throws asks a person. The re-check right before writing runs either way.

A call `decide` approves never shows a card: it reaches neither `onApprovalCard` nor `canApprove` — no person answers it, so record it yourself before returning `"approve"`.

eve runs a tool's request policy again right before an approved call executes (its recheck). The tool's own checks run again then and may still refuse; `decide` and `onApprovalCard` do not — the extension marks each call in session state once a person was asked or `decide` approved it. Only where that state cannot be read (no eve session) can `decide` be called a second time for the same `context.callId`, so keep it idempotent: record an approval under the call id, not once per call of `decide`.

## Without eve: `./operations`

The customer and sales document writes also run without eve — for another surface on the same account, such as a remote MCP server whose writes wait on an approval page:

```ts
import { createLexwareClient } from "@kevludwig/lexware-office";
import {
  buildCard,
  executeApprovedSalesDocument,
  journalIn,
  orderConfirmationInputSchema,
  prepareSalesDocument,
  shownDuplicates,
  withSource,
} from "@kevludwig/eve-lexware-office/operations";

const client = createLexwareClient({ apiKey });
// An order confirmation names its quotation as `quotation_id`: withSource turns
// it into the source fields that prepare and execute read — pass the same value to both.
const input = withSource(orderConfirmationInputSchema.parse(args));
const warnings = await prepareSalesDocument(client, "order-confirmation", input);
const card = buildCard("create_order_confirmation", input, warnings);
if (!card) throw new Error("not one of the extension's writing tools");
// keep input and warnings with the pending action; after a person approves:
const shown = shownDuplicates(warnings);
await executeApprovedSalesDocument({ client, journal: journalIn(store) }, "order-confirmation", input, {
  id: actionId,
  shownOnCard: (url) => shown.includes(url),
  notes: () => card.findings.map((finding) => `${finding.title}: ${finding.value}`),
});
```

Quotations and invoices work the same without `withSource` (`quotationInputSchema`, `invoiceInputSchema`; an invoice's `source_document_id` is already the generic field). `buildCard` returns `null` for a tool name that is not one of the extension's writing tools. For customers, `prepareCustomer` returns `shownContactIds`; pass them to `executeApprovedCustomer` as they are (an array) or as a `Set`. `store` is any `JsonStore` from `@kevludwig/lexware-office`.

Nothing behind `./operations` loads eve, the mount's configuration or the Vercel Blob store — a server without eve installed can import it (a test checks this with eve made unresolvable). The checks it runs are the eve tools' checks; `decide`, `canApprove` and `onApprovalCard` are the mount's and do not apply here — whoever runs the approval page decides who may approve.

The same checks, card, journal and re-check as the eve tools. Keep the input unchanged between card and click — eve guarantees that per call, your store must.

## Tests

`npm test` runs 138 tests against a fake API — no account, no network. They run against the build (`pretest` builds it), so they test what a consumer installs.

## Not affiliated with Lexware

An independent open-source project, MIT licensed. Not made, endorsed, or supported by Haufe-Lexware or its group; the names are used only to say which API this speaks to.
