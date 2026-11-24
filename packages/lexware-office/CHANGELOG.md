# Changelog

## 0.6.0

### Achtung beim Update

- **Sales document links change.** Created, read, listed and duplicate sales documents now link as Lexware Office does — `#!/VoucherView/Order|Invoice|Quotation/<id>` instead of `#!/VoucherDetail/<id>`. A consumer that stored such URLs to compare them later — e.g. the duplicates an approval card showed — no longer matches them by string: accept both forms or compare document ids (`@kevludwig/eve-lexware-office` 0.10 does that for its own approvals). `voucherUrl(id)` without a kind is unchanged and still opens any voucher.

### Added

- `findContactsByEmail(client, email, { customer, vendor, size })`: contacts with this email address in their own addresses or at a contact person — always a list of candidates. `_` and `%` are escaped (`escapeContactSearch`), so the address matches only itself; under `MIN_EMAIL_SEARCH_LENGTH` (3) characters no request is sent.
- `Contact.billingAddresses` and `Contact.shippingAddresses`: every address of the contact, in its order.
- `findArticles(client, { articleNumber, gtin, type }, { size })`: articles by number, GTIN/EAN or type (AND), mapped like `getArticle`; `Article.gtin`; `MAX_ARTICLE_PAGE_SIZE`.
- `NewSalesDocument.address` (`SalesAddressOverride`): name, supplement, street, zip, city and country for this one document instead of the contact's billing address; empty fields are not sent, a country that is not ISO 3166-1 alpha-2 is refused before sending.
- `customerOrderLine(orderNumber, language)` — „Ihre Bestellung Nr. …" / „Your order no. …" — and `customerOrderNumbersIn(text)` to read it back.
- `findDuplicateSalesDocument` takes `customerOrderNumber`: a candidate whose introduction names the same number is a match (`by: "order-number"`), whatever its total; a total match reports `by: "total"`. With an order number every checked candidate is read before a total match is reported — still at most `maxCandidates`.
- `getSalesDocument` returns `title` and `introduction`.
- `vatIdProblem`, `vatIdCountry`, `normalizeVatId`, `VAT_ID_PATTERNS`: the form of an EU VAT ID per member state, offline (no VIES).
- `isRateLimitError`, `isRateLimitBody`.
- `paymentTermLabel(days, discount, language)`: `"en"` phrases the term in English („Payable within 14 days without deduction"). Lexware does not translate a term on an English document. One day reads „1 day" / „1 Tag", also in a cash discount.
- `voucherUrl(id, kind)`: with a sales document's kind, the link Lexware Office itself uses — `#!/VoucherView/Order/<id>`, `…/Invoice/<id>`, `…/Quotation/<id>`; `VoucherLinkKind`, `MIN_ARTICLE_PAGE_SIZE`.

### Changed

- Sales documents (created, read, listed, duplicates) link with `VoucherView/…` instead of `VoucherDetail/<id>` — see „Achtung beim Update".
- `salesDocumentProblems` refuses an `address` override without `name` or `countryCode` — Lexware answers it with 406 "Name and countryCode are required address fields." (checked live).
- `findArticles` asks for at least 25 articles: the API refuses a smaller page with 406.
- A GET answered 500 with "rate limit exceeded" is retried like a 429 (the API documents both). Writes answered so are not sent again — the docs do not promise that they did not run. `describeError` adds a rate-limit hint to both — for a write answered 500, that it may have run and should be checked in Lexware Office before a retry.
- `salesDocumentProblems` refuses an introduction or remark over 2000 characters.

## 0.5.0

### Added

- `createCustomer` takes every writable field of the contacts endpoint: `company.taxNumber`, `company.vatRegistrationId` (spaces removed), `company.allowTaxFreeInvoices`, `company.contactPerson` (salutation, first and last name, `primary` — shown on vouchers —, email, phone), `person.salutation`, `shippingAddress`, `xRechnung` (`buyerReference`, `vendorNumberAtCustomer`), and `emailAddresses` / `phoneNumbers` with one entry per type. `email` and `phone` stay as shortcuts for the business entries.
- `getContactDetails` returns a contact with every documented property, typed as `ContactDetails`.
- `updateCustomer(client, id, changes, { expectedVersion })`: reads the contact, applies `CustomerChanges` field by field (left out keeps, `null` removes), and writes it back with its version. A contact changed since `expectedVersion` is not written; the error starts with "Abgebrochen".
- `planCustomerUpdate` returns the PUT body and the changed fields (`ContactChange`) without writing; `updateBlockers` names the lists with more than one entry, which the API does not update.
- `contactProblems` names what the API would reject — company and person together, a salutation over 25 or a note over 1000 characters, more than one contact person, address or entry per type, a country code that is not ISO 3166-1 alpha-2, a Leitweg-ID without the vendor number — and `createCustomer` throws on it before sending.
- `EMAIL_TYPES`, `PHONE_TYPES`, `MAX_SALUTATION_LENGTH`, `MAX_NOTE_LENGTH`.

## 0.4.2

### Added

- `ReminderPolicy.isPaymentDay`: a due date on a day it rejects moves to the next one it accepts (as § 193 BGB moves deadlines off weekends and holidays); reminder days are then counted from there. Not set, nothing changes.
- `germanPaymentDay` (weekdays without Germany's nationwide public holidays), `germanNationwideHolidays(year)` and `nextPaymentDay`.

## 0.4.1

### Fixed

- The wait between 429 retries ends as soon as the request's `signal` aborts, and the request rejects with the signal's reason — before, a cancelled call slept out `Retry-After` (up to 10 s per retry) first.

## 0.4.0

### Changed

- A request answered with 429 is sent again up to `rateLimitRetries` times (default 3, before: once). The wait follows the server's `Retry-After` (at most 10 s), else `rateLimitBackoffMs` times the attempt. This covers several clients on one account — serverless instances, a second app — that the per-client queue does not see.

## 0.3.0

### Added

- `createSalesDocument` takes every writable field of the sales document endpoints: `voucherDate`, `shippingConditions` (`service`, `serviceperiod`, `delivery`, `deliveryperiod`, `none`), `paymentConditions` (term, label, cash discount), `taxConditions` (`net`, `gross`, `vatfree`, the § 13b, intra-community, third-country and photovoltaic types, `taxSubType`, `taxTypeNote`), `totalDiscountPercentage`, `language`, `printLayoutId`, `deliveryTerms` (order confirmations) and `xRechnung.buyerReference` (invoices). The options are typed as `NewSalesDocument`.
- Line items take `discountPercentage`, `grossPrice` (sent on a `gross` document), an `article` reference (`service` or `material`), and on quotations `alternatives`, sent as alternative sub-items.
- `salesDocumentProblems` lists what the API would drop or reject — a field on the wrong kind, a period ending before it starts, a vat-free type with a rate above 0 %, a gross document without gross prices — and `createSalesDocument` throws on it before sending.
- `paymentTermLabel(days, discount?)` phrases a payment term as Lexware Office does.
- Account settings: `listPrintLayouts`, `resolvePrintLayout`, `listPaymentConditions`, `defaultPaymentCondition`, `getProfile`, `listCountries`, `getArticle`.
- `Contact` carries `isCompany`, `vatRegistrationId`, `allowTaxFreeInvoices` and the billing `countryCode`.
- `VALID_TAX_RATES`, `SALES_TAX_TYPES`, `isVatFreeTaxType`, `lineNet`; `SALES_TEXT_LIMITS.deliveryTerms`.

### Changed

- Quotations are sent without shipping conditions — the API documents none for them. Order confirmations and invoices without `shippingConditions` keep the default: delivery on the voucher date.
- `netTotal` and `getSalesDocument().lineItemsNet`, and with them the duplicate search, count a line's `discountPercentage`.

## 0.2.0

### Added

- Line items as a written document has them: `description` on any line (Markdown, max. 2000 characters), headings and paragraphs as `{ type: "text", name, description? }` without price, and `optional` lines on quotations — printed as „Optionale Position“, not part of the total.
- `createSalesDocument` takes `introduction` and `remark`. Left out, the account's default texts stay as before.
- `isPricedLine`, `countsToTotal` and `SALES_TEXT_LIMITS` (the API's text lengths).
- `getSalesDocument` returns `optionalItems` and `hasOptionalOrAlternative` — an order confirmation cannot be pursued from such a quotation (the API answers 406).

### Changed

- `LineItem` is now `PricedLineItem | TextLineItem`. Code that reads `quantity` or `netPrice` from a `LineItem` narrows with `isPricedLine` first.
- `getSalesDocument().lineItems` and `lineItemsNet`, and with them `findDuplicateSalesDocument`, leave out optional lines as well as text lines.
- `createSalesDocument` throws on an optional line outside a quotation instead of sending a flag the API does not document.
