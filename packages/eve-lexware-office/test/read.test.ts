/** The read tool: what it lets through, what it asks, and what it cuts. */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { on, useApi } from "./harness.ts";

const { default: read } = await import("../dist/extension/tools/read.mjs");

const run = (path: string, query?: Record<string, string | number | boolean>) =>
  read.execute({ path, query }, { abortSignal: undefined }) as Promise<Record<string, unknown>>;

describe("read", () => {
  it("answers a readable path from the API", async () => {
    const api = useApi(on("GET", /^\/contacts$/, () => ({ content: [{ id: "c1" }] })));
    const result = await run("/contacts", { number: 10001 });

    assert.deepEqual(result, { content: [{ id: "c1" }] });
    assert.equal(api.calls[0]?.query.get("number"), "10001");
  });

  it("refuses a path outside the allowlist, without calling the API", async () => {
    const api = useApi();
    const result = await run("/invoices");

    assert.match(String(result.error), /nicht lesbar/);
    assert.equal(api.calls.length, 0);
  });

  it("refuses a write endpoint even when it exists", async () => {
    useApi();
    assert.match(String((await run("/vouchers")).error), /nicht lesbar/);
  });

  it("sends query parameters through the query field, not the path", async () => {
    useApi();
    assert.match(String((await run("/contacts?number=1")).error), /Query-Parameter/);
  });

  it("turns an API error into a result the model can read", async () => {
    useApi(on("GET", /^\/profile$/, () => ({ message: "Forbidden" }), 403));
    assert.match(String((await run("/profile")).error), /403/);
  });

  it("cuts a long list and says how many entries are left", async () => {
    const entries = Array.from({ length: 200 }, (_, index) => ({ id: `v${index}`, note: "x".repeat(200) }));
    useApi(on("GET", /^\/voucherlist$/, () => ({ content: entries, totalElements: entries.length })));

    const result = await run("/voucherlist", { voucherType: "invoice", voucherStatus: "open" });
    const kept = result.content as unknown[];

    assert.ok(kept.length > 0 && kept.length < entries.length);
    assert.match(String(result._truncated), new RegExp(`Nur ${kept.length} von ${entries.length}`));
  });

  it("returns a single document whole, past the list bound", async () => {
    // A quotation with long line descriptions passes 12 000 characters at a
    // dozen lines — cut, its lines cannot be copied into an order confirmation.
    const lineItems = Array.from({ length: 12 }, (_, index) => ({
      id: `l${index}`,
      name: `Position ${index}`,
      description: "Beschreibung ".repeat(80),
      quantity: 1,
      unitName: "Stück",
      unitPrice: { currency: "EUR", netAmount: 100, taxRatePercentage: 19 },
    }));
    useApi(on("GET", /^\/quotations\//, () => ({ id: "q1", voucherNumber: "AG2026001", lineItems })));

    const result = await run("/quotations/3f0ef2e1-5f2b-4b44-9f0f-3b4bd7f0f0aa");

    assert.equal(result._truncated, undefined);
    assert.equal((result.lineItems as unknown[]).length, 12);
    assert.ok(JSON.stringify(result).length > 12_000);
  });
});
