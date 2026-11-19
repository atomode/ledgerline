import { describe, expect, it } from "vitest";
import { createLedgerlineClient } from "./index.js";

describe("typed client", () => {
  it("sends typed requests and parses typed responses", async () => {
    const calls: Request[] = [];
    const client = createLedgerlineClient({
      baseUrl: "http://api.test",
      fetch: async (req: Request) => {
        calls.push(req);
        return new Response(JSON.stringify({ data: [], nextCursor: null }), {
          headers: { "content-type": "application/json" },
        });
      },
    });

    const { data, error } = await client.GET("/v1/invoices", {
      params: { query: { status: "needs_review", limit: 25 } },
    });

    expect(error).toBeUndefined();
    expect(data?.nextCursor).toBeNull();
    expect(calls[0]?.url).toBe("http://api.test/v1/invoices?status=needs_review&limit=25");

    // @ts-expect-error: "paid" is not an InvoiceStatus, so this must not compile.
    void client.GET("/v1/invoices", { params: { query: { status: "paid" } } });
  });
});
