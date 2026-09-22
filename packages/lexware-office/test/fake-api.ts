/** A fake Public API for tests: routes by method and path, records every call. */

import { createLexwareClient } from "../src/index.ts";

export type Route = (request: { method: string; path: string; query: URLSearchParams; body: unknown }) => Response | undefined;

export function fakeApi(...routes: Route[]) {
  const calls: { method: string; path: string; query: URLSearchParams; body: unknown }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const parsed = new URL(String(url));
    const path = parsed.pathname.replace(/^\/v1/, "");
    const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    const call = { method: init.method ?? "GET", path, query: parsed.searchParams, body };
    calls.push(call);
    for (const route of routes) {
      const answer = route(call);
      if (answer) return answer;
    }
    return new Response(`no route for ${call.method} ${path}`, { status: 404 });
  }) as typeof fetch;
  return { client: createLexwareClient({ apiKey: "k", fetch: fetchImpl, minSpacingMs: 0 }), calls };
}

export const on =
  (method: string, pattern: RegExp, answer: (request: Parameters<Route>[0]) => unknown, status = 200): Route =>
  (request) =>
    request.method === method && pattern.test(request.path) ? Response.json(answer(request), { status }) : undefined;
