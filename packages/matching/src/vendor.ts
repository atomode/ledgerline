const LEGAL_SUFFIXES = new Set([
  "inc",
  "incorporated",
  "llc",
  "ltd",
  "limited",
  "plc",
  "gmbh",
  "ag",
  "sa",
  "sas",
  "sarl",
  "bv",
  "nv",
  "co",
  "corp",
  "corporation",
  "company",
  "pty",
  "srl",
  "spa",
  "kk",
  "oy",
  "ab",
  "as",
]);

/**
 * Canonical vendor key: lowercase, accents and punctuation stripped, "&" -> "and",
 * trailing legal-entity suffixes removed. "ACME Supplies, Ltd." and "Acme Supplies Limited" collide.
 */
export function normalizeVendorName(name: string): string {
  const words = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  while (words.length > 1 && LEGAL_SUFFIXES.has(words[words.length - 1] ?? "")) words.pop();
  return words.join(" ");
}
