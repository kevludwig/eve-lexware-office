/**
 * Account settings a sales document refers to: print layouts, payment
 * conditions, the profile's tax setup, countries, articles. Read-only.
 */

import { query, type LexwareClient } from "./client.ts";

export interface PrintLayout {
  id: string;
  name: string;
  default: boolean;
}

export async function listPrintLayouts(client: LexwareClient, signal?: AbortSignal): Promise<PrintLayout[]> {
  return (await client.request<PrintLayout[]>("/print-layouts", { signal })) ?? [];
}

/** A print layout by id or by name (case-insensitive); null if none or several match. */
export async function resolvePrintLayout(client: LexwareClient, nameOrId: string, signal?: AbortSignal): Promise<PrintLayout | null> {
  const needle = nameOrId.trim().toLowerCase();
  const layouts = await listPrintLayouts(client, signal);
  const byId = layouts.find((layout) => layout.id.toLowerCase() === needle);
  if (byId) return byId;
  const byName = layouts.filter((layout) => layout.name.trim().toLowerCase() === needle);
  return byName.length === 1 ? byName[0]! : null;
}

export interface PaymentConditionTemplate {
  id: string;
  /** As configured, with placeholders such as {paymentRange}. */
  paymentTermLabelTemplate: string;
  paymentTermDuration?: number;
  paymentDiscountConditions?: { discountPercentage: number; discountRange: number };
  organizationDefault: boolean;
}

export async function listPaymentConditions(client: LexwareClient, signal?: AbortSignal): Promise<PaymentConditionTemplate[]> {
  return (await client.request<PaymentConditionTemplate[]>("/payment-conditions", { signal })) ?? [];
}

/**
 * The account's default payment condition — what a document without payment
 * conditions gets unless its contact has its own (which the API does not
 * expose). The label with its placeholders filled in.
 */
export async function defaultPaymentCondition(
  client: LexwareClient,
  signal?: AbortSignal,
): Promise<{ label: string; duration?: number; discount?: { percentage: number; days: number } } | null> {
  const found = (await listPaymentConditions(client, signal)).find((condition) => condition.organizationDefault);
  if (!found) return null;
  const discount = found.paymentDiscountConditions;
  const label = found.paymentTermLabelTemplate
    .replace(/\{paymentRange\}/g, String(found.paymentTermDuration ?? ""))
    .replace(/\{discountRange\}/g, String(discount?.discountRange ?? ""))
    .replace(/\{discount\}/g, discount ? `${discount.discountPercentage.toLocaleString("de-DE", { maximumFractionDigits: 2 })} %` : "");
  return {
    label,
    ...(found.paymentTermDuration !== undefined ? { duration: found.paymentTermDuration } : {}),
    ...(discount ? { discount: { percentage: discount.discountPercentage, days: discount.discountRange } } : {}),
  };
}

export interface Profile {
  organizationId: string;
  companyName?: string;
  /** The account's tax type: net, gross, or vatfree. */
  taxType?: "net" | "gross" | "vatfree";
  /** Kleinunternehmer according to § 19 UStG. */
  smallBusiness?: boolean;
  distanceSalesPrinciple?: "ORIGIN" | "DESTINATION";
}

export async function getProfile(client: LexwareClient, signal?: AbortSignal): Promise<Profile> {
  return client.request<Profile>("/profile", { signal });
}

export type CountryTaxClassification = "de" | "intraCommunity" | "thirdPartyCountry";

export interface Country {
  countryCode: string;
  countryNameDE?: string;
  countryNameEN?: string;
  taxClassification: CountryTaxClassification;
}

export async function listCountries(client: LexwareClient, signal?: AbortSignal): Promise<Country[]> {
  return (await client.request<Country[]>("/countries", { signal })) ?? [];
}

export interface Article {
  id: string;
  title: string;
  /** As a line item spells it. */
  lineType: "service" | "material";
  articleNumber?: string;
  /** GTIN/EAN, where stored. */
  gtin?: string;
  unitName?: string;
  netPrice?: number;
  grossPrice?: number;
  taxRate?: number;
}

interface RawArticle {
  id: string;
  title?: string;
  type?: "PRODUCT" | "SERVICE";
  articleNumber?: string;
  gtin?: string;
  unitName?: string;
  price?: { netPrice?: number; grossPrice?: number; taxRate?: number };
}

function toArticle(raw: RawArticle): Article {
  return {
    id: raw.id,
    title: raw.title ?? "",
    lineType: raw.type === "PRODUCT" ? "material" : "service",
    ...(raw.articleNumber ? { articleNumber: raw.articleNumber } : {}),
    ...(raw.gtin ? { gtin: raw.gtin } : {}),
    ...(raw.unitName ? { unitName: raw.unitName } : {}),
    ...(raw.price?.netPrice !== undefined ? { netPrice: raw.price.netPrice } : {}),
    ...(raw.price?.grossPrice !== undefined ? { grossPrice: raw.price.grossPrice } : {}),
    ...(raw.price?.taxRate !== undefined ? { taxRate: raw.price.taxRate } : {}),
  };
}

export async function getArticle(client: LexwareClient, id: string, signal?: AbortSignal): Promise<Article> {
  return toArticle(await client.request<RawArticle>(`/articles/${encodeURIComponent(id)}`, { signal }));
}

/** What GET /articles filters by; several combine with AND. */
export interface ArticleFilter {
  /** Exactly this article number — the API answers with at most one article. */
  articleNumber?: string;
  /** GTIN/EAN — several articles can share one. */
  gtin?: string;
  /** Products or services only. */
  type?: "PRODUCT" | "SERVICE";
}

/** The API's page size limits for articles: it refuses fewer than 25 (406) and more than 250. */
export const MIN_ARTICLE_PAGE_SIZE = 25;
export const MAX_ARTICLE_PAGE_SIZE = 250;

/**
 * The articles matching the filter, first page, up to `size` (default and
 * least 25, at most 250 — the API refuses a smaller page). Without any filter it lists the account's articles. An empty
 * list means no match — it is never guessed from a similar number.
 */
export async function findArticles(
  client: LexwareClient,
  filter: ArticleFilter,
  options: { size?: number; signal?: AbortSignal } = {},
): Promise<Article[]> {
  const size = Math.min(Math.max(options.size ?? MIN_ARTICLE_PAGE_SIZE, MIN_ARTICLE_PAGE_SIZE), MAX_ARTICLE_PAGE_SIZE);
  const page = await client.request<{ content?: RawArticle[] }>(
    `/articles${query({ articleNumber: filter.articleNumber?.trim(), gtin: filter.gtin?.trim(), type: filter.type, size })}`,
    { signal: options.signal },
  );
  return (page?.content ?? []).map(toArticle);
}
