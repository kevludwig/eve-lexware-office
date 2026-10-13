/**
 * Account settings a sales document refers to: print layouts, payment
 * conditions, the profile's tax setup, countries, articles. Read-only.
 */

import { type LexwareClient } from "./client.ts";

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
  unitName?: string;
  netPrice?: number;
  grossPrice?: number;
  taxRate?: number;
}

export async function getArticle(client: LexwareClient, id: string, signal?: AbortSignal): Promise<Article> {
  const raw = await client.request<{
    id: string;
    title?: string;
    type?: "PRODUCT" | "SERVICE";
    articleNumber?: string;
    unitName?: string;
    price?: { netPrice?: number; grossPrice?: number; taxRate?: number };
  }>(`/articles/${encodeURIComponent(id)}`, { signal });
  return {
    id: raw.id,
    title: raw.title ?? "",
    lineType: raw.type === "PRODUCT" ? "material" : "service",
    ...(raw.articleNumber ? { articleNumber: raw.articleNumber } : {}),
    ...(raw.unitName ? { unitName: raw.unitName } : {}),
    ...(raw.price?.netPrice !== undefined ? { netPrice: raw.price.netPrice } : {}),
    ...(raw.price?.grossPrice !== undefined ? { grossPrice: raw.price.grossPrice } : {}),
    ...(raw.price?.taxRate !== undefined ? { taxRate: raw.price.taxRate } : {}),
  };
}
