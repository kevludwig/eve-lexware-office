/**
 * `./operations` must run where eve is not installed: nothing it imports —
 * at runtime or in its type declarations — may reach eve, the extension's
 * config (extension.ts, runtime.ts), its session state, or the Vercel Blob store.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const lib = resolve(here, "../dist/extension/lib");

describe("./operations without eve", () => {
  it("loads with eve, the mount's runtime and session state unresolvable", () => {
    const script = `
      const ops = await import(${JSON.stringify(resolve(lib, "operations.mjs"))});
      const card = ops.buildCard("create_customer", { company_name: "Beispiel GmbH", street: "Musterstraße 1", zip: "12345", city: "Musterstadt" }, []);
      if (card?.tool !== "create_customer") throw new Error("no card");
      process.stdout.write(Object.keys(ops).sort().join(","));
    `;
    // The block itself must work: a direct import of eve fails in the same setup.
    assert.throws(() =>
      execFileSync(process.execPath, ["--import", resolve(here, "block-eve.mjs"), "--input-type=module", "-e", 'await import("eve/context")'], { cwd: here, stdio: "pipe" }),
    );
    const exported = execFileSync(process.execPath, ["--import", resolve(here, "block-eve.mjs"), "--input-type=module", "-e", script], {
      cwd: here,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    for (const name of ["buildCard", "prepareSalesDocument", "executeApprovedSalesDocument", "prepareCustomer", "executeApprovedCustomer", "journalIn", "readAccount", "withSource"]) {
      assert.ok(exported.split(",").includes(name), `exports ${name}`);
    }
  });

  it("declares its types without eve", () => {
    const seen = new Set<string>();
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const source = readFileSync(file, "utf8");
      for (const [, specifier] of source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
        assert.doesNotMatch(specifier!, /^(eve|@vercel\/blob)(\/|$)|vercel-blob/, `${file} imports ${specifier}`);
        if (!specifier!.startsWith(".")) continue;
        const target = resolve(dirname(file), specifier!.replace(/\.m?js$/, "")) + ".d.ts";
        assert.ok(existsSync(target), `${target} exists`);
        visit(target);
      }
    };
    visit(resolve(lib, "operations.d.ts"));
    const names = [...seen].map((file) => file.slice(lib.length + 1));
    for (const forbidden of ["runtime.d.ts", "state.d.ts", "findings.d.ts", "types.d.ts", "with-card.d.ts"]) {
      assert.ok(!names.includes(forbidden), `operations.d.ts reaches ${forbidden}`);
    }
  });
});
