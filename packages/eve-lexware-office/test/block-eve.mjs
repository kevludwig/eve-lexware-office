/**
 * Preload for test/operations-isolated.test.ts: makes eve, @vercel/blob and
 * the extension's eve-bound modules unresolvable, as if eve were not
 * installed. Any import of them fails the child process.
 */

import { registerHooks } from "node:module";

const BLOCKED_SPECIFIER = /^(eve|@vercel\/blob)(\/|$)|^@kevludwig\/lexware-office\/vercel-blob$/;
const BLOCKED_MODULE = /\/dist\/extension\/(extension|lib\/(runtime|state|findings|journal|with-card|call-card|sales-eve|purchase))\.mjs$/;

registerHooks({
  resolve(specifier, context, next) {
    if (BLOCKED_SPECIFIER.test(specifier)) throw new Error(`blocked import of ${specifier} from ${context.parentURL}`);
    const resolved = next(specifier, context);
    if (BLOCKED_MODULE.test(resolved.url)) throw new Error(`blocked import of ${resolved.url} from ${context.parentURL}`);
    return resolved;
  },
});
