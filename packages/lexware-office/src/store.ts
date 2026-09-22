/**
 * Where durable records live — the reminder ledger, send claims. A small JSON
 * document store: read, write, create only if absent, delete.
 *
 * `create` must be atomic: two callers creating the same key, one wins. That
 * is what keeps a reminder from going out twice. `memoryStore` is for tests
 * and single-process use; `@kevinludwig/lexware-office/vercel-blob` provides
 * one on Vercel Blob.
 */

export interface JsonStore {
  /** The document at `key`, or null if there is none. Throws when the store fails. */
  read<T>(key: string): Promise<T | null>;
  /** Writes the document, replacing what was there. */
  write(key: string, value: unknown): Promise<void>;
  /** Writes the document only if none exists; false when one does. */
  create(key: string, value: unknown): Promise<boolean>;
  /** Deletes the document; no error if there is none. */
  delete(key: string): Promise<void>;
}

/** A key segment from an id: anything but word characters, dots, and dashes becomes "_". */
export function keySegment(value: string): string {
  return value.trim().replace(/[^\w.-]+/g, "_");
}

/** An in-memory store — for tests, or one process that never restarts. */
export function memoryStore(): JsonStore & { readonly size: number } {
  const documents = new Map<string, string>();
  return {
    get size() {
      return documents.size;
    },
    async read<T>(key: string) {
      const value = documents.get(key);
      return value === undefined ? null : (JSON.parse(value) as T);
    },
    async write(key, value) {
      documents.set(key, JSON.stringify(value));
    },
    async create(key, value) {
      if (documents.has(key)) return false;
      documents.set(key, JSON.stringify(value));
      return true;
    },
    async delete(key) {
      documents.delete(key);
    },
  };
}
