import { Problem } from "@ledgerline/contracts";

/** Standard error responses documented on every route. */
export const problemResponses = {
  400: Problem.describe("Validation failed"),
  404: Problem.describe("Not found"),
  429: Problem.describe("Too many requests or pipeline backlog; honor Retry-After"),
  500: Problem.describe("Unexpected error"),
  501: Problem.describe("Not implemented yet"),
} as const;
