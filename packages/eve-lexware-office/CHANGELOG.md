# Changelog

## 0.10.0

### Achtung beim Update

- **Document links change** (with `@kevludwig/lexware-office` 0.6.0): links to sales documents — in results, on the card, and in `shownDuplicates(warnings)` — are now `#!/VoucherView/Order|Invoice|Quotation/<id>` instead of `#!/VoucherDetail/<id>`. `executeApprovedSalesDocument` asks `shownOnCard` with both forms, so an approval pending across the update still goes ahead at a duplicate its card showed. Code of your own that compares stored links — e.g. a pending action's `shownDuplicates` against a fresh search, or links saved in your records — must accept both forms or compare document ids.
- **A failed duplicate search now stops an approved write** (see Fixed). Consumers that sort failures into "unclear whether created" by the marker „nicht angelegt:" should treat „Die Dublettenprüfung ist fehlgeschlagen" and „Die Suche nach ähnlichen Kontakten ist fehlgeschlagen" as "nothing sent".

### Fixed

- A duplicate search that fails right before an approved write stops the write instead of being skipped: a 403, the rate limit (429, or 500 "rate limit exceeded" after the retries), any error. Nothing is sent and no journal entry is written; the error names the reason. The same for the second search for similar contacts before `create_customer` and the duplicate search before `create_purchase_invoice`.

### Added

- `customer_order_number` and `delivery_address` on `create_order_confirmation` and `create_invoice`. Both go into the introduction as fixed lines — „Ihre Bestellung Nr. …" first (en: „Your order no. …"), then „Lieferadresse: …" (en: „Delivery address: …"), then the own introduction; the 2000 characters count all of it. The card shows both, and says when they replace the account's default introduction.
- The duplicate check finds a document of the same customer naming the same order number, whatever its total („⚠ Dublette: … zur Bestellung Nr. … existiert bereits"). The approved write is journaled under customer and order number as well: a run after a timeout, or another approval of the same order whose card did not show the first document, returns that document (described as it is) instead of creating a second. A card that showed it was approved knowingly — then a second one is created. A draft deleted in Lexware Office is created again; a write Lexware refused (4xx) frees the order. With an order number, a duplicate check that could not read every candidate stops the write unless the card said so („⚠ Dublettenprüfung: unvollständig").
- „⚠ Artikelpreis" when a position's price differs from its article's (net, or gross on a gross document).
- For a vat-free tax type the country check takes the delivery address's country when one is given; the customer's VAT ID is checked for its member state's form and, for intra-community supplies and EU services, for not being German.
- `./operations`: `Operations.draftOnly` — quotations and order confirmations are created as drafts whatever `draft` says; `prepareSalesDocument(client, kind, input, { signal, draftOnly, checks })` (a signal as fourth argument still works) with the caller's own checks in the mount's `checks` signature; `buildCard(tool, input, warnings, { draftOnly })`; `Approved.warnings` — the articles as the card read them, not read again; `PrepareOptions`, `HOST_CHECK_FAILED`, `introductionOf`, `deliveryAddressLine`, `orderJournalId`; `JournalEntry.status` `"failed"`.
- The result of a sales document carries `customerOrderNumber` when one was given.
- „⚠ Lieferadresse" when the customer has a delivery address other than a billing one and the call names no `delivery_address`: Lexware Office does not print a contact's delivery address on an order confirmation or invoice (checked in print).
- „⚠ Zahlungsziel auf Deutsch" on an English document without `payment_term_days`: Lexware prints the account's default term in German (checked in print). With `payment_term_days`, the term is phrased in English.

### Changed

- Links to created documents are Lexware Office's own (`#!/VoucherView/Order|Invoice|Quotation/<id>`); duplicates on the card link the same way — see „Achtung beim Update".
- „⚠ Artikelpreis" now says that Lexware keeps the line's price — checked live for a net document with a service article.
- The articles a document references are read once, before the card; the eve tools hand them to the write. The card's „Artikel" line is now the finding `article-resolved` (same text).

## 0.9.0

### Added

