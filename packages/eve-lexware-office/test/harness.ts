/**
 * Test harness for the extension.
 *
 * The tests run against the BUILD (`dist/extension/…`, wired as `pretest`),
 * not the source: the source imports without file extensions, as eve's build
 * resolves them, and Node cannot load that. Testing the build also tests
 * exactly what a consumer installs.
 *
 * The mount's runtime is replaced once, before the first import of a module
 * under test: `client()` hands out the fake API of the current test,
 * `store()` a fresh in-memory store. Everything else — checks, cards,
 * findings — is the real code.
 */

import { mock } from "node:test";

import { createLexwareClient, memoryStore, reminderLedger, type JsonStore, type LexwareClient, type ReminderLedger } from "@kevludwig/lexware-office";

export interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

export type Route = (call: Call) => Response | undefined;

/** Answers `method` + `path` with `answer`; anything unrouted becomes a 404. */
export const on =
  (method: string, pattern: RegExp, answer: (call: Call) => unknown, status = 200): Route =>
  (call) =>
    call.method === method && pattern.test(call.path) ? Response.json(answer(call), { status }) : undefined;

/** A client against routes instead of the network; `calls` records what was asked. */
export function fakeApi(...routes: Route[]): { client: LexwareClient; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const parsed = new URL(String(url));
    const call: Call = {
      method: init.method ?? "GET",
      path: parsed.pathname.replace(/^\/v1/, ""),
      query: parsed.searchParams,
      body: typeof init.body === "string" ? JSON.parse(init.body) : init.body,
    };
    calls.push(call);
    for (const route of routes) {
      const answer = route(call);
      if (answer) return answer;
    }
    return new Response(`no route for ${call.method} ${call.path}`, { status: 404 });
  }) as typeof fetch;
  return { client: createLexwareClient({ apiKey: "test-key", fetch: fetchImpl, minSpacingMs: 0 }), calls };
}

let current: { client: LexwareClient; calls: Call[] } | null = null;
let currentStore: JsonStore = memoryStore();

/** Points the extension at these routes for the rest of the test. */
export function useApi(...routes: Route[]): { client: LexwareClient; calls: Call[] } {
  current = fakeApi(...routes);
  currentStore = memoryStore();
  return current;
}

export const store = (): JsonStore => currentStore;

/** The reminder records of the current test, in memory. */
export const ledger = (): ReminderLedger => reminderLedger(currentStore, "reminders/test");

mock.module(new URL("../dist/extension/lib/runtime.mjs", import.meta.url).href, {
  exports: {
    client: () => {
      if (!current) throw new Error("useApi() first — no fake API for this test.");
      return current.client;
    },
    store: () => currentStore,
    ledger: () => reminderLedger(currentStore, "reminders/test"),
    config: () => ({ storage: {}, reminders: { mode: "test" } }),
    key: (...segments: string[]) => segments.join("/"),
  },
});

/** A posting category as /posting-categories returns it. */
export const category = (id: string, name: string, type = "outgo") => ({ id, name, type, contactRequired: false, splitAllowed: false, groupName: "Test" });

/** A contact as /contacts returns it. */
export const contact = (id: string, name: string, roles: Record<string, unknown> = { vendor: {} }) => ({
  id,
  organizationId: "org",
  version: 1,
  roles,
  company: { name },
  addresses: {},
});
