import createClient, { type ClientOptions } from "openapi-fetch";
import type { paths } from "./schema.gen.js";

export type { paths, components } from "./schema.gen.js";

/**
 * Typed Ledgerline API client generated from openapi.yaml.
 * Paths, params, bodies and responses are all checked at compile time.
 */
export function createLedgerlineClient(options: ClientOptions & { baseUrl: string }) {
  return createClient<paths>(options);
}
export type LedgerlineClient = ReturnType<typeof createLedgerlineClient>;
