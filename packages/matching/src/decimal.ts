/** Fixed-point helpers: quantities are compared at 4 decimal places using BigInt, never floats. */
export const QTY_SCALE = 10_000n;

export function parseScaled(decimal: string, scale = QTY_SCALE): bigint {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(decimal.trim());
  if (!m) throw new RangeError(`not a plain decimal: ${JSON.stringify(decimal)}`);
  const [, sign, whole = "0", frac = ""] = m;
  const digits = scale.toString().length - 1;
  const v = BigInt(whole) * scale + BigInt((frac + "0".repeat(digits)).slice(0, digits) || "0");
  return sign === "-" ? -v : v;
}

/** quantity (decimal string) x unit price (minor units) -> minor units, rounded half away from zero */
export function lineTotalMinor(quantity: string, unitPriceMinor: number): number {
  const q = parseScaled(quantity);
  const raw = q * BigInt(unitPriceMinor);
  const half = QTY_SCALE / 2n;
  const rounded = raw >= 0n ? (raw + half) / QTY_SCALE : -((-raw + half) / QTY_SCALE);
  return Number(rounded);
}
