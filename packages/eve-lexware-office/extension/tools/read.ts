import { describeError, query } from "@kevinludwig/lexware-office";
import { defineTool } from "eve/tools";
import { z } from "zod";

import { client } from "../lib/runtime";

/**
 * Read access to the Lexware Office API — one tool for the GET endpoints.
 * One tool, not one per endpoint: twenty schemas would cost context every
 * turn. Writes stay typed tools with checks and approval; this allowlist is
 * the line between reading and writing.
 */

const UUID = "[0-9a-fA-F-]{36}";

const READABLE: readonly RegExp[] = [
  new RegExp(`^/contacts(/${UUID})?$`),
  new RegExp(`^/articles(/${UUID})?$`),
  new RegExp(`^/vouchers/${UUID}$`),
  /^\/voucherlist$/,
  new RegExp(`^/invoices/${UUID}$`),
  new RegExp(`^/credit-notes/${UUID}$`),
  new RegExp(`^/delivery-notes/${UUID}$`),
  new RegExp(`^/down-payment-invoices/${UUID}$`),
  new RegExp(`^/dunnings/${UUID}$`),
  new RegExp(`^/order-confirmations/${UUID}$`),
  new RegExp(`^/quotations/${UUID}$`),
  new RegExp(`^/payments/${UUID}$`),
  new RegExp(`^/recurring-templates(/${UUID})?$`),
  new RegExp(`^/event-subscriptions(/${UUID})?$`),
  new RegExp(`^/files/${UUID}/status$`),
  /^\/posting-categories$/,
  /^\/payment-conditions$/,
  /^\/print-layouts$/,
  /^\/countries$/,
  /^\/profile$/,
];

/** Upper bound of a list in characters — a long voucher list would flood the context. */
const MAX_LIST_CHARS = 12_000;

/**
 * Upper bound of a single document. Higher: an order confirmation copies a
 * quotation's lines, and long line descriptions put a dozen lines past the
 * list bound — a cut document cannot be copied.
 */
const MAX_DOCUMENT_CHARS = 60_000;

export default defineTool({
  description:
    "Liest Daten aus Lexware Office: Kontakte, Artikel, Belegliste, einzelne Belege, Buchungskategorien, " +
    "Zahlungsbedingungen, Profil, Länder. Nur lesend. Nützlich, um eine Kundennummer aufzulösen, eine " +
    "Buchungskategorie zu finden oder zu prüfen, ob ein Beleg schon existiert.",
  inputSchema: z
    .object({
      path: z
        .string()
        .trim()
        .min(2)
        .max(200)
        .describe("Pfad ohne Basis-URL, z.B. '/contacts', '/voucherlist' oder '/posting-categories'. Nur lesende Endpunkte."),
      query: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
        .optional()
        .describe(
          "Query-Parameter, z.B. { number: 10001 } für /contacts oder { voucherType: 'invoice', voucherStatus: 'overdue' } " +
            "für /voucherlist — dort sind voucherType und voucherStatus Pflicht.",
        ),
    })
    .strict(),

  // No approval: reading changes nothing, and the key decides what is visible.

  async execute(input, ctx) {
    const path = input.path.startsWith("/") ? input.path : `/${input.path}`;
    if (path.includes("?")) return { error: `Query-Parameter gehören in das Feld \`query\`, nicht in den Pfad (${path}).` };
    if (!READABLE.some((pattern) => pattern.test(path))) {
      return {
        error:
          `${path} ist über dieses Tool nicht lesbar. Lesbar sind: /contacts, /articles, /voucherlist, /vouchers/{id}, ` +
          "/invoices/{id}, /credit-notes/{id}, /delivery-notes/{id}, /down-payment-invoices/{id}, /dunnings/{id}, " +
          "/order-confirmations/{id}, /quotations/{id}, /payments/{id}, /recurring-templates, /event-subscriptions, /files/{id}/status, " +
          "/posting-categories, /payment-conditions, /print-layouts, /countries, /profile.",
      };
    }
    try {
      return truncate(await client().request(`${path}${query(input.query ?? {})}`, { signal: ctx.abortSignal }));
    } catch (error) {
      // A result, not an exception: a 403 tells the model about the key's permissions.
      return { error: describeError(error) };
    }
  },
});

/** Cuts an oversized answer and says so — fewer entries must not read as "no more". */
function truncate(data: unknown): unknown {
  const rendered = JSON.stringify(data) ?? "";
  const isList = Boolean(data && typeof data === "object" && Array.isArray((data as { content?: unknown }).content));
  const max = isList ? MAX_LIST_CHARS : MAX_DOCUMENT_CHARS;
  if (rendered.length <= max) return data;
  if (isList) {
    const page = data as { content: unknown[] };
    const kept: unknown[] = [];
    let size = 0;
    for (const entry of page.content) {
      const length = (JSON.stringify(entry) ?? "").length + 1;
      if (size + length > max) break;
      kept.push(entry);
      size += length;
    }
    return {
      ...page,
      content: kept,
      _truncated: `Nur ${kept.length} von ${page.content.length} Einträgen gezeigt. Grenze über die Query-Parameter ein (size, voucherDateFrom).`,
    };
  }
  return { _truncated: `Antwort auf ${max} Zeichen gekürzt.`, data: rendered.slice(0, max) };
}
