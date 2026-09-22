/**
 * Posting categories (`/posting-categories`).
 *
 * Every voucher item carries a category. `income` applies to outgoing
 * vouchers, `outgo` to incoming ones — the API rejects a purchase invoice with
 * an income category. The list is per account and practically never changes;
 * it is cached per client.
 */

import type { LexwareClient } from "./client.ts";

export interface PostingCategory {
  id: string;
  name: string;
  type: "income" | "outgo";
  /** Whether the category demands a real contact on the voucher. */
  contactRequired: boolean;
  /** Whether items with different tax rates are allowed. */
  splitAllowed: boolean;
  groupName?: string;
}

/**
 * The rate a reverse-charge item is booked with (§13b UStG): the recipient
 * owes the VAT and deducts it again. Lexware Office books both sides through
 * the category — the item carries this rate with a tax amount of 0, the gross
 * is what the supplier was paid. A 0 % item is rejected (`invalid_taxrate_0`).
 */
export const REVERSE_CHARGE_TAX_RATE = 19;

/** Whether a category books as reverse charge — the API has no flag, the name is the only marker ("… §13b …"). */
export function isReverseChargeCategory(name: string | undefined): boolean {
  return Boolean(name && /§\s*13b/i.test(name));
}

const cache = new WeakMap<LexwareClient, readonly PostingCategory[]>();

/** All posting categories of the account behind this client. */
export async function listPostingCategories(client: LexwareClient, signal?: AbortSignal): Promise<readonly PostingCategory[]> {
  const cached = cache.get(client);
  if (cached) return cached;
  const categories = (await client.request<PostingCategory[]>("/posting-categories", { signal })) ?? [];
  cache.set(client, categories);
  return categories;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A category of the given direction by name or id — exact name first, then a
 * name containing it. A passed id is checked against the list, so a category
 * of the wrong direction fails here, not with a 406 at creation. Null means
 * "not resolvable", not "error".
 */
export async function resolveCategory(
  client: LexwareClient,
  nameOrId: string,
  type: PostingCategory["type"],
  signal?: AbortSignal,
): Promise<PostingCategory | null> {
  const needle = nameOrId.trim();
  if (!needle) return null;
  const matching = (await listPostingCategories(client, signal)).filter((category) => category.type === type);
  if (UUID.test(needle)) return matching.find((category) => category.id.toLowerCase() === needle.toLowerCase()) ?? null;
  const lower = needle.toLowerCase();
  return (
    matching.find((category) => category.name.toLowerCase() === lower) ??
    matching.find((category) => category.name.toLowerCase().includes(lower)) ??
    null
  );
}
