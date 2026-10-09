# Changelog

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
