# Changelog

## 0.6.2

### Changed

- Declining a payment reminder whose card said "⚠ Früh" (asked for before the policy's first day) no longer rests the invoice for `declinedQuietDays`: it means "not yet". The invoice comes up again once it is due; its pending mark expires after `pendingValidHours`.

## 0.6.1

### Fixed

- `./operations` is free of eve, at runtime and in its type declarations: nothing it imports loads `eve/*`, the extension's configuration (`extension.ts`, the runtime), session state, or the Vercel Blob store. Findings and their texts, the card types, the sales checks and writes, and the purchase card's figures moved into modules of their own; the eve tools wrap them. A test imports `./operations` with eve made unresolvable.
- `decide` and `onApprovalCard` no longer run again on eve's recheck of an approved call (eve runs the request policy once more before the call executes). Each call is marked in session state once a person was asked or `decide` approved it; the tool's own checks still run on the recheck and may still refuse.
- `send_payment_reminder` marks a reminder as waiting only once a person is asked or `decide` approves it — a reminder `decide` refuses no longer shows up as „wartet schon“ in other conversations.
- `executeApprovedCustomer` takes `shownContactIds` as an array — as `prepareCustomer` returns them — or as a `Set`.
- Requires `@kevludwig/lexware-office` ^0.4.1 (published as a caret range): a 429 retry wait ends when the request's signal aborts.

### Changed

- Invented example values in the `verkaufsbelege` and `eingangsrechnung` skills and in the `create_customer` and `send_payment_reminder` descriptions.
- README: the `./operations` example handles a `null` card and shows `withSource` for order confirmations; `decide` may be called twice where session state is unreadable (keep it idempotent); calls `decide` approves reach neither `onApprovalCard` nor `canApprove`.

- A recheck of an approved call (eve runs the request policy again) no longer overwrites the findings, shown contacts and bound targets of the card: a duplicate or similar contact that appeared between card and click still stops the write, and a payment reminder stays bound to the address the card showed.

## 0.6.0

### Added

- `decide` in the mount: `({ tool, input, warnings, findings, context }) => "ask" | "approve" | { deny }` answers a writing call after its checks, instead of a person — for rules such as "a first reminder up to a set amount runs by itself". It is asked only when the tool would otherwise show a card; what the tool's own checks refuse stays refused. A `decide` that throws asks a person. Record automatic approvals yourself.
- `@kevludwig/eve-lexware-office/operations`: the writes without eve, for another agent surface on the same account (e.g. a remote MCP server with an approval page). Input schemas and descriptions of the customer and sales document tools, `prepareCustomer` / `prepareSalesDocument` (the checks before the card), `buildCard`, `describeWarning`, `executeApprovedCustomer` / `executeApprovedSalesDocument` (the approved write with journal and re-check), `journalIn(store)`, `shownDuplicates`, and the read tool's allowlist as `readAccount` with `readInputSchema`. Nothing in it reads the mount's configuration or eve's session.

### Changed

- The customer and sales document tools run on these operations; their behaviour is unchanged.
- `zod` moved from dependencies to `peerDependencies` (`^4.5.4`), so the schemas the package exports are built with the consumer's zod. Install it alongside: `npm install @kevludwig/eve-lexware-office @kevludwig/lexware-office zod`.
- Requires `@kevludwig/lexware-office` 0.4.0.

## 0.5.0

### Added

- `create_invoice`, `create_order_confirmation` and `create_quotation` take the document's other fields: `voucher_date`; `payment_term_days` with optional `payment_term_label` and `cash_discount`; `total_discount_percent` or `total_discount_amount`; `tax_type` with `tax_sub_type` and `tax_note`; `language`; `print_layout` (name or id). Positions take `discount_percent`, `gross_price` (on `tax_type: "gross"`) and `article_id`; quotation positions take `alternatives`.
- Order confirmations and invoices take when the service is supplied: `service_date`, `service_period { from, to }`, `delivery_date`, `delivery_period`, or `no_service_date`. Order confirmations take `delivery_terms`, invoices `title` and `buyer_reference` (Leitweg-ID).
- The schemas check what crosses fields: one kind of service date, a period that does not end before it starts, real calendar days, one total discount, skonto within the payment term, 0 % on vat-free tax types, gross prices only on gross documents, validity not before the voucher date.
- The approval card shows the service date or period, the payment term (on an invoice with its due date), the tax type, total discount and line discounts, alternatives, voucher date, language, print layout, delivery terms and Leitweg-ID.
- New findings: a warning when an invoice has no service date (§ 14 (4) No. 6 UStG); the payment term that applies when none is given (the contact's, else the account's default, named — a warning when that is „sofort"); a print layout or article that does not exist; a vat-free tax type the customer's VAT ID, country or the account does not support.
- The result reports `shipping`, `paymentTerm`, `taxType`, and `voucherDate`, `totalDiscount` and `language` where set.

### Changed

- A quotation's default validity counts from its voucher date, and the card shows it.
- Tax rates 0, 5, 7, 16 and 19 % — other EU rates with `tax_sub_type`.
- The `verkaufsbelege` skill maps orders such as „Leistungszeitraum 16.09.–30.09.", „14 Tage netto" or „2 % Skonto" to the fields instead of the texts, documents the defaults, when to set a vat-free tax type, and what to take over from a source document.
- Requires `@kevludwig/lexware-office` 0.3.0.

## 0.4.0

### Breaking

- Without `canApprove`, only the principal whose turn requested the call (`context.request.principal`) may approve or cancel a write, as in eve's default for tools without a response policy. Responder and requester are compared by `authenticator`, `issuer`, `principalType` and `principalId`. A call requested by an unauthenticated or anonymous caller stays open to any responder, as in eve. Before, anyone who could answer in the session could approve. To keep that, pass `canApprove: () => true`. An explicit `canApprove` replaces the default as before.

## 0.3.0

### Changed

- Requires eve 0.77.0 or newer (peer `>=0.77.0`), built against it: eve 0.72 changed the tool capability extensions are built against.
- `canApprove` receives eve's approval response context as a second argument: `(responder, context) => boolean | Promise<boolean>`. `context.session.initiator` lets a mount require that the approver owns the session; `context.request.principal` is whose turn requested the call, `context.response.decision` is approve or cancel. A `canApprove` that reads only the responder works as before.

## 0.2.0

### Added

- `create_quotation`, `create_order_confirmation` and `create_invoice` take positions with a `description`, `type: "text"` lines for headings such as „Teil 1: Festpreis“ (no quantity or price), and `introduction` and `remark`. Without them, Lexware Office's default texts stay.
- `create_quotation` takes `optional: true` on a position: printed as „Optionale Position“, outside the total.
- `draft: true` on `create_quotation` and `create_order_confirmation` creates a draft instead of finalizing — for reading a long quotation in Lexware Office before it gets its number. Without it, both are finalized as before.
- The approval card lists the positions: headings as „▸“, a cut description per position, optional positions in a block of their own with their own total, whether introduction and remark are custom, and a draft in title, subtitle and note. The card stays within 3500 characters.
- A finding when an order confirmation follows a quotation with optional positions: Lexware Office does not chain the two, the confirmation is created without the link.

### Changed

- Duplicate check and the comparison with a source document count neither text lines nor optional positions.
- The result reports `status` („Entwurf“ or „festgeschrieben“), `positions` as the priced ones that count, and `optionalPositions` / `optionalNetTotal`.
- The `verkaufsbelege` skill explains descriptions, headings, optional positions, introduction and remark, and `draft`; an order confirmation from a quotation takes only the positions the customer ordered.
- Requires `@kevludwig/lexware-office` 0.2.0.
