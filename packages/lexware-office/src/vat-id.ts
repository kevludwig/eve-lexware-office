/**
 * The form of an EU VAT ID (USt-IdNr.) per member state — offline, without
 * VIES. A matching form says nothing about whether the number is assigned:
 * that only VIES answers, and that check is the caller's (an external service).
 */

/**
 * The patterns VIES documents per country prefix, after spaces, dots and
 * dashes are removed. Greece uses EL, Northern Ireland XI.
 */
export const VAT_ID_PATTERNS: Readonly<Record<string, RegExp>> = {
  AT: /^ATU\d{8}$/,
  BE: /^BE[01]\d{9}$/,
  BG: /^BG\d{9,10}$/,
  CY: /^CY\d{8}[A-Z]$/,
  CZ: /^CZ\d{8,10}$/,
  DE: /^DE\d{9}$/,
  DK: /^DK\d{8}$/,
  EE: /^EE\d{9}$/,
  EL: /^EL\d{9}$/,
  ES: /^ES[A-Z0-9]\d{7}[A-Z0-9]$/,
  FI: /^FI\d{8}$/,
  FR: /^FR[A-HJ-NP-Z0-9]{2}\d{9}$/,
  HR: /^HR\d{11}$/,
  HU: /^HU\d{8}$/,
  IE: /^IE(\d{7}[A-W][A-IW]?|\d[A-Z+*]\d{5}[A-W])$/,
  IT: /^IT\d{11}$/,
  LT: /^LT(\d{9}|\d{12})$/,
  LU: /^LU\d{8}$/,
  LV: /^LV\d{11}$/,
  MT: /^MT\d{8}$/,
  NL: /^NL\d{9}B\d{2}$/,
  PL: /^PL\d{10}$/,
  PT: /^PT\d{9}$/,
  RO: /^RO\d{2,10}$/,
  SE: /^SE\d{12}$/,
  SI: /^SI\d{8}$/,
  SK: /^SK\d{10}$/,
  XI: /^XI(\d{9}|\d{12}|GD\d{3}|HA\d{3})$/,
};

/** A VAT ID as written for comparison: upper case, without spaces, dots or dashes. */
export const normalizeVatId = (value: string): string => value.toUpperCase().replace(/[\s.\-]/g, "");

/** The member state a VAT ID's prefix names, as an ISO country code (EL → GR, XI → GB); null for an unknown prefix. */
export function vatIdCountry(value: string): string | null {
  const prefix = normalizeVatId(value).slice(0, 2);
  if (!(prefix in VAT_ID_PATTERNS)) return null;
  return prefix === "EL" ? "GR" : prefix === "XI" ? "GB" : prefix;
}

/**
 * What is wrong with a VAT ID's form, in German — or null when it has the
 * form of its member state. Only the form: an assigned number needs VIES.
 */
export function vatIdProblem(value: string): string | null {
  const id = normalizeVatId(value);
  if (!id) return "leer";
  const prefix = id.slice(0, 2);
  if (prefix === "GR") return `„${value}“: Griechenland schreibt EL, nicht GR`;
  const pattern = VAT_ID_PATTERNS[prefix];
  if (!pattern) return `„${value}“: kein EU-Länderkürzel am Anfang (z. B. ATU…, FR…, NL…)`;
  return pattern.test(id) ? null : `„${value}“ hat nicht die Form einer USt-IdNr. aus ${prefix}`;
}