- `checks` in the mount: `({ tool, input, signal }) => Warning[]` adds the host's own findings to `create_quotation`, `create_order_confirmation` and `create_invoice`, after the extension's — on the card, in `onApprovalCard`, in `decide`'s `warnings` and `findings`, and in the result. It runs once per call, before the card; eve's recheck keeps the findings the card showed. A check that throws or returns no list of findings is logged and adds „⚠ Zusatzprüfung: fehlgeschlagen"; the call goes on.
- The result of an approved quotation, order confirmation or invoice carries the Lexware contact id as `contactId`, next to `contactName` — to link the document to your own records.
- `./operations`: the types `SalesChecks`, `SalesCheckCall`, `SalesTool`, `QuotationInput`, `OrderConfirmationInput` and `InvoiceInput`.

### Changed

- The card numbers optional positions as Lexware Office prints them: regular positions 1…n, optional ones „O1.", „O2." … (was „Optional 3." continuing the regular numbering). An alternative names its position the same way.

## 0.8.1

### Fixed

- A `decide` that denies on eve's recheck stops the call: after a person approved the card, `decide` runs again right before the write, so a rule switched off between card and click no longer lets the call through. Only a deny counts then; `"ask"`, `"approve"` or a throw keep the approval, and the findings stay those the card showed.

### Added

- `recheck` on the call `decide` receives: true on that second run.

## 0.8.0

### Changed

- Requires eve 0.88 or newer: built with eve 0.88, whose session stream uses v27 facts. eve 0.84 and later no longer load extensions built for 0.83.
- `onApprovalCard` is called on `interaction.opened` for approvals (was `input.requested`); tool name and input come from the session view.
- A declined payment reminder is recorded on `call.settled` with outcome `rejected` (was `action.result` with status `rejected`), whether a person or a policy denied it.
- `canApprove` receives `response.decision` as `"approve"` or `"deny"` (eve renamed `"cancel"` to `"deny"`).

## 0.7.1

### Changed

- Built with eve 0.83, which requires eve 0.83 or newer (state contract v16). eve 0.83 no longer loads extensions that require state contract v13, the one 0.7.0 and earlier were built with.

## 0.7.0

### Added

- `update_customer`: changes a customer by `customer_number` or `contact_id` — only the fields given, `null` removes, groups merged field by field. The card lists each field with its old and new value; the approved write goes out with the version the card showed and stops ("Abgebrochen") when the contact was edited since. Contacts the API will not update (more than one address, contact person or entry per type), an unknown customer number, and a change that changes nothing are refused before a card.
- `create_customer` takes every writable field of the contacts endpoint: `tax_number`, `vat_id`, `allow_tax_free_invoices` and `contact_person` (salutation, names, email, phone, `on_documents` — default yes) for a company; `salutation` for a person; `address_supplement`, `shipping_address`, `xrechnung` (Leitweg-ID and vendor number), email addresses and phone numbers per type, and `note`. Person fields on a company and company fields on a person are refused by the schema.
- The customer card shows contact person, shipping address, tax fields, XRechnung, every email address and phone number, and the note.
- `./operations`: `customerUpdateInputSchema`, `prepareCustomerUpdate`, `executeApprovedCustomerUpdate`, `customerChangesOf`, `CONTACT_FIELD_LABEL`, and the descriptions `customerDescription` and `customerUpdateDescription`.
- Finding `contact-change` (a field with its old and new value).

### Changed

- `create_customer`'s description says that a company's person is its contact person, never `first_name`/`last_name`, and that `update_customer` changes an existing customer. The `verkaufsbelege` skill explains creating and changing customers.
- Needs `@kevludwig/lexware-office` 0.5.0.

## 0.6.3

### Added

- An order confirmation's card names text copied from a quotation that only fits the quotation: „⚠ Angebotswortlaut“ where title, introduction, remark, delivery terms or a line item still say „Angebot“, and „⚠ Frist abgelaufen“ for a „bis (zum) dd.mm.yyyy“ before the voucher date, such as an acceptance deadline.
- `verkaufsbelege` skill: an order confirmation from a quotation adapts quotation-only wording („dieses Angebots“ → „dieses Auftrags“, no acceptance deadline); without `delivery_terms` Lexware Office prints the account's default delivery terms.

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
