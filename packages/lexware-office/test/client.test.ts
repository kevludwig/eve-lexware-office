import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { LexwareApiError, createLexwareClient, describeError, findContactsByName, query, voucherFileIds } from "../src/index.ts";

type Call = { url: string; init: RequestInit; at: number };

function fakeFetch(answers: Array<() => Response>) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init, at: Date.now() });
    const next = answers.shift();
    if (!next) throw new Error("no more answers");
    return next();
  }) as typeof fetch;
  return { impl, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("createLexwareClient", () => {
  it("sends the key, the base URL, and JSON", async () => {
    const { impl, calls } = fakeFetch([() => json({ id: "c1" })]);
    const client = createLexwareClient({ apiKey: "secret", baseUrl: "https://api.example/v1/", fetch: impl, minSpacingMs: 0 });
    const result = await client.request<{ id: string }>("/contacts", { method: "POST", json: { name: "x" } });
    assert.equal(result.id, "c1");
    assert.equal(calls[0]?.url, "https://api.example/v1/contacts");
    const headers = calls[0]?.init.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer secret");
    assert.equal(headers["Content-Type"], "application/json");
    assert.equal(calls[0]?.init.body, JSON.stringify({ name: "x" }));
  });

  it("keeps the spacing between requests of one client", async () => {
    const { impl, calls } = fakeFetch([() => json({}), () => json({}), () => json({})]);
    const client = createLexwareClient({ apiKey: "k", fetch: impl, minSpacingMs: 60 });
    await Promise.all([client.request("/a"), client.request("/b"), client.request("/c")]);
    const gaps = calls.slice(1).map((call, index) => call.at - calls[index]!.at);
    for (const gap of gaps) assert.ok(gap >= 55, `gap ${gap} ms`);
  });

  it("retries on 429, then reports", async () => {
    const limited = () => new Response("", { status: 429 });
    const { impl, calls } = fakeFetch([limited, limited, () => json({ ok: true })]);
    const client = createLexwareClient({ apiKey: "k", fetch: impl, minSpacingMs: 0, rateLimitBackoffMs: 1 });
    assert.deepEqual(await client.request("/x"), { ok: true });
    assert.equal(calls.length, 3);

    const always = fakeFetch([limited, () => new Response("slow down", { status: 429 })]);
    const once = createLexwareClient({ apiKey: "k", fetch: always.impl, minSpacingMs: 0, rateLimitBackoffMs: 1, rateLimitRetries: 1 });
    await assert.rejects(once.request("/x"), (error: unknown) => error instanceof LexwareApiError && error.status === 429);
  });

  it("waits as long as Retry-After says", async () => {
    const { impl, calls } = fakeFetch([() => new Response("", { status: 429, headers: { "retry-after": "0.2" } }), () => json({ ok: true })]);
    const client = createLexwareClient({ apiKey: "k", fetch: impl, minSpacingMs: 0, rateLimitBackoffMs: 1 });
    await client.request("/x");
    assert.ok(calls[1]!.at - calls[0]!.at >= 190, `waited ${calls[1]!.at - calls[0]!.at} ms`);
  });

  it("waits until the HTTP date in Retry-After", async () => {
    // HTTP dates have whole seconds: the next full second plus one, so the wait is between 1 and 2 s.
    const until = new Date(Math.ceil(Date.now() / 1_000) * 1_000 + 1_000).toUTCString();
    const { impl, calls } = fakeFetch([() => new Response("", { status: 429, headers: { "retry-after": until } }), () => json({ ok: true })]);
    const client = createLexwareClient({ apiKey: "k", fetch: impl, minSpacingMs: 0, rateLimitBackoffMs: 1 });
    await client.request("/x");
    const waited = calls[1]!.at - calls[0]!.at;
    assert.ok(waited >= 900 && waited < 2_500, `waited ${waited} ms`);
  });

  it("stops waiting for a retry when the caller aborts", async () => {
    const { impl, calls } = fakeFetch([() => new Response("", { status: 429, headers: { "retry-after": "5" } }), () => json({ ok: true })]);
    const client = createLexwareClient({ apiKey: "k", fetch: impl, minSpacingMs: 0 });
    const controller = new AbortController();
    const started = Date.now();
    const pending = client.request("/x", { signal: controller.signal });
    setTimeout(() => controller.abort(new Error("cancelled by the caller")), 50);
    await assert.rejects(pending, /cancelled by the caller/);
    assert.ok(Date.now() - started < 1_000, "did not wait out Retry-After");
    assert.equal(calls.length, 1);
  });

  it("turns an error answer into LexwareApiError with a hint", async () => {
    const { impl } = fakeFetch([() => new Response("forbidden", { status: 403, statusText: "Forbidden" })]);
    const client = createLexwareClient({ apiKey: "k", fetch: impl, minSpacingMs: 0 });
    const error = await client.request("/vouchers/1").catch((caught: unknown) => caught);
    assert.ok(error instanceof LexwareApiError);
    assert.equal(error.status, 403);
    assert.match(describeError(error), /Recht für diesen Endpunkt/);
  });

  it("answers an empty body with undefined", async () => {
    const { impl } = fakeFetch([() => new Response(null, { status: 204 })]);
    const client = createLexwareClient({ apiKey: "k", fetch: impl, minSpacingMs: 0 });
    assert.equal(await client.request("/x"), undefined);
  });

  it("refuses to start without a key", () => {
    assert.throws(() => createLexwareClient({ apiKey: " " }), /apiKey/);
  });

  it("links vouchers in the web app", () => {
    const client = createLexwareClient({ apiKey: "k" });
    assert.equal(client.voucherUrl("v1"), "https://app.lexware.de/vouchers#!/VoucherDetail/v1");
  });
});

describe("query", () => {
  it("drops empty values", () => {
    assert.equal(query({ a: 1, b: "", c: undefined, d: true }), "?a=1&d=true");
    assert.equal(query({}), "");
  });
});

describe("file uploads", () => {
  const slow = (ms: number, body: unknown) =>
    (async (_url: string | URL | Request, init: RequestInit = {}) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        init.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(init.signal?.reason);
        });
      });
      return json(body);
    }) as typeof fetch;
  const file = { bytes: new Uint8Array([37, 80, 68, 70]), filename: "R.pdf", mediaType: "application/pdf" };

  it("give an upload longer than a JSON call", async () => {
    const client = createLexwareClient({ apiKey: "k", fetch: slow(60, { id: "f1" }), minSpacingMs: 0, timeoutMs: 20, uploadTimeoutMs: 500 });
    assert.deepEqual(await client.upload("/vouchers/v1/files", file), { id: "f1" });
    await assert.rejects(client.request("/vouchers/v1"));
  });

  it("tell from the voucher whether a file arrived", async () => {
    const { impl, calls } = fakeFetch([() => json({ id: "v1", files: ["f1"] }), () => json({ id: "v2" })]);
    const client = createLexwareClient({ apiKey: "k", fetch: impl, minSpacingMs: 0 });
    assert.deepEqual(await voucherFileIds(client, "v1"), ["f1"]);
    assert.deepEqual(await voucherFileIds(client, "v2"), []);
    assert.match(calls[0]!.url, /\/vouchers\/v1$/);
  });
});

describe("contact search", () => {
  it("does not ask Lexware for names under three characters (it answers 400)", async () => {
    const { impl, calls } = fakeFetch([() => json({ content: [{ id: "c1", company: { name: "XYZ GmbH" }, roles: { customer: {} } }] })]);
    const client = createLexwareClient({ apiKey: "k", fetch: impl, minSpacingMs: 0 });
    assert.deepEqual(await findContactsByName(client, " XY "), []);
    assert.equal(calls.length, 0);
    assert.equal((await findContactsByName(client, "XYZ")).length, 1);
    assert.equal(calls.length, 1);
  });
});
