import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { PDFDocument } from "pdf-lib";
import { classifyDocument } from "./classify.js";
import { firstPages } from "./pages.js";

async function pdfWithPages(n: number) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < n; i++) doc.addPage([200, 200]);
  return Buffer.from(await doc.save());
}

function fakeClient(text: string) {
  const sent: { pages: number }[] = [];
  const client = {
    beta: {
      messages: {
        create: async (req: {
          messages: { content: { type: string; source?: { data: string } }[] }[];
        }) => {
          const data = req.messages[0]!.content.find((c) => c.type === "document")!.source!.data;
          const doc = await PDFDocument.load(Buffer.from(data, "base64"));
          sent.push({ pages: doc.getPageCount() });
          return {
            model: "claude-haiku-5-5",
            content: [{ type: "text", text }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1500, output_tokens: 8 },
          };
        },
      },
    },
  } as unknown as Anthropic;
  return { client, sent };
}

describe("classifyDocument", () => {
  it("sends only the first page of a long document", async () => {
    const { client, sent } = fakeClient('{"kind":"statement"}');
    const res = await classifyDocument(client, await pdfWithPages(6), {
      model: "claude-haiku-5-5",
    });
    expect(res.kind).toBe("statement");
    expect(res.pageCount).toBe(6);
    expect(sent).toEqual([{ pages: 1 }]);
    expect(res.costMicros).toBe(Math.round(1500 * 0.1 + 8 * 0.5));
  });

  it("fails open to invoice on an unparseable answer, so the stricter stage decides", async () => {
    const { client } = fakeClient("not json");
    const res = await classifyDocument(client, await pdfWithPages(1), {
      model: "claude-haiku-5-5",
    });
    expect(res.kind).toBe("invoice");
  });
});

describe("firstPages", () => {
  it("returns the input untouched when it is not a parseable PDF", async () => {
    const junk = Buffer.from("%PDF-1.4 garbage");
    const res = await firstPages(junk);
    expect(res.pdf).toBe(junk);
    expect(res.pageCount).toBe(0);
  });
});
