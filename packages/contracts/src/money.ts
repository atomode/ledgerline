/**
 * Decimal-string <-> minor-unit conversion. Pure string/BigInt arithmetic: no floats anywhere,
 * because 0.1 + 0.2 !== 0.3 is not an acceptable property for a payables system.
 */

const exponentCache = new Map<string, number>();

/** ISO 4217 exponent: USD 2, JPY 0, BHD 3. */
export function currencyExponent(currency: string): number {
  let e = exponentCache.get(currency);
  if (e === undefined) {
    e = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
      .maximumFractionDigits as number;
    exponentCache.set(currency, e);
  }
  return e;
}

const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;

/**
 * "1234.5" USD -> 123450. Extra precision beyond the currency's exponent is rounded half away
 * from zero (the convention on printed invoices), e.g. "10.005" USD -> 1001.
 */
export function toMinorUnits(decimal: string, currency: string): number {
  const m = DECIMAL.exec(decimal.trim());
  if (!m) throw new RangeError(`not a plain decimal: ${JSON.stringify(decimal)}`);
  const [, sign, whole = "0", frac = ""] = m;
  const exp = currencyExponent(currency);
  const kept = frac.slice(0, exp).padEnd(exp, "0");
  const dropped = frac.slice(exp);
  let minor = BigInt(whole + kept);
  if (dropped.length > 0 && Number(dropped[0]) >= 5) minor += 1n;
  if (sign === "-" && minor !== 0n) minor = -minor;
  if (minor > BigInt(Number.MAX_SAFE_INTEGER) || minor < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError(`amount out of safe range: ${decimal}`);
  }
  return Number(minor);
}

/** 123450 USD -> "1234.50" */
export function fromMinorUnits(minor: number, currency: string): string {
  const exp = currencyExponent(currency);
  const neg = minor < 0;
  const digits = Math.abs(minor)
    .toString()
    .padStart(exp + 1, "0");
  const out = exp === 0 ? digits : `${digits.slice(0, -exp)}.${digits.slice(-exp)}`;
  return neg ? `-${out}` : out;
}
