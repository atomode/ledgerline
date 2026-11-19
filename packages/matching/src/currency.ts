/**
 * Which currency an invoice is in, decided by code from what the document actually prints.
 *
 * The model is good at reading but has to guess when a supplier prints only "$" or "¥": an
 * Australian "$" and a US "$" look the same on paper. So the model reports the marker as printed,
 * and these rules decide: an ISO code or an unambiguous symbol wins; a shared symbol is resolved
 * from master data (the PO first, because it is the contract, then the vendor's default); when
 * neither fits, the model's guess is kept and flagged so a person checks it.
 *
 * Note: resolving a bare "$" from the PO means the 3-way match can't catch a currency mismatch
 * on such documents. That is the point: a bare "$" carries no evidence against a CAD PO.
 */

const ISO_4217 = new Set(Intl.supportedValuesOf("currency"));

/** Symbols that name exactly one currency. Checked longest first, so "CA$" is not read as "A$". */
const UNAMBIGUOUS_LIST: [string, string][] = [
  ["US$", "USD"],
  ["AU$", "AUD"],
  ["A$", "AUD"],
  ["CA$", "CAD"],
  ["C$", "CAD"],
  ["NZ$", "NZD"],
  ["HK$", "HKD"],
  ["S$", "SGD"],
  ["MX$", "MXN"],
  ["R$", "BRL"],
  ["€", "EUR"],
  ["£", "GBP"],
  ["₹", "INR"],
  ["₩", "KRW"],
  ["₺", "TRY"],
  ["₽", "RUB"],
  ["₪", "ILS"],
  ["฿", "THB"],
  ["₱", "PHP"],
  ["円", "JPY"],
  ["zł", "PLN"],
  ["Kč", "CZK"],
];
const UNAMBIGUOUS = [...UNAMBIGUOUS_LIST].sort((a, b) => b[0].length - a[0].length);

/** Symbols several currencies share, with the currencies they can mean. */
const AMBIGUOUS: [RegExp, string[]][] = [
  [/\$/, ["USD", "CAD", "AUD", "NZD", "SGD", "HKD", "MXN"]],
  [/[¥￥]/, ["JPY", "CNY"]],
  [/元/, ["CNY", "TWD"]],
  [/\bkr\.?(?=\s|\d|$)/i, ["SEK", "NOK", "DKK", "ISK"]],
];

export type CurrencyMarker =
  | { kind: "code"; currency: string }
  | { kind: "ambiguous"; candidates: string[] }
  | { kind: "none" };

export function classifyCurrencyMarker(printed: string | null): CurrencyMarker {
  const s = printed?.trim() ?? "";
  if (!s) return { kind: "none" };
  for (const token of s.match(/\b[A-Za-z]{3}\b/g) ?? []) {
    const code = token.toUpperCase();
    if (ISO_4217.has(code)) return { kind: "code", currency: code };
  }
  for (const [symbol, currency] of UNAMBIGUOUS) {
    if (s.includes(symbol)) return { kind: "code", currency };
  }
  for (const [re, candidates] of AMBIGUOUS) {
    if (re.test(s)) return { kind: "ambiguous", candidates };
  }
  return { kind: "none" };
}

export interface CurrencyDecision {
  currency: string;
  source: "document" | "purchase_order" | "vendor_default" | "model_inferred";
  /** true: nothing on the document or in master data settles it; keep out of auto-approval. */
  ambiguous: boolean;
}

export function resolveCurrency(input: {
  /** The model's ISO code (its best guess). */
  extracted: string;
  /** The currency marker exactly as printed on the document, if any. */
  printed: string | null;
  poCurrency: string | null;
  vendorDefault: string | null;
}): CurrencyDecision {
  const marker = classifyCurrencyMarker(input.printed);
  if (marker.kind === "code")
    return { currency: marker.currency, source: "document", ambiguous: false };
  const fits = (c: string | null): c is string =>
    !!c && (marker.kind === "none" || marker.candidates.includes(c));
  if (fits(input.poCurrency)) {
    return { currency: input.poCurrency, source: "purchase_order", ambiguous: false };
  }
  if (fits(input.vendorDefault)) {
    return { currency: input.vendorDefault, source: "vendor_default", ambiguous: false };
  }
  return { currency: input.extracted, source: "model_inferred", ambiguous: true };
}
