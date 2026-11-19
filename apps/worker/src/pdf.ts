/**
 * Cheap page count without a PDF parser: count page objects. Good enough to estimate token cost
 * for rate limiting (an overestimate only slows us slightly; an exact count isn't worth a dependency).
 */
export function estimatePdfPages(pdf: Buffer): number {
  const matches = pdf.toString("latin1").match(/\/Type\s*\/Page(?!s)/g);
  return Math.max(1, matches?.length ?? 1);
}

/** Rough input tokens per page for a PDF document block (text + page image). */
export const TOKENS_PER_PAGE_ESTIMATE = 2_500;
