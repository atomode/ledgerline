import { PDFDocument } from "pdf-lib";

/**
 * A new PDF holding only the first `n` pages. Classification only needs the first page, and PDF
 * input is billed per page, so this keeps the cheap gate cheap on long documents.
 * Falls back to the original bytes if the PDF can't be parsed (the extractor will decide).
 */
export async function firstPages(pdf: Buffer, n = 1): Promise<{ pdf: Buffer; pageCount: number }> {
  try {
    const src = await PDFDocument.load(pdf, { ignoreEncryption: true, updateMetadata: false });
    const pageCount = src.getPageCount();
    if (pageCount <= n) return { pdf, pageCount };
    const out = await PDFDocument.create();
    const pages = await out.copyPages(src, [...Array(n).keys()]);
    pages.forEach((p) => out.addPage(p));
    return { pdf: Buffer.from(await out.save()), pageCount };
  } catch {
    return { pdf, pageCount: 0 };
  }
}
