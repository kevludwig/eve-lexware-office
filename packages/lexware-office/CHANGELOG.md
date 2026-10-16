# Changelog

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
