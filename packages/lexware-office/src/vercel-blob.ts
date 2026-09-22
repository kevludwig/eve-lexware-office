/**
 * A JsonStore on Vercel Blob. Documents are private, live at fixed pathnames
 * under `prefix`, and are read past the CDN cache — records change within
 * seconds of being read. `create` relies on Blob refusing to overwrite.
 */

import { BlobError, del, get, put } from "@vercel/blob";

import type { JsonStore } from "./store.ts";

export interface VercelBlobStoreOptions {
  /** Pathname prefix, e.g. "lexware-office/production". Empty: keys are pathnames. */
  prefix: string;
  /** Read-write token. Default: BLOB_READ_WRITE_TOKEN from the environment. */
  token?: string;
}

export function vercelBlobStore(options: VercelBlobStoreOptions): JsonStore {
  const prefix = options.prefix.replace(/\/+$/, "");
  const pathname = (key: string) => (prefix ? `${prefix}/${key}` : key);
  const token = options.token;

  return {
    async read<T>(key: string) {
      const result = await get(pathname(key), { access: "private", useCache: false, token });
      if (!result || result.statusCode !== 200) return null;
      return JSON.parse(await new Response(result.stream).text()) as T;
    },
    async write(key, value) {
      await put(pathname(key), JSON.stringify(value), {
        access: "private",
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: "application/json",
        token,
      });
    },
    async create(key, value) {
      try {
        await put(pathname(key), JSON.stringify(value), {
          access: "private",
          addRandomSuffix: false,
          allowOverwrite: false,
          contentType: "application/json",
          token,
        });
        return true;
      } catch (error) {
        if (error instanceof BlobError && /already exists/i.test(error.message)) return false;
        throw error;
      }
    },
    async delete(key) {
      await del(pathname(key), { token });
    },
  };
}
