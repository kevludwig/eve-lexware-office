# Changelog

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
